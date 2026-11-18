/* Playback selection for the HP TouchPad. ES5 for its 2011 WebKit. */
var JF = window.JF || {};

// Emby's static MP4 sends the original audio tracks. The stock TouchPad
// decoder chooses the default track. Select alternate tracks in the bridge.
JF.audioNeedsRemux = function(source, index) {
	if (index === undefined || index === null) return false;
	var streams = source && source.MediaStreams || [];
	var first = null;
	for (var i = 0; i < streams.length; i++) {
		if (streams[i].Type !== "Audio") continue;
		if (!first || streams[i].IsDefault || streams[i].Index === source.DefaultAudioStreamIndex) {
			first = streams[i];
			if (first.Index === source.DefaultAudioStreamIndex) break;
		}
	}
	return !!first && index !== first.Index;
};

JF.choosePlayback = function(item, source, requestedAudio, forceTranscode) {
	item = item || {};
	source = source || {};
	var streams = (source && source.MediaStreams) || item.MediaStreams || [];
	var video = null, audio = [], selected = null, i;
	for (i = 0; i < streams.length; i++) {
		if (streams[i].Type === "Video" && !video) video = streams[i];
		if (streams[i].Type === "Audio") audio.push(streams[i]);
	}
	var index = requestedAudio;
	if (index === undefined || index === null) index = source.DefaultAudioStreamIndex;
	for (i = 0; i < audio.length; i++) {
		if (index !== undefined && index !== null && audio[i].Index === index) selected = audio[i];
	}
	if (!selected) {
		for (i = 0; i < audio.length; i++) if (audio[i].IsDefault) { selected = audio[i]; break; }
	}
	if (!selected && audio.length) selected = audio[0];
	var codec = selected && String(selected.Codec || "").toLowerCase();
	var bridgeAudio = selected ? selected.Index : null;
	// A default Audio Vivid / unknown track might not be decodable by FFmpeg.
	// Prefer a known audio track when the selected track is not recognized.
	if (!/^(aac|mp3|ac3|eac3|dts|truehd|flac|opus|vorbis)$/.test(codec || "")) {
		for (i = 0; i < audio.length; i++) {
			if (/^(aac|mp3|ac3|eac3|dts|truehd|flac|opus|vorbis)$/.test(String(audio[i].Codec || "").toLowerCase())) {
				bridgeAudio = audio[i].Index;
				break;
			}
		}
	}
	var container = String(source.Container || "").toLowerCase().split(",");
	var vcodec = video && String(video.Codec || "").toLowerCase();
	var range = video && String(video.VideoRangeType || video.VideoRange || "").toLowerCase();
	var transfer = video && String(video.ColorTransfer || "").toLowerCase();
	var hdr = /hdr|dolby|dovi|hlg/.test(range || "") || /^(pq|smpte2084|arib-std-b67)$/.test(transfer || "");
	var probe = JF.cachedVideoProbe(item, source);
	var probedVideo = (probe && probe.video) || {};
	var probeAllowsDirect = !probe || (probe.hdrKind === "sdr" &&
		(!probedVideo.codec || probedVideo.codec === "h264") &&
		(!probedVideo.bitDepth || probedVideo.bitDepth <= 8) &&
		(!probedVideo.width || probedVideo.width <= 1920) &&
		(!probedVideo.height || probedVideo.height <= 1080));
	var mp4 = false;
	for (i = 0; i < container.length; i++) if (container[i] === "mp4" || container[i] === "m4v") mp4 = true;
	var aacProfile = selected && String(selected.Profile || "").toLowerCase();
	var supportedAudio = !audio.length || (!!selected && /^(aac|mp3)$/.test(codec || "") &&
		(!selected.Channels || selected.Channels <= 2) &&
		(codec !== "aac" || !aacProfile || /^(lc|aac lc)$/.test(aacProfile)));
	var direct = !forceTranscode && mp4 && vcodec === "h264" && !hdr && probeAllowsDirect &&
		(!video.BitDepth || video.BitDepth <= 8) &&
		(!video.Width || video.Width <= 1920) && (!video.Height || video.Height <= 1080) && supportedAudio;
	return {direct: !!direct, audioIndex: bridgeAudio};
};

// The bridge base is a private setting, not part of application source.
var MINI_PROBE_TTL = 300000;
var MINI_PROBE_MAX = 16;
var MINI_PROBE_TIMEOUT = 20000;
// A warm request is deliberately shorter than the player's own cold-start
// window.  It may wait for the bridge to have enough output buffered, but must
// not leave the webOS card waiting forever.
var MINI_WARM_TIMEOUT = 34000;
var miniProbeCache = {};
var miniProbeOrder = [];
var miniProbePending = {};

// A bridge capability is supplied by the user. Keep it on the private LAN,
// in the path only, with no URL user info, query, fragment or extra path.
JF.bridgeAddress = function(value) {
	var address = String(value || "").replace(/^\s+|\s+$/g, "").replace(/\/+$/, "");
	var match = /^http:\/\/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3}):(\d{1,5})\/v1\/[A-Za-z0-9_-]{24,128}$/.exec(address);
	if (!match) return "";
	var a = +match[1], b = +match[2], port = +match[5];
	if (!(a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168))) return "";
	if (b > 255 || +match[3] > 255 || +match[4] > 255 || port < 1024 || port > 65535) return "";
	// Reject ambiguous leading-zero octets, which some URL parsers treat as octal.
	for (var i = 1; i <= 4; i++) if (String(+match[i]) !== match[i]) return "";
	return address;
};

function miniBridgeBase() {
	try { return JF.bridgeAddress(localStorage.getItem("jf.miniBridge")); }
	catch (e) { return ""; }
}

function miniProbeKey(item, source) {
	if (!item || item.Id === undefined || item.Id === null || !source ||
		source.Id === undefined || source.Id === null) {
		return "";
	}
	return "k:" + String(item.Id) + "|" + String(source.Id);
}

function miniProbeCopy(value, fields) {
	var copy = {}, i;
	for (i = 0; i < fields.length; i++) {
		if (value[fields[i]] !== undefined && value[fields[i]] !== null) {
			copy[fields[i]] = value[fields[i]];
		}
	}
	return copy;
}

function miniProbeInfo(raw, sourceId) {
	var kinds = {sdr: true, hdr10: true, hlg: true, "dolby-vision": true};
	if (!raw || raw.returnValue !== true || String(raw.mediaSourceId) !== sourceId ||
		!raw.video || typeof raw.video !== "object" || typeof raw.miniSupported !== "boolean" ||
		!kinds[String(raw.hdrKind || "").toLowerCase()]) {
		return null;
	}
	var info = {
		mediaSourceId: sourceId,
		video: miniProbeCopy(raw.video, ["codec", "profile", "pixFmt", "bitDepth", "width", "height",
			"colorTransfer", "colorPrimaries", "colorSpace", "colorRange", "dolbyVisionProfile"]),
		hdrKind: String(raw.hdrKind).toLowerCase(),
		miniSupported: raw.miniSupported
	};
	if (raw.audio && typeof raw.audio === "object") {
		info.audio = miniProbeCopy(raw.audio, ["codec", "channels"]);
	}
	if (typeof raw.reason === "string" && raw.reason) {
		info.reason = raw.reason.substring(0, 240);
	}
	return info;
}

function miniProbeCached(key) {
	var entry = miniProbeCache[key];
	if (!entry) return null;
	if (new Date().getTime() - entry.at >= MINI_PROBE_TTL) {
		delete miniProbeCache[key];
		return null;
	}
	return entry.info;
}

function miniProbeRemember(key, info) {
	var i, old;
	if (!miniProbeCache[key]) {
		for (i = miniProbeOrder.length - 1; i >= 0; i--) {
			if (miniProbeOrder[i] === key) miniProbeOrder.splice(i, 1);
		}
		miniProbeOrder.push(key);
	}
	miniProbeCache[key] = {at: new Date().getTime(), info: info};
	while (miniProbeOrder.length > MINI_PROBE_MAX) {
		old = miniProbeOrder.shift();
		if (old !== key) delete miniProbeCache[old];
	}
}

function miniProbeFinish(key, ok, info, callbacks) {
	var i;
	delete miniProbePending[key];
	if (ok && info) miniProbeRemember(key, info);
	for (i = 0; i < callbacks.length; i++) callbacks[i](ok, info || null);
}

JF.miniProbeConfigured = function() {
	return !!miniBridgeBase();
};

JF.cachedVideoProbe = function(item, source) {
	var key = miniProbeKey(item, source);
	return key ? miniProbeCached(key) : null;
};

JF.probeVideo = function(item, source, callback) {
	callback = callback || function() {};
	var base = miniBridgeBase();
	var key = miniProbeKey(item, source);
	if (!base || !key) {
		callback(false, null);
		return;
	}
	var cached = miniProbeCached(key);
	if (cached) {
		callback(true, cached);
		return;
	}
	if (miniProbePending[key]) {
		miniProbePending[key].push(callback);
		return;
	}
	miniProbePending[key] = [callback];
	var req;
	var done = false;
	var timer;
	var finish = function(ok, info) {
		if (done) return;
		done = true;
		if (timer) clearTimeout(timer);
		miniProbeFinish(key, ok, info, miniProbePending[key] || []);
	};
	try {
		req = new XMLHttpRequest();
	} catch (e) {
		finish(false, null);
		return;
	}
	timer = setTimeout(function() {
		try { req.abort(); } catch (e) {}
		finish(false, null);
	}, MINI_PROBE_TIMEOUT);
	try {
		req.open("GET", base + "/probe/" + encodeURIComponent(String(item.Id)) +
			"?mediaSourceId=" + encodeURIComponent(String(source.Id)), true);
		req.setRequestHeader("Accept", "application/json");
		req.onreadystatechange = function() {
			if (req.readyState !== 4) return;
			var raw = null;
			try { raw = JSON.parse(req.responseText || ""); } catch (e) {}
			var info = req.status >= 200 && req.status < 300 ? miniProbeInfo(raw, String(source.Id)) : null;
			finish(!!info, info);
		};
		req.onerror = function() { finish(false, null); };
		req.onabort = function() { finish(false, null); };
		req.send(null);
	} catch (e) {
		finish(false, null);
	}
};

JF.miniVideoUrl = function(item, source, audioIndex, startTicks) {
	var base = miniBridgeBase();
	if (!base) return "";
	return base + "/stream/" + encodeURIComponent(item.Id) + JF.api.query({
		startSeconds: Math.max(0, Math.floor((startTicks || 0) / 10000000)),
		audioStreamIndex: audioIndex,
		mediaSourceId: source.Id || item.Id,
		format: JF.miniWarmEnabled ? "mkv" : "mp4"
	});
};

// Ask the bridge to pre-open exactly one already validated stream.  The stream
// URL is intentionally the only input: accepting a server-provided warm or
// ready URL here would turn this helper into an unrestricted HTTP client.  On
// success callback receives the locally constructed /ready/<sessionId> URL;
// on failure it receives "" and a short, non-sensitive reason.  The function
// returns a cancel function, which aborts the request without invoking the
// callback.
function miniWarmParts(streamUrl) {
	var base = miniBridgeBase();
	if (!base || typeof streamUrl !== "string") return null;
	var prefix = base + "/stream/";
	if (streamUrl.indexOf(prefix) !== 0) return null;
	var rest = streamUrl.substring(prefix.length);
	var q = rest.indexOf("?");
	var item = q < 0 ? rest : rest.substring(0, q);
	var query = q < 0 ? "" : rest.substring(q);
	// miniVideoUrl always emits an encoded, single path segment and a query;
	// reject lookalikes rather than normalizing arbitrary URLs into a warm path.
	if (!item || item.indexOf("/") >= 0 || item.indexOf("#") >= 0 || !query || query.indexOf("#") >= 0) {
		return null;
	}
	try {
		if (encodeURIComponent(decodeURIComponent(item)) !== item) return null;
	} catch (e) {
		return null;
	}
	return {base: base, item: item, query: query};
}

JF.prepareMiniVideo = function(streamUrl, callback) {
	callback = typeof callback === "function" ? callback : function() {};
	var parts = miniWarmParts(streamUrl);
	var req = null;
	var timer = null;
	var done = false;
	var cancelled = false;
	var finish = function(url, reason) {
		if (done) return;
		done = true;
		if (timer) clearTimeout(timer);
		if (!cancelled) callback(url || "", reason || null);
	};
	var cancel = function() {
		if (done) return;
		cancelled = true;
		done = true;
		if (timer) clearTimeout(timer);
		if (req) {
			try { req.abort(); } catch (e) {}
		}
	};
	if (!parts) {
		finish("", "invalid");
		return cancel;
	}
	try {
		req = new XMLHttpRequest();
	} catch (e) {
		finish("", "network");
		return cancel;
	}
	timer = setTimeout(function() {
		// Mark the request complete before abort: some old XHR implementations
		// synchronously deliver onabort from abort().
		finish("", "timeout");
		try { req.abort(); } catch (e) {}
	}, MINI_WARM_TIMEOUT);
	try {
		req.open("GET", parts.base + "/warm/" + parts.item + parts.query, true);
		req.setRequestHeader("Accept", "application/json");
		req.onreadystatechange = function() {
			if (req.readyState !== 4 || done) return;
			var raw = null;
			try { raw = JSON.parse(req.responseText || ""); } catch (e) {}
			if (req.status >= 200 && req.status < 300 && raw && raw.returnValue === true &&
				typeof raw.sessionId === "string" && /^[0-9a-f]{32}$/.test(raw.sessionId)) {
				// Never trust a URL returned by the bridge.  The capability and item
				// remain those validated from the original /stream URL.
				finish(parts.base + "/ready/" + raw.sessionId, null);
				return;
			}
			var reason = req.status === 429 ? "busy" : req.status === 415 ? "unsupported" :
				(req.status >= 400 ? "http" : "invalid");
			finish("", reason);
		};
		req.onerror = function() { finish("", "network"); };
		req.onabort = function() { finish("", "aborted"); };
		req.send(null);
	} catch (e) {
		finish("", "network");
	}
	return cancel;
};
