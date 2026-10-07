/* Music: a queue of tracks, played by an <audio> element, with a bar along the
 * bottom of the app so the music carries on while browsing.
 *
 * What to play comes from the server, as for video: PlaybackInfo with an audio
 * profile returns the file itself (MP3, AAC, WAV), which the player can seek in,
 * or a converted MP3 stream starting at the time we ask for.
 */
enyo.kind({
	name: "JF.NowPlaying",
	kind: enyo.HFlexBox,
	align: "center",
	className: "jf-nowplaying",
	showing: false,
	events: {
		onOpen: ""  // the cover or title was tapped: show the Now Playing screen
	},
	components: [
		{name: "art", className: "jf-np-art", onclick: "doOpen"},
		{flex: 1, className: "jf-np-text", onclick: "doOpen", components: [
			{name: "title", className: "jf-np-title"},
			{name: "artist", className: "jf-np-artist"}
		]},
		{kind: "Button", caption: "Prev", onclick: "previousClick", className: "jf-np-button"},
		{name: "pauseButton", kind: "Button", caption: "Pause", onclick: "pauseClick", className: "jf-np-pause"},
		{kind: "Button", caption: "Next", onclick: "nextClick", className: "jf-np-button"},
		{name: "clock", content: "0:00", className: "jf-clock"},
		{name: "slider", kind: "Slider", minimum: 0, maximum: 1000, position: 0, animatePosition: false,
			onChanging: "sliderChanging", onChange: "sliderChange", className: "jf-np-slider"},
		{name: "duration", content: "", className: "jf-clock"},
		// The TouchPad font has no media symbols, so the buttons are words.
		{kind: "Button", caption: "Stop", onclick: "closeClick", className: "jf-np-button"},
		{name: "audio", nodeTag: "audio", className: "jf-np-audio"}
	],

	rendered: function() {
		this.inherited(arguments);
		var node = this.$.audio.hasNode();
		if (node && !this.wired) {
			this.wired = true;
			node.setAttribute("x-palm-media-audio-class", "media");
			var self = this;
			var names = ["playing", "pause", "ended", "error"];
			for (var i = 0; i < names.length; i++) {
				node.addEventListener(names[i], function(e) { self.audioEvent(e); }, false);
			}
		}
	},

	// ---- the queue -------------------------------------------------------
	// Views follow along through addListener: fn(what), what being "track",
	// "state" (playing or paused), "queue" (order, shuffle, repeat) or "position".

	addListener: function(fn) {
		this.listeners = this.listeners || [];
		this.listeners.push(fn);
	},

	notify: function(what) {
		var list = this.listeners || [];
		for (var i = 0; i < list.length; i++) {
			list[i](what);
		}
	},

	// Play these tracks, starting with tracks[index]; index "shuffle" plays them
	// in a random order.
	playTracks: function(tracks, index) {
		this.queue = tracks.slice(0);
		this.original = null;
		this.shuffled = false;
		// Not over the Now Playing screen, which has the controls already.
		this.setShowing(!(this.owner && this.owner.$.pane && this.owner.$.pane.getViewName() === "nowplayingView"));
		if (index === "shuffle") {
			this.index = Math.floor(Math.random() * this.queue.length);
			this.setShuffle(true);
			index = 0;
		}
		this.notify("queue");
		this.playIndex(index || 0, 0);
	},

	// Shuffle keeps the current track and mixes the rest; turning it off goes
	// back to the order the tracks came in.
	setShuffle: function(on) {
		if (!this.queue || !!on === !!this.shuffled) {
			return;
		}
		var current = this.queue[this.index || 0];
		if (on) {
			this.original = this.queue.slice(0);
			var rest = this.queue.slice(0);
			rest.splice(this.index || 0, 1);
			for (var i = rest.length - 1; i > 0; i--) {
				var j = Math.floor(Math.random() * (i + 1));
				var t = rest[i];
				rest[i] = rest[j];
				rest[j] = t;
			}
			this.queue = [current].concat(rest);
			this.index = 0;
		} else {
			this.queue = this.original || this.queue;
			this.original = null;
			this.index = Math.max(0, enyo.indexOf(current, this.queue));
		}
		this.shuffled = !!on;
		this.notify("queue");
	},

	// Repeat: "off", "all" (start the list again) or "one" (the same track).
	repeat: "off",
	cycleRepeat: function() {
		this.repeat = {off: "all", all: "one", one: "off"}[this.repeat];
		this.notify("queue");
	},

	// Put tracks right after the one playing.
	playNext: function(tracks) {
		this.addTracks(tracks, true);
	},

	addToQueue: function(tracks) {
		this.addTracks(tracks, false);
	},

	addTracks: function(tracks, next) {
		if (!this.queue) {
			this.playTracks(tracks, 0);
			return;
		}
		var at = next ? this.index + 1 : this.queue.length;
		this.queue.splice.apply(this.queue, [at, 0].concat(tracks));
		if (this.original) {
			var oat = next ? enyo.indexOf(this.queue[this.index], this.original) + 1 : this.original.length;
			this.original.splice.apply(this.original, [oat, 0].concat(tracks));
		}
		this.notify("queue");
	},

	removeAt: function(i) {
		if (!this.queue || i < 0 || i >= this.queue.length) {
			return;
		}
		var track = this.queue[i];
		if (this.original) {
			var o = enyo.indexOf(track, this.original);
			if (o >= 0) {
				this.original.splice(o, 1);
			}
		}
		this.queue.splice(i, 1);
		if (i < this.index) {
			this.index--;
		} else if (i === this.index) {
			// The track playing went: carry on with what came after it.
			this.notify("queue");
			this.playIndex(this.index, 0);
			return;
		}
		this.notify("queue");
	},

	jumpTo: function(i) {
		this.playIndex(i, 0);
	},

	// What comes after the current track, by the repeat setting; -1 for nothing.
	nextIndex: function() {
		if (this.repeat === "one") {
			return this.index;
		}
		if (this.index + 1 < this.queue.length) {
			return this.index + 1;
		}
		return this.repeat === "all" ? 0 : -1;
	},

	playIndex: function(index, startTicks) {
		if (!this.queue || index < 0 || index >= this.queue.length) {
			this.stopAll();
			return;
		}
		this.endTrack();
		this.index = index;
		var track = this.item = this.queue[index];
		this.$.title.setContent(track.Name || "");
		this.$.artist.setContent(track.AlbumArtist || (track.Artists || []).join(", ") || track.Album || "");
		var url = JF.api.imageUrl(track, 120);
		this.$.art.applyStyle("background-image", url ? "url('" + url + "')" : "none");
		this.updateDashboard();
		this.notify("track");
		this.startStream(startTicks || 0);
	},

	startStream: function(startTicks) {
		var self = this;
		var track = this.item;
		this.stopTimer();
		this.playing = true;
		this.paused = false;
		this.info = null;
		this.startTicks = startTicks;
		this.$.pauseButton.setCaption("Pause");
		this.showPosition(startTicks);
		var request = this.request = {};
		JF.api.playbackInfo(track, {startTicks: startTicks}, function(info) {
			if (request !== self.request || !self.playing) {
				return;
			}
			if (!info) {
				JF.log("music: the server gave no way to play " + track.Id);
				self.failed("The server could not find a way to play this track.");
				return;
			}
			self.info = info;
			self.direct = info.method === "DirectPlay";
			self.relayed = JF.relay.needed(info.url);
			JF.log("music: " + track.Name + " " + info.method);
			JF.relay.open(info.url, function(url) {
				if (request !== self.request || !self.playing) {
					return;
				}
				if (!url) {
					self.failed("Could not start the stream relay.");
					return;
				}
				var node = self.$.audio.hasNode();
				node.src = url;
				node.load();
				node.play();
				// A file starts at 0:00; a converted stream starts where we asked.
				self.pendingSeek = self.direct && startTicks ? startTicks / 10000000 : null;
				self.tellServer("/Sessions/Playing");
				self.timer = setInterval(function() { self.tick(); }, 1000);
			});
		});
	},

	// Stop the current track and tell the server how far it got.
	endTrack: function() {
		if (!this.playing) {
			return;
		}
		this.stopTimer();
		this.tellServer("/Sessions/Playing/Stopped");
		if (this.info && !this.direct) {
			JF.api.stopEncoding(this.info.playSessionId);
		}
		this.playing = false;
		this.request = null;
		var node = this.$.audio.hasNode();
		if (node) {
			try { node.pause(); } catch (e) {}
		}
	},

	// Stop and hide. Called when a video starts, too.
	stopAll: function() {
		this.endTrack();
		var node = this.$.audio.hasNode();
		if (node) {
			node.removeAttribute("src");
			try { node.load(); } catch (e) {}
		}
		this.queue = null;
		this.closeDashboard();
		this.notify("track");
		this.setShowing(false);
	},

	isActive: function() {
		return !!this.queue;
	},

	stopTimer: function() {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	},

	// ---- position --------------------------------------------------------

	positionTicks: function() {
		var node = this.$.audio.hasNode();
		var t = node && !this.pendingSeek ? node.currentTime || 0 : 0;
		if (this.pendingSeek) {
			return this.startTicks;
		}
		return Math.round((this.direct ? 0 : this.startTicks) + t * 10000000);
	},

	durationTicks: function() {
		return (this.item && this.item.RunTimeTicks) || 0;
	},

	tick: function() {
		this.ticks = (this.ticks || 0) + 1;
		var node = this.$.audio.hasNode();
		if (this.pendingSeek && node && node.readyState > 0) {
			node.currentTime = this.pendingSeek;
			this.pendingSeek = null;
		}
		if (!this.dragging) {
			this.showPosition(this.positionTicks());
		}
		this.notify("position");
		if (this.ticks % 10 === 0) {
			this.tellServer("/Sessions/Playing/Progress");
		}
		if (this.relayed && this.ticks % 30 === 0) {
			JF.relay.ping();
		}
	},

	showPosition: function(ticks) {
		var total = this.durationTicks();
		this.$.clock.setContent(JF.api.ticksToClock(ticks));
		this.$.duration.setContent(total ? JF.api.ticksToClock(total) : "");
		this.$.slider.setPosition(total ? Math.round(1000 * ticks / total) : 0);
	},

	tellServer: function(path) {
		if (!this.item || !this.info || JF.noReport) {
			return;
		}
		JF.api.post(path, {
			ItemId: this.item.Id, MediaSourceId: this.info.mediaSourceId, PlaySessionId: this.info.playSessionId,
			PositionTicks: this.positionTicks(), IsPaused: !!this.paused,
			PlayMethod: this.info.method, CanSeek: true
		});
	},

	// ---- buttons ---------------------------------------------------------

	pauseClick: function() {
		var node = this.$.audio.hasNode();
		if (!node) {
			return;
		}
		if (!this.playing) {
			// After a failed track: try it again.
			if (this.queue) {
				this.playIndex(this.index, 0);
			}
			return;
		}
		if (this.paused) {
			node.play();
		} else {
			node.pause();
		}
	},

	// Next, by hand: with repeat on one track, still move on.
	nextClick: function() {
		var next = this.index + 1 < this.queue.length ? this.index + 1 : this.repeat === "off" ? -1 : 0;
		if (next < 0) {
			this.stopAll();
		} else {
			this.playIndex(next, 0);
		}
	},

	// Back to the start of the track, or to the one before if we are near its start.
	previousClick: function() {
		if (this.positionTicks() > 50000000 || this.index === 0) {
			this.seekTo(0);
		} else {
			this.playIndex(this.index - 1, 0);
		}
	},

	closeClick: function() {
		this.stopAll();
	},

	seekTo: function(ticks) {
		var node = this.$.audio.hasNode();
		if (!node || !this.playing) {
			return;
		}
		if (!this.direct) {
			this.endTrack();
			this.startStream(ticks);
			return;
		}
		if (this.pendingSeek) {
			this.pendingSeek = ticks / 10000000 || null;
		} else {
			node.currentTime = ticks / 10000000;
		}
		this.showPosition(ticks);
	},

	sliderChanging: function(inSender, position) {
		this.dragging = true;
		this.$.clock.setContent(JF.api.ticksToClock(position / 1000 * this.durationTicks()));
	},

	sliderChange: function(inSender, position) {
		this.dragging = false;
		this.seekTo(Math.round(position / 1000 * this.durationTicks()));
	},

	// Stop on a track that will not play, and say why; Next still works.
	failed: function(text) {
		this.endTrack();
		this.$.artist.setContent(text);
		this.$.pauseButton.setCaption("Play");
		this.updateDashboard();
	},

	// ---- control from outside the app ---------------------------------------
	// HP's Music app shows its controls in the notification area while it is in
	// the background, and takes Bluetooth and headset buttons; so does this.

	// Called by the App as its window goes to the background and comes back.
	appInBackground: function(background) {
		this.background = background;
		if (background && this.queue) {
			this.openDashboard();
		} else {
			this.closeDashboard();
		}
	},

	dashboardInfo: function() {
		var track = this.item || {};
		return {
			title: track.Name || "",
			artist: track.AlbumArtist || (track.Artists || []).join(", ") || track.Album || "",
			image: JF.api.imageUrl(track, 120) || "",
			playing: !!(this.playing && !this.paused)
		};
	},

	openDashboard: function() {
		if (!this.dashboard) {
			JF.log("music: opening the dashboard");
			this.dashboard = enyo.windows.openDashboard("dashboard.html", "jfmusic", this.dashboardInfo(),
				{clickableWhenLocked: true});
		}
	},

	closeDashboard: function() {
		if (this.dashboard) {
			JF.log("music: closing the dashboard");
			try { this.dashboard.close(); } catch (e) {}
			this.dashboard = null;
		}
	},

	updateDashboard: function() {
		this.notify("state");
		var win = this.dashboard && enyo.windows.fetchWindow("jfmusic");
		if (win) {
			enyo.windows.setWindowParams(win, this.dashboardInfo());
		}
	},

	// From the dashboard, or a Bluetooth or headset button.
	command: function(name) {
		if (!this.queue) {
			return false;
		}
		if (name === "previous") {
			this.previousClick();
		} else if (name === "next") {
			this.nextClick();
		} else if (name === "playpause") {
			this.pauseClick();
		} else if (name === "pause") {
			if (this.playing && !this.paused) {
				this.pauseClick();
			}
		} else if (name === "play") {
			if (!this.playing || this.paused) {
				this.pauseClick();  // also retries a track that failed
			}
		}
		return true;
	},

	// ---- what the audio element tells us ---------------------------------

	audioEvent: function(e) {
		if (!this.playing) {
			return;
		}
		if (e.type === "playing") {
			this.paused = false;
			this.$.pauseButton.setCaption("Pause");
			this.updateDashboard();
		} else if (e.type === "pause") {
			this.paused = true;
			this.$.pauseButton.setCaption("Play");
			this.updateDashboard();
			this.tellServer("/Sessions/Playing/Progress");
		} else if (e.type === "ended") {
			var next = this.nextIndex();
			if (next < 0) {
				this.stopAll();
			} else {
				this.playIndex(next, 0);
			}
		} else if (e.type === "error") {
			var node = this.$.audio.hasNode();
			var code = node && node.error ? node.error.code : "?";
			JF.log("music: audio error " + code + " on " + this.item.Name);
			this.failed("Could not play this track (error " + code + ").");
		}
	}
});
