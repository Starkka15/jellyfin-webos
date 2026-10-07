/* One movie or episode: artwork, details and the Play buttons. */
enyo.kind({
	name: "JF.DetailView",
	kind: enyo.VFlexBox,
	className: "jf-view",
	events: {
		onPlay: "",
		onBack: ""
	},
	components: [
		{kind: "PageHeader", className: "jf-header", components: [
			{kind: "Button", caption: "Back", onclick: "doBack"},
			{name: "title", content: "", flex: 1, className: "jf-header-title jf-header-indent"}
		]},
		{kind: "Scroller", flex: 1, components: [
			{kind: "HFlexBox", className: "jf-detail", components: [
				{name: "art", className: "jf-detail-art"},
				{flex: 1, className: "jf-detail-info", components: [
					{name: "name", className: "jf-detail-name"},
					{name: "meta", className: "jf-detail-meta"},
					{kind: "HFlexBox", className: "jf-detail-buttons", components: [
						{name: "resume", kind: "Button", caption: "Resume", className: "enyo-button-affirmative",
							onclick: "resumeClick", showing: false},
						{name: "play", kind: "Button", caption: "Play", className: "enyo-button-affirmative",
							onclick: "playClick"},
						{name: "watched", kind: "Button", caption: "Mark Watched", onclick: "watchedClick"}
					]},
					{name: "note", className: "jf-message"},
					{name: "overview", className: "jf-detail-overview"}
				]}
			]}
		]}
	],

	// Show what we already know, then ask the server for the full record.
	open: function(item) {
		var self = this;
		this.showItem(item);
		JF.api.item(item.Id, function(ok, full) {
			if (ok && full && self.item && full.Id === self.item.Id) {
				self.showItem(full);
			}
		});
	},

	showItem: function(item) {
		this.item = item;
		var video = item.MediaType === "Video";
		var playable = video || item.MediaType === "Audio";
		var position = (item.UserData && item.UserData.PlaybackPositionTicks) || 0;
		this.$.title.setContent(item.SeriesName || item.Name || "");
		this.$.name.setContent(this.nameFor(item));
		this.$.meta.setContent(this.metaFor(item));
		this.$.overview.setContent(item.Overview || "");
		var url = JF.api.imageUrl(item, 480);
		this.$.art.applyStyle("background-image", url ? "url('" + url + "')" : "none");
		this.$.play.setShowing(playable);
		this.$.play.setCaption(position ? "Play from Start" : "Play");
		this.$.resume.setShowing(video && position > 0);
		this.$.resume.setCaption("Resume at " + JF.api.ticksToText(position));
		this.$.watched.setShowing(video);
		this.$.watched.setCaption(item.UserData && item.UserData.Played ? "Mark Unwatched" : "Mark Watched");
		this.$.note.setContent(playable ? "" : "This app cannot play this kind of item yet.");
	},

	nameFor: function(item) {
		if (item.Type === "Episode") {
			var prefix = "";
			if (item.ParentIndexNumber !== undefined && item.IndexNumber !== undefined) {
				prefix = "S" + item.ParentIndexNumber + " E" + item.IndexNumber + " — ";
			}
			return prefix + (item.Name || "");
		}
		return item.Name || "";
	},

	metaFor: function(item) {
		var parts = [];
		if (item.Type === "Audio") {
			if (item.AlbumArtist || item.Artists) {
				parts.push(item.AlbumArtist || item.Artists.join(", "));
			}
			if (item.Album) {
				parts.push(item.Album);
			}
		}
		if (item.ProductionYear) {
			parts.push(item.ProductionYear);
		}
		if (item.RunTimeTicks) {
			parts.push(JF.api.ticksToText(item.RunTimeTicks));
		}
		if (item.OfficialRating) {
			parts.push(item.OfficialRating);
		}
		return parts.join("  ·  ");
	},

	watchedClick: function() {
		var self = this;
		var item = this.item;
		var played = !(item.UserData && item.UserData.Played);
		this.$.watched.setDisabled(true);
		JF.api.setPlayed(item.Id, played, function(ok) {
			self.$.watched.setDisabled(false);
			if (ok && self.item === item) {
				self.open(item);  // fetch the record again and redraw
			}
		});
	},

	playClick: function() {
		JF.log("tap: play from start");
		this.doPlay(this.item, 0);
	},

	resumeClick: function() {
		JF.log("tap: resume");
		this.doPlay(this.item, (this.item.UserData && this.item.UserData.PlaybackPositionTicks) || 0);
	}
});
