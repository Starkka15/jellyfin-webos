/* Offline downloads, kept by the TouchPad's download manager.
 *
 * Measured on webOS CE 3.1.0: the download manager reaches modern https servers,
 * saves a stream the server is still converting (no total size is known; it just
 * keeps receiving), creates its target folder, keeps going while the app is
 * closed, and can delete its files again. A downloaded file then plays from
 * local storage with no network, knows its length, and seeks at once.
 *
 * Files go in /media/internal/.jellyfin (hidden, so the Videos app does not list
 * them under item ids) as <item id>.mp4 and <item id>.jpg. A converted download
 * is MPEG-TS inside, but the web engine only hands files with a known video
 * extension to the media player (ts is not one), and the player itself goes by
 * the contents, so .mp4 plays.
 *
 * The record of downloads lives in localStorage ("jf.downloads"): one entry per
 * item id, with a trimmed copy of the item so it can be shown offline. One
 * download runs at a time; the rest wait their turn. The App owns one of these
 * and makes it available as JF.downloads.
 */
enyo.kind({
	name: "JF.Downloads",
	kind: enyo.Component,
	folder: "/media/internal/.jellyfin",
	components: [
		{name: "dlSvc", kind: "PalmService", service: "palm://com.palm.downloadmanager/", method: "download",
			subscribe: true, onResponse: "statusResponse"},
		{name: "querySvc", kind: "PalmService", service: "palm://com.palm.downloadmanager/",
			method: "downloadStatusQuery", subscribe: true, onResponse: "statusResponse"},
		{name: "cancelSvc", kind: "PalmService", service: "palm://com.palm.downloadmanager/", method: "cancelDownload"},
		{name: "deleteSvc", kind: "PalmService", service: "palm://com.palm.downloadmanager/",
			method: "deleteDownloadedFile"},
		// Free space on /media/internal, from the app's own service (df in its jail).
		{name: "spaceSvc", kind: "PalmService", service: "palm://com.stark.jellyfin.service/", method: "space",
			onSuccess: "spaceAnswer", onFailure: "spaceAnswer"}
	],
	// Left free whatever happens: webOS needs room of its own on /media/internal.
	reserve: 300 * 1048576,

	create: function() {
		this.inherited(arguments);
		this.listeners = [];
		this.entries = {};
		try {
			this.entries = enyo.json.parse(localStorage.getItem("jf.downloads") || "{}") || {};
		} catch (e) {
			this.entries = {};
		}
	},

	// Pick up downloads that ran while the app was closed, and start any queued.
	restore: function() {
		for (var id in this.entries) {
			var e = this.entries[id];
			// Closed before the download manager answered: start it again.
			if (e.state === "downloading" && !e.ticket) {
				e.state = "queued";
			}
			e.starting = false;
			if (!e.posterTicket) {
				e.posterStarting = false;
			}
			if (e.state === "downloading" && e.ticket) {
				this.$.querySvc.call({ticket: e.ticket});
			}
			if (e.posterTicket && !e.poster) {
				this.$.querySvc.call({ticket: e.posterTicket});
			}
		}
		this.next();
	},

	save: function() {
		localStorage.setItem("jf.downloads", enyo.json.stringify(this.entries));
		for (var i = 0; i < this.listeners.length; i++) {
			this.listeners[i]();
		}
	},

	addListener: function(fn) {
		this.listeners.push(fn);
	},

	// ---- what the views ask ---------------------------------------------------

	get: function(id) {
		return this.entries[id] || null;
	},

	// Path of a finished download, or null.
	localFile: function(id) {
		var e = this.entries[id];
		return e && e.state === "done" ? e.file : null;
	},

	// An album's own id finds the poster saved with any of its downloaded tracks.
	localImage: function(id) {
		var e = this.entries[id];
		if (e) {
			return e.poster || null;
		}
		for (var k in this.entries) {
			if (this.entries[k].item.AlbumId === id && this.entries[k].poster) {
				return this.entries[k].poster;
			}
		}
		return null;
	},

	// The downloaded tracks of an album, in disc and track order.
	albumTracks: function(albumId) {
		var out = [];
		for (var k in this.entries) {
			var e = this.entries[k];
			if (e.item.AlbumId === albumId && e.state === "done") {
				out.push(e.item);
			}
		}
		out.sort(function(a, b) {
			return ((a.ParentIndexNumber || 1) - (b.ParentIndexNumber || 1)) || ((a.IndexNumber || 0) - (b.IndexNumber || 0));
		});
		return out;
	},

	// How many of these tracks are downloaded, and how many are still coming.
	countFor: function(tracks) {
		var done = 0;
		var pending = 0;
		for (var i = 0; i < tracks.length; i++) {
			var e = this.entries[tracks[i].Id];
			if (e && e.state === "done") {
				done++;
			} else if (e && (e.state === "queued" || e.state === "downloading")) {
				pending++;
			}
		}
		return {done: done, pending: pending};
	},

	// Changes when a download is added, finishes or goes; not on progress.
	signature: function() {
		var key = "";
		for (var k in this.entries) {
			key += k + ":" + this.entries[k].state + " ";
		}
		return key;
	},

	// Items with a download, finished or not, newest first.
	// For the home screen, newest first. Music shows as one tile per album.
	items: function() {
		var list = [];
		for (var id in this.entries) {
			list.push(this.entries[id]);
		}
		list.sort(function(a, b) { return b.added - a.added; });
		var out = [];
		var albums = {};
		for (var i = 0; i < list.length; i++) {
			var item = list[i].item;
			if (item.MediaType === "Audio" && item.AlbumId) {
				if (!albums[item.AlbumId]) {
					albums[item.AlbumId] = true;
					out.push({Id: item.AlbumId, Type: "MusicAlbum", Name: item.Album || "Album",
						AlbumArtist: item.AlbumArtist, IsFolder: true});
				}
				continue;
			}
			out.push(item);
		}
		return out;
	},

	// Enough of the record to show and play the item offline.
	trim: function(item) {
		var keep = ["Id", "Name", "Type", "MediaType", "SeriesName", "SeriesId", "SeasonId", "SeasonName",
			"ParentIndexNumber", "IndexNumber", "RunTimeTicks", "ProductionYear", "OfficialRating", "Overview",
			"ImageTags", "SeriesPrimaryImageTag", "UserData",
			"AlbumArtist", "Artists", "Album", "AlbumId", "AlbumPrimaryImageTag"];
		var out = {};
		for (var i = 0; i < keep.length; i++) {
			if (item[keep[i]] !== undefined) {
				out[keep[i]] = item[keep[i]];
			}
		}
		return out;
	},

	// ---- starting, cancelling, deleting --------------------------------------

	// Queue a download of this item (a full record, so its tracks are known).
	// choice: {audioIndex, subtitleIndex, maxBitrate, description}; left out, the
	// player's last language choices and the best quality are used.
	start: function(item, choice) {
		this.startAll([{item: item, choice: choice}]);
	},

	// Queue several downloads ([{item, choice}]) after checking they fit, with
	// whatever is already waiting. If they might not, ask first.
	startAll: function(list) {
		var self = this;
		var fresh = [];
		var need = this.pendingBytes();
		for (var i = 0; i < list.length; i++) {
			if (!this.isWanted(list[i].item.Id)) {
				fresh.push(list[i]);
				need += this.estimate(list[i].item, list[i].choice && list[i].choice.maxBitrate);
			}
		}
		if (!fresh.length) {
			return;
		}
		var go = function() {
			for (var j = 0; j < fresh.length; j++) {
				self.queue(fresh[j].item, fresh[j].choice);
			}
		};
		this.freeSpace(function(free) {
			if (free === null || need + self.reserve <= free) {
				go();  // fits, or the space could not be read: go ahead as before
				return;
			}
			JF.confirm("Not Enough Space?",
				(fresh.length > 1 ? "These downloads" : "This download") + " could take up to " + self.sizeText(need) +
				(self.pendingBytes() ? ", with the ones already waiting," : "") + " and " +
				self.sizeText(Math.max(0, free - self.reserve)) + " is free. A download that runs out of room stops.",
				"Download Anyway", go);
		});
	},

	// Queued, downloading or done already.
	isWanted: function(id) {
		var e = this.entries[id];
		return !!e && (e.state === "done" || e.state === "downloading" || e.state === "queued");
	},

	// At most how big a download gets. Video: the bitrate asked for (the server
	// often needs less) and the sound. Music: the file's own size when known, else
	// a high-quality 320 kb/s.
	estimate: function(item, maxBitrate) {
		var seconds = (item.RunTimeTicks || 0) / 10000000;
		if (item.MediaType === "Audio") {
			var source = item.MediaSources && item.MediaSources[0];
			return source && source.Size ? source.Size : seconds * 320000 / 8;
		}
		var stored = parseInt(localStorage.getItem("jf.downloadQuality"), 10) || 3000000;
		return seconds * ((maxBitrate || stored) + 192000) / 8;
	},

	// What the queued and running downloads still have to fetch.
	pendingBytes: function() {
		var total = 0;
		for (var id in this.entries) {
			var e = this.entries[id];
			if (e.state === "queued" || e.state === "downloading") {
				total += Math.max(0, this.estimate(e.item, e.maxBitrate) - (e.received || 0));
			}
		}
		return total;
	},

	sizeText: function(bytes) {
		return bytes >= 1073741824 ? (bytes / 1073741824).toFixed(1) + " GB" : Math.round(bytes / 1048576) + " MB";
	},

	// callback(free bytes), or callback(null) when the service cannot say.
	freeSpace: function(callback) {
		this.spaceWaiting = (this.spaceWaiting || []).concat([callback]);
		if (this.spaceWaiting.length === 1) {
			this.$.spaceSvc.call({});
		}
	},

	spaceAnswer: function(inSender, r) {
		var free = r && r.returnValue && typeof r.free === "number" ? r.free : null;
		var waiting = this.spaceWaiting || [];
		this.spaceWaiting = [];
		for (var i = 0; i < waiting.length; i++) {
			waiting[i](free);
		}
	},

	queue: function(item, choice) {
		var old = this.entries[item.Id];
		if (this.isWanted(item.Id)) {
			return;
		}
		if (old && old.ticket) {
			this.$.deleteSvc.call({ticket: old.ticket});  // what a failed attempt left behind
		}
		choice = choice || JF.api.defaultTracks(item);
		this.entries[item.Id] = {
			id: item.Id, item: this.trim(item), state: "queued", received: 0, added: new Date().getTime(),
			audioIndex: choice.audioIndex, subtitleIndex: choice.subtitleIndex, maxBitrate: choice.maxBitrate,
			description: choice.description || ""
		};
		this.save();
		this.next();
	},

	// Start the next queued download if none is running.
	next: function() {
		var queued = null;
		for (var id in this.entries) {
			var e = this.entries[id];
			if (e.state === "downloading") {
				return;
			}
			if (e.state === "queued" && (!queued || e.added < queued.added)) {
				queued = e;
			}
		}
		if (queued) {
			this.begin(queued);
		}
	},

	begin: function(e) {
		var self = this;
		e.state = "downloading";
		e.received = 0;
		this.save();
		JF.api.playbackInfo(e.item, {audioIndex: e.audioIndex, subtitleIndex: e.subtitleIndex, startTicks: 0,
			maxBitrate: e.maxBitrate},
			function(info) {
				if (self.entries[e.id] !== e || e.state !== "downloading") {
					return;  // cancelled meanwhile
				}
				if (!info) {
					self.failed(e, "The server could not prepare this download.");
					return;
				}
				JF.log("download " + e.id + " " + info.method);
				e.starting = true;
				self.$.dlSvc.call({target: info.url, targetDir: self.folder, targetFilename: e.id + self.extension(e, info)});
			});
	},

	// Video is saved as .mp4 whatever is inside (see the top of this file); music
	// keeps its own type, which the audio element goes by.
	extension: function(e, info) {
		if (e.item.MediaType !== "Audio") {
			return ".mp4";
		}
		var m = /stream\.(\w+)/i.exec(info.url);
		var type = m ? m[1].toLowerCase() : "mp3";
		return "." + ({mp3: "mp3", m4a: "m4a", mp4: "m4a", aac: "m4a", wav: "wav", ogg: "ogg", oga: "ogg",
			opus: "opus", flac: "flac"}[type] || "mp3");
	},

	// The poster follows the video, never alongside another download: the download
	// manager's first answer carries only a ticket, so two starting at once could
	// not be told apart.
	fetchPoster: function(e) {
		var poster = JF.api.serverImageUrl(e.item, 440);
		if (!poster) {
			this.next();
			return;
		}
		e.posterStarting = true;
		this.$.dlSvc.call({target: poster, targetDir: this.folder, targetFilename: e.id + ".jpg"});
	},

	// Stop a download in progress, or delete a finished one.
	remove: function(id) {
		var e = this.entries[id];
		if (!e) {
			return;
		}
		if (e.ticket) {
			if (e.state === "downloading") {
				this.$.cancelSvc.call({ticket: e.ticket});
			}
			this.$.deleteSvc.call({ticket: e.ticket});
		}
		if (e.posterTicket) {
			this.$.deleteSvc.call({ticket: e.posterTicket});
		}
		delete this.entries[id];
		this.save();
		this.next();
	},

	failed: function(e, text) {
		JF.log("download " + e.id + " failed: " + text);
		e.state = "failed";
		e.error = text;
		this.save();
		this.next();
	},

	// ---- what the download manager tells us ----------------------------------

	entryForTicket: function(ticket, response) {
		for (var id in this.entries) {
			var e = this.entries[id];
			if (e.ticket === ticket) {
				return {entry: e, poster: false};
			}
			if (e.posterTicket === ticket) {
				return {entry: e, poster: true};
			}
		}
		// The first answer to a new download carries only its ticket. At most one
		// download is starting at any time (see fetchPoster), so it is that one.
		for (id in this.entries) {
			e = this.entries[id];
			if (e.starting && !e.ticket) {
				e.starting = false;
				e.ticket = ticket;
				return {entry: e, poster: false};
			}
			if (e.posterStarting && !e.posterTicket) {
				e.posterStarting = false;
				e.posterTicket = ticket;
				return {entry: e, poster: true};
			}
		}
		return null;
	},

	statusResponse: function(inSender, r) {
		if (!r || r.ticket === undefined) {
			return;
		}
		var found = this.entryForTicket(r.ticket, r);
		if (!found) {
			return;
		}
		var e = found.entry;
		var ok = r.completed && r.completionStatusCode === 200 && !r.aborted && !r.interrupted;
		if (found.poster) {
			if (r.completed) {
				if (ok) {
					e.poster = (r.destPath || this.folder + "/") + r.destFile;
				}
				this.save();
				this.next();
			}
			return;
		}
		if (r.amountReceived !== undefined) {
			e.received = r.amountReceived;
		}
		if (r.completed) {
			if (ok && e.received > 0) {
				e.state = "done";
				e.file = (r.destPath || this.folder + "/") + r.destFile;
				JF.log("download " + e.id + " done, " + e.received + " bytes");
				this.save();
				this.fetchPoster(e);
			} else {
				this.failed(e, "The download stopped (" + (r.completionStatusCode || "no answer") + ").");
			}
			return;
		}
		// Progress arrives many times a second; tell the views about every megabyte.
		var mb = Math.floor(e.received / 1048576);
		if (mb !== e.shownMb) {
			e.shownMb = mb;
			this.save();
		}
	}
});
