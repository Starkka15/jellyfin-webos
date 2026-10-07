/* One album: cover, details, a Play button and the track list. Tapping a track
 * plays the album from that track.
 */
enyo.kind({
	name: "JF.AlbumView",
	kind: enyo.VFlexBox,
	className: "jf-view",
	events: {
		onPlayTracks: "",
		onBack: ""
	},
	components: [
		{kind: "PageHeader", className: "jf-header", components: [
			{kind: "Button", caption: "Back", onclick: "doBack"},
			{name: "title", content: "", flex: 1, className: "jf-header-title jf-header-indent"}
		]},
		{name: "scroller", kind: "Scroller", flex: 1, components: [
			{kind: "HFlexBox", className: "jf-detail", components: [
				{name: "art", className: "jf-album-art"},
				{flex: 1, className: "jf-detail-info", components: [
					{name: "name", className: "jf-detail-name"},
					{name: "artist", className: "jf-album-artist"},
					{name: "meta", className: "jf-detail-meta"},
					{kind: "HFlexBox", className: "jf-detail-buttons", components: [
						{name: "play", kind: "Button", caption: "Play", className: "enyo-button-affirmative",
							onclick: "playClick", disabled: true}
					]},
					{name: "message", className: "jf-message"},
					{name: "tracks", className: "jf-tracks"}
				]}
			]}
		]}
	],

	open: function(album) {
		var self = this;
		this.album = album;
		this.tracks = [];
		this.$.title.setContent(album.Name || "");
		this.$.name.setContent(album.Name || "");
		this.$.artist.setContent(album.AlbumArtist || (album.Artists || []).join(", ") || "");
		this.$.meta.setContent(album.ProductionYear ? String(album.ProductionYear) : "");
		var url = JF.api.imageUrl(album, 480);
		this.$.art.applyStyle("background-image", url ? "url('" + url + "')" : "none");
		this.$.play.setDisabled(true);
		this.$.tracks.destroyControls();
		this.$.tracks.render();
		this.$.message.setContent("Loading…");
		this.$.scroller.setScrollTop(0);
		JF.api.albumTracks(album, function(ok, data, status) {
			if (album !== self.album) {
				return;
			}
			if (!ok) {
				self.$.message.setContent("Could not load the tracks (" + (status || "no answer") + ").");
				return;
			}
			self.showTracks((data && data.Items) || []);
		});
	},

	showTracks: function(tracks) {
		this.tracks = tracks = this.inOrder(tracks);
		var discs = {};
		var total = 0;
		for (var i = 0; i < tracks.length; i++) {
			discs[tracks[i].ParentIndexNumber || 1] = true;
			total += tracks[i].RunTimeTicks || 0;
		}
		var manyDiscs = Object.keys ? Object.keys(discs).length > 1 : false;
		for (i = 0; i < tracks.length; i++) {
			this.$.tracks.createComponent({kind: "JF.TrackRow", item: tracks[i], position: i,
				showDisc: manyDiscs, albumArtist: this.album.AlbumArtist, onRowClick: "rowClick", owner: this});
		}
		this.$.tracks.render();
		var meta = [];
		if (this.album.ProductionYear) {
			meta.push(this.album.ProductionYear);
		}
		meta.push(tracks.length + (tracks.length === 1 ? " track" : " tracks"));
		if (total) {
			meta.push(JF.api.ticksToText(total));
		}
		this.$.meta.setContent(meta.join("  ·  "));
		this.$.message.setContent(tracks.length ? "" : "No tracks.");
		this.$.play.setDisabled(!tracks.length);
	},

	// Files without track numbers come back sorted by name as text (1, 10, 11,
	// 2...). Then go by the number the names start with, if they have one.
	inOrder: function(tracks) {
		var numbered = true;
		for (var i = 0; i < tracks.length; i++) {
			if (!tracks[i].IndexNumber) {
				numbered = false;
			}
		}
		if (numbered) {
			return tracks;
		}
		var lead = function(t) {
			var m = /^\s*(\d+)/.exec(t.Name || "");
			return m ? parseInt(m[1], 10) : 100000;
		};
		var keyed = [];
		for (i = 0; i < tracks.length; i++) {
			keyed.push({t: tracks[i], disc: tracks[i].ParentIndexNumber || 1, n: tracks[i].IndexNumber || lead(tracks[i]), i: i});
		}
		keyed.sort(function(a, b) {
			return (a.disc - b.disc) || (a.n - b.n) || (a.i - b.i);
		});
		var out = [];
		for (i = 0; i < keyed.length; i++) {
			out.push(keyed[i].t);
		}
		return out;
	},

	playClick: function() {
		if (this.tracks.length) {
			this.doPlayTracks(this.tracks, 0);
		}
	},

	rowClick: function(inSender, position) {
		this.doPlayTracks(this.tracks, position);
	}
});

/* One line in an album's track list. */
enyo.kind({
	name: "JF.TrackRow",
	kind: enyo.HFlexBox,
	align: "center",
	className: "jf-track",
	published: {
		item: null,
		position: 0,
		showDisc: false,
		albumArtist: ""
	},
	events: {
		onRowClick: ""
	},
	components: [
		{name: "number", className: "jf-track-number"},
		{flex: 1, components: [
			{name: "name", className: "jf-track-name"},
			{name: "artist", className: "jf-track-artist"}
		]},
		{name: "length", className: "jf-track-length"}
	],

	create: function() {
		this.inherited(arguments);
		var t = this.item;
		var n = t.IndexNumber ? String(t.IndexNumber) : "";
		if (this.showDisc && t.ParentIndexNumber) {
			n = t.ParentIndexNumber + "-" + n;
		}
		this.$.number.setContent(n);
		this.$.name.setContent(t.Name || "");
		// Only name the artist where it differs from the album's.
		var artist = (t.Artists || []).join(", ");
		this.$.artist.setContent(artist && artist !== this.albumArtist ? artist : "");
		this.$.artist.setShowing(!!this.$.artist.getContent());
		this.$.length.setContent(t.RunTimeTicks ? JF.api.ticksToClock(t.RunTimeTicks) : "");
	},

	clickHandler: function() {
		this.doRowClick(this.position);
		return true;
	}
});
