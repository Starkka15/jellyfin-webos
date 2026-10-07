/* A list of tracks: an album, a playlist, or one of the automatic lists
 * (favorite, recently played, most played; see JF.api.autoLists). Cover,
 * details, Play, Shuffle and More, then the tracks. Tapping a track plays the
 * list from that track; each track's "..." button and the More button open the
 * same menu: Play Next, Add to Queue, Add to Playlist, Instant Mix, Favorite,
 * and for a playlist's own tracks, Remove from Playlist.
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
					{name: "downloadStatus", className: "jf-download-status", showing: false},
					{kind: "HFlexBox", className: "jf-detail-buttons", components: [
						{name: "play", kind: "Button", caption: "Play", className: "enyo-button-affirmative",
							onclick: "playClick", disabled: true},
						{name: "shuffle", kind: "Button", caption: "Shuffle", onclick: "shuffleClick", disabled: true},
						{name: "more", kind: "Button", caption: "More", onclick: "moreClick", disabled: true}
					]},
					{name: "message", className: "jf-message"},
					{name: "tracks", className: "jf-tracks"}
				]}
			]}
		]},
		{name: "menu", kind: "PopupSelect", onSelect: "menuSelect"},
		// Add to Playlist: an existing music playlist, or a new one.
		{name: "playlistDialog", kind: "ModalDialog", caption: "Add to Playlist", lazy: false, components: [
			{name: "playlistScroller", kind: "Scroller", className: "jf-playlist-choices", components: [
				{name: "playlistList", kind: "RowGroup", caption: "Your playlists"}
			]},
			{kind: "RowGroup", caption: "New playlist", components: [
				{name: "newName", kind: "Input", hint: "Name", autoCapitalize: "title"}
			]},
			{name: "playlistNote", className: "jf-dialog-note"},
			{kind: "HFlexBox", components: [
				{kind: "Button", caption: "Cancel", flex: 1, onclick: "closePlaylistDialog"},
				{name: "createButton", kind: "Button", caption: "Create", flex: 1, className: "enyo-button-affirmative",
					onclick: "createPlaylistClick"}
			]}
		]}
	],

	open: function(album) {
		var self = this;
		this.album = album;
		this.tracks = [];
		this.$.title.setContent(album.Name || "");
		this.$.name.setContent(album.Name || "");
		this.$.artist.setContent(album.Type === "Playlist" ? "Playlist" :
			album.Type === "TrackList" ? "Automatic playlist" :
			album.AlbumArtist || (album.Artists || []).join(", ") || "");
		this.$.meta.setContent(album.ProductionYear ? String(album.ProductionYear) : "");
		var url = JF.api.imageUrl(album, 480);
		this.$.art.applyStyle("background-image", url ? "url('" + url + "')" : "none");
		this.$.play.setDisabled(true);
		this.$.shuffle.setDisabled(true);
		this.$.more.setDisabled(true);
		this.$.tracks.destroyControls();
		this.$.tracks.render();
		this.$.message.setContent("Loading…");
		this.$.scroller.setScrollTop(0);
		JF.api.albumTracks(album, function(ok, data, status) {
			if (album !== self.album) {
				return;
			}
			if (!ok) {
				// Offline: an album's downloaded tracks can still be played.
				var local = JF.downloads.albumTracks(album.Id);
				if (local.length) {
					self.showTracks(local);
					self.$.message.setContent("Can't reach the server: showing the downloaded tracks.");
					return;
				}
				self.$.message.setContent("Could not load the tracks (" + (status || "no answer") + ").");
				return;
			}
			self.showTracks((data && data.Items) || []);
		});
	},

	// A playlist or automatic list keeps its own order; an album goes by disc and track.
	listOrder: function() {
		return this.album.Type === "Playlist" || this.album.Type === "TrackList";
	},

	showTracks: function(tracks) {
		var byPosition = this.listOrder();
		this.tracks = tracks = byPosition ? tracks : this.inOrder(tracks);
		var discs = {};
		var total = 0;
		for (var i = 0; i < tracks.length; i++) {
			discs[tracks[i].ParentIndexNumber || 1] = true;
			total += tracks[i].RunTimeTicks || 0;
		}
		var manyDiscs = Object.keys ? Object.keys(discs).length > 1 : false;
		this.$.tracks.destroyControls();
		for (i = 0; i < tracks.length; i++) {
			this.$.tracks.createComponent({kind: "JF.TrackRow", item: tracks[i], position: i,
				showDisc: manyDiscs && !byPosition, albumArtist: this.album.AlbumArtist, numberByPosition: byPosition,
				onRowClick: "rowClick", onMore: "trackMore", owner: this});
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
		this.$.message.setContent(tracks.length ? "" : this.album.Id === "favorites" ?
			"No favorite songs yet. Use a track's \"...\" button to add some." : "No tracks.");
		this.$.play.setDisabled(!tracks.length);
		this.$.shuffle.setDisabled(tracks.length < 2);
		this.$.more.setDisabled(!tracks.length);
		this.showDownloads();
	},

	// "Downloaded 12 of 15 tracks", kept up to date while downloads run.
	showDownloads: function() {
		if (!this.listening) {
			this.listening = true;
			JF.downloads.addListener(enyo.bind(this, "showDownloads"));
		}
		var tracks = this.tracks || [];
		var c = JF.downloads.countFor(tracks);
		var text = "";
		if (c.pending) {
			text = "Downloading: " + c.done + " of " + tracks.length + " tracks done.";
		} else if (c.done) {
			text = c.done === tracks.length ? "Downloaded: plays without a connection." :
				"Downloaded " + c.done + " of " + tracks.length + " tracks.";
		}
		this.$.downloadStatus.setContent(text);
		this.$.downloadStatus.setShowing(!!text);
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

	// The player's shuffle mode: it can be turned off again on the Now Playing screen.
	shuffleClick: function() {
		if (this.tracks.length) {
			this.doPlayTracks(this.tracks, "shuffle");
		}
	},

	rowClick: function(inSender, position) {
		this.doPlayTracks(this.tracks, position);
	},

	// ---- the More menu ---------------------------------------------------------

	// The whole list.
	moreClick: function() {
		var whole = this.album.Type === "MusicAlbum" || this.album.Type === "Playlist" ? this.album : null;
		this.openMenu({tracks: this.tracks, item: whole}, this.$.more);
	},

	// One track.
	trackMore: function(inSender, position, button) {
		this.openMenu({tracks: [this.tracks[position]], item: this.tracks[position], position: position}, button);
	},

	openMenu: function(target, around) {
		this.target = target;
		var items = [
			{caption: "Play Next", value: "next"},
			{caption: "Add to Queue", value: "queue"},
			{caption: "Add to Playlist…", value: "playlist"}
		];
		if (target.item) {
			items.push({caption: "Instant Mix", value: "mix"});
			var fav = target.item.UserData && target.item.UserData.IsFavorite;
			items.push({caption: fav ? "Remove from Favorites" : "Add to Favorites", value: fav ? "unfavorite" : "favorite"});
		}
		var c = JF.downloads.countFor(target.tracks);
		if (c.done + c.pending < target.tracks.length) {
			items.push({caption: target.tracks.length > 1 ? "Download" : "Download Track", value: "download"});
		}
		if (c.done + c.pending > 0) {
			items.push({caption: target.tracks.length > 1 ? "Delete Downloads" : "Delete Download", value: "undownload"});
		}
		if (this.album.Type === "Playlist" && target.position !== undefined && target.item.PlaylistItemId) {
			items.push({caption: "Remove from Playlist", value: "remove"});
		}
		this.$.menu.setItems(items);
		this.$.menu.openAroundControl(around);
	},

	menuSelect: function(inSender, inItem) {
		var self = this;
		var t = this.target;
		var action = inItem.getValue();
		if (action === "next") {
			JF.music.playNext(t.tracks);
		} else if (action === "queue") {
			JF.music.addToQueue(t.tracks);
		} else if (action === "playlist") {
			this.openPlaylistDialog();
		} else if (action === "mix") {
			JF.api.instantMix(t.item.Id, function(ok, data) {
				var mix = (ok && data && data.Items) || [];
				if (mix.length) {
					self.doPlayTracks(mix, 0);
				}
			});
		} else if (action === "favorite" || action === "unfavorite") {
			JF.api.setFavorite(t.item.Id, action === "favorite", function(ok, userData) {
				if (ok) {
					t.item.UserData = userData || t.item.UserData || {};
					t.item.UserData.IsFavorite = action === "favorite";
					if (self.album.Id === "favorites" && action === "unfavorite") {
						self.open(self.album);  // it leaves the favorites list
					}
				}
			});
		} else if (action === "download") {
			for (var i = 0; i < t.tracks.length; i++) {
				JF.downloads.start(t.tracks[i]);
			}
		} else if (action === "undownload") {
			for (var j = 0; j < t.tracks.length; j++) {
				JF.downloads.remove(t.tracks[j].Id);
			}
		} else if (action === "remove") {
			JF.api.removeFromPlaylist(this.album.Id, [t.item.PlaylistItemId], function(ok) {
				if (ok) {
					self.open(self.album);
				}
			});
		}
	},

	// ---- Add to Playlist --------------------------------------------------------

	openPlaylistDialog: function() {
		var self = this;
		this.$.playlistDialog.openAtCenter();
		this.$.newName.setValue("");
		this.$.playlistNote.setContent("Loading your playlists…");
		this.$.playlistList.destroyControls();
		this.$.playlistList.render();
		JF.api.playlists(function(ok, data) {
			var lists = (ok && data && data.Items) || [];
			self.$.playlistList.destroyControls();
			for (var i = 0; i < lists.length; i++) {
				// Not into itself.
				if (lists[i].Id === self.album.Id) {
					continue;
				}
				self.$.playlistList.createComponent({kind: "Item", content: lists[i].Name, playlist: lists[i],
					onclick: "playlistChosen", owner: self});
			}
			self.$.playlistList.render();
			self.$.playlistScroller.setShowing(self.$.playlistList.getControls().length > 0);
			self.$.playlistNote.setContent(lists.length ? "Tap a playlist, or name a new one." :
				"You have no playlists yet. Name one to create it.");
		});
	},

	ids: function() {
		var ids = [];
		for (var i = 0; i < this.target.tracks.length; i++) {
			ids.push(this.target.tracks[i].Id);
		}
		return ids;
	},

	playlistChosen: function(inSender) {
		var self = this;
		var playlist = inSender.playlist;
		this.$.playlistNote.setContent("Adding…");
		JF.api.addToPlaylist(playlist.Id, this.ids(), function(ok) {
			if (ok) {
				self.closePlaylistDialog();
			} else {
				self.$.playlistNote.setContent("Could not add to " + playlist.Name + ".");
			}
		});
	},

	createPlaylistClick: function() {
		var self = this;
		var name = (this.$.newName.getValue() || "").replace(/^\s+|\s+$/g, "");
		if (!name) {
			this.$.playlistNote.setContent("Type a name for the new playlist.");
			return;
		}
		this.$.createButton.setDisabled(true);
		this.$.playlistNote.setContent("Creating…");
		JF.api.createPlaylist(name, this.ids(), function(ok) {
			self.$.createButton.setDisabled(false);
			if (ok) {
				self.closePlaylistDialog();
			} else {
				self.$.playlistNote.setContent("Could not create the playlist.");
			}
		});
	},

	closePlaylistDialog: function() {
		this.$.playlistDialog.close();
	}
});

/* One line in a track list: tap it to play; "..." opens its menu. */
enyo.kind({
	name: "JF.TrackRow",
	kind: enyo.HFlexBox,
	align: "center",
	className: "jf-track",
	published: {
		item: null,
		position: 0,
		showDisc: false,
		numberByPosition: false,
		albumArtist: ""
	},
	events: {
		onRowClick: "",
		onMore: ""
	},
	components: [
		{kind: "HFlexBox", align: "center", flex: 1, onclick: "rowClick", components: [
			{name: "number", className: "jf-track-number"},
			{flex: 1, components: [
				{name: "name", className: "jf-track-name"},
				{name: "artist", className: "jf-track-artist"}
			]},
			{name: "length", className: "jf-track-length"}
		]},
		{name: "moreButton", kind: "Button", caption: "...", className: "jf-track-more", onclick: "moreClick"}
	],

	create: function() {
		this.inherited(arguments);
		var t = this.item;
		var n = this.numberByPosition ? String(this.position + 1) : t.IndexNumber ? String(t.IndexNumber) : "";
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

	rowClick: function() {
		this.doRowClick(this.position);
		return true;
	},

	moreClick: function() {
		this.doMore(this.position, this.$.moreButton);
		return true;
	}
});
