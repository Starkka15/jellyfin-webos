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
	musicCategories: ["albums", "artists", "genres", "playlists"],
	components: [
		{kind: "PageHeader", className: "jf-header", components: [
			{kind: "Button", caption: "Back", onclick: "doBack"},
			{name: "title", content: "", flex: 1, className: "jf-header-title jf-header-indent"},
			{name: "count", content: "", className: "jf-header-count"}
		]},
		// Only for the music library: what the grid shows.
		{name: "tabs", kind: "RadioGroup", className: "jf-tabs", onChange: "tabChanged", showing: false, components: [
			{caption: "Albums"}, {caption: "Artists"}, {caption: "Genres"}, {caption: "Playlists"}
		]},
		{name: "scroller", kind: "Scroller", flex: 1, components: [
			{name: "message", className: "jf-message"},
			{name: "grid", className: "jf-grid"},
			{name: "more", kind: "Button", caption: "Show More", onclick: "loadMore", showing: false,
				className: "jf-more"}
		]}
	],

	// Show the children of this item, from the top.
	open: function(parent) {
		this.parentItem = parent;
		var music = parent.CollectionType === "music";
		this.$.tabs.setShowing(music);
		if (music) {
			parent.musicCategory = parent.musicCategory || "albums";
			this.$.tabs.setValue(enyo.indexOf(parent.musicCategory, this.musicCategories));
		}
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
			// The Playlists tab starts with the automatic lists; they are not counted in the paging.
			if (parent.musicCategory === "playlists" && self.loaded === 0) {
				for (var a = 0; a < JF.api.autoLists.length; a++) {
					self.$.grid.createComponent({kind: "JF.Tile", item: JF.api.autoLists[a], onTileClick: "tileClick",
						owner: self});
				}
			}
			for (var i = 0; i < items.length; i++) {
				if (items[i].Type === "MusicGenre") {
					items[i].musicLibraryId = parent.Id;  // a genre page lists this library's albums
				}
				self.$.grid.createComponent({kind: "JF.Tile", item: items[i], onTileClick: "tileClick", owner: self});
			}
			self.$.grid.render();
			self.loaded += items.length;
			self.total = data.TotalRecordCount || self.loaded;
			self.$.message.setContent(self.loaded || parent.musicCategory === "playlists" ? "" : "Nothing here.");
			self.$.count.setContent(self.total ? self.loaded + " of " + self.total : "");
			self.$.more.setShowing(items.length > 0 && self.loaded < self.total);
		});
	},

	tabChanged: function() {
		var category = this.musicCategories[this.$.tabs.getValue()];
		if (this.parentItem && category !== this.parentItem.musicCategory) {
			this.parentItem.musicCategory = category;
			this.open(this.parentItem);
		}
	},

	tileClick: function(inSender, item) {
		this.doOpen(item);
	}
});
