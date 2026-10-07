/* Exhibition: what the TouchPad shows on a Touchstone dock, when Jellyfin is the
 * exhibition chosen (appinfo.json has "dockMode": true).
 *
 * The system launches the app with {dockMode: true, windowType: "dockModeWindow"}.
 * If the app was not running, index.html renders this instead of the app; if it
 * was, the App opens this in a second window of type "dockmode" (as HP's Photos
 * does for its slideshow).
 *
 * While music plays in the app, this shows the track, its progress and the
 * controls. Otherwise it shows the artwork of the movie and TV libraries, one
 * picture at a time, with a clock. The music lives in the app's own window, which
 * this reaches through the root window; it is polled rather than listened to, so
 * nothing in the app points back into this window after it closes.
 */
enyo.kind({
	name: "JF.Exhibition",
	kind: enyo.Control,
	className: "jf-exhibit",
	slideSeconds: 12,
	components: [
		{kind: "ApplicationEvents", onApplicationRelaunch: "relaunched"},
		// Two layers, faded across each other.
		{name: "slideA", className: "jf-exhibit-slide"},
		{name: "slideB", className: "jf-exhibit-slide"},
		{name: "caption", className: "jf-exhibit-caption", components: [
			{name: "slideTitle", className: "jf-exhibit-title"},
			{name: "slideSub", className: "jf-exhibit-sub"}
		]},
		{name: "clock", className: "jf-exhibit-clock"},
		{name: "music", className: "jf-exhibit-music", showing: false, components: [
			{name: "art", className: "jf-exhibit-art"},
			{className: "jf-exhibit-track", components: [
				{name: "trackTitle", className: "jf-exhibit-title"},
				{name: "trackArtist", className: "jf-exhibit-sub"},
				{name: "trackAlbum", className: "jf-exhibit-sub"},
				{className: "jf-exhibit-bar", components: [
					{name: "barFill", className: "jf-exhibit-bar-fill"}
				]},
				{name: "trackTime", className: "jf-exhibit-sub"},
				{kind: "HFlexBox", className: "jf-exhibit-buttons", components: [
					{kind: "Button", caption: "Prev", onclick: "previousClick"},
					{name: "pauseButton", kind: "Button", caption: "Pause", onclick: "pauseClick",
						className: "enyo-button-affirmative jf-npv-pause"},
					{kind: "Button", caption: "Next", onclick: "nextClick"}
				]}
			]}
		]}
	],

	rendered: function() {
		this.inherited(arguments);
		if (this.started) {
			return;
		}
		this.started = true;
		if (window.PalmSystem) {
			enyo.setAllowedOrientation("free");
		}
		this.slides = [];
		this.slideIndex = -1;
		this.front = "slideA";
		var self = this;
		this.tick();
		this.timer = setInterval(function() { self.tick(); }, 1000);
		if (JF.api.restore()) {
			JF.api.chooseAddress(function() { self.loadSlides(); });
		} else {
			this.$.slideTitle.setContent("Jellyfin");
			this.$.slideSub.setContent("Sign in in the app to see your library here.");
		}
	},

	destroy: function() {
		clearInterval(this.timer);
		this.inherited(arguments);
	},

	// The app's music, when the app is open in its own window.
	music: function() {
		try {
			var root = enyo.windows.getRootWindow();
			if (root !== window && root.JF && root.JF.music && root.JF.music.queue) {
				return root.JF.music;
			}
		} catch (e) {}
		return null;
	},

	// Once a second: the clock, the music, and every slideSeconds a new picture.
	tick: function() {
		var now = new Date();
		var h = now.getHours();
		var m = now.getMinutes();
		this.$.clock.setContent((h % 12 || 12) + ":" + (m < 10 ? "0" : "") + m + (h < 12 ? " AM" : " PM"));
		var music = this.music();
		this.showMusic(music);
		this.ticks = (this.ticks || 0) + 1;
		if (!music && (this.ticks % this.slideSeconds === 0 || this.slideIndex < 0)) {
			this.nextSlide();
		}
	},

	showMusic: function(music) {
		var track = music ? music.queue[music.index] : null;
		this.$.music.setShowing(!!track);
		this.$.caption.setShowing(!track);
		this.$.slideA.addRemoveClass("jf-exhibit-dim", !!track);
		this.$.slideB.addRemoveClass("jf-exhibit-dim", !!track);
		if (!track) {
			return;
		}
		if (track !== this.shownTrack) {
			this.shownTrack = track;
			this.$.trackTitle.setContent(track.Name || "");
			this.$.trackArtist.setContent(track.AlbumArtist || (track.Artists || []).join(", ") || "");
			this.$.trackAlbum.setContent(track.Album || "");
			var url = JF.api.imageUrl(track, 600);
			this.$.art.applyStyle("background-image", url ? "url('" + url + "')" : "none");
			// The cover, large and dimmed, behind everything.
			this.$[this.front].applyStyle("background-image", url ? "url('" + url + "')" : "none");
		}
		var pos = music.positionTicks() || 0;
		var total = music.durationTicks() || 0;
		this.$.barFill.applyStyle("width", (total ? Math.min(100, 100 * pos / total) : 0) + "%");
		this.$.trackTime.setContent(JF.api.ticksToClock(pos) + (total ? " / " + JF.api.ticksToClock(total) : ""));
		this.$.pauseButton.setCaption(music.playing && !music.paused ? "Pause" : "Play");
	},

	// Movies and shows with a backdrop, in a random order.
	loadSlides: function() {
		var self = this;
		JF.api.get("/Items", {userId: JF.api.userId, recursive: true, includeItemTypes: "Movie,Series",
			imageTypes: "Backdrop", sortBy: "Random", limit: 60, fields: "ProductionYear"}, function(ok, data) {
			self.slides = ok && data ? data.Items || [] : [];
			self.slideIndex = -1;
			self.nextSlide();
		});
	},

	nextSlide: function() {
		if (!this.slides || !this.slides.length) {
			return;
		}
		this.slideIndex = (this.slideIndex + 1) % this.slides.length;
		var item = this.slides[this.slideIndex];
		var tag = item.BackdropImageTags && item.BackdropImageTags[0];
		var url = JF.api.baseUrl + "/Items/" + item.Id + "/Images/Backdrop?maxWidth=1024&quality=80" +
			(tag ? "&tag=" + tag : "");
		// Load it first, then fade it in over the one showing.
		var self = this;
		var img = new Image();
		img.onload = function() {
			var back = self.front === "slideA" ? "slideB" : "slideA";
			self.$[back].applyStyle("background-image", "url('" + url + "')");
			self.$[back].addClass("jf-exhibit-front");
			self.$[self.front].removeClass("jf-exhibit-front");
			self.front = back;
			self.$.slideTitle.setContent(item.Name || "");
			self.$.slideSub.setContent(item.ProductionYear ? String(item.ProductionYear) : "");
		};
		img.src = url;
	},

	// Started from the dock, this window is the app's first; launching the app from
	// the launcher then lands here. Open the app in its card.
	relaunched: function() {
		var p = enyo.windowParams || {};
		if (!p.dockMode && p.windowType !== "dockModeWindow") {
			enyo.windows.activate("index.html", "jfMain", p);
			return true;
		}
	},

	previousClick: function() {
		var m = this.music();
		if (m) {
			m.previousClick();
		}
	},

	pauseClick: function() {
		var m = this.music();
		if (m) {
			m.pauseClick();
		}
	},

	nextClick: function() {
		var m = this.music();
		if (m) {
			m.nextClick();
		}
	}
});
