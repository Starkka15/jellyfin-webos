/* One movie or episode: artwork, details and the Play buttons. */
enyo.kind({
	name: "JF.DetailView",
	kind: enyo.VFlexBox,
	className: "jf-view jf-detail-view",
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
					{name: "mediaGroup", className: "jf-detail-media", showing: false, components: [
						{name: "mediaInfo", className: "jf-detail-meta", showing: false, components: [
							{name: "videoInfo"},
							{name: "audioInfo"}
						]},
						{name: "sourceRow", kind: "VFlexBox", className: "jf-detail-source", showing: false, components: [
							{content: "Source", className: "jf-detail-source-label"},
							{name: "sourceSelector", kind: "ListSelector", className: "jf-detail-source-selector",
								onChange: "sourceChanged"}
						]},
						{name: "probeNote", className: "jf-detail-probe", showing: false}
					]},
					{kind: "HFlexBox", className: "jf-detail-actions", components: [
						{name: "resume", kind: "Button", caption: "Resume", className: "enyo-button-affirmative",
							onclick: "resumeClick", showing: false},
						{name: "play", kind: "Button", caption: "Play", className: "enyo-button-affirmative",
							onclick: "playClick"},
						{name: "playSettings", kind: "Button", caption: "Playback settings", onclick: "playSettingsClick", showing: false},
						{name: "more", kind: "Button", caption: "More", onclick: "moreClick"}
					]},
					{name: "downloadStatus", className: "jf-download-status", showing: false},
					{name: "note", className: "jf-message"},
					{name: "overview", className: "jf-detail-overview"}
				]}
			]}
		]},
		{name: "menu", kind: "PopupSelect", className: "jf-detail-menu", onSelect: "menuSelect"},
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
		]},
		// These are deliberately independent: the chosen player and whether the
		// Mac mini is required answer two different questions.
		{name: "playDialog", kind: "ModalDialog", className: "jf-detail-settings", caption: "Playback settings", lazy: false, components: [
			{kind: "RowGroup", components: [
				{kind: "Item", layoutKind: "HFlexLayout", align: "center", components: [
					{content: "Player", flex: 1},
					{name: "playPlayer", kind: "ListSelector", items: [
						{caption: "System video player", value: "system"},
						{caption: "In-app player", value: "embedded"}
					]}
				]},
				{kind: "Item", layoutKind: "HFlexLayout", align: "center", components: [
					{content: "Playback route", flex: 1},
					{name: "playMode", kind: "ListSelector", items: [
						{caption: "Auto", value: "auto"},
						{caption: "LAN bridge (experimental)", value: "mini"}
					]}
				]}
			]},
			{className: "jf-dialog-note", content: "Auto plays compatible sources directly. Other sources use the configured bridge or the Jellyfin server."},
			{kind: "HFlexBox", components: [
				{kind: "Button", caption: "Cancel", flex: 1, onclick: "closePlaySettings"},
				{kind: "Button", caption: "Save", flex: 1, className: "enyo-button-affirmative", onclick: "savePlaySettings"}
			]}
		]}
	],

	create: function() {
		this.inherited(arguments);
		var selectors = [this.$.sourceSelector, this.$.playPlayer, this.$.playMode];
		for (var i = 0; i < selectors.length; i++) {
			if (selectors[i] && selectors[i].popup) {
				selectors[i].popup.addClass("jf-detail-menu");
			}
		}
	},

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
		this.probeSerial = (this.probeSerial || 0) + 1;
		this.probeInfo = null;
		this.setPlaybackDisabled(false);
		var video = item.MediaType === "Video";
		var playable = video || item.MediaType === "Audio";
		var position = (item.UserData && item.UserData.PlaybackPositionTicks) || 0;
		this.$.title.setContent(item.SeriesName || item.Name || "");
		this.$.name.setContent(this.nameFor(item));
		this.$.meta.setContent(this.metaFor(item));
		var source = this.setSourceOptions(item);
		var mediaInfo = this.mediaInfoFor(item, source);
		this.$.mediaGroup.setShowing(!!mediaInfo || (item.MediaSources || []).length > 1);
		this.$.mediaInfo.setShowing(!!mediaInfo);
		if (mediaInfo) {
			this.$.videoInfo.setContent(mediaInfo.video);
			this.$.audioInfo.setContent(mediaInfo.audio);
		}
		this.probeSelectedSource(item, source, this.probeSerial);
		this.$.overview.setContent(item.Overview || "");
		var url = JF.api.imageUrl(item, 480);
		this.$.art.applyStyle("background-image", url ? "url('" + url + "')" : "none");
		this.$.play.setShowing(playable && !(video && position > 0));
		this.$.play.setCaption("Play");
		this.$.resume.setShowing(video && position > 0);
		this.$.resume.setCaption("Resume at " + JF.api.ticksToText(position));
		this.$.playSettings.setShowing(video);
		this.watchedCaption = item.UserData && item.UserData.Played ? "Mark Unwatched" : "Mark Watched";
		this.favoriteCaption = JF.api.favoriteCaption(item);
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
		this.downloadCaption = captions[state];
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

	// Keep secondary video actions available without making the detail header wider
	// than the TouchPad's portrait viewport.
	moreClick: function() {
		var item = this.item;
		var video = item && item.MediaType === "Video";
		var position = (item && item.UserData && item.UserData.PlaybackPositionTicks) || 0;
		var items = [];
		if (video && position > 0) {
			items.push({caption: "Play from Start", value: "start"});
		}
		if (video) {
			items.push({caption: this.watchedCaption || "Mark Watched", value: "watched"});
			items.push({caption: this.downloadCaption || "Download", value: "download"});
			items.push({caption: "Play via LAN bridge (experimental)", value: "mini"});
		}
		if (item) {
			items.push({caption: this.favoriteCaption || "Add to Favorites", value: "favorite"});
		}
		this.$.menu.setItems(items);
		this.$.menu.openAroundControl(this.$.more);
	},

	menuSelect: function(inSender, inItem) {
		var action = inItem.getValue();
		if (action === "start") {
			this.playClick();
		} else if (action === "watched") {
			this.watchedClick();
		} else if (action === "download") {
			this.downloadClick();
		} else if (action === "mini") {
			this.forceMacClick();
		} else if (action === "favorite") {
			this.favoriteClick();
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
		var text = (mb ? "At most about " + mb + " MB. " : "") + "Subtitles are drawn into the picture.";
		var note = this.$.dlEstimate;
		note.setContent(text);
		JF.downloads.freeSpace(function(free) {
			if (free !== null && note.getContent() === text) {
				note.setContent(text + " " + JF.downloads.sizeText(free) + " free.");
			}
		});
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

	// A chosen source must stand on its own: source-level streams from another
	// file can describe a different audio track or codec. Brief library records
	// can lack sources; the full item in open() redraws this later.
	streamFor: function(item, source, type) {
		var list = source ? (source.MediaStreams || []) : (item.MediaStreams || []);
		var fallback = null, preferred = null;
		for (var i = 0; i < list.length; i++) {
			var stream = list[i];
			if (stream.Type !== type) {
				continue;
			}
			if (type === "Audio" && source && source.DefaultAudioStreamIndex !== undefined &&
				source.DefaultAudioStreamIndex !== null && stream.Index === source.DefaultAudioStreamIndex) {
				return stream;
			}
			if (!fallback) {
				fallback = stream;
			}
			if (type === "Audio" && stream.IsDefault) {
				preferred = stream;
			}
		}
		return preferred || fallback;
	},

	sourceById: function(item, sourceId) {
		var sources = item && item.MediaSources || [];
		if (sourceId === undefined || sourceId === null) {
			return null;
		}
		for (var i = 0; i < sources.length; i++) {
			if (String(sources[i].Id) === String(sourceId)) {
				return sources[i];
			}
		}
		return null;
	},

	sourceFor: function(item) {
		var sources = item && item.MediaSources || [];
		return this.sourceById(item, this.selectedSourceId) || sources[0] || null;
	},

	sourceLabel: function(item, source) {
		var video = this.streamFor(item, source, "Video");
		var codec = (video && video.Codec) || source.VideoCodec;
		var width = (video && video.Width) || source.Width;
		var height = (video && video.Height) || source.Height;
		var container = source.Container;
		return (codec ? String(codec).toUpperCase() : "Unknown codec") + " · " +
			(width && height ? width + "×" + height : "Unknown resolution") + " · " +
			(container ? String(container).toUpperCase() : "Unknown container");
	},

	setSourceOptions: function(item) {
		var sources = item && item.MediaSources || [];
		var source;
		if (this.sourceItemId !== (item && item.Id)) {
			this.sourceItemId = item && item.Id;
			this.selectedSourceId = null;
		}
		source = this.sourceById(item, this.selectedSourceId);
		if (!source && sources.length) {
			source = sources[0];
			this.selectedSourceId = source.Id;
		}
		if (!sources.length) {
			this.selectedSourceId = null;
		}
		this.$.sourceRow.setShowing(sources.length > 1);
		this.$.sourceSelector.setItems(this.sourceItems(item, sources));
		this.$.sourceSelector.setValue(this.selectedSourceId);
		return source || null;
	},

	sourceItems: function(item, sources) {
		var items = [];
		for (var i = 0; i < sources.length; i++) {
			items.push({caption: this.sourceLabel(item, sources[i]), value: sources[i].Id});
		}
		return items;
	},

	sourceChanged: function(inSender) {
		var sourceId = inSender.getValue();
		var source = this.sourceById(this.item, sourceId);
		if (!source) {
			return;
		}
		this.selectedSourceId = source.Id;
		var mediaInfo = this.mediaInfoFor(this.item, source);
		this.$.mediaInfo.setShowing(!!mediaInfo);
		if (mediaInfo) {
			this.$.videoInfo.setContent(mediaInfo.video);
			this.$.audioInfo.setContent(mediaInfo.audio);
		}
		this.probeSerial = (this.probeSerial || 0) + 1;
		this.probeInfo = null;
		this.setPlaybackDisabled(false);
		this.probeSelectedSource(this.item, source, this.probeSerial);
	},

	bitrateText: function(value) {
		if (typeof value === "string") {
			value = parseInt(value, 10);
		}
		if (typeof value !== "number" || !isFinite(value) || value <= 0) {
			return "";
		}
		var kbps = Math.round(value / 1000);
		return kbps >= 1000 ? Math.round(kbps / 100) / 10 + " Mb/s" : kbps + " kb/s";
	},

	mediaInfoFor: function(item, source, actual) {
		if (!item || item.MediaType !== "Video") {
			return null;
		}
		if (source === undefined) {
			source = this.sourceFor ? this.sourceFor(item) :
				(item.MediaSources && item.MediaSources[0]) || null;
		}
		var video = this.streamFor(item, source, "Video");
		var audio = this.streamFor(item, source, "Audio");
		var actualVideo = actual && actual.video;
		var actualAudio = actual && actual.audio;
		var videoCodec = (actualVideo && actualVideo.codec) || (video && video.Codec) ||
			(source && source.VideoCodec) || (!source && item.VideoCodec);
		var audioCodec = (actualAudio && actualAudio.codec) || (audio && audio.Codec) ||
			(source && source.AudioCodec) || (!source && item.AudioCodec);
		var width = (actualVideo && actualVideo.width) || (video && video.Width) ||
			(source && source.Width) || (!source && item.Width);
		var height = (actualVideo && actualVideo.height) || (video && video.Height) ||
			(source && source.Height) || (!source && item.Height);
		var container = (source && source.Container) || (!source && item.Container);
		var range = actual ? this.probeHdrText(actual) :
			(video && (video.VideoRangeType || video.VideoRange)) ||
			(source && (source.VideoRangeType || source.VideoRange)) ||
			(!source && (item.VideoRangeType || item.VideoRange));
		var bitrate = (source && source.Bitrate) || (video && video.Bitrate) || (!source && item.Bitrate);
		var videoParts = ["Video: " + (videoCodec ? String(videoCodec).toUpperCase() : "Unknown codec"),
			width && height ? width + "×" + height : "Unknown resolution",
			container ? String(container).toUpperCase() : "Unknown container"];
		if (actualVideo && actualVideo.bitDepth) {
			videoParts.push(actualVideo.bitDepth + "-bit");
		}
		if (range) {
			videoParts.push("Range: " + range);
		}
		var bitrateText = this.bitrateText(bitrate);
		if (bitrateText) {
			videoParts.push(bitrateText);
		}
		var channelCount = (actualAudio && actualAudio.channels) || (audio && audio.Channels);
		return {video: videoParts.join(" · "), audio: "Audio: " +
			(audioCodec ? String(audioCodec).toUpperCase() : "Unknown codec") + " · " +
			(channelCount ? channelCount + " ch" : "Unknown channels")};
	},

	probeHdrText: function(actual) {
		var kind = actual && String(actual.hdrKind || "").toLowerCase();
		var video = actual && actual.video || {};
		if (kind === "dolby-vision") {
			return "Dolby Vision" + (video.dolbyVisionProfile !== undefined ?
				" Profile " + video.dolbyVisionProfile : "");
		}
		if (kind === "hdr10") return "HDR10";
		if (kind === "hlg") return "HLG";
		if (kind === "sdr") return "SDR";
		return "Unknown";
	},

	setProbeNote: function(text) {
		if (!this.$.probeNote) return;
		this.$.probeNote.setContent(text || "");
		this.$.probeNote.setShowing(!!text);
	},

	setPlaybackDisabled: function(disabled) {
		if (this.$.play && this.$.play.setDisabled) {
			this.$.play.setDisabled(!!disabled);
		}
		if (this.$.resume && this.$.resume.setDisabled) {
			this.$.resume.setDisabled(!!disabled);
		}
	},

	shouldDisableForProbe: function(item, source, info) {
		var kind, video, transfer, decision;
		if (!info || info.miniSupported !== false) return false;
		kind = String(info.hdrKind || "").toLowerCase();
		video = info.video || {};
		transfer = String(video.colorTransfer || "").toLowerCase();
		// Actual HDR/Dolby facts override a stale server SDR label: these routes
		// cannot safely fall back to the TouchPad's direct player.
		if (kind === "hdr10" || kind === "hlg" || kind === "dolby-vision" ||
			video.dolbyVisionProfile !== undefined || /smpte2084|arib-std-b67/.test(transfer)) {
			return true;
		}
		// For non-HDR sources, only a route that was already non-direct needs Mini.
		decision = JF.choosePlayback ? JF.choosePlayback(item, source, null, false) : null;
		return !!decision && !decision.direct;
	},

	probeSelectedSource: function(item, source, token) {
		var self = this;
		this.setPlaybackDisabled(false);
		if (!item || item.MediaType !== "Video" || !source || !this.streamFor(item, source, "Video")) {
			this.setProbeNote("");
			return;
		}
		if (!JF.miniProbeConfigured || !JF.miniProbeConfigured()) {
			this.setProbeNote("Source metadata from the server.");
			return;
		}
		var apply = function(ok, info) {
			if (token !== self.probeSerial || self.item !== item ||
				String(self.selectedSourceId) !== String(source.Id)) return;
			if (!ok || !info || String(info.mediaSourceId) !== String(source.Id)) {
				self.probeInfo = null;
				self.setPlaybackDisabled(false);
				self.setProbeNote("Source probe failed. Showing server metadata.");
				return;
			}
			self.probeInfo = info;
			self.setPlaybackDisabled(self.shouldDisableForProbe(item, source, info));
			var mediaInfo = self.mediaInfoFor(item, source, info);
			self.$.mediaInfo.setShowing(!!mediaInfo);
			if (mediaInfo) {
				self.$.videoInfo.setContent(mediaInfo.video);
				self.$.audioInfo.setContent(mediaInfo.audio);
			}
			if (info.hdrKind === "dolby-vision" && info.video &&
				String(info.video.dolbyVisionProfile) === "5" && info.miniSupported === false) {
				self.setProbeNote("The bridge cannot convert this Dolby Vision Profile 5 source. Choose another version.");
			} else {
				self.setProbeNote("");
			}
		};
		var cached = JF.cachedVideoProbe ? JF.cachedVideoProbe(item, source) : null;
		if (cached) {
			apply(true, cached);
			return;
		}
		this.setProbeNote("Checking the selected source…");
		if (JF.probeVideo) {
			JF.probeVideo(item, source, apply);
		} else {
			apply(false, null);
		}
	},

	watchedClick: function() {
		var self = this;
		var item = this.item;
		var played = !(item.UserData && item.UserData.Played);
		this.$.more.setDisabled(true);
		JF.api.setPlayed(item.Id, played, function(ok) {
			self.$.more.setDisabled(false);
			if (ok && self.item === item) {
				self.open(item);  // fetch the record again and redraw
			}
		});
	},

	favoriteClick: function() {
		var self = this;
		this.$.more.setDisabled(true);
		JF.api.toggleFavorite(this.item, function() {
			self.$.more.setDisabled(false);
			self.favoriteCaption = JF.api.favoriteCaption(self.item);
		});
	},

	playSettingsClick: function() {
		var settings = JF.playbackSettings();
		this.$.playPlayer.setValue(settings.player);
		this.$.playMode.setValue(settings.mode);
		this.$.playDialog.openAtCenter();
	},

	closePlaySettings: function() {
		this.$.playDialog.close();
	},

	savePlaySettings: function() {
		localStorage.setItem("jf.videoPlayer", this.$.playPlayer.getValue() === "embedded" ? "embedded" : "system");
		localStorage.setItem("jf.videoMode", this.$.playMode.getValue() === "mini" ? "mini" : "auto");
		this.$.playDialog.close();
	},

	forceMacClick: function() {
		this.doPlay(this.item, 0, JF.playbackSettings({mode: "mini"}), this.selectedSourceId);
	},

	playClick: function() {
		JF.log("tap: play from start");
		this.doPlay(this.item, 0, JF.playbackSettings(), this.selectedSourceId);
	},

	resumeClick: function() {
		JF.log("tap: resume");
		this.doPlay(this.item, (this.item.UserData && this.item.UserData.PlaybackPositionTicks) || 0,
			JF.playbackSettings(), this.selectedSourceId);
	}
});
