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
// How long after a video says it is playing its decoder is given to show it is.
JF.DECODER_WAIT = 6000;

// Plain SRT, including the version returned by Emby for embedded text tracks.
JF.parseSrt = function(text) {
	var cues = [];
	if (!text || text.length > 2000000) return cues;
	var blocks = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split(/\n[ \t]*\n+/);
	var stamp = "(\\d+):(\\d{2}):(\\d{2})[,.](\\d{3})";
	var timestamps = new RegExp("^\\s*" + stamp + "\\s+-->\\s+" + stamp + "(?:\\s|$)");
	var seconds = function(match, i) {
		return +match[i] * 3600 + +match[i + 1] * 60 + +match[i + 2] + +match[i + 3] / 1000;
	};
	for (var i = 0; i < blocks.length; i++) {
		var lines = blocks[i].split("\n");
		if (/^\s*\d+\s*$/.test(lines[0])) lines.shift();
		var m = timestamps.exec(lines.shift() || "");
		if (!m || !lines.length) continue;
		var start = seconds(m, 1), end = seconds(m, 5);
		var caption = lines.join("\n").replace(/<\/?(?:i|b|u|s|font)\b[^>]*>/gi, "").replace(/^\s+|\s+$/g, "");
		if (end > start && caption) cues.push({start: start, end: end, text: caption});
	}
	cues.sort(function(a, b) { return a.start - b.start; });
	var through = 0;
	for (var j = 0; j < cues.length; j++) {
		through = cues[j].through = Math.max(through, cues[j].end);
	}
	return cues;
};

JF.subtitleAt = function(cues, time) {
	var lo = 0, hi = cues.length;
	while (lo < hi) {
		var mid = (lo + hi) >> 1;
		if (cues[mid].start <= time) lo = mid + 1;
		else hi = mid;
	}
	var lines = [];
	for (var i = lo - 1; i >= 0 && cues[i].through > time; i--) {
		if (cues[i].end > time) lines.push(cues[i].text);
	}
	return lines.reverse().join("\n");
};

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
			{name: "subtitleOverlay", className: "jf-subtitle-overlay", showing: false, components: [
				{name: "subtitleText", className: "jf-subtitle-text"}
			]},
			// Catches taps on the picture: shows or hides the controls.
			{name: "tapLayer", className: "jf-tap-layer", onclick: "stageClick",
				ondragstart: "stageDragStart", ondrag: "stageDrag", ondragfinish: "stageDragFinish"},
			{name: "header", kind: "HFlexBox", align: "center", className: "jf-player-top", components: [
				{kind: "Button", caption: "Done", onclick: "doneClick", className: "jf-player-back"},
				{name: "title", content: "", flex: 1, className: "jf-player-title"},
				{name: "routeStatus", className: "jf-player-route", showing: false},
				{kind: "HFlexBox", align: "center", className: "jf-player-quick", components: [
					{name: "audioButton", kind: "Button", caption: "Audio", onclick: "audioClick", showing: false,
						className: "jf-player-symbol jf-symbol-audio", attributes: {"aria-label": "Audio track"}},
					{name: "subtitleButton", kind: "Button", caption: "Subtitles", onclick: "subtitleClick", showing: false,
						className: "jf-player-symbol jf-symbol-subtitles", attributes: {"aria-label": "Subtitles"}},
					{name: "moreButton", kind: "Button", caption: "More", onclick: "openMore",
						className: "jf-player-symbol jf-symbol-more", attributes: {"aria-label": "Playback settings", "aria-expanded": "false"}}
				]}
			]},
			{name: "statusPane", className: "jf-player-feedback", components: [
				{name: "status", className: "jf-player-status", showing: false, attributes: {"role": "status"}},
				{name: "retryButton", kind: "Button", caption: "Retry", showing: false, onclick: "retryClick",
					className: "jf-player-retry"}
			]},
			{name: "transport", className: "jf-transport", components: [
				// The contextual action stays near the timeline without taking its width.
				{name: "skipButton", kind: "Button", caption: "Skip Intro", showing: false, onclick: "skipClick",
					className: "jf-player-skip"},
				{kind: "HFlexBox", align: "center", className: "jf-player-timeline", components: [
					{name: "clock", content: "0:00", className: "jf-clock jf-elapsed"},
					{name: "seekTrack", flex: 1, className: "jf-seek-track", components: [
						{name: "seekFill", className: "jf-seek-fill"},
						{name: "loopRange", className: "jf-loop-range", showing: false},
						{name: "slider", kind: "Slider", minimum: 0, maximum: 1000, position: 0, animatePosition: false,
							onChanging: "sliderChanging", onChange: "sliderChange"},
						{name: "seekPreview", className: "jf-seek-preview", showing: false}
					]},
					{name: "duration", content: "", className: "jf-clock jf-runtime"}
				]},
				{className: "jf-player-command-row", components: [
					{kind: "Button", caption: "Lock", onclick: "lockClick", className: "jf-player-lock jf-player-symbol jf-symbol-lock",
						attributes: {"aria-label": "Lock playback controls"}},
					{kind: "HFlexBox", align: "center", pack: "center", className: "jf-player-primary", components: [
						{kind: "Button", caption: "−30 s", onclick: "skipBack", className: "jf-player-symbol jf-symbol-rewind",
							attributes: {"aria-label": "Back 30 seconds"}},
						{name: "pauseButton", kind: "Button", caption: "Pause", onclick: "pauseClick", className: "jf-pause jf-player-symbol"},
						{kind: "Button", caption: "+30 s", onclick: "skipForward", className: "jf-player-symbol jf-symbol-forward",
							attributes: {"aria-label": "Forward 30 seconds"}}
					]}
				]}
			]},
			{name: "unlockButton", kind: "Button", caption: "Unlock", onclick: "unlockClick",
				className: "jf-player-unlock jf-player-symbol jf-symbol-unlock", showing: false,
				attributes: {"aria-label": "Unlock playback controls"}},
			{name: "moreScrim", className: "jf-player-more-scrim", showing: false, onclick: "closeMore"},
			{name: "morePanel", className: "jf-player-more-panel", showing: false,
				attributes: {"role": "region", "aria-label": "Playback settings"}, components: [
				{kind: "HFlexBox", align: "center", className: "jf-player-panel-heading", components: [
					{name: "panelHeading", content: "Playback settings", flex: 1},
					{kind: "Button", caption: "Close", onclick: "closeMore"}
				]},
				{name: "playbackSection", className: "jf-player-panel-section", components: [
					{name: "moreRoute", className: "jf-player-panel-route"},
					{name: "moreSource", className: "jf-player-panel-meta", showing: false},
					{name: "routeActions", kind: "HFlexBox", className: "jf-player-panel-actions", showing: false, components: [
						{name: "autoRoute", kind: "Button", caption: "Auto", onclick: "chooseAuto", flex: 1},
						{name: "miniRoute", kind: "Button", caption: "LAN bridge", onclick: "chooseMini", flex: 1}
					]}
				]},
				{name: "loopSection", className: "jf-player-panel-section", showing: false, components: [
					{content: "A–B repeat", className: "jf-player-panel-label"},
					{name: "loopLabel", className: "jf-player-panel-meta"},
					{kind: "HFlexBox", className: "jf-player-panel-actions", components: [
						{kind: "Button", caption: "Set A", onclick: "markLoopStart", flex: 1},
						{name: "setLoopEnd", kind: "Button", caption: "Set B", onclick: "markLoopEnd", flex: 1, disabled: true},
						{name: "clearLoopButton", kind: "Button", caption: "Clear", onclick: "clearLoopClick", flex: 1, disabled: true}
					]}
				]},
				{name: "trackSection", className: "jf-player-panel-section", showing: false, components: [
					{name: "trackStatus", className: "jf-player-panel-meta jf-track-status", attributes: {"role": "status"}},
					{name: "trackList", className: "jf-track-list"}
				]},
				{name: "subtitleOptions", className: "jf-player-panel-section", showing: false, components: [
					{content: "Text size", className: "jf-player-panel-label"},
					{kind: "HFlexBox", className: "jf-player-panel-actions", components: [
						{name: "subSmall", kind: "Button", caption: "Small", option: "small", onclick: "subtitleSizeClick", flex: 1},
						{name: "subMedium", kind: "Button", caption: "Medium", option: "medium", onclick: "subtitleSizeClick", flex: 1},
						{name: "subLarge", kind: "Button", caption: "Large", option: "large", onclick: "subtitleSizeClick", flex: 1}
					]},
					{content: "Background opacity", className: "jf-player-panel-label jf-subtitle-setting-label"},
					{name: "subtitleBackgrounds", kind: "HFlexBox", className: "jf-player-panel-actions jf-subtitle-backgrounds",
						attributes: {"role": "group", "aria-label": "Subtitle background opacity"}, components: [
							{kind: "Button", caption: "None", option: "0", onclick: "subtitleBackgroundClick", flex: 1},
							{kind: "Button", caption: "25%", option: "25", onclick: "subtitleBackgroundClick", flex: 1},
							{kind: "Button", caption: "50%", option: "50", onclick: "subtitleBackgroundClick", flex: 1},
							{kind: "Button", caption: "90%", option: "90", onclick: "subtitleBackgroundClick", flex: 1}
						]},
					{name: "subtitleOffsetLabel", className: "jf-player-panel-label jf-subtitle-setting-label"},
					{kind: "HFlexBox", className: "jf-player-panel-actions", components: [
						{kind: "Button", caption: "Earlier", delta: -250, onclick: "subtitleOffsetClick", flex: 1,
							attributes: {"aria-label": "Show subtitles 250 milliseconds earlier"}},
						{kind: "Button", caption: "Later", delta: 250, onclick: "subtitleOffsetClick", flex: 1,
							attributes: {"aria-label": "Show subtitles 250 milliseconds later"}},
						{kind: "Button", caption: "Reset", delta: 0, onclick: "subtitleOffsetClick", flex: 1}
					]}
				]}
			]}
		]}
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
			var names = ["loadedmetadata", "playing", "waiting", "pause", "ended", "error"];
			for (var i = 0; i < names.length; i++) {
				node.addEventListener(names[i], function(e) { self.videoEvent(e); }, false);
			}
			node.addEventListener("timeupdate", function() {
				self.checkLoop();
				if (self.subtitleCues && self.subtitleCues.length) self.renderSubtitle();
				if (self.audioSwitch) self.confirmAudioSwitch();
			}, false);
			node.addEventListener("seeking", function() {
				if (self.subtitleCues && self.subtitleCues.length) self.showSubtitle("");
			}, false);
			node.addEventListener("seeked", function() {
				if (self.subtitleCues && self.subtitleCues.length) self.renderSubtitle();
			}, false);
		}
	},

	// ---- starting and stopping ------------------------------------------

	// Play this item from startTicks. The item should be a full record, so
	// its audio and subtitle streams are known.
	playItem: function(item, startTicks, routePlan) {
		this.item = item;
		this.localOnly = false;
		this.networkPlayback = null;
		this.networkTranscode = false;
		this.localUrl = "";
		this.routePlan = routePlan || null;
		this.playbackMode = this.routePlan && this.routePlan.forceMac ? "mini" : "auto";
		this.playbackChoice = null;
		var source = this.routePlan && this.routePlan.source;
		var trackSource = source && source.MediaStreams ? source : item;
		this.audioStreams = JF.api.streams(trackSource, "Audio");
		this.subtitleStreams = JF.api.streams(trackSource, "Subtitle");
		var tracks = JF.api.defaultTracks(trackSource);
		this.audioIndex = tracks.audioIndex;
		this.audioSwitch = null;
		this.audioNotice = "";
		this.$.title.setContent(item.SeriesName ? item.SeriesName + " — " + item.Name : item.Name || "");
		// A download plays from the tablet; its tracks were fixed when it was made.
		this.localFile = JF.downloads ? JF.downloads.localFile(item.Id) : null;
		if (this.localFile) {
			this.routePlan = null;
		}
		this.clearTextSubtitle();
		this.subtitleOffsetMs = 0;
		this.subtitleSize = localStorage.getItem("jf.subtitleSize") || "medium";
		this.applySubtitleSize();
		this.applySubtitleBackground(localStorage.getItem("jf.subtitleBackground"));
		this.chooseSubtitle(this.localFile ? -1 : tracks.subtitleIndex);
		this.setRetryShowing(false);
		this.$.audioButton.setShowing(!this.localFile && this.audioStreams.length > 0);
		this.$.subtitleButton.setShowing(!this.localFile && this.subtitleStreams.length > 0);
		// Full screen before anything plays, as Palm's player does.
		enyo.setFullScreen(true);
		this.keepScreenOn(true);
		this.lockRotation(true);
		// Find the intro and credits first: a stream that starts inside the intro
		// can then be asked for from the intro's end, instead of started twice.
		var self = this;
		var request = this.request = {};
		this.playing = true;
		this.triedAgain = false;
		this.skipped = {};
		this.setSegment(null);
		this.setStatus("Starting…");
		this.loadSegments(item, function() {
			if (request === self.request) {
				self.startStream(self.pastIntro(startTicks || 0));
			}
		});
	},

	// A companion app can supply a validated loopback relay without making it
	// look like an Emby library item. It deliberately has no reporting, stream
	// selection or server-made-transcode path.
	playLocalUrl: function(url, title, subtitles, network) {
		url = JF.localVideoUrl ? JF.localVideoUrl(url) : "";
		if (!url && !network) {
			this.setStatus("Invalid local video address.");
			return false;
		}
		this.item = null;
		this.localOnly = true;
		this.localUrl = url;
		this.networkPlayback = network || null;
		this.networkTranscode = !!(network && !network.direct);
		this.networkChecked = false;
		this.routePlan = null;
		this.playbackMode = "auto";
		this.playbackChoice = null;
		this.localFile = null;
		this.audioStreams = [];
		this.subtitleStreams = subtitles || [];
		this.audioIndex = null;
		this.audioSwitch = null;
		this.subtitleIndex = -1;
		this.burnIndex = null;
		this.clearTextSubtitle();
		this.subtitleOffsetMs = 0;
		this.subtitleSize = localStorage.getItem("jf.subtitleSize") || "medium";
		this.applySubtitleSize();
		this.applySubtitleBackground(localStorage.getItem("jf.subtitleBackground"));
		this.$.title.setContent(title || "Local video");
		this.$.audioButton.setShowing(false);
		this.$.subtitleButton.setShowing(this.subtitleStreams.length > 0);
		this.setRetryShowing(false);
		enyo.setFullScreen(true);
		this.keepScreenOn(true);
		this.lockRotation(true);
		this.playing = true;
		this.triedAgain = false;
		this.skipped = {};
		this.segments = [];
		this.setSegment(null);
		this.setStatus("Starting…");
		this.startStream(0);
		return true;
	},

	// ---- intros and credits ---------------------------------------------------

	// A download carries its own; otherwise ask the server, but do not hold the
	// video up for it: after three seconds playback starts without.
	loadSegments: function(item, callback) {
		var self = this;
		var entry = JF.downloads ? JF.downloads.get(item.Id) : null;
		this.segments = entry && entry.segments ? entry.segments : [];
		if (this.segments.length || JF.api.skipMode() === "off") {
			callback();
			return;
		}
		var waiting = true;
		var go = function() {
			if (waiting) {
				waiting = false;
				clearTimeout(timer);
				callback();
			}
		};
		var timer = setTimeout(go, 3000);
		JF.api.segments(item.Id, function(list) {
			if (self.item === item) {
				self.segments = list;
				// A download made before the app kept these.
				if (entry && list.length) {
					entry.segments = list;
					JF.downloads.save();
				}
			}
			go();
		});
	},

	// The intro or credits at this time, unless they are all but over.
	segmentAt: function(ticks) {
		var list = this.segments || [];
		for (var i = 0; i < list.length; i++) {
			if (ticks >= list[i].StartTicks && ticks < list[i].EndTicks - 30000000) {
				return list[i];
			}
		}
		return null;
	},

	// Do the credits run to the end (within ten seconds of it)?
	runsToEnd: function(segment) {
		var total = this.durationTicks();
		return !!total && segment.EndTicks >= total - 100000000;
	},

	// Where to start when asked to start at ticks: after the intro, if that is
	// where ticks falls and intros are skipped automatically.
	pastIntro: function(ticks) {
		var segment = JF.api.skipMode() === "auto" ? this.segmentAt(ticks) : null;
		if (!segment || this.runsToEnd(segment)) {
			return ticks;
		}
		this.skipped[segment.Id] = true;
		JF.log("starting after the " + segment.Type + " at " + JF.api.ticksToClock(segment.EndTicks));
		return segment.EndTicks;
	},

	setSegment: function(segment) {
		this.segment = segment;
		if (segment) {
			this.$.skipButton.setCaption(segment.Type === "Intro" ? "Skip Intro" : "Skip Credits");
		}
		this.$.skipButton.setShowing(!!segment);
	},

	// Once a second while playing. Each intro or credits is skipped by itself
	// once: after going back into one, there is the button.
	checkSegment: function() {
		if (this.localOnly || !this.info || !this.wasShowing || this.paused || this.dragging) {
			return;
		}
		var mode = JF.api.skipMode();
		if (mode === "off") {
			return;
		}
		var segment = this.segmentAt(this.positionTicks());
		if (segment === this.segment) {
			return;
		}
		this.setSegment(segment);
		if (!segment) {
			return;
		}
		// A film's credits are left to the button: a scene may follow them.
		var auto = mode === "auto" && !this.skipped[segment.Id] &&
			!(this.runsToEnd(segment) && this.item.Type !== "Episode");
		if (auto) {
			this.skipSegment(segment);
		} else {
			this.showControls();
		}
	},

	skipClick: function() {
		if (this.segment) {
			this.skipSegment(this.segment);
		}
	},

	skipSegment: function(segment) {
		this.skipped[segment.Id] = true;
		this.setSegment(null);
		JF.log("skipping the " + segment.Type + " to " + JF.api.ticksToClock(segment.EndTicks));
		if (this.runsToEnd(segment)) {
			// Nothing after the credits: this is the end, and the server hears it
			// as watched to the end, so the next episode comes up next.
			this.reportTicks = this.durationTicks();
			this.finished();
		} else {
			this.seekTo(segment.EndTicks);
		}
	},

	// Ask the server how to play the item with the current audio and subtitle
	// choice, then play it from startTicks.
	startStream: function(startTicks) {
		var self = this;
		if (this.networkPlayback) this.playbackChoice = null;
		var limit = this.item && this.item.RunTimeTicks ? this.item.RunTimeTicks - 50000000 : startTicks;
		startTicks = Math.max(0, Math.min(startTicks, Math.max(0, limit)));
		if (this.cancelMiniWarm) this.cancelMiniWarm();
		this.cancelMiniWarm = null;
		this.stopTimers();
		this.endEncoding();
		// Release the bridge's single FFmpeg slot before seeking or selecting audio.
		if (this.info && this.info.method === "MacMini") {
			this.waitingForRoute = true;
			this.$.video.setSrc("");
		}
		this.info = null;
		this.playing = true;
		this.paused = false;
		this.byHand = false;
		this.interrupted = false;
		this.wentAway = false;
		this.hasPlayed = false;
		this.wasShowing = false;
		this.buffering = false;
		this.clearSeekPreview();
		this.resetLoop();
		this.setMoreOpen(false);
		this.pendingSeek = null;
		this.showSubtitle("");
		this.lastTicks = startTicks;
		this.waitingForRoute = true;
		// The clock for a made stream: where it starts, plus time spent playing.
		this.startTicks = startTicks;
		this.playedMs = 0;
		this.runningSince = 0;
		this.setRetryShowing(false);
		this.setStatus(this.audioSwitch ? this.audioNotice : "Starting…");
		this.setPauseButton(false);
		this.showPosition(startTicks);
		this.showControls();
		var request = this.request = {};
		if (this.localOnly) {
			this.startLocalStream(startTicks, request);
			return;
		}
		if (this.routePlan && !this.localFile) {
			this.startPlannedStream(startTicks, request);
			return;
		}
		this.findStream(startTicks, function(info) {
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

	startLocalStream: function(startTicks, request) {
		if (this.networkPlayback) {
			var self = this, route = this.networkPlayback, convert = this.networkTranscode;
			var seconds = Math.floor(startTicks / 10000) / 1000;
			var url = convert ? route.transcode + "?startSeconds=" + seconds + "&format=ts" : route.direct;
			this.info = {method: convert ? "MacMini" : "DirectPlay", localBridge: true, elapsedClock: convert};
			this.direct = !convert;
			this.pendingSeek = this.direct && seconds ? seconds : null;
			this.relayed = JF.relay.needed(url);
			if (convert) this.setStatus("Preparing a LAN bridge stream…");
			JF.relay.open(url, function(localUrl) {
				if (request !== self.request || !self.playing) return;
				if (localUrl) self.playUrl(convert ? localUrl : localUrl + "/video.mp4");
				else self.showRetry("Could not open the stream. Please try again.");
			});
			return;
		}
		if (!this.localUrl) {
			this.setStatus("Invalid local video address.");
			return;
		}
		this.info = {method: "DirectPlay", mediaSourceId: "local", localBridge: true};
		this.direct = true;
		this.pendingSeek = startTicks ? startTicks / 10000000 : null;
		this.relayed = false;
		if (request === this.request && this.playing) {
			this.playUrl(this.localUrl);
		}
	},

	// The settings dialog deliberately uses the same route decision as the
	// system player. Its private remote URL only ever enters the relay service.
	startPlannedStream: function(startTicks, request) {
		var self = this;
		var plan = this.routePlan;
		// Older callers constructed a route plan directly, before the in-player
		// session mode existed. Preserve their forceMac request until playItem
		// initializes a deliberate Auto or Mini choice.
		var forceMac = this.playbackMode === "mini" ||
			(this.playbackMode !== "auto" && !!(plan && plan.forceMac));
		var requestedAudio = this.audioIndex;
		if (plan && JF.audioNeedsRemux(plan.source, requestedAudio)) {
			if (this.canChooseMacMini()) forceMac = true;
			else if (!forceMac) requestedAudio = null;
		}
		var route = plan && plan.source ? JF.videoRoute(this.item, plan.source, startTicks,
			requestedAudio, forceMac) : null;
		if (!route) {
			this.showRetry("This format needs the LAN media bridge. Configure it or choose another source.");
			return;
		}
		if (route.audioIndex !== undefined && route.audioIndex !== null) this.audioIndex = route.audioIndex;
		this.info = {method: route.direct ? "DirectPlay" : "MacMini", mediaSourceId: route.mediaSourceId,
			localBridge: true};
		this.direct = route.direct;
		if (!route.direct) this.startTicks = route.startSeconds * 10000000;
		// A direct MP4 is a file and can seek after metadata; a Mini stream starts
		// at startTicks and must never be presented to the video tag as seekable.
		this.pendingSeek = route.direct && route.startSeconds ? route.startSeconds : null;
		this.relayed = JF.relay.needed(route.url);
		if (route.warm) this.setStatus("Preparing a converted stream…");
		this.cancelMiniWarm = JF.openVideoRoute(route, function(url, error) {
			if (request !== self.request || !self.playing) {
				return;
			}
			if (url) {
				self.playUrl(route.direct ? url : url + "/video.mp4");
			} else {
				self.showRetry(route.warm ? JF.videoRouteError(error) : "Could not start playback. Please try again.");
			}
		});
	},

	playUrl: function(url) {
		var self = this;
		this.waitingForRoute = false;
		this.clearSeekPreview();
		this.$.video.setSrc(url);
		this.updateRouteStatus();
		var node = this.$.video.hasNode();
		if (node) {
			node.play();
		}
		this.tellServer("/Sessions/Playing");
		this.timer = setInterval(function() { self.tick(); }, 1000);
	},

	// How to play the item: its download if there is one, else ask the server.
	findStream: function(startTicks, callback) {
		if (this.localFile) {
			callback({method: "DirectPlay", url: "file://" + this.localFile, mediaSourceId: this.item.Id,
				playSessionId: "local" + new Date().getTime().toString(16)});
			return;
		}
		JF.api.playbackInfo(this.item, {audioIndex: this.audioIndex, subtitleIndex: this.subtitleIndex,
			startTicks: startTicks}, callback);
	},

	setStatus: function(text) {
		this.$.status.setContent(text);
		this.$.status.setShowing(!!text);
	},

	// ---- route and decoder choices ------------------------------------------

	setRetryShowing: function(show) {
		if (this.$.retryButton) {
			this.$.retryButton.setShowing(!!show);
		}
	},

	showRetry: function(message) {
		if (this.audioSwitch && this.restoreAudioTrack()) return;
		this.waitingForRoute = false;
		if (this.controlsLocked) this.setControlsLocked(false);
		if (this.moreOpen) this.setMoreOpen(false);
		this.setStatus(message);
		this.setRetryShowing(true);
		this.showControls();
		this.clearControlsTimer();
	},

	canChooseMacMini: function() {
		return !!(this.routePlan && this.routePlan.source && JF.miniProbeConfigured &&
			JF.miniProbeConfigured());
	},

	canChooseNetworkRoute: function() {
		var route = this.networkPlayback;
		return !!(route && route.direct && (route.transcode || (route.source && route.path)));
	},

	codecCaption: function(codec) {
		codec = String(codec || "").toLowerCase();
		if (codec === "h264" || codec === "avc") return "H.264";
		if (codec === "hevc" || codec === "h265") return "HEVC";
		if (codec === "av1") return "AV1";
		if (codec === "mpeg4") return "MPEG-4";
		return codec ? codec.toUpperCase() : "Unknown video";
	},

	selectedSourceAudio: function(source) {
		var streams = source && source.MediaStreams || this.item && this.item.MediaStreams || [];
		var fallback = null;
		for (var i = 0; i < streams.length; i++) {
			if (streams[i].Type !== "Audio") continue;
			if (!fallback || streams[i].IsDefault) fallback = streams[i];
			if (this.audioIndex !== null && this.audioIndex !== undefined && streams[i].Index === this.audioIndex) {
				return streams[i];
			}
		}
		return fallback;
	},

	sourceCaption: function() {
		var source = this.routePlan && this.routePlan.source;
		var streams = source && source.MediaStreams || this.item && this.item.MediaStreams || [];
		var video = null;
		for (var i = 0; i < streams.length; i++) {
			if (streams[i].Type === "Video") {
				video = streams[i];
				break;
			}
		}
		var bits = [];
		if (video) {
			bits.push(this.codecCaption(video.Codec));
			if (video.Width && video.Height) bits.push(video.Width + "×" + video.Height);
			if (video.BitDepth) bits.push(video.BitDepth + "-bit");
			var range = String(video.VideoRangeType || video.VideoRange || video.ColorTransfer || "").toLowerCase();
			if (/dolby|dovi/.test(range)) bits.push("Dolby Vision");
			else if (/hdr|smpte2084|pq/.test(range)) bits.push("HDR");
			else if (/hlg|arib-std-b67/.test(range)) bits.push("HLG");
		}
		var audio = this.selectedSourceAudio(source);
		if (audio) {
			var label = this.codecCaption(audio.Codec);
			if (audio.Channels) label += " " + (audio.Channels === 2 ? "stereo" : audio.Channels + " ch");
			bits.push(label);
		}
		return "Source: " + (bits.length ? bits.join(" · ") : "details unavailable");
	},

	routeCaption: function() {
		if (!this.info) return "Route: preparing";
		if (this.info.method === "MacMini") return "Route: LAN bridge conversion";
		if (this.info.method === "DirectPlay") return "Route: direct";
		return "Route: " + this.info.method;
	},

	openMore: function() {
		if (!this.playing || this.controlsLocked) return;
		this.showPanel("playback");
		var source = this.routePlan && this.routePlan.source;
		var mode = this.playbackMode === "mini" || this.networkTranscode ? "mini" : "auto";
		this.$.moreRoute.setContent(this.routeCaption());
		this.$.moreSource.setShowing(!!source);
		if (source) this.$.moreSource.setContent(this.sourceCaption());
		this.$.routeActions.setShowing(this.canChooseMacMini() || this.canChooseNetworkRoute());
		this.$.autoRoute.addRemoveClass("jf-player-choice", mode === "auto");
		this.$.autoRoute.setAttribute("aria-pressed", mode === "auto" ? "true" : "false");
		this.$.miniRoute.addRemoveClass("jf-player-choice", mode === "mini");
		this.$.miniRoute.setAttribute("aria-pressed", mode === "mini" ? "true" : "false");
		this.$.loopSection.setShowing(this.canLoop());
		this.updateLoopPanel();
		this.setMoreOpen(true);
		this.clearControlsTimer();
	},

	showPanel: function(mode) {
		this.panelMode = mode;
		this.$.panelHeading.setContent(mode === "audio" ? "Audio tracks" : mode === "subtitles" ? "Subtitles" : "Playback settings");
		this.$.playbackSection.setShowing(mode === "playback");
		this.$.trackSection.setShowing(mode !== "playback");
		this.$.loopSection.setShowing(mode === "playback" && this.canLoop());
		this.updateSubtitleOptions();
	},

	setMoreOpen: function(open) {
		if (!!this.moreOpen === open) return;
		this.moreOpen = open;
		this.$.moreScrim.setShowing(open);
		this.$.morePanel.setShowing(open);
		this.$.moreButton.setAttribute("aria-expanded", open ? "true" : "false");
		if (!open) {
			this.panelMode = null;
			this.previewSubtitleBackground = false;
			this.updateSubtitleOverlay();
		}
	},

	closeMore: function() {
		this.setMoreOpen(false);
		this.restartControlsTimer();
	},

	chooseAuto: function() {
		this.closeMore();
		this.selectPlaybackMode("auto");
	},

	chooseMini: function() {
		this.closeMore();
		this.selectPlaybackMode("mini");
	},

	selectPlaybackMode: function(mode) {
		if (this.networkPlayback) { this.selectNetworkPlaybackMode(mode); return; }
		if (mode === this.playbackMode) {
			if (mode === "auto") this.playbackChoice = null;
			this.restartControlsTimer();
			return;
		}
		if (mode === "auto") {
			this.playbackChoice = null;
			this.playbackMode = "auto";
			this.restartHere();
			return;
		}
		if (!this.canChooseMacMini() || !JF.probeVideo) {
			this.setStatus("The LAN media bridge is not configured.");
			this.showControls();
			return;
		}
		var self = this;
		var item = this.item;
		var plan = this.routePlan;
		var source = plan.source;
		var choice = this.playbackChoice = {};
		this.setStatus("Checking the selected source…");
		JF.probeVideo(item, source, function(ok, info) {
			if (self.playbackChoice !== choice || !self.playing || self.item !== item ||
				self.routePlan !== plan || self.routePlan.source !== source) {
				return;
			}
			self.playbackChoice = null;
			if (!ok || !info || String(info.mediaSourceId) !== String(source.Id) || info.miniSupported !== true) {
				self.setStatus("The bridge cannot convert this source. Choose another version.");
				self.showControls();
				return;
			}
			self.playbackMode = "mini";
			self.restartHere();
		});
	},

	selectNetworkPlaybackMode: function(mode) {
		if (!this.playing || !this.canChooseNetworkRoute()) return;
		if (mode === "auto") {
			this.playbackChoice = null;
			if (!this.networkTranscode) return;
			this.networkTranscode = false;
			this.networkChecked = false;
			this.startStream(this.positionTicks());
			return;
		}
		if (this.waitingForRoute || this.networkTranscode || this.playbackChoice) return;
		var self = this, route = this.networkPlayback, request = this.request;
		var choice = this.playbackChoice = {};
		function switchRoute(plan) {
			if (self.playbackChoice !== choice || self.request !== request || !self.playing) return;
			self.playbackChoice = null;
			if (!plan || !plan.transcode) {
				self.setStatus(plan && plan.reason || "The LAN bridge cannot convert this source.");
				self.showControls();
				return;
			}
			plan.direct = route.direct;
			plan.source = route.source;
			plan.path = route.path;
			self.networkPlayback = plan;
			self.networkTranscode = true;
			self.startStream(self.positionTicks());
		}
		if (route.transcode) switchRoute(route);
		else {
			this.setStatus("Checking the selected source…");
			JF.networkPlaybackPlan(route.source, route.path, switchRoute, true);
		}
	},

	retryClick: function() {
		if (!this.playing || this.waitingForRoute) return;
		this.setRetryShowing(false);
		this.setStatus("Retrying…");
		this.restartHere();
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
		} else if (this.info.method === "MacMini" && !this.info.elapsedClock && node &&
			typeof node.currentTime === "number" && isFinite(node.currentTime)) {
			this.lastTicks = Math.round(this.startTicks + node.currentTime * 10000000);
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
		if (this.info && !this.direct && !this.info.localBridge) {
			JF.api.stopEncoding(this.info.playSessionId);
		}
	},

	durationTicks: function() {
		var node = this.$.video.hasNode();
		if (this.direct && node && node.duration > 0 && isFinite(node.duration)) {
			return Math.round(node.duration * 10000000);
		}
		return (this.item && this.item.RunTimeTicks) ||
			(this.networkPlayback && Math.round(this.networkPlayback.duration * 10000000)) || 0;
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
		this.checkSegment();
		// Keep the relay service running; it stops 120 s after its last call.
		if (this.relayed && this.ticks % 30 === 0) {
			JF.relay.ping();
		}
	},

	showPosition: function(ticks) {
		var total = this.durationTicks();
		this.$.clock.setContent(JF.api.ticksToClock(ticks));
		this.$.duration.setContent(total ? JF.api.ticksToClock(total) : "");
		var progress = total ? Math.max(0, Math.min(1000, Math.round(1000 * ticks / total))) : 0;
		this.$.slider.setPosition(progress);
		this.$.seekFill.applyStyle("width", progress / 10 + "%");
	},

	updateRouteStatus: function() {
		var method = this.info && this.info.method;
		var caption = method === "MacMini" ? "LAN bridge" : method === "DirectPlay" ? "Direct" : "";
		this.$.routeStatus.setContent(caption);
		this.$.routeStatus.setShowing(!!caption);
	},

	// Keep the server's record of where we are up to date. Test launches from
	// a PC set JF.noReport so they do not touch the user's watch history.
	tellServer: function(path) {
		if (!this.item || !this.info || this.info.localBridge || JF.noReport) {
			return;
		}
		// Kept and sent later if there is no connection (a download watched offline).
		JF.api.report(path, {
			ItemId: this.item.Id, MediaSourceId: this.info.mediaSourceId, PlaySessionId: this.info.playSessionId,
			PositionTicks: this.reportTicks || this.positionTicks(), IsPaused: !!this.paused,
			PlayMethod: this.info.method, CanSeek: true,
			AudioStreamIndex: this.audioIndex, SubtitleStreamIndex: this.subtitleIndex
		}, this.item.RunTimeTicks);
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
		this.clearSeekPreview();
		this.resetLoop();
		this.setMoreOpen(false);
		this.setControlsLocked(false);
		this.stopTimers();
		this.tellServer("/Sessions/Playing/Stopped");
		this.reportTicks = 0;
		this.endEncoding();
		this.playing = false;
		this.audioSwitch = null;
		this.clearTextSubtitle();
		this.request = null;
		if (this.cancelMiniWarm) this.cancelMiniWarm();
		this.cancelMiniWarm = null;
		this.waitingForRoute = false;
		this.info = null;
		this.playbackChoice = null;
		this.setRetryShowing(false);
		var node = this.$.video.hasNode();
		if (node) {
			try { node.pause(); } catch (e) {}
		}
		this.$.video.setSrc("");
		this.keepScreenOn(false);
		this.lockRotation(false);
		enyo.setFullScreen(false);
	},

	// LuneOS's PalmSystem has no setWindowProperties, and Enyo calls it without
	// checking, so the TypeError stopped playback before the video loaded.
	keepScreenOn: function(on) {
		if (!window.PalmSystem || typeof PalmSystem.setWindowProperties != "function") {
			return;
		}
		enyo.windows.setWindowProperties(window, {blockScreenTimeout: on});
	},

	// Hold the screen in the video's orientation while it plays, as HP's video
	// player does: turning the tablet would resize the page under the picture.
	lockRotation: function(on) {
		if (!window.PalmSystem) {
			return;
		}
		enyo.setAllowedOrientation(on ? (window.PalmSystem.videoOrientation || "up") : (JF.phone ? "up" : "free"));
	},

	// ---- the controls over the picture -------------------------------------

	showControls: function() {
		if (this.controlsLocked) return;
		this.setControlsShowing(true);
		this.updateRouteStatus();
		if (this.playing && !this.dragging) {
			this.showPosition(this.positionTicks());
		}
		this.restartControlsTimer();
	},

	setControlsShowing: function(showing) {
		this.controlsUp = showing;
		this.$.header.setShowing(showing);
		this.$.transport.setShowing(showing);
		this.$.subtitleOverlay.addRemoveClass("jf-subtitle-raised", showing);
	},

	// Hidden after a while, except when paused or while the slider is held.
	hideControls: function() {
		if (this.controlsLocked || this.moreOpen) return;
		if (this.paused || this.dragging) {
			this.restartControlsTimer();
			return;
		}
		this.setControlsShowing(false);
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
		if (this.controlsLocked) return true;
		if (this.controlsUp) {
			this.clearControlsTimer();
			this.setControlsShowing(false);
		} else {
			this.showControls();
		}
	},

	setControlsLocked: function(locked) {
		if (!!this.controlsLocked === locked) return;
		this.controlsLocked = locked;
		this.$.unlockButton.setShowing(locked);
		if (locked) {
			this.setMoreOpen(false);
			this.clearSeekPreview();
			this.clearControlsTimer();
			this.setControlsShowing(false);
		}
	},

	lockClick: function() {
		if (this.playing) this.setControlsLocked(true);
	},

	unlockClick: function() {
		this.setControlsLocked(false);
		this.showControls();
	},

	dismissOverlay: function() {
		if (this.controlsLocked) {
			this.unlockClick();
			return true;
		}
		if (this.moreOpen) {
			this.closeMore();
			return true;
		}
		return false;
	},

	// ---- transport ---------------------------------------------------------

	setPauseButton: function(paused) {
		this.$.pauseButton.setCaption(paused ? "Play" : "Pause");
		this.$.pauseButton.addRemoveClass("jf-symbol-play", paused);
	},

	doneClick: function() {
		this.stopStream();
		this.doBack();
	},

	pauseClick: function() {
		var node = this.$.video.hasNode();
		if (!node || !this.playing || this.waitingForRoute) {
			return;
		}
		if (this.paused && (this.interrupted || this.wentAway)) {
			// The player was taken apart while the card was away or the tablet
			// slept (which can happen while paused by hand, now that a pause lets
			// the screen sleep): what is left cannot simply be told to play, so
			// start the stream afresh from where it stopped.
			this.resumeAfterInterruption();
			return;
		}
		if (this.paused) {
			node.play();
		} else {
			// Paused by hand: it stays paused when the card comes back.
			this.byHand = true;
			node.pause();
		}
		this.showControls();
	},

	// ---- the card going away and coming back ----
	//
	// When the card leaves the front (card view, another app, the screen going
	// off, the tablet sleeping), webOS pauses the video and takes its player
	// apart: the decoder is closed and the stream's connection dropped. The
	// video element still says "paused", but play() does nothing useful then.
	// So a pause that the person did not ask for is remembered, and when the
	// card is in front again the stream is started afresh from where it stopped.

	// The card is in front again (from the app).
	cameBack: function() {
		var self = this;
		var request = this.request;
		if (!this.playing) {
			return;
		}
		// The system's pause can reach us a moment after the card is back.
		setTimeout(function() {
			if (request === self.request && self.playing && self.paused && self.interrupted) {
				self.resumeAfterInterruption();
			}
		}, 700);
	},

	resumeAfterInterruption: function() {
		var ticks = this.interruptedAt || this.lastTicks || 0;
		JF.log("back in front: carrying on from " + JF.api.ticksToClock(ticks));
		this.interrupted = false;
		this.wentAway = false;
		this.tellServer("/Sessions/Playing/Stopped");
		this.startStream(ticks);
	},

	// The card is leaving the front (card view, another app, the screen going off,
	// the tablet sleeping). webOS tears the player and the stream apart, so
	// remember where we are — even when paused by hand, which records nothing on
	// its own — so a later Play starts afresh from here instead of a dead stream.
	leftFront: function() {
		if (!this.playing) {
			return;
		}
		this.clearSeekPreview();
		this.setMoreOpen(false);
		this.interruptedAt = this.positionTicks();
		this.wentAway = true;
	},

	// Headphones unplugged: pause rather than play out loud.
	pauseVideo: function() {
		if (this.playing && !this.paused) {
			this.pauseClick();
		}
	},

	seekTo: function(ticks) {
		var node = this.$.video.hasNode();
		if (!node || !this.playing) {
			return;
		}
		var total = this.durationTicks();
		ticks = this.seekLimit(ticks, total);
		if (this.networkPlayback) {
			this.playbackChoice = null;
			if (this.waitingForRoute && this.direct) {
				this.networkChecked = false;
				this.startStream(ticks);
				return;
			}
		}
		if (this.loopEndTicks != null && (ticks < this.loopStartTicks || ticks >= this.loopEndTicks)) {
			this.resetLoop();
		}
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

	seekLimit: function(ticks, total) {
		return Math.max(0, total ? Math.min(ticks, total - 50000000) : ticks);
	},

	clearSeekPreview: function() {
		this.dragging = false;
		this.swipeSeek = null;
		this.$.seekPreview.setShowing(false);
	},

	showSeekPreview: function(ticks, total) {
		if (!this.dragging) {
			this.seekWidth = this.$.seekTrack.hasNode().offsetWidth;
			this.dragging = true;
		}
		var width = this.seekWidth;
		var left = Math.max(44, Math.min(width - 44, width * ticks / total));
		this.$.seekPreview.setContent(JF.api.ticksToClock(ticks));
		this.$.seekPreview.applyStyle("left", left + "px");
		this.$.seekPreview.setShowing(true);
	},

	sliderChanging: function(inSender, position) {
		var total = this.durationTicks();
		if (!this.controlsLocked && this.playing && !this.waitingForRoute && total) {
			this.showSeekPreview(this.seekLimit(position / 1000 * total, total), total);
		}
	},

	sliderChange: function(inSender, position) {
		var total = this.durationTicks();
		this.clearSeekPreview();
		if (!this.controlsLocked && this.playing && !this.waitingForRoute && total) {
			this.seekTo(Math.round(position / 1000 * total));
		} else {
			this.showPosition(this.positionTicks());
		}
	},

	stageDragStart: function(inSender, event) {
		var total = this.durationTicks();
		if (!this.controlsLocked && event.horizontal && this.playing && !this.waitingForRoute && total) {
			var width = inSender.hasNode().offsetWidth;
			if (width) this.swipeSeek = {start: this.positionTicks(), total: total, width: width, target: null};
		}
	},

	stageDrag: function(inSender, event) {
		var swipe = this.swipeSeek;
		if (!swipe || (swipe.target === null && Math.abs(event.dx) < 18)) return;
		if (swipe.target === null && !this.controlsUp) this.showControls();
		// A full-width swipe covers two minutes, regardless of the film length.
		swipe.target = this.seekLimit(swipe.start + Math.round(event.dx / swipe.width * 1200000000), swipe.total);
		this.showSeekPreview(swipe.target, swipe.total);
		this.$.slider.setPosition(Math.round(swipe.target / swipe.total * 1000));
	},

	stageDragFinish: function(inSender, event) {
		event.preventClick();
		var swipe = this.swipeSeek;
		if (swipe) {
			this.clearSeekPreview();
			if (swipe.target !== null && this.playing && !this.waitingForRoute) {
				this.seekTo(swipe.target);
			}
		}
	},

	// A–B repeat stays on the native time line of a seekable direct stream.
	canLoop: function() {
		return this.playing && this.direct && this.hasPlayed && !this.waitingForRoute &&
			this.durationTicks() > 60000000;
	},

	updateLoopPanel: function() {
		var text = "Set A at the current position.";
		var hasStart = this.loopStartTicks != null;
		if (hasStart) {
			text = "A " + JF.api.ticksToClock(this.loopStartTicks);
			text += this.loopEndTicks != null ? "  ·  B " + JF.api.ticksToClock(this.loopEndTicks) :
				"  ·  Move forward to set B.";
		}
		this.$.loopLabel.setContent(text);
		this.$.setLoopEnd.setDisabled(!hasStart);
		this.$.clearLoopButton.setDisabled(!hasStart);
	},

	updateLoopRange: function() {
		var total = this.durationTicks();
		var a = this.loopStartTicks;
		if (a == null || !total) {
			this.$.loopRange.setShowing(false);
			return;
		}
		var b = this.loopEndTicks;
		this.$.loopRange.applyStyle("left", 100 * a / total + "%");
		this.$.loopRange.applyStyle("width", b == null ? "2px" : 100 * (b - a) / total + "%");
		this.$.loopRange.setShowing(true);
	},

	markLoopStart: function() {
		if (!this.canLoop()) return;
		this.loopStartTicks = this.seekLimit(this.positionTicks(), this.durationTicks());
		this.loopEndTicks = null;
		this.updateLoopRange();
		this.updateLoopPanel();
		this.closeMore();
	},

	markLoopEnd: function() {
		if (!this.canLoop() || this.loopStartTicks == null) return;
		var target = this.seekLimit(this.positionTicks(), this.durationTicks());
		if (target - this.loopStartTicks < 10000000) {
			this.$.loopLabel.setContent("Set B at least one second after A.");
			return;
		}
		this.loopEndTicks = target;
		this.updateLoopRange();
		this.updateLoopPanel();
		this.closeMore();
		this.seekTo(this.loopStartTicks);
	},

	resetLoop: function() {
		this.loopStartTicks = this.loopEndTicks = null;
		this.$.loopRange.setShowing(false);
	},

	clearLoopClick: function() {
		this.resetLoop();
		this.updateLoopPanel();
	},

	checkLoop: function() {
		if (this.loopEndTicks == null || this.paused || this.dragging || !this.canLoop()) return false;
		var node = this.$.video.hasNode();
		if (!node || node.seeking || node.currentTime * 10000000 < this.loopEndTicks) return false;
		node.currentTime = this.loopStartTicks / 10000000;
		this.lastTicks = this.loopStartTicks;
		return true;
	},

	// ---- audio and subtitles -----------------------------------------------

	audioClick: function() { this.openTracks("audio"); },
	subtitleClick: function() { this.openTracks("subtitles"); },

	openTracks: function(mode) {
		if (!this.playing || this.controlsLocked) return;
		this.showPanel(mode);
		this.renderTrackList();
		this.setMoreOpen(true);
		this.clearControlsTimer();
	},

	streamByIndex: function(streams, index) {
		for (var i = 0; i < streams.length; i++) {
			if (streams[i].index === index) return streams[i];
		}
		return null;
	},

	renderTrackList: function() {
		var audio = this.panelMode === "audio";
		var source = this.routePlan && this.routePlan.source;
		var current = audio ? this.audioIndex : this.subtitleIndex;
		if (audio && current == null) {
			var active = this.selectedSourceAudio(source);
			if (active) current = active.Index;
		}
		var streams = audio ? this.audioStreams : [{index: -1, title: "Off"}].concat(this.subtitleStreams);
		var controls = [];
		for (var i = 0; i < streams.length; i++) {
			var track = streams[i], activeTrack = track.index === current;
			var unsupported = !audio && this.routePlan && track.index >= 0 && !track.isText;
			var caption = track.title + (unsupported ? " · Image subtitle unavailable" : !audio && track.isExternal ? " · External" : "");
			controls.push({kind: "Button", caption: caption, trackIndex: track.index, onclick: "trackClick",
				disabled: !!unsupported, className: "jf-track-row" + (activeTrack ? " jf-player-choice" : "")});
		}
		this.$.trackList.destroyControls();
		this.$.trackList.createComponents(controls, {owner: this});
		var rows = this.$.trackList.getControls();
		for (var j = 0; j < rows.length; j++) {
			rows[j].setAttribute("aria-pressed", rows[j].trackIndex === current ? "true" : "false");
		}
		this.$.trackList.render();
		this.updateTrackStatus();
	},

	updateTrackStatus: function() {
		if (this.panelMode !== "audio" && this.panelMode !== "subtitles") return;
		var text = this.panelMode === "audio" ? this.audioNotice : this.subtitleNotice;
		this.$.trackStatus.setContent(text || "");
		this.$.trackStatus.setShowing(!!text);
	},

	trackClick: function(sender) {
		if (this.panelMode === "audio") this.selectAudio(sender.trackIndex);
		else if (this.panelMode === "subtitles") this.selectSubtitle(sender.trackIndex);
	},

	// A different audio track or a legacy burned-in subtitle needs a new
	// stream. Restart at the media position, not at the start of the film.
	restartHere: function() {
		var here = this.positionTicks();
		this.tellServer("/Sessions/Playing/Stopped");
		this.startStream(here);
	},

	selectAudio: function(index) {
		var stream = this.streamByIndex(this.audioStreams, index);
		if (!stream || this.audioSwitch) return;
		var source = this.routePlan && this.routePlan.source;
		if (source) {
			var decision = JF.choosePlayback(this.item, source, index, this.playbackMode === "mini");
			if (decision.audioIndex !== index || ((!decision.direct || JF.audioNeedsRemux(source, index)) && !this.canChooseMacMini())) {
				this.audioNotice = decision.audioIndex !== index ? "This audio format is unavailable." : "This track needs the LAN media bridge.";
				this.updateTrackStatus();
				return;
			}
		}
		this.closeMore();
		if (index === this.audioIndex) {
			this.audioNotice = "";
			return;
		}
		this.audioSwitch = {previous: this.audioIndex, target: index, at: this.positionTicks(), language: stream.language};
		this.audioNotice = "Switching to " + stream.title + "…";
		this.audioIndex = index;
		this.restartHere();
	},

	confirmAudioSwitch: function() {
		var change = this.audioSwitch;
		if (!change || !this.wasShowing || !this.hasPlayed || this.waitingForRoute ||
			this.audioIndex !== change.target || this.positionTicks() < change.at + 20000000) return;
		this.audioSwitch = null;
		this.audioNotice = "";
		if (change.language) localStorage.setItem("jf.audioLanguage", change.language);
		if (this.moreOpen) this.updateTrackStatus();
	},

	restoreAudioTrack: function() {
		var change = this.audioSwitch;
		if (!change) return false;
		this.audioSwitch = null;
		this.audioIndex = change.previous;
		this.audioNotice = "Couldn't switch tracks. Previous track selected.";
		if (this.moreOpen && this.panelMode === "audio") this.renderTrackList();
		this.startStream(change.at);
		this.showControls();
		return true;
	},

	selectSubtitle: function(index) {
		var stream = this.streamByIndex(this.subtitleStreams, index);
		if (index >= 0 && (!stream || (this.routePlan && !stream.isText))) return;
		var wasBurned = this.burnIndex;
		localStorage.setItem("jf.subtitles", index >= 0 ? "on" : "off");
		if (stream && stream.language) localStorage.setItem("jf.subtitleLanguage", stream.language);
		this.chooseSubtitle(index);
		this.renderTrackList();
		this.updateSubtitleOptions();
		if (this.burnIndex !== wasBurned) {
			this.closeMore();
			this.restartHere();
		}
	},

	chooseSubtitle: function(index) {
		var stream = this.streamByIndex(this.subtitleStreams, index);
		if (this.routePlan && stream && !stream.isText) stream = null;
		this.subtitleIndex = stream ? index : -1;
		this.burnIndex = stream && !this.routePlan && !stream.url ? index : null;
		this.clearTextSubtitle();
		this.$.subtitleButton.addRemoveClass("jf-player-track-on", this.subtitleIndex >= 0);
		if (!stream || (!this.routePlan && !stream.url)) return;
		var self = this;
		var request = this.subtitleRequest = {};
		this.subtitleNotice = "Loading subtitles…";
		this.updateTrackStatus();
		var loaded = function(ok, text) {
			if (self.subtitleRequest !== request) return;
			self.subtitleCues = ok ? JF.parseSrt(text) : [];
			self.subtitleNotice = self.subtitleCues.length ? "" : "Subtitles unavailable. Select this track again to retry.";
			self.$.subtitleButton.addRemoveClass("jf-player-track-on", self.subtitleCues.length > 0);
			self.updateTrackStatus();
			self.renderSubtitle();
		};
		if (stream.url) this.cancelSubtitle = JF.networkGetText(stream.url, loaded);
		else {
			var source = this.routePlan.source;
			this.cancelSubtitle = JF.api.textSubtitle(this.item.Id, source.Id || this.item.Id, index, loaded);
		}
	},

	clearTextSubtitle: function() {
		this.subtitleRequest = null;
		if (this.cancelSubtitle) this.cancelSubtitle();
		this.cancelSubtitle = null;
		this.subtitleCues = [];
		this.subtitleNotice = "";
		this.showSubtitle("");
	},

	showSubtitle: function(text) {
		this.visibleSubtitle = text;
		this.updateSubtitleOverlay();
	},

	updateSubtitleOverlay: function() {
		var preview = this.previewSubtitleBackground && this.moreOpen && this.panelMode === "subtitles" && this.subtitleIndex >= 0;
		var text = this.visibleSubtitle || (preview ? "Subtitle preview" : "");
		if (text === (this.renderedSubtitleText || "")) return;
		this.renderedSubtitleText = text;
		this.$.subtitleText.setContent(text);
		this.$.subtitleOverlay.setShowing(!!text);
	},

	renderSubtitle: function() {
		var node = this.$.video.hasNode();
		if (!node || !this.playing || !this.hasPlayed || !this.wasShowing || this.waitingForRoute ||
			node.seeking || !this.subtitleCues || !this.subtitleCues.length) return;
		var offset = (this.subtitleOffsetMs || 0) / 1000;
		this.showSubtitle(JF.subtitleAt(this.subtitleCues, this.positionTicks() / 10000000 - offset));
	},

	updateSubtitleOptions: function() {
		var track = this.streamByIndex(this.subtitleStreams, this.subtitleIndex);
		var showing = this.panelMode === "subtitles" && !!track && track.isText && (!!this.routePlan || !!track.url);
		this.$.subtitleOptions.setShowing(showing);
		if (!showing) return;
		var delay = this.subtitleOffsetMs || 0;
		this.$.subtitleOffsetLabel.setContent(delay ? "Timing · " + Math.abs(delay / 1000) + " s " +
			(delay > 0 ? "later" : "earlier") : "Timing · Original");
		var buttons = [this.$.subSmall, this.$.subMedium, this.$.subLarge].concat(this.$.subtitleBackgrounds.getControls());
		for (var i = 0; i < buttons.length; i++) {
			var on = buttons[i].option === this.subtitleSize || buttons[i].option === this.subtitleBackground;
			buttons[i].addRemoveClass("jf-player-choice", on);
			buttons[i].setAttribute("aria-pressed", on ? "true" : "false");
		}
	},

	applySubtitleSize: function() {
		if (this.subtitleSize !== "small" && this.subtitleSize !== "large") this.subtitleSize = "medium";
		this.$.subtitleText.addRemoveClass("jf-subtitle-small", this.subtitleSize === "small");
		this.$.subtitleText.addRemoveClass("jf-subtitle-large", this.subtitleSize === "large");
	},

	subtitleSizeClick: function(sender) {
		this.subtitleSize = sender.option;
		this.applySubtitleSize();
		localStorage.setItem("jf.subtitleSize", this.subtitleSize);
		this.updateSubtitleOptions();
	},

	applySubtitleBackground: function(option) {
		this.subtitleBackground = /^(0|25|50|90)$/.test(option) ? option : "90";
		this.$.subtitleText.setAttribute("data-background", this.subtitleBackground);
	},

	subtitleBackgroundClick: function(sender) {
		this.applySubtitleBackground(sender.option);
		localStorage.setItem("jf.subtitleBackground", this.subtitleBackground);
		this.updateSubtitleOptions();
		this.previewSubtitleBackground = true;
		this.updateSubtitleOverlay();
	},

	subtitleOffsetClick: function(sender) {
		this.subtitleOffsetMs = sender.delta ? Math.min(10000, Math.max(-10000, this.subtitleOffsetMs + sender.delta)) : 0;
		this.updateSubtitleOptions();
		this.renderSubtitle();
	},

	// ---- what the video element tells us ----------------------------------

	videoEvent: function(e) {
		var node = this.$.video.hasNode();
		if (!this.playing || !node || this.waitingForRoute) {
			return;
		}
		if (e.type === "playing" && this.wasShowing && !this.buffering && !this.paused && !this.interrupted) {
			return;
		}
		JF.log("video " + e.type);
		if (e.type === "error") {
			var code = node.error ? node.error.code : "?";
			JF.log("video error code " + code);
			if (this.audioSwitch && this.restoreAudioTrack()) return;
			if (this.networkPlayback && this.tryNetworkTranscode()) return;
			if (this.wasShowing) {
				// It was working: the connection dropped, often after a long pause.
				// One try per drop: a stream that never starts again ends in the message below.
				var ticks = this.positionTicks();
				this.wasShowing = false;
				this.setStatus("Reconnecting…");
				this.startStream(ticks);
			} else {
				this.stopTimers();
				this.showRetry("This device could not play this video (error " + code + ").");
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
			// Metadata alone proves nothing: a player that cannot decode the stream
			// reports it and then fails, every time.
			this.wasShowing = true;
			this.buffering = false;
			if (this.interrupted) {
				// The system has started the video again by itself, by asking for
				// the same address: that plays from where the stream first began,
				// not from where it stopped.
				this.resumeAfterInterruption();
				return;
			}
			this.paused = false;
			this.byHand = false;
			this.clockRun(true);
			// Playing again: hold the screen awake once more.
			this.keepScreenOn(true);
			this.setPauseButton(false);
			this.setStatus("");
			this.setRetryShowing(false);
			if (this.subtitleCues && this.subtitleCues.length) this.renderSubtitle();
			this.watchDecoder();
		} else if (e.type === "waiting" && this.info && this.info.elapsedClock) {
			this.buffering = true;
			this.clockRun(false);
		} else if (e.type === "pause") {
			this.paused = true;
			this.clockRun(false);
			// Paused: let the screen dim and sleep as it normally would, so a movie
			// left paused does not hold the display on. It comes back on resume.
			this.keepScreenOn(false);
			if (!this.byHand) {
				// Not the Pause button: the system stopped it (see cameBack).
				this.interrupted = true;
				this.interruptedAt = this.positionTicks();
				JF.log("paused by the system at " + JF.api.ticksToClock(this.interruptedAt));
			}
			this.setPauseButton(true);
			this.tellServer("/Sessions/Playing/Progress");
		} else if (e.type === "ended") {
			if (this.audioSwitch && this.restoreAudioTrack()) return;
			if (this.checkLoop()) node.play();
			else this.finished();
		}
	},

	tryNetworkTranscode: function() {
		var route = this.networkPlayback;
		if (!route || this.networkTranscode) return false;
		var self = this, from = this.positionTicks(), request = this.request;
		if (route.transcode) {
			this.networkTranscode = true;
			this.waitingForRoute = true;
			this.$.video.setSrc("");
			this.startStream(from);
			return true;
		}
		if (!route.source || this.networkChecked) return false;
		this.networkChecked = true;
		this.waitingForRoute = true;
		this.setStatus("Checking the selected source…");
		JF.networkPlaybackPlan(route.source, route.path, function(plan) {
			if (request !== self.request || !self.playing) return;
			if (plan && plan.transcode) {
				plan.direct = route.direct;
				plan.source = route.source;
				plan.path = route.path;
				self.networkPlayback = plan;
				self.tryNetworkTranscode();
			} else self.showRetry(plan && plan.reason || "Could not play this stream.");
		}, true);
		return true;
	},

	// The TouchPad's player can say "playing" while its video decoder stands
	// still: no picture, no sound, and no error either. (Seen on a TouchPad that
	// had been put to sleep with a video open: its sound system had hung, and the
	// player waits on that. Every video after that did it until the sound system
	// was restarted.) So, once a video says it is playing, look at the decoder's
	// own count twice. If it has not moved, have the sound output closed and
	// reopened and start the stream again, once; if that does it too, say what
	// is wrong.
	watchDecoder: function() {
		var self = this;
		var request = this.request;
		if (this.watching || !JF.relay) {
			return;
		}
		this.watching = true;
		JF.relay.decoderCount(function(before) {
			setTimeout(function() {
				JF.relay.decoderCount(function(after) {
					self.watching = false;
					if (request !== self.request || !self.playing || self.paused) {
						return;  // stopped, paused or moved on meanwhile
					}
					if (before < 0 || after < 0) {
						return;  // not a device where this can be told
					}
					if (after !== before) {
						if (self.triedAgain) {
							JF.log("video is running again after the sound output was reset");
						}
						self.triedAgain = false;
						return;  // pictures are being made
					}
					JF.log("the video decoder has not moved in " + (JF.DECODER_WAIT / 1000) + " s (count " + after + ")");
					if (self.tryNetworkTranscode()) return;
					if (!self.triedAgain) {
						self.triedAgain = true;
						var from = self.startTicks;
						self.tellServer("/Sessions/Playing/Stopped");
						self.setStatus("Starting again…");
						JF.relay.resetAudio(function(done) {
							JF.log("sound output reset: " + (done ? "done" : "could not be done"));
							if (request === self.request && self.playing) {
								self.startStream(from);
							}
						});
						return;
					}
					self.stopTimers();
					self.clockRun(false);
					self.paused = true;
					self.setStatus("The TouchPad's video player has stopped responding. Try Retry, then restart the TouchPad if it continues.");
					self.setRetryShowing(true);
					self.showControls();
					// Leave the way out on screen.
					self.clearControlsTimer();
				});
			}, JF.DECODER_WAIT);
		});
	},

	// The video ran to its end: go on to the next episode if there is one.
	finished: function() {
		var self = this;
		var item = this.item;
		var planned = this.routePlan && !this.localFile ? {forceMac: this.playbackMode === "mini" ||
			(this.playbackMode !== "auto" && !!this.routePlan.forceMac)} : null;
		this.stopStream();
		if (!item || item.Type !== "Episode") {
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
				var following = ok && full ? full : next;
				if (planned && following.MediaSources && following.MediaSources[0]) {
					planned.source = following.MediaSources[0];
				}
				self.playItem(following, 0, planned && planned.source ? planned : null);
			});
		});
	}
});
