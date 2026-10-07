/* Plays one video, built the way the TouchPad's own Videos app builds its
 * player (metascene.videos, nowplaying-assistant.js on the device):
 *
 *  - full screen is switched on when the player opens, before the video
 *    loads, and never toggled while it plays;
 *  - the video fills the whole view and is never resized;
 *  - the controls float over the picture and are only shown and hidden.
 *
 * Our earlier player kept the video in a box between two bars and resized it
 * for full screen. On the TouchPad that left the picture updating only when
 * the page did, and full screen froze it while the sound carried on.
 *
 * What to play comes from the server: PlaybackInfo with a device profile
 * returns either the file itself or the address of a continuous MPEG-TS stream
 * it makes on the fly, starting at the time we ask for. A file is seeked by the
 * player. A made stream cannot be: seeking asks for a new stream at the new
 * time, as the Plex client resumes. (HLS was tried and dropped: the TouchPad's
 * HLS reader stalls after a jump and loses the picture or the sound.)
 */
enyo.kind({
	name: "JF.PlayerView",
	kind: enyo.VFlexBox,
	className: "jf-view jf-player",
	events: {
		onBack: ""
	},
	// How long the controls stay up after the last touch, as in Palm's player.
	controlsFor: 5000,
	components: [
		{name: "stage", flex: 1, className: "jf-stage", components: [
			{name: "video", kind: "Video", className: "jf-video", showControls: false},
			// Catches taps on the picture: shows or hides the controls.
			{name: "tapLayer", className: "jf-tap-layer", onclick: "stageClick"},
			{name: "status", className: "jf-player-status", showing: false},
			{name: "header", kind: "HFlexBox", align: "center", className: "jf-player-top", components: [
				{kind: "Button", caption: "Done", onclick: "doneClick"},
				{name: "title", content: "", flex: 1, className: "jf-player-title"},
				{name: "audioButton", kind: "Button", caption: "Audio", onclick: "audioClick"},
				{name: "subtitleButton", kind: "Button", caption: "Subtitles", onclick: "subtitleClick"}
			]},
			{name: "transport", kind: "HFlexBox", align: "center", className: "jf-transport", components: [
				{name: "pauseButton", kind: "Button", caption: "Pause", onclick: "pauseClick", className: "jf-pause"},
				{kind: "Button", caption: "− 30 s", onclick: "skipBack"},
				{kind: "Button", caption: "+ 30 s", onclick: "skipForward"},
				{name: "clock", content: "0:00", className: "jf-clock"},
				{name: "slider", kind: "Slider", flex: 1, minimum: 0, maximum: 1000, position: 0, animatePosition: false,
					onChanging: "sliderChanging", onChange: "sliderChange"},
				{name: "duration", content: "", className: "jf-clock"}
			]}
		]},
		{name: "audioMenu", kind: "PopupSelect", onSelect: "audioSelected"},
		{name: "subtitleMenu", kind: "PopupSelect", onSelect: "subtitleSelected"}
	],

	rendered: function() {
		this.inherited(arguments);
		var node = this.$.video.hasNode();
		if (node && !this.wired) {
			this.wired = true;
			// Media audio class, as HP's own video player sets it: volume keys and
			// audio routing then treat this as media.
			node.setAttribute("x-palm-media-audio-class", "media");
			var self = this;
			var names = ["loadedmetadata", "playing", "pause", "ended", "error"];
			for (var i = 0; i < names.length; i++) {
				node.addEventListener(names[i], function(e) { self.videoEvent(e); }, false);
			}
		}
	},

	// ---- starting and stopping ------------------------------------------

	// Play this item from startTicks. The item should be a full record, so
	// its audio and subtitle streams are known.
	playItem: function(item, startTicks) {
		this.item = item;
		this.audioStreams = JF.api.streams(item, "Audio");
		this.subtitleStreams = JF.api.streams(item, "Subtitle");
		this.audioIndex = this.preferredStream(this.audioStreams, localStorage.getItem("jf.audioLanguage"));
		this.chooseSubtitle(localStorage.getItem("jf.subtitles") === "on" ?
			this.preferredSubtitle(localStorage.getItem("jf.subtitleLanguage")) : -1);
		this.$.title.setContent(item.SeriesName ? item.SeriesName + " — " + item.Name : item.Name || "");
		this.$.audioButton.setShowing(this.audioStreams.length > 1);
		this.$.subtitleButton.setShowing(this.subtitleStreams.length > 0);
		// Full screen before anything plays, as Palm's player does.
		enyo.setFullScreen(true);
		enyo.windows.setWindowProperties(window, {blockScreenTimeout: true});
		this.lockRotation(true);
		this.startStream(startTicks || 0);
	},

	// Ask the server how to play the item with the current audio and subtitle
	// choice, then play it from startTicks.
	startStream: function(startTicks) {
		var self = this;
		var limit = this.item.RunTimeTicks ? this.item.RunTimeTicks - 50000000 : startTicks;
		startTicks = Math.max(0, Math.min(startTicks, Math.max(0, limit)));
		this.stopTimers();
		this.endEncoding();
		this.info = null;
		this.playing = true;
		this.paused = false;
		this.hasPlayed = false;
		this.pendingSeek = null;
		this.lastTicks = startTicks;
		// The clock for a made stream: where it starts, plus time spent playing.
		this.startTicks = startTicks;
		this.playedMs = 0;
		this.runningSince = 0;
		this.setStatus("Starting…");
		this.$.pauseButton.setCaption("Pause");
		this.showPosition(startTicks);
		this.showControls();
		var request = this.request = {};
		JF.api.playbackInfo(this.item, {audioIndex: this.audioIndex, subtitleIndex: this.subtitleIndex, startTicks: startTicks},
			function(info) {
				if (request !== self.request || !self.playing) {
					return;  // something newer was asked for meanwhile
				}
				if (!info) {
					self.setStatus("The server could not find a way to play this on the TouchPad.");
					return;
				}
				self.info = info;
				self.direct = info.method === "DirectPlay";
				// A file always starts at 0:00; move to the start once it has loaded.
				self.pendingSeek = self.direct && startTicks ? startTicks / 10000000 : null;
				JF.log("play " + self.item.Id + " " + info.method + " from " + JF.api.ticksToClock(startTicks) +
					" audio " + self.audioIndex + " subtitles " + self.subtitleIndex +
					"; server chose " + ((info.url.match(/(Audio|Subtitle)StreamIndex=-?\d+/g) || []).join(" ") || "defaults"));
				// An https stream goes through our relay service (see Relay.js).
				self.relayed = JF.relay.needed(info.url);
				JF.relay.open(info.url, function(url) {
					if (request !== self.request || !self.playing) {
						return;
					}
					if (url) {
						self.playUrl(url);
					} else {
						self.setStatus("Could not start the stream relay. Try reinstalling the app.");
					}
				});
			});
	},

	playUrl: function(url) {
		var self = this;
		this.$.video.setSrc(url);
		var node = this.$.video.hasNode();
		if (node) {
			node.play();
		}
		this.tellServer("/Sessions/Playing");
		this.timer = setInterval(function() { self.tick(); }, 1000);
	},

	setStatus: function(text) {
		this.$.status.setContent(text);
		this.$.status.setShowing(!!text);
	},

	// Where we are in the film. A file reports its own time. For a made stream
	// the TouchPad's currentTime is not reliable (it read 0 for a stream still
	// being made), so keep a clock: the stream's start plus time spent playing.
	positionTicks: function() {
		var node = this.$.video.hasNode();
		if (!this.info || !this.hasPlayed) {
			return this.lastTicks || 0;
		}
		if (this.direct) {
			if (node && this.pendingSeek === null) {
				this.lastTicks = Math.round(node.currentTime * 10000000);
			}
		} else {
			var ms = this.playedMs + (this.runningSince ? new Date().getTime() - this.runningSince : 0);
			this.lastTicks = Math.round(this.startTicks + ms * 10000);
		}
		return this.lastTicks;
	},

	clockRun: function(run) {
		var now = new Date().getTime();
		if (run && !this.runningSince) {
			this.runningSince = now;
		} else if (!run && this.runningSince) {
			this.playedMs += now - this.runningSince;
			this.runningSince = 0;
		}
	},

	// Ask the server to stop making the stream we were reading.
	endEncoding: function() {
		if (this.info && !this.direct) {
			JF.api.stopEncoding(this.info.playSessionId);
		}
	},

	durationTicks: function() {
		var node = this.$.video.hasNode();
		if (this.direct && node && node.duration > 0 && isFinite(node.duration)) {
			return Math.round(node.duration * 10000000);
		}
		return this.item.RunTimeTicks || 0;
	},

	// Once a second: keep the time display current while the controls are up,
	// and report progress to the server every ten seconds.
	tick: function() {
		this.ticks = (this.ticks || 0) + 1;
		if (this.controlsUp && !this.dragging) {
			this.showPosition(this.positionTicks());
		}
		if (this.ticks % 10 === 0) {
			this.tellServer("/Sessions/Playing/Progress");
		}
		// Keep the relay service running; it stops 120 s after its last call.
		if (this.relayed && this.ticks % 30 === 0) {
			JF.relay.ping();
		}
	},

	showPosition: function(ticks) {
		var total = this.durationTicks();
		this.$.clock.setContent(JF.api.ticksToClock(ticks));
		this.$.duration.setContent(total ? JF.api.ticksToClock(total) : "");
		if (total) {
			this.$.slider.setPosition(Math.round(1000 * ticks / total));
		}
	},

	// Keep the server's record of where we are up to date. Test launches from
	// a PC set JF.noReport so they do not touch the user's watch history.
	tellServer: function(path) {
		if (!this.item || !this.info || JF.noReport) {
			return;
		}
		JF.api.post(path, {
			ItemId: this.item.Id, MediaSourceId: this.info.mediaSourceId, PlaySessionId: this.info.playSessionId,
			PositionTicks: this.positionTicks(), IsPaused: !!this.paused,
			PlayMethod: this.info.method, CanSeek: true,
			AudioStreamIndex: this.audioIndex, SubtitleStreamIndex: this.subtitleIndex
		});
	},

	stopTimers: function() {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
		this.clearControlsTimer();
	},

	// Stop the video and tell the server where we got to.
	stopStream: function() {
		if (!this.playing) {
			return;
		}
		this.positionTicks();
		this.clockRun(false);
		this.stopTimers();
		this.tellServer("/Sessions/Playing/Stopped");
		this.endEncoding();
		this.playing = false;
		this.request = null;
		this.info = null;
		var node = this.$.video.hasNode();
		if (node) {
			try { node.pause(); } catch (e) {}
		}
		this.$.video.setSrc("");
		enyo.windows.setWindowProperties(window, {blockScreenTimeout: false});
		this.lockRotation(false);
		enyo.setFullScreen(false);
	},

	// Hold the screen in the video's orientation while it plays, as HP's video
	// player does: turning the tablet would resize the page under the picture.
	lockRotation: function(on) {
		if (!window.PalmSystem) {
			return;
		}
		enyo.setAllowedOrientation(on ? (window.PalmSystem.videoOrientation || "up") : "free");
	},

	// ---- the controls over the picture -------------------------------------

	showControls: function() {
		this.controlsUp = true;
		this.$.header.setShowing(true);
		this.$.transport.setShowing(true);
		if (this.playing) {
			this.showPosition(this.positionTicks());
		}
		this.restartControlsTimer();
	},

	// Hidden after a while, except when paused or while the slider is held.
	hideControls: function() {
		if (this.paused || this.dragging) {
			this.restartControlsTimer();
			return;
		}
		this.controlsUp = false;
		this.$.header.setShowing(false);
		this.$.transport.setShowing(false);
	},

	restartControlsTimer: function() {
		var self = this;
		this.clearControlsTimer();
		this.controlsTimer = setTimeout(function() { self.hideControls(); }, this.controlsFor);
	},

	clearControlsTimer: function() {
		if (this.controlsTimer) {
			clearTimeout(this.controlsTimer);
			this.controlsTimer = null;
		}
	},

	stageClick: function() {
		if (this.controlsUp) {
			this.controlsUp = false;
			this.clearControlsTimer();
			this.$.header.setShowing(false);
			this.$.transport.setShowing(false);
		} else {
			this.showControls();
		}
	},

	// ---- transport ---------------------------------------------------------

	doneClick: function() {
		this.stopStream();
		this.doBack();
	},

	pauseClick: function() {
		var node = this.$.video.hasNode();
		if (!node || !this.playing) {
			return;
		}
		if (this.paused) {
			node.play();
		} else {
			node.pause();
		}
		this.showControls();
	},

	seekTo: function(ticks) {
		var node = this.$.video.hasNode();
		if (!node || !this.playing) {
			return;
		}
		var total = this.durationTicks();
		ticks = Math.max(0, total ? Math.min(ticks, total - 50000000) : ticks);
		if (!this.direct) {
			// A made stream: ask for a new one that starts there.
			this.tellServer("/Sessions/Playing/Stopped");
			this.startStream(ticks);
			return;
		}
		this.lastTicks = ticks;
		if (this.hasPlayed) {
			node.currentTime = ticks / 10000000;
		} else {
			this.pendingSeek = ticks / 10000000;  // applied once the video has loaded
		}
		this.showPosition(ticks);
		this.showControls();
		this.tellServer("/Sessions/Playing/Progress");
	},
	skipBack: function() { this.seekTo(this.positionTicks() - 300000000); },
	skipForward: function() { this.seekTo(this.positionTicks() + 300000000); },

	sliderChanging: function(inSender, position) {
		this.dragging = true;
		this.$.clock.setContent(JF.api.ticksToClock(position / 1000 * this.durationTicks()));
	},

	sliderChange: function(inSender, position) {
		this.dragging = false;
		this.seekTo(Math.round(position / 1000 * this.durationTicks()));
	},

	// ---- audio and subtitles -----------------------------------------------

	preferredStream: function(streams, language) {
		if (language) {
			for (var i = 0; i < streams.length; i++) {
				if (streams[i].language === language) {
					return streams[i].index;
				}
			}
		}
		return null;  // let the server pick its default
	},

	// Prefer full subtitles over the signs-and-songs tracks anime releases carry.
	preferredSubtitle: function(language) {
		var first = -1;
		for (var i = 0; i < this.subtitleStreams.length; i++) {
			var s = this.subtitleStreams[i];
			if (language && s.language !== language) {
				continue;
			}
			if (first < 0) {
				first = s.index;
			}
			if (!/sign|song/i.test(s.title)) {
				return s.index;
			}
		}
		return first;
	},

	menuItems: function(streams, current, withOff) {
		// MenuCheckItem draws its tick from an image: the TouchPad font has no ✓.
		var items = withOff ? [{kind: "MenuCheckItem", caption: "Off", value: -1, checked: current < 0}] : [];
		for (var i = 0; i < streams.length; i++) {
			var on = streams[i].index === current || (current === null && streams[i].isDefault);
			items.push({kind: "MenuCheckItem", caption: streams[i].title, value: streams[i].index, checked: on});
		}
		return items;
	},

	audioClick: function() {
		this.clearControlsTimer();
		this.$.audioMenu.setItems(this.menuItems(this.audioStreams, this.audioIndex, false));
		this.$.audioMenu.openAroundControl(this.$.audioButton);
	},

	subtitleClick: function() {
		this.clearControlsTimer();
		this.$.subtitleMenu.setItems(this.menuItems(this.subtitleStreams, this.subtitleIndex, true));
		this.$.subtitleMenu.openAroundControl(this.$.subtitleButton);
	},

	streamByIndex: function(streams, index) {
		for (var i = 0; i < streams.length; i++) {
			if (streams[i].index === index) {
				return streams[i];
			}
		}
		return null;
	},

	// A different audio track or burned-in subtitle needs a new stream from the
	// server; it picks up where we are.
	restartHere: function() {
		var here = this.positionTicks();
		this.tellServer("/Sessions/Playing/Stopped");
		this.startStream(here);
	},

	audioSelected: function(inSender, inItem) {
		var index = inItem.getValue();
		var stream = this.streamByIndex(this.audioStreams, index);
		// Remember the language, so the next thing played picks the same one.
		if (stream && stream.language) {
			localStorage.setItem("jf.audioLanguage", stream.language);
		}
		if (index !== this.audioIndex) {
			this.audioIndex = index;
			this.restartHere();
		} else {
			this.restartControlsTimer();
		}
	},

	subtitleSelected: function(inSender, inItem) {
		var index = inItem.getValue();
		var stream = this.streamByIndex(this.subtitleStreams, index);
		var wasBurned = this.burnIndex;
		localStorage.setItem("jf.subtitles", index >= 0 ? "on" : "off");
		if (stream && stream.language) {
			localStorage.setItem("jf.subtitleLanguage", stream.language);
		}
		this.chooseSubtitle(index);
		if (this.burnIndex !== wasBurned) {
			this.restartHere();
		} else {
			this.restartControlsTimer();
		}
	},

	// The server draws the chosen subtitles into the picture. Drawing them in
	// the app was tried first: any text laid over the video made the TouchPad
	// redraw the picture through the web page, and playback fell from 24
	// frames a second to about 5.
	chooseSubtitle: function(index) {
		var stream = this.streamByIndex(this.subtitleStreams, index);
		this.subtitleIndex = stream ? index : -1;
		this.burnIndex = stream ? index : null;
	},

	// ---- what the video element tells us ----------------------------------

	videoEvent: function(e) {
		var node = this.$.video.hasNode();
		if (!this.playing || !node) {
			return;
		}
		JF.log("video " + e.type);
		if (e.type === "error") {
			var code = node.error ? node.error.code : "?";
			JF.log("video error code " + code);
			if (this.hasPlayed) {
				// It was working: the connection dropped, often after a long pause.
				this.setStatus("Reconnecting…");
				this.startStream(this.positionTicks());
			} else {
				this.setStatus("The TouchPad could not play this video (error " + code + ").");
				this.stopTimers();
			}
			return;
		}
		if (e.type === "loadedmetadata") {
			if (this.pendingSeek) {
				node.currentTime = this.pendingSeek;
			}
			this.pendingSeek = null;
			this.hasPlayed = true;
		} else if (e.type === "playing") {
			this.paused = false;
			this.clockRun(true);
			this.$.pauseButton.setCaption("Pause");
			this.setStatus("");
		} else if (e.type === "pause") {
			this.paused = true;
			this.clockRun(false);
			this.$.pauseButton.setCaption("Play");
			this.tellServer("/Sessions/Playing/Progress");
		} else if (e.type === "ended") {
			this.finished();
		}
	},

	// The video ran to its end: go on to the next episode if there is one.
	finished: function() {
		var self = this;
		var item = this.item;
		this.stopStream();
		if (item.Type !== "Episode") {
			this.doBack();
			return;
		}
		this.setStatus("Looking for the next episode…");
		JF.api.nextEpisode(item, function(next) {
			if (!next) {
				self.setStatus("");
				self.doBack();
				return;
			}
			JF.api.item(next.Id, function(ok, full) {
				self.playItem(ok && full ? full : next, 0);
			});
		});
	}
});
