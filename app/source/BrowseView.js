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
			{name: "grid", className: "jf-grid"},
			{name: "more", kind: "Button", caption: "Show More", onclick: "loadMore", showing: false,
				className: "jf-more"}
		]},
		{name: "sortMenu", kind: "PopupSelect", onSelect: "sortSelected"}
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
			this.$.sortButton.setCaption("Sort: " + JF.api.sortFor(this.sortType).choice[1]);
		}
		// A show opens here, not on a detail page, so it is made a favorite here.
		this.$.favorite.setShowing(parent.Type === "Series" || parent.Type === "BoxSet");
		this.$.favorite.setCaption(JF.api.favoriteCaption(parent));
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

	tileClick: function(inSender, item) {
		this.doOpen(item);
	}
});
