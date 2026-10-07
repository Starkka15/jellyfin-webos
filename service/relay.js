// Stream relay for the Jellyfin app (node 0.4.12 on webOS 3 / webOS CE, ES5 only).
//
// The TouchPad's media player fetches over its own 2011 HTTP stack (libsoup with
// GnuTLS 2), which cannot talk to a modern HTTPS server: playing an https://
// address fails at once with "Connection terminated unexpectedly". The app's own
// requests are fine, because webOS CE gives the app WebKit modern TLS, and so is
// CE's /usr/bin/curl (OpenSSL 1.1.1w). Node's own https is not.
//
// So for an https server the app registers each stream address here and gets back
// a local http://127.0.0.1 address. When the media player opens that, this service
// fetches the real address with curl and passes the bytes straight through. Only
// registered addresses are relayed, so this is not an open proxy for other apps,
// and the access token never appears in the local address.
//
// The service framework stops a service a set time after its last call; an open
// connection does not count. While a relayed stream plays, the app calls "ping".

if (typeof require === "undefined") {
	require = IMPORTS.require;
}

var http = require("http");
var child_process = require("child_process");

var CURL = "/usr/bin/curl";
var MAX_ROUTES = 8;

var server = null;
var port = 0;
var waiting = [];        // callbacks waiting for the server to start listening
var routes = {};         // id -> {url, created}
var routeOrder = [];

function log(msg) {
	try { console.log("[jfrelay] " + msg); } catch (e) {}
}

function newId() {
	var s = "";
	for (var i = 0; i < 4; i++) {
		s += (((1 + Math.random()) * 0x10000) | 0).toString(16).substring(1);
	}
	return s;
}

// Headers worth passing from the server to the media player.
var PASS = {"content-type": true, "content-length": true, "content-range": true, "accept-ranges": true};

function relay(req, res) {
	var m = /^\/s\/([0-9a-f]+)/.exec(req.url);
	var route = m && routes[m[1]];
	if (!route || (req.method !== "GET" && req.method !== "HEAD")) {
		res.writeHead(404, {"Content-Length": "0"});
		res.end();
		return;
	}
	var args = ["-s", "-S", "-i", "-N", "--http1.1", "--connect-timeout", "20"];
	if (req.method === "HEAD") {
		args.push("-I");
	}
	if (req.headers.range) {
		args.push("-H", "Range: " + req.headers.range);
	}
	args.push(route.url);
	var child = child_process.spawn(CURL, args);
	var head = "";
	var started = false;
	var finished = false;

	function finish() {
		if (finished) {
			return;
		}
		finished = true;
		try { child.kill(); } catch (e) {}
	}

	child.stdout.on("data", function(chunk) {
		if (finished) {
			return;
		}
		if (!started) {
			head += chunk.toString("binary");
			var end = head.indexOf("\r\n\r\n");
			if (end < 0) {
				if (head.length > 65536) {
					res.writeHead(502, {"Content-Length": "0"});
					res.end();
					finish();
				}
				return;
			}
			var lines = head.substring(0, end).split("\r\n");
			var status = parseInt((lines[0].split(" ")[1]) || "502", 10);
			var headers = {};
			for (var i = 1; i < lines.length; i++) {
				var c = lines[i].indexOf(":");
				if (c > 0) {
					var name = lines[i].substring(0, c).toLowerCase();
					if (PASS[name]) {
						headers[name] = lines[i].substring(c + 1).replace(/^\s+|\s+$/g, "");
					}
				}
			}
			started = true;
			res.writeHead(status, headers);
			var rest = new Buffer(head.substring(end + 4), "binary");
			head = "";
			if (rest.length) {
				res.write(rest);
			}
			return;
		}
		// Let the player set the pace: stop reading from curl while it is behind.
		if (res.write(chunk) === false) {
			child.stdout.pause();
		}
	});
	res.on("drain", function() {
		if (!finished) {
			child.stdout.resume();
		}
	});
	child.stderr.on("data", function(d) {
		log("curl: " + d.toString().replace(/\s+$/, ""));
	});
	child.on("exit", function(code) {
		if (!started) {
			log("curl exited " + code + " before any reply");
			try {
				res.writeHead(502, {"Content-Length": "0"});
			} catch (e) {}
		}
		finished = true;
		try { res.end(); } catch (e2) {}
	});
	// The media player hung up (a seek, a new stream, or the app closed).
	req.connection.on("close", finish);
}

function withServer(cb) {
	if (port) {
		cb(null, port);
		return;
	}
	waiting.push(cb);
	if (server) {
		return;
	}
	server = http.createServer(relay);
	server.on("error", function(e) {
		log("server error: " + e);
		var w = waiting;
		waiting = [];
		server = null;
		for (var i = 0; i < w.length; i++) {
			w[i](e);
		}
	});
	server.listen(0, "127.0.0.1", function() {
		port = server.address().port;
		log("listening on 127.0.0.1:" + port);
		var w = waiting;
		waiting = [];
		for (var i = 0; i < w.length; i++) {
			w[i](null, port);
		}
	});
}

// ---- luna command: relay ----------------------------------------------------
// args: {url: "https://..."}  ->  {returnValue: true, url: "http://127.0.0.1:<port>/s/<id>"}
var relayAssistant = function() {};
relayAssistant.prototype.run = function(future) {
	var a = this.controller.args || {};
	if (!a.url || !/^https?:\/\//.test(a.url)) {
		future.result = {returnValue: false, errorText: "missing or bad url"};
		return future;
	}
	withServer(function(err, p) {
		if (err) {
			future.result = {returnValue: false, errorText: "could not listen: " + err};
			return;
		}
		var id = newId();
		routes[id] = {url: a.url, created: new Date().getTime()};
		routeOrder.push(id);
		while (routeOrder.length > MAX_ROUTES) {
			delete routes[routeOrder.shift()];
		}
		future.result = {returnValue: true, url: "http://127.0.0.1:" + p + "/s/" + id};
	});
	return future;
};

// ---- luna command: ping -----------------------------------------------------
// Keeps the service running while a relayed stream plays.
var pingAssistant = function() {};
pingAssistant.prototype.run = function(future) {
	future.result = {returnValue: true, port: port};
	return future;
};
