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
var dgram = require("dgram");

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

// Every address on the local networks the tablet is on: callback([ip]).
// Read from the kernel's routing table, whose network and mask columns are
// little-endian hex (0004A8C0 / 00FCFFFF is 192.168.4.0 / 255.255.252.0).
function localHosts(callback) {
	var hosts = [];
	var table = "";
	try {
		table = require("fs").readFileSync("/proc/net/route", "utf8");
	} catch (e) {
		log("discover: no routing table: " + e);
	}
	var hex = function(h) {
		var n = parseInt(h, 16);
		return (((n & 255) << 24) >>> 0) + (((n >>> 8) & 255) << 16) + (((n >>> 16) & 255) << 8) + ((n >>> 24) & 255);
	};
	var toIp = function(n) {
		return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
	};
	var lines = table.split("\n");
	for (var l = 1; l < lines.length; l++) {
		var f = lines[l].split(/\s+/);
		if (f.length < 8 || f[0] === "lo" || f[1] === "00000000") {
			continue;  // the loopback, and the default route
		}
		var net = hex(f[1]);
		var mask = hex(f[7]);
		// Keep it to a home-sized network: anything larger than a /22 is skipped.
		if (((~mask) >>> 0) > 1023) {
			continue;
		}
		var size = ((~mask) >>> 0) + 1;
		for (var i = 1; i < size - 1; i++) {
			hosts.push(toIp(net + i));
		}
	}
	log("discover: asking " + hosts.length + " local address(es)");
	callback(hosts);
}

// ---- luna command: discover -------------------------------------------------
// Jellyfin servers on the local network answer a UDP broadcast of
// "who is JellyfinServer?" on port 7359 with {Address, Id, Name}, when their
// Auto Discovery setting is on (the default). The official apps find servers
// this way; a web app cannot use UDP, so the service asks on its behalf.
//
// webOS's firewall drops incoming packets that are not part of a conversation
// the tablet started, and a reply to a broadcast comes from an address the
// tablet never sent to, so it is dropped (seen as IPT_PACKET_DROPPED_NO_MATCH
// with SPT=7359). A reply from an address the tablet did ask is let in, so the
// question also goes to every address on the local subnet (at most 1024,
// a few milliseconds of tiny packets). node 0.4 cannot list interfaces and the
// service jail has no ifconfig, so the networks come from /proc/net/route.
// -> {returnValue: true, servers: [{name, address, id}]}
var discoverAssistant = function() {};
discoverAssistant.prototype.run = function(future) {
	var found = {};
	var list = [];
	var socket;
	var finished = false;
	function finish() {
		if (finished) {
			return;
		}
		finished = true;
		try { socket.close(); } catch (e) {}
		log("discover: " + list.length + " server(s)");
		future.result = {returnValue: true, servers: list};
	}
	try {
		socket = dgram.createSocket("udp4");
		socket.on("message", function(msg) {
			try {
				var r = JSON.parse(msg.toString());
				if (r.Address && !found[r.Id || r.Address]) {
					found[r.Id || r.Address] = true;
					list.push({name: r.Name || "", address: r.Address, id: r.Id || ""});
				}
			} catch (e) {}
		});
		socket.on("error", function(e) {
			log("discover error: " + e);
			finish();
		});
		socket.bind(0);
		socket.setBroadcast(true);
		var msg = new Buffer("who is JellyfinServer?");
		socket.send(msg, 0, msg.length, 7359, "255.255.255.255");
		localHosts(function(hosts) {
			for (var i = 0; i < hosts.length && !finished; i++) {
				socket.send(msg, 0, msg.length, 7359, hosts[i]);
			}
			setTimeout(finish, 2500);
		});
	} catch (e) {
		log("discover failed: " + e);
		finished = true;
		future.result = {returnValue: true, servers: []};
	}
	return future;
};

// ---- luna command: installed ------------------------------------------------
// An app removed and installed again should start clean, but a device may keep
// the old localStorage (a tester's Pre3 came up signed in), listing downloads
// that are gone. Removing the app deletes the downloads folder and this marker
// beside it (scripts/pmPreRemove.script): a missing marker means a new install.
// Beside the folder, not in it: the download manager makes the folder as root,
// and where /media/internal keeps owners (the emulator) the service cannot
// write there.
// -> {returnValue: true, existed: <was the marker there>}; it is made if not.
// Without "existed" the marker could not be made, and nothing can be told.
var installedAssistant = function() {};
installedAssistant.prototype.run = function(future) {
	var fs = require("fs");
	var marker = "/media/internal/.jellyfin-installed";
	var existed = true;
	try {
		fs.statSync(marker);
	} catch (e) {
		existed = false;
	}
	if (!existed) {
		try {
			fs.writeFileSync(marker, "");
		} catch (e2) {
			log("installed: no marker: " + e2);
			future.result = {returnValue: true, errorText: String(e2)};
			return future;
		}
	}
	future.result = {returnValue: true, existed: existed};
	return future;
};

// ---- luna command: files ----------------------------------------------------
// What is really in the downloads folder, so the app can drop its record of a
// download whose file has gone (deleted over USB, or with the folder).
// -> {returnValue: true, files: [names]}; an absent folder is an empty one.
// Without "files" the folder could not be read, and nothing can be told.
var filesAssistant = function() {};
filesAssistant.prototype.run = function(future) {
	var fs = require("fs");
	var folder = "/media/internal/.jellyfin";
	var names;
	try {
		names = fs.readdirSync(folder);
	} catch (e) {
		var gone = false;
		try {
			fs.statSync("/media/internal");
			try {
				fs.statSync(folder);
			} catch (e2) {
				gone = true;
			}
		} catch (e3) {}
		if (!gone) {
			log("files: cannot read the folder: " + e);
			future.result = {returnValue: true, errorText: String(e)};
			return future;
		}
		names = [];
	}
	future.result = {returnValue: true, files: names};
	return future;
};

// ---- luna command: space ----------------------------------------------------
// Room left for downloads, which go to /media/internal. A web app cannot ask,
// and node 0.4 has no statvfs, but the service jail has busybox df.
// -> {returnValue: true, free: <bytes>, total: <bytes>}
var spaceAssistant = function() {};
spaceAssistant.prototype.run = function(future) {
	child_process.exec("df -k /media/internal", function(err, stdout) {
		// Filesystem 1K-blocks Used Available Use% Mounted on; a long name wraps onto its own line.
		var f = String(stdout || "").split("\n").slice(1).join(" ").split(/\s+/);
		var nums = [];
		for (var i = 0; i < f.length; i++) {
			if (/^\d+$/.test(f[i])) {
				nums.push(parseInt(f[i], 10));
			}
		}
		if (err || nums.length < 3) {
			log("space: df failed: " + (err || stdout));
			future.result = {returnValue: false, errorText: "df failed"};
			return;
		}
		future.result = {returnValue: true, total: nums[0] * 1024, free: nums[2] * 1024};
	});
	return future;
};
