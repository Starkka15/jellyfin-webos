/* Home: the user's libraries, what they were watching, and what is new. */
enyo.kind({
	name: "JF.HomeView",
	kind: enyo.VFlexBox,
	className: "jf-view",
	events: {
		onOpen: "",
		onSearch: "",
		onSignOut: "",
		onOpenNetworkSource: ""
	},
	components: [
		{kind: "PageHeader", className: "jf-header", components: [
			// On a phone only the search fits; Refresh and Sign Out are in the app menu.
			{name: "title", content: "Jellyfin", flex: 1, className: "jf-header-title jf-wide-only"},
			{name: "search", kind: "Input", hint: "Search", className: "jf-search",
				autoCapitalize: "lowercase", autocorrect: false, spellcheck: false, onkeypress: "searchKey"},
			{kind: "Button", caption: "Search", onclick: "searchClick"},
			{kind: "Button", caption: "Refresh", onclick: "load", className: "jf-wide-only"},
			{kind: "Button", caption: "Sign Out", onclick: "doSignOut", className: "jf-wide-only"}
		]},
		{kind: "Scroller", flex: 1, components: [
			{name: "message", className: "jf-message"},
			{name: "networkLabel", content: "Network Sources", className: "jf-section", showing: false},
			{name: "networkButtons", kind: "HFlexBox", className: "jf-detail-buttons", showing: false, components: [
				{name: "nas", kind: "Button", caption: "NAS", onclick: "nasClick"},
				{name: "alist", kind: "Button", caption: "AList", onclick: "alistClick"}
			]},
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
		var brand = localStorage.getItem("jf.embyUrl") === JF.api.signedInUrl ? "Emby" : "Jellyfin";
		this.$.title.setContent(JF.api.userName ? brand + " — " + JF.api.userName : brand);
		this.updateNetworkSources();
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

	updateNetworkSources: function() {
		var configured = JF.miniProbeConfigured();
		this.$.networkLabel.setShowing(configured);
		this.$.networkButtons.setShowing(configured);
	},

	// Rebuilt only when downloads are added, finish or go away, not on progress.
	showDownloads: function() {
		if (!this.listening) {
			this.listening = true;
			JF.downloads.addListener(enyo.bind(this, "showDownloads"));
		}
		var key = JF.downloads.signature();
		if (key !== this.downloadsKey) {
			this.downloadsKey = key;
			this.fill("downloads", JF.downloads.items());
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

	nasClick: function() {
		this.doOpenNetworkSource("nas");
	},

	alistClick: function() {
		this.doOpenNetworkSource("alist");
	},

	tileClick: function(inSender, item) {
		this.doOpen(item);
	}
});
