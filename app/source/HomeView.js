/* Home: the user's libraries, what they were watching, and what is new. */
enyo.kind({
	name: "JF.HomeView",
	kind: enyo.VFlexBox,
	className: "jf-view",
	events: {
		onOpen: "",
		onSearch: "",
		onSignOut: ""
	},
	components: [
		{kind: "PageHeader", className: "jf-header", components: [
			{name: "title", content: "Jellyfin", flex: 1, className: "jf-header-title"},
			{name: "search", kind: "Input", hint: "Search", className: "jf-search",
				autoCapitalize: "lowercase", autocorrect: false, spellcheck: false, onkeypress: "searchKey"},
			{kind: "Button", caption: "Search", onclick: "searchClick"},
			{kind: "Button", caption: "Refresh", onclick: "load"},
			{kind: "Button", caption: "Sign Out", onclick: "doSignOut"}
		]},
		{kind: "Scroller", flex: 1, components: [
			{name: "message", className: "jf-message"},
			// Local, so it shows even when the server cannot be reached.
			{name: "downloadsLabel", content: "Downloads", className: "jf-section", showing: false},
			{name: "downloads", className: "jf-grid"},
			{name: "librariesLabel", content: "Libraries", className: "jf-section", showing: false},
			{name: "libraries", className: "jf-grid"},
			{name: "resumeLabel", content: "Continue Watching", className: "jf-section", showing: false},
			{name: "resume", className: "jf-grid"},
			{name: "nextUpLabel", content: "Next Up", className: "jf-section", showing: false},
			{name: "nextUp", className: "jf-grid"},
			{name: "latestLabel", content: "Recently Added", className: "jf-section", showing: false},
			{name: "latest", className: "jf-grid"}
		]}
	],

	load: function() {
		var self = this;
		this.showDownloads();
		this.$.title.setContent(JF.api.userName ? "Jellyfin — " + JF.api.userName : "Jellyfin");
		this.$.message.setContent("Loading…");
		JF.api.views(function(ok, data, status) {
			if (!ok) {
				self.$.message.setContent(status === 401 ? "Your sign-in has expired. Sign out and back in." :
					"Could not reach the server (" + (status || "no answer") + ").");
				return;
			}
			self.$.message.setContent("");
			self.fill("libraries", data && data.Items);
		});
		JF.api.resume(function(ok, data) {
			self.fill("resume", ok && data ? data.Items : []);
		});
		JF.api.nextUp(function(ok, data) {
			self.fill("nextUp", ok && data ? data.Items : []);
		});
		JF.api.latest(function(ok, data) {
			self.fill("latest", ok && enyo.isArray(data) ? data : []);
		});
	},

	// Rebuilt only when downloads are added, finish or go away, not on progress.
	showDownloads: function() {
		if (!this.listening) {
			this.listening = true;
			JF.downloads.addListener(enyo.bind(this, "showDownloads"));
		}
		var items = JF.downloads.items();
		var key = "";
		for (var i = 0; i < items.length; i++) {
			key += items[i].Id + ":" + JF.downloads.get(items[i].Id).state + " ";
		}
		if (key !== this.downloadsKey) {
			this.downloadsKey = key;
			this.fill("downloads", items);
		}
	},

	fill: function(name, items) {
		var grid = this.$[name];
		items = items || [];
		grid.destroyControls();
		for (var i = 0; i < items.length; i++) {
			grid.createComponent({kind: "JF.Tile", item: items[i], onTileClick: "tileClick", owner: this});
		}
		this.$[name + "Label"].setShowing(items.length > 0);
		grid.render();
	},

	searchKey: function(inSender, inEvent) {
		if (inEvent && inEvent.keyCode === 13) {
			this.searchClick();
		}
	},

	searchClick: function() {
		var term = (this.$.search.getValue() || "").replace(/^\s+|\s+$/g, "");
		if (term) {
			this.$.search.forceBlur && this.$.search.forceBlur();
			this.doSearch(term);
		}
	},

	tileClick: function(inSender, item) {
		this.doOpen(item);
	}
});
