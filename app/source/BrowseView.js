/* The contents of a library, folder, series or season, as a grid of posters. */
enyo.kind({
	name: "JF.BrowseView",
	kind: enyo.VFlexBox,
	className: "jf-view",
	events: {
		onOpen: "",
		onBack: ""
	},
	pageSize: 60,
	// The tabs of each kind of library: the RadioGroup that shows them, and the
	// category each tab stands for (see JF.api.children).
	tabSets: {
		music: {tabs: "musicTabs", categories: ["albums", "artists", "genres", "playlists"]},
		movies: {tabs: "movieTabs", categories: ["all", "unwatched", "favorites", "collections", "genres"]},
		tvshows: {tabs: "showTabs", categories: ["all", "unwatched", "favorites", "genres", "studios"]}
	},
	components: [
		{kind: "PageHeader", className: "jf-header", components: [
			{kind: "Button", caption: "Back", onclick: "doBack"},
			{name: "title", content: "", flex: 1, className: "jf-header-title jf-header-indent"},
			{name: "sortButton", kind: "Button", caption: "Sort", onclick: "sortClick", showing: false},
			{name: "favorite", kind: "Button", caption: "Add to Favorites", onclick: "favoriteClick", showing: false},
			{name: "seasonButton", kind: "Button", caption: "Download Season", onclick: "seasonClick", showing: false},
			{name: "count", content: "", className: "jf-header-count"}
		]},
		// Only for music, movie and show libraries: what the grid shows.
		{name: "musicTabs", kind: "RadioGroup", className: "jf-tabs", onChange: "tabChanged", showing: false, components: [
			{caption: "Albums"}, {caption: "Artists"}, {caption: "Genres"}, {caption: "Playlists"}
		]},
		{name: "movieTabs", kind: "RadioGroup", className: "jf-tabs", onChange: "tabChanged", showing: false, components: [
			{caption: "Movies"}, {caption: "Unwatched"}, {caption: "Favorites"}, {caption: "Collections"},
			{caption: "Genres"}
		]},
		{name: "showTabs", kind: "RadioGroup", className: "jf-tabs", onChange: "tabChanged", showing: false, components: [
			{caption: "Shows"}, {caption: "Unwatched"}, {caption: "Favorites"}, {caption: "Genres"}, {caption: "Studios"}
		]},
		{name: "scroller", kind: "Scroller", flex: 1, components: [
			{name: "message", className: "jf-message"},
			{name: "seasonStatus", className: "jf-message", showing: false},
			{name: "grid", className: "jf-grid"},
			{name: "more", kind: "Button", caption: "Show More", onclick: "loadMore", showing: false,
				className: "jf-more"}
		]},
		{name: "sortMenu", kind: "PopupSelect", onSelect: "sortSelected"},
		// Download a season: which episodes, and how big. Each episode gets the
		// player's usual audio and subtitle languages, as a single download does.
		{name: "seasonDialog", kind: "ModalDialog", caption: "Download Season", lazy: false, components: [
			{kind: "RowGroup", components: [
				{kind: "Item", layoutKind: "HFlexLayout", align: "center", components: [
					{content: "Episodes", flex: 1},
					{name: "seasonWhich", kind: "ListSelector", onChange: "showSeasonEstimate", items: [
						{caption: "All", value: "all"},
						{caption: "Unwatched", value: "unwatched"}
					]}
				]},
				{kind: "Item", layoutKind: "HFlexLayout", align: "center", components: [
					{content: "Quality", flex: 1},
					{name: "seasonQuality", kind: "ListSelector", onChange: "showSeasonEstimate", items: [
						{caption: "Best", value: 3000000},
						{caption: "Smaller", value: 1500000},
						{caption: "Smallest", value: 800000}
					]}
				]}
			]},
			{name: "seasonEstimate", className: "jf-dialog-note"},
			{kind: "HFlexBox", components: [
				{kind: "Button", caption: "Cancel", flex: 1, onclick: "closeSeasonDialog"},
				{name: "seasonGo", kind: "Button", caption: "Download", flex: 1, className: "enyo-button-affirmative",
					onclick: "confirmSeason"}
			]}
		]}
	],

	// Show the children of this item, from the top.
	open: function(parent) {
		this.parentItem = parent;
		var set = this.tabSets[parent.CollectionType];
		for (var type in this.tabSets) {
			this.$[this.tabSets[type].tabs].setShowing(this.tabSets[type] === set);
		}
		if (set) {
			parent.category = parent.category || set.categories[0];
			this.$[set.tabs].setValue(enyo.indexOf(parent.category, set.categories));
		}
		this.sortType = this.sortTypeFor(parent);
		this.$.sortButton.setShowing(!!this.sortType);
		if (this.sortType) {
			this.$.sortButton.setCaption(JF.phone ? "Sort" : "Sort: " + JF.api.sortFor(this.sortType).choice[1]);
		}
		// A show opens here, not on a detail page, so it is made a favorite here.
		this.$.favorite.setShowing(parent.Type === "Series" || parent.Type === "BoxSet");
		this.$.favorite.setCaption(JF.api.favoriteCaption(parent));
		this.$.seasonButton.setShowing(parent.Type === "Season");
		this.$.seasonButton.setCaption(JF.phone ? "Download" : "Download Season");
		this.seasonEpisodes = null;
		this.statusLoading = false;
		this.showSeasonStatus();
		this.loaded = 0;
		this.total = 0;
		this.$.title.setContent(this.titleFor(parent));
		this.$.count.setContent("");
		this.$.grid.destroyControls();
		this.$.grid.render();
		this.$.more.setShowing(false);
		this.$.scroller.setScrollTop(0);
		this.loadMore();
	},

	// Lists of movies or shows can be sorted; lists of genres, studios and collections go by name.
	sortTypeFor: function(parent) {
		var type = parent.CollectionType;
		if (type === "movies" || type === "tvshows") {
			return /^(all|unwatched|favorites)$/.test(parent.category) ? type : null;
		}
		return parent.Type === "Genre" || parent.Type === "Studio" ? parent.libraryType : null;
	},

	titleFor: function(parent) {
		if (parent.Type === "Season" && parent.SeriesName) {
			return parent.SeriesName + " — " + parent.Name;
		}
		return parent.Name || "";
	},

	loadMore: function() {
		var self = this;
		var parent = this.parentItem;
		this.$.message.setContent("Loading…");
		this.$.more.setDisabled(true);
		JF.api.children(parent, this.loaded, this.pageSize, function(ok, data, status) {
			if (parent !== self.parentItem) {
				return;  // the user moved on while this was loading
			}
			self.$.more.setDisabled(false);
			if (!ok) {
				self.$.message.setContent("Could not load this (" + (status || "no answer") + ").");
				return;
			}
			var items = data.Items || [];
			var playlists = parent.CollectionType === "music" && parent.category === "playlists";
			// The Playlists tab starts with the automatic lists; they are not counted in the paging.
			if (playlists && self.loaded === 0) {
				for (var a = 0; a < JF.api.autoLists.length; a++) {
					self.$.grid.createComponent({kind: "JF.Tile", item: JF.api.autoLists[a], onTileClick: "tileClick",
						owner: self});
				}
			}
			for (var i = 0; i < items.length; i++) {
				// A genre or studio page lists what it has in this library.
				if (/^(MusicGenre|Genre|Studio)$/.test(items[i].Type)) {
					items[i].libraryId = parent.Id;
					items[i].libraryType = parent.CollectionType;
				}
				self.$.grid.createComponent({kind: "JF.Tile", item: items[i], onTileClick: "tileClick", owner: self});
			}
			self.$.grid.render();
			self.loaded += items.length;
			self.total = data.TotalRecordCount || self.loaded;
			self.$.message.setContent(self.loaded || playlists ? "" : self.emptyText(parent));
			self.$.count.setContent(self.total ? self.loaded + " of " + self.total : "");
			self.$.more.setShowing(items.length > 0 && self.loaded < self.total);
		});
	},

	emptyText: function(parent) {
		if (parent.category === "favorites") {
			return "No favorites yet. Add them from a movie or show's page.";
		}
		if (parent.category === "collections") {
			return "No collections on this server.";
		}
		if (parent.category === "unwatched") {
			return "You have watched everything here.";
		}
		return "Nothing here.";
	},

	tabChanged: function(inSender) {
		var set = this.tabSets[this.parentItem && this.parentItem.CollectionType];
		if (!set || this.$[set.tabs] !== inSender) {
			return;
		}
		var category = set.categories[inSender.getValue()];
		if (category !== this.parentItem.category) {
			this.parentItem.category = category;
			this.open(this.parentItem);
		}
	},

	// ---- sorting -------------------------------------------------------------

	// MenuCheckItem draws its tick from an image: the TouchPad font has no ✓.
	sortClick: function() {
		if (!this.sortType) {
			return;
		}
		var sort = JF.api.sortFor(this.sortType);
		var choices = JF.api.sortChoices[this.sortType];
		var items = [];
		for (var i = 0; i < choices.length; i++) {
			items.push({kind: "MenuCheckItem", caption: choices[i][1], value: choices[i][0],
				checked: choices[i][0] === sort.by});
		}
		// Then the two directions, named for the field chosen.
		var orders = JF.api.sortOrders[sort.choice[2]];
		items.push({kind: "MenuCheckItem", caption: orders[0], value: "Ascending", checked: sort.order === "Ascending",
			className: "jf-menu-gap"});
		items.push({kind: "MenuCheckItem", caption: orders[1], value: "Descending", checked: sort.order === "Descending"});
		this.$.sortMenu.setItems(items);
		this.$.sortMenu.openAroundControl(this.$.sortButton);
	},

	sortSelected: function(inSender, inItem) {
		var inValue = inItem.getValue();
		var sort = JF.api.sortFor(this.sortType);
		if (inValue === "Ascending" || inValue === "Descending") {
			JF.api.setSort(this.sortType, sort.by, inValue);
		} else if (inValue !== sort.by) {
			JF.api.setSort(this.sortType, inValue);
		} else {
			return;
		}
		this.open(this.parentItem);
	},

	favoriteClick: function() {
		var self = this;
		var parent = this.parentItem;
		this.$.favorite.setDisabled(true);
		JF.api.toggleFavorite(parent, function() {
			self.$.favorite.setDisabled(false);
			if (parent === self.parentItem) {
				self.$.favorite.setCaption(JF.api.favoriteCaption(parent));
			}
		});
	},

	// ---- downloading a season -------------------------------------------------

	// The season's episodes with their audio and subtitle tracks. callback(episodes)
	loadEpisodes: function(callback) {
		var self = this;
		var season = this.parentItem;
		if (this.seasonEpisodes) {
			callback(this.seasonEpisodes);
			return;
		}
		JF.api.get("/Shows/" + season.SeriesId + "/Episodes", {userId: JF.api.userId, seasonId: season.Id,
			fields: "Overview,MediaStreams,MediaSources"}, function(ok, data) {
			if (season === self.parentItem) {
				self.seasonEpisodes = ok && data ? data.Items || [] : null;
				callback(self.seasonEpisodes);
			}
		});
	},

	seasonClick: function() {
		var self = this;
		this.$.seasonButton.setDisabled(true);
		this.loadEpisodes(function(episodes) {
			self.$.seasonButton.setDisabled(false);
			if (!episodes) {
				self.$.message.setContent("Could not get this season's episodes.");
				return;
			}
			self.$.seasonDialog.openAtCenter();
			self.$.seasonWhich.setValue("all");
			self.$.seasonQuality.setValue(parseInt(localStorage.getItem("jf.downloadQuality"), 10) || 3000000);
			self.showSeasonEstimate();
		});
	},

	// The episodes the dialog would download, leaving out ones already downloaded or waiting.
	chosenEpisodes: function() {
		var out = [];
		var episodes = this.seasonEpisodes || [];
		var unwatched = this.$.seasonWhich.getValue() === "unwatched";
		for (var i = 0; i < episodes.length; i++) {
			var ep = episodes[i];
			if (ep.MediaType === "Video" && !JF.downloads.isWanted(ep.Id) &&
				!(unwatched && ep.UserData && ep.UserData.Played)) {
				out.push(ep);
			}
		}
		return out;
	},

	showSeasonEstimate: function() {
		var self = this;
		var chosen = this.chosenEpisodes();
		var quality = this.$.seasonQuality.getValue();
		var bytes = 0;
		for (var i = 0; i < chosen.length; i++) {
			bytes += JF.downloads.estimate(chosen[i], quality);
		}
		this.$.seasonGo.setDisabled(!chosen.length);
		var text = chosen.length ? chosen.length + (chosen.length === 1 ? " episode" : " episodes") + ", at most about " +
			JF.downloads.sizeText(bytes) + "." : "Nothing left to download here.";
		text += " Audio and subtitles follow your usual choices; subtitles are drawn into the picture.";
		this.$.seasonEstimate.setContent(text);
		JF.downloads.freeSpace(function(free) {
			if (free !== null && self.$.seasonEstimate.getContent() === text) {
				self.$.seasonEstimate.setContent(text + " " + JF.downloads.sizeText(free) + " free.");
			}
		});
	},

	closeSeasonDialog: function() {
		this.$.seasonDialog.close();
	},

	confirmSeason: function() {
		var quality = this.$.seasonQuality.getValue();
		var qualityName = quality === 3000000 ? "Best" : quality === 1500000 ? "Smaller" : "Smallest";
		localStorage.setItem("jf.downloadQuality", String(quality));
		var chosen = this.chosenEpisodes();
		var list = [];
		for (var i = 0; i < chosen.length; i++) {
			var tracks = JF.api.defaultTracks(chosen[i]);
			list.push({item: chosen[i], choice: {audioIndex: tracks.audioIndex, subtitleIndex: tracks.subtitleIndex,
				maxBitrate: quality, description: "quality: " + qualityName}});
		}
		this.$.seasonDialog.close();
		JF.downloads.startAll(list);  // asks first if it may not fit
	},

	// "3 of 12 episodes downloaded, 2 waiting." under the header of a season.
	showSeasonStatus: function() {
		if (!this.listening) {
			this.listening = true;
			JF.downloads.addListener(enyo.bind(this, "showSeasonStatus"));
		}
		var season = this.parentItem;
		var episodes = season && season.Type === "Season" ? this.seasonEpisodes : null;
		if (season && season.Type === "Season" && !episodes && !this.statusLoading) {
			// Only worth fetching when something of this season is downloaded.
			var any = false;
			var all = JF.downloads.items();
			for (var i = 0; i < all.length; i++) {
				if (all[i].SeasonId === season.Id) {
					any = true;
				}
			}
			if (any) {
				var self = this;
				this.statusLoading = true;
				this.loadEpisodes(function() {
					self.statusLoading = false;
					self.showSeasonStatus();
				});
			}
		}
		var count = episodes ? JF.downloads.countFor(episodes) : {done: 0, pending: 0};
		var text = "";
		if (count.done || count.pending) {
			text = count.done + " of " + episodes.length + " episodes downloaded" +
				(count.pending ? ", " + count.pending + " still to come." : ".");
		}
		this.$.seasonStatus.setContent(text);
		this.$.seasonStatus.setShowing(!!text);
	},

	tileClick: function(inSender, item) {
		this.doOpen(item);
	}
});
