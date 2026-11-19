/* Network media is browsed through the private Mini bridge. */
JF.networkPath = function(path) {
	if (!Array.isArray(path) || path.length > 24) return null;
	var parts = [], i, name;
	for (i = 0; i < path.length; i++) {
		name = path[i];
		if (typeof name !== "string" || !name || name === "." || name === ".." ||
			name.length > 255 || /[\x00-\x1f\x7f\\/:]/.test(name)) return null;
		try { parts.push(encodeURIComponent(name)); } catch (e) { return null; }
	}
	return parts.length ? "/" + parts.join("/") : "";
};

JF.networkMediaUrl = function(source, path) {
	var base = miniBridgeBase();
	var encoded = JF.networkPath(path);
	if (!base || !encoded || !/\.(mp4|m4v)$/i.test(path[path.length - 1])) return "";
	if (source === "nas") return base + "/nas" + encoded;
	if (source === "alist") return base + "/alist-media" + encoded;
	return "";
};

JF.networkTranscodeUrl = function(source, path) {
	var base = miniBridgeBase(), encoded = JF.networkPath(path);
	return base && encoded && (source === "nas" || source === "alist") ?
		base + "/library-transcode/" + source + encoded : "";
};

JF.networkPlaybackPlan = function(source, path, callback, probeDirect) {
	var base = miniBridgeBase(), encoded = JF.networkPath(path);
	if (!base || !encoded || (source !== "nas" && source !== "alist")) {
		callback(null);
		return;
	}
	var direct = JF.networkMediaUrl(source, path), suffix = "/" + source + encoded;
	if (direct && !probeDirect) {
		callback({direct: direct, source: source, path: path.slice(0)});
		return;
	}
	return JF.networkGetText(base + "/library-probe" + suffix, function(ok, text) {
		var facts;
		if (ok) {
			try { facts = JSON.parse(text); } catch (e) {}
		}
		if (!facts || facts.returnValue !== true || !facts.video) {
			callback(direct ? {direct: direct, source: source, path: path.slice(0)} : null);
			return;
		}
		var video = facts.video, audio = facts.audio;
		var canDirect = direct && facts.hdrKind === "sdr" && video.codec === "h264" &&
			video.width > 0 && video.width <= 1920 && video.height > 0 && video.height <= 1080 &&
			(video.bitDepth === 8 || video.pixFmt === "yuv420p" || video.pixFmt === "yuvj420p") &&
			(!audio || (audio.codec === "aac" && audio.channels > 0 && audio.channels <= 2));
		callback({direct: canDirect ? direct : "",
			transcode: facts.miniSupported ? JF.networkTranscodeUrl(source, path) : "",
			format: "ts",
			duration: +facts.durationSeconds || 0, reason: facts.reason || ""});
	});
};

JF.networkSubtitleTracks = function(source, path, entries) {
	var base = miniBridgeBase(), file = path[path.length - 1] || "", dot = file.lastIndexOf(".");
	if (!base || dot < 1 || (source !== "nas" && source !== "alist")) return [];
	var stem = file.slice(0, dot);
	var tracks = [];
	for (var i = 0; i < entries.length; i++) {
		var entry = entries[i], name = entry && entry.name;
		if (!entry || entry.directory || typeof name !== "string" || !/\.(srt|ass|ssa|vtt)$/i.test(name)) continue;
		var label = name.slice(0, name.lastIndexOf("."));
		var extra = label.slice(stem.length);
		if (label !== stem && (label.indexOf(stem + ".") !== 0 || !/^\.[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/i.test(extra))) continue;
		var encoded = JF.networkPath(path.slice(0, -1).concat([name]));
		if (encoded) tracks.push({index: tracks.length, title: label === stem ? name : extra.slice(1),
			isExternal: true, isText: true, url: base + "/library-subtitle/" + source + encoded});
	}
	return tracks;
};

JF.networkGetText = function(url, callback) {
	var xhr = new XMLHttpRequest(), timer, done = false;
	function finish(ok, text) {
		if (done) return;
		done = true;
		clearTimeout(timer);
		callback(ok, text);
	}
	function cancel() {
		done = true;
		clearTimeout(timer);
		xhr.abort();
	}
	try {
		xhr.open("GET", url, true);
		xhr.onreadystatechange = function() {
			if (xhr.readyState === 4) finish(xhr.status === 200, xhr.responseText);
		};
		xhr.onerror = function() { finish(false); };
		timer = setTimeout(function() {
			finish(false);
			xhr.abort();
		}, 15000);
		xhr.send(null);
	} catch (e) {
		finish(false);
	}
	return cancel;
};

JF.networkBrowse = function(source, path, callback) {
	var base = miniBridgeBase(), encoded = JF.networkPath(path);
	if (!base || encoded === null || (source !== "nas" && source !== "alist")) {
		callback(false);
		return;
	}
	var xhr, timer, done = false;
	function finish(ok, data) {
		if (done) return;
		done = true;
		clearTimeout(timer);
		callback(ok, data);
	}
	try {
		xhr = new XMLHttpRequest();
		xhr.open("GET", base + "/library/" + source + encoded, true);
		xhr.onreadystatechange = function() {
			if (xhr.readyState !== 4 || done) return;
			var data;
			try { data = JSON.parse(xhr.responseText); } catch (e) {}
			if (xhr.status === 200 && data && data.returnValue === true && Array.isArray(data.entries)) {
				finish(true, data);
			} else {
				finish(false);
			}
		};
		xhr.onerror = function() { finish(false); };
		timer = setTimeout(function() {
			finish(false);
			xhr.abort();
		}, 15000);
		xhr.send(null);
	} catch (e) {
		finish(false);
	}
};
