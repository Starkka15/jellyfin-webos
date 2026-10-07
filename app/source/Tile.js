/* One poster in a grid: artwork, a title and an optional second line. */
enyo.kind({
	name: "JF.Tile",
	kind: enyo.Control,
	className: "jf-tile",
	published: {
		item: null
	},
	events: {
		onTileClick: ""
	},
	components: [
		{name: "art", className: "jf-tile-art", components: [
			{name: "letter", className: "jf-tile-letter"},
			{name: "badge", className: "jf-tile-badge", showing: false},
			{name: "progress", className: "jf-tile-progress", showing: false, components: [
				{name: "progressBar", className: "jf-tile-progress-bar"}
			]}
		]},
		{name: "title", className: "jf-tile-title"},
		{name: "sub", className: "jf-tile-sub"}
	],

	create: function() {
		this.inherited(arguments);
		this.itemChanged();
	},

	itemChanged: function() {
		var item = this.item;
		if (!item) {
			return;
		}
		if (/^(MusicAlbum|Audio|MusicArtist|MusicGenre|Playlist|TrackList)$/.test(item.Type)) {
			this.addClass("jf-tile-square");
		}
		var url = JF.api.imageUrl(item, 330);
		if (url) {
			this.$.art.applyStyle("background-image", "url('" + url + "')");
			this.$.letter.setContent("");
		} else {
			// No artwork: show the first letter on a plain block.
			this.$.letter.setContent((item.Name || "?").charAt(0).toUpperCase());
		}
		// Watched state: a tick when seen, a count of unseen episodes on a
		// series, and a bar when part-way through.
		var data = item.UserData || {};
		// The tick is drawn in CSS (jf-tile-seen): the TouchPad font has no ✓.
		var count = data.UnplayedItemCount ? String(data.UnplayedItemCount) : "";
		var seen = !count && !!data.Played;
		this.$.badge.setContent(count);
		this.$.badge.addRemoveClass("jf-tile-seen", seen);
		this.$.badge.setShowing(!!count || seen);
		var percent = data.PlayedPercentage || 0;
		this.$.progress.setShowing(percent > 0 && percent < 100);
		this.$.progressBar.applyStyle("width", Math.round(percent) + "%");
		this.$.title.setContent(this.titleFor(item));
		this.$.sub.setContent(this.subFor(item));
	},

	titleFor: function(item) {
		if (item.Type === "Episode" && item.IndexNumber) {
			return item.IndexNumber + ". " + (item.Name || "");
		}
		return item.Name || "";
	},

	subFor: function(item) {
		if (item.Type === "Episode" && item.SeriesName) {
			return item.SeriesName;
		}
		if (item.Type === "MusicAlbum" || item.Type === "Audio") {
			return item.AlbumArtist || (item.Artists || []).join(", ");
		}
		// An artist's "year" is a birth or founding year; it means nothing on a tile.
		if (item.ProductionYear && item.Type !== "MusicArtist" && item.Type !== "MusicGenre") {
			return String(item.ProductionYear);
		}
		return "";
	},

	// Enyo 1 routes a DOM click on this control to a method named clickHandler.
	clickHandler: function(inSender, inEvent) {
		this.doTileClick(this.item);
		return true;
	}
});
