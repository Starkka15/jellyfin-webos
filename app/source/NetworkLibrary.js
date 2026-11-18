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
