/* The music controls shown in the notification area (dashboard.html), modelled
 * on HP's Music app for the TouchPad. NowPlaying opens it while music plays and
 * the app is in the background, and keeps it up to date through window params
 * {title, artist, image, playing}. The buttons send {musicCommand} back to the
 * app's window the same way.
 */
enyo.kind({
	name: "JF.Dashboard",
	kind: enyo.HFlexBox,
	align: "center",
	className: "jf-dashboard",
	components: [
		{kind: "ApplicationEvents", onWindowParamsChange: "paramsChanged"},
		{name: "art", className: "jf-dash-art", onclick: "openApp"},
		{flex: 1, className: "jf-dash-text", onclick: "openApp", components: [
			{name: "title", className: "jf-dash-title"},
			{name: "artist", className: "jf-dash-artist"}
		]},
		// Drawn with CSS: the TouchPad font has no media symbols.
		{className: "jf-dash-button jf-dash-prev", onclick: "previousClick"},
		{name: "playButton", className: "jf-dash-button jf-dash-play", onclick: "playClick"},
		{className: "jf-dash-button jf-dash-next", onclick: "nextClick"}
	],

	rendered: function() {
		this.inherited(arguments);
		this.paramsChanged();
	},

	paramsChanged: function() {
		var p = enyo.windowParams || {};
		JF.log("dashboard: " + (p.title || "") + (p.playing === undefined ? "" : p.playing ? " (playing)" : " (paused)"));
		if (p.title !== undefined) {
			this.$.title.setContent(p.title);
		}
		if (p.artist !== undefined) {
			this.$.artist.setContent(p.artist);
		}
		if (p.image !== undefined) {
			this.$.art.applyStyle("background-image", p.image ? "url('" + p.image + "')" : "none");
		}
		if (p.playing !== undefined) {
			// Playing shows the pause button, paused shows play.
			this.$.playButton.addRemoveClass("jf-dash-pause", !!p.playing);
		}
	},

	send: function(command) {
		var app = enyo.windows.getRootWindow();
		if (app) {
			// The time makes each press a change, so the same button works twice running.
			enyo.windows.setWindowParams(app, {musicCommand: command, at: new Date().getTime()});
		}
	},

	previousClick: function() { this.send("previous"); },
	playClick: function() { this.send("playpause"); },
	nextClick: function() { this.send("next"); },

	openApp: function() {
		var app = enyo.windows.getRootWindow();
		if (app) {
			enyo.windows.activateWindow(app, {});
		}
	}
});
