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
	components: [
		{name: "art", className: "jf-np-art"},
		{flex: 1, className: "jf-np-text", components: [
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

	// Play these tracks, starting with tracks[index].
	playTracks: function(tracks, index) {
		this.queue = tracks.slice(0);
		this.setShowing(true);
		this.playIndex(index || 0, 0);
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

	nextClick: function() {
		this.playIndex(this.index + 1, 0);
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
	},

	// ---- what the audio element tells us ---------------------------------

	audioEvent: function(e) {
		if (!this.playing) {
			return;
		}
		if (e.type === "playing") {
			this.paused = false;
			this.$.pauseButton.setCaption("Pause");
		} else if (e.type === "pause") {
			this.paused = true;
			this.$.pauseButton.setCaption("Play");
			this.tellServer("/Sessions/Playing/Progress");
		} else if (e.type === "ended") {
			this.playIndex(this.index + 1, 0);
		} else if (e.type === "error") {
			var node = this.$.audio.hasNode();
			var code = node && node.error ? node.error.code : "?";
			JF.log("music: audio error " + code + " on " + this.item.Name);
			this.failed("Could not play this track (error " + code + ").");
		}
	}
});
