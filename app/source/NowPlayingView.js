/* The full Now Playing screen, opened from the music bar: large cover art, the
 * controls, shuffle and repeat, and the queue ("Up Next"), where a track can be
 * played straight away or taken out. Everything here is a view of JF.music (the
 * NowPlaying bar), which owns the queue and the audio.
 */
enyo.kind({
	name: "JF.NowPlayingView",
	kind: enyo.VFlexBox,
	className: "jf-view",
	events: {
		onBack: ""
	},
	components: [
		{kind: "PageHeader", className: "jf-header", components: [
			{kind: "Button", caption: "Back", onclick: "doBack"},
			{content: "Now Playing", flex: 1, className: "jf-header-title jf-header-indent"},
			{name: "count", className: "jf-header-count"}
		]},
		{kind: "HFlexBox", flex: 1, components: [
			{className: "jf-npv-left", components: [
				{name: "art", className: "jf-npv-art"},
				{name: "title", className: "jf-npv-title"},
				{name: "artist", className: "jf-npv-artist"},
				{kind: "HFlexBox", align: "center", className: "jf-npv-time", components: [
					{name: "clock", content: "0:00", className: "jf-clock"},
					{name: "slider", kind: "Slider", flex: 1, minimum: 0, maximum: 1000, position: 0,
						animatePosition: false, onChanging: "sliderChanging", onChange: "sliderChange"},
					{name: "duration", className: "jf-clock"}
				]},
				{kind: "HFlexBox", pack: "center", className: "jf-npv-transport", components: [
					{kind: "Button", caption: "Prev", onclick: "previousClick"},
					{name: "pauseButton", kind: "Button", caption: "Pause", onclick: "pauseClick",
						className: "enyo-button-affirmative jf-npv-pause"},
					{kind: "Button", caption: "Next", onclick: "nextClick"}
				]},
				{kind: "HFlexBox", pack: "center", className: "jf-npv-modes", components: [
					{name: "shuffleButton", kind: "Button", caption: "Shuffle: Off", onclick: "shuffleClick"},
					{name: "repeatButton", kind: "Button", caption: "Repeat: Off", onclick: "repeatClick"}
				]}
			]},
			{flex: 1, kind: "VFlexBox", className: "jf-npv-right", components: [
				{content: "Up Next", className: "jf-section jf-npv-heading"},
				{name: "scroller", kind: "Scroller", flex: 1, components: [
					{name: "queue"}
				]}
			]}
		]}
	],

	// Called by the App when the screen is shown.
	showQueue: function() {
		if (!this.listening) {
			this.listening = true;
			JF.music.addListener(enyo.bind(this, "musicChanged"));
		}
		this.musicChanged("track");
	},

	musicChanged: function(what) {
		if (!this.hasNode() || !this.showing) {
			return;
		}
		var m = JF.music;
		if (what === "position") {
			if (!this.dragging) {
				this.showPosition(m.positionTicks());
			}
			return;
		}
		var track = m.queue ? m.queue[m.index] : null;
		this.$.title.setContent(track ? track.Name || "" : "Nothing playing");
		this.$.artist.setContent(track ? track.AlbumArtist || (track.Artists || []).join(", ") || track.Album || "" : "");
		var url = track ? JF.api.imageUrl(track, 440) : "";
		this.$.art.applyStyle("background-image", url ? "url('" + url + "')" : "none");
		this.$.pauseButton.setCaption(m.playing && !m.paused ? "Pause" : "Play");
		this.$.shuffleButton.setCaption("Shuffle: " + (m.shuffled ? "On" : "Off"));
		this.$.repeatButton.setCaption("Repeat: " + {off: "Off", all: "All", one: "One"}[m.repeat]);
		this.showPosition(track ? m.positionTicks() : 0);
		if (what === "track" || what === "queue") {
			this.showList();
		}
	},

	showPosition: function(ticks) {
		var total = JF.music.durationTicks();
		this.$.clock.setContent(JF.api.ticksToClock(ticks));
		this.$.duration.setContent(total ? JF.api.ticksToClock(total) : "");
		this.$.slider.setPosition(total ? Math.round(1000 * ticks / total) : 0);
	},

	showList: function() {
		var m = JF.music;
		var queue = m.queue || [];
		this.$.queue.destroyControls();
		for (var i = 0; i < queue.length; i++) {
			this.$.queue.createComponent({kind: "JF.QueueRow", item: queue[i], position: i, current: i === m.index,
				onRowClick: "rowClick", onRemove: "removeClick", owner: this});
		}
		this.$.queue.render();
		this.$.count.setContent(queue.length ? (m.index + 1) + " of " + queue.length : "");
	},

	rowClick: function(inSender, position) {
		JF.music.jumpTo(position);
	},

	removeClick: function(inSender, position) {
		JF.music.removeAt(position);
	},

	previousClick: function() { JF.music.previousClick(); },
	pauseClick: function() { JF.music.pauseClick(); },
	nextClick: function() { JF.music.nextClick(); },

	shuffleClick: function() {
		JF.music.setShuffle(!JF.music.shuffled);
	},

	repeatClick: function() {
		JF.music.cycleRepeat();
	},

	sliderChanging: function(inSender, position) {
		this.dragging = true;
		this.$.clock.setContent(JF.api.ticksToClock(position / 1000 * JF.music.durationTicks()));
	},

	sliderChange: function(inSender, position) {
		this.dragging = false;
		JF.music.seekTo(Math.round(position / 1000 * JF.music.durationTicks()));
	}
});

/* One line of the queue: tap to play it, Remove to take it out. */
enyo.kind({
	name: "JF.QueueRow",
	kind: enyo.HFlexBox,
	align: "center",
	className: "jf-track jf-queue-row",
	published: {
		item: null,
		position: 0,
		current: false
	},
	events: {
		onRowClick: "",
		onRemove: ""
	},
	components: [
		{name: "number", className: "jf-track-number"},
		{flex: 1, onclick: "rowClick", components: [
			{name: "name", className: "jf-track-name"},
			{name: "artist", className: "jf-track-artist"}
		]},
		{name: "length", className: "jf-track-length"},
		{kind: "Button", caption: "Remove", className: "jf-queue-remove", onclick: "removeClick"}
	],

	create: function() {
		this.inherited(arguments);
		var t = this.item;
		this.$.number.setContent(this.current ? "Now" : String(this.position + 1));
		this.$.name.setContent(t.Name || "");
		this.$.artist.setContent(t.AlbumArtist || (t.Artists || []).join(", ") || "");
		this.$.length.setContent(t.RunTimeTicks ? JF.api.ticksToClock(t.RunTimeTicks) : "");
		this.addRemoveClass("jf-queue-current", this.current);
	},

	rowClick: function() {
		this.doRowClick(this.position);
		return true;
	},

	removeClick: function() {
		this.doRemove(this.position);
		return true;
	}
});
