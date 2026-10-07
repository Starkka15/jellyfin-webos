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
					// A row of its own: a movie's Resume, Play and Watched already fill the first.
					{kind: "HFlexBox", className: "jf-detail-buttons", components: [
						{name: "download", kind: "Button", caption: "Download", onclick: "downloadClick", showing: false},
						{name: "favorite", kind: "Button", caption: "Add to Favorites", onclick: "favoriteClick"}
					]},
					{name: "downloadStatus", className: "jf-download-status", showing: false},
					{name: "note", className: "jf-message"},
					{name: "overview", className: "jf-detail-overview"}
				]}
			]}
		]},
		// Options for a download: which audio and subtitles go into the file, and how big it gets.
		{name: "dlDialog", kind: "ModalDialog", caption: "Download", lazy: false, components: [
			{kind: "RowGroup", components: [
				{kind: "Item", layoutKind: "HFlexLayout", align: "center", components: [
					{content: "Audio", flex: 1},
					{name: "dlAudio", kind: "ListSelector"}
				]},
				{kind: "Item", layoutKind: "HFlexLayout", align: "center", components: [
					{content: "Subtitles", flex: 1},
					{name: "dlSubtitles", kind: "ListSelector"}
				]},
				{kind: "Item", layoutKind: "HFlexLayout", align: "center", components: [
					{content: "Quality", flex: 1},
					{name: "dlQuality", kind: "ListSelector", onChange: "showEstimate", items: [
						{caption: "Best", value: 3000000},
						{caption: "Smaller", value: 1500000},
						{caption: "Smallest", value: 800000}
					]}
				]}
			]},
			{name: "dlEstimate", className: "jf-dialog-note"},
			{kind: "HFlexBox", components: [
				{kind: "Button", caption: "Cancel", flex: 1, onclick: "closeOptions"},
				{kind: "Button", caption: "Download", flex: 1, className: "enyo-button-affirmative",
					onclick: "confirmDownload"}
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
		this.$.favorite.setCaption(JF.api.favoriteCaption(item));
		this.$.note.setContent(playable ? "" : "This app cannot play this kind of item yet.");
		this.showDownload();
	},

	// ---- offline download ------------------------------------------------------

	showDownload: function() {
		if (!this.listening) {
			this.listening = true;
			JF.downloads.addListener(enyo.bind(this, "showDownload"));
		}
		var item = this.item;
		var video = item && item.MediaType === "Video";
		var e = video ? JF.downloads.get(item.Id) : null;
		var state = e ? e.state : "none";
		var mb = e ? Math.round(e.received / 1048576) : 0;
		var captions = {none: "Download", queued: "Cancel Download", downloading: "Cancel Download",
			done: "Delete Download", failed: "Retry Download"};
		var notes = {
			none: "",
			queued: "Waiting for another download to finish.",
			downloading: "Downloading… " + mb + " MB so far." + (e && e.description ? " " + e.description + "." : ""),
			done: "Downloaded (" + mb + " MB). Plays without a connection." +
				(e && e.description ? " " + e.description + "." : ""),
			failed: e && e.error ? e.error : ""
		};
		this.$.download.setShowing(video);
		this.$.download.setCaption(captions[state]);
		this.$.downloadStatus.setContent(notes[state]);
		this.$.downloadStatus.setShowing(video && !!notes[state]);
	},

	downloadClick: function() {
		var e = JF.downloads.get(this.item.Id);
		if (!e || e.state === "failed") {
			this.openOptions();
		} else {
			JF.downloads.remove(this.item.Id);
		}
	},

	// Start from the player's last language choices and the last quality used.
	openOptions: function() {
		var item = this.item;
		var tracks = JF.api.defaultTracks(item);
		var audio = JF.api.streams(item, "Audio");
		var subs = JF.api.streams(item, "Subtitle");
		var audioItems = [{caption: "Default", value: "default"}];
		for (var i = 0; i < audio.length; i++) {
			audioItems.push({caption: audio[i].title, value: audio[i].index});
		}
		var subItems = [{caption: "Off", value: -1}];
		for (i = 0; i < subs.length; i++) {
			subItems.push({caption: subs[i].title, value: subs[i].index});
		}
		this.$.dlDialog.openAtCenter();
		this.$.dlAudio.setItems(audioItems);
		this.$.dlAudio.setValue(tracks.audioIndex === null ? "default" : tracks.audioIndex);
		this.$.dlSubtitles.setItems(subItems);
		this.$.dlSubtitles.setValue(tracks.subtitleIndex);
		this.$.dlQuality.setValue(parseInt(localStorage.getItem("jf.downloadQuality"), 10) || 3000000);
		this.showEstimate();
	},

	// The server sends at most this much; it often needs less.
	showEstimate: function() {
		var seconds = (this.item.RunTimeTicks || 0) / 10000000;
		var mb = Math.round(seconds * (this.$.dlQuality.getValue() + 192000) / 8 / 1048576);
		this.$.dlEstimate.setContent((mb ? "At most about " + mb + " MB. " : "") +
			"Subtitles are drawn into the picture.");
	},

	closeOptions: function() {
		this.$.dlDialog.close();
	},

	confirmDownload: function() {
		var audio = this.$.dlAudio.getValue();
		var quality = this.$.dlQuality.getValue();
		localStorage.setItem("jf.downloadQuality", String(quality));
		var parts = [];
		var labels = [this.$.dlAudio, this.$.dlSubtitles, this.$.dlQuality];
		var names = ["audio", "subtitles", "quality"];
		for (var i = 0; i < labels.length; i++) {
			var v = labels[i].getValue();
			var items = labels[i].getItems();
			for (var j = 0; j < items.length; j++) {
				if (items[j].value === v) {
					parts.push(names[i] + ": " + items[j].caption);
				}
			}
		}
		this.$.dlDialog.close();
		JF.downloads.start(this.item, {
			audioIndex: audio === "default" ? null : audio,
			subtitleIndex: this.$.dlSubtitles.getValue(),
			maxBitrate: quality,
			description: parts.join(", ")
		});
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

	favoriteClick: function() {
		var self = this;
		this.$.favorite.setDisabled(true);
		JF.api.toggleFavorite(this.item, function() {
			self.$.favorite.setDisabled(false);
			self.$.favorite.setCaption(JF.api.favoriteCaption(self.item));
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
