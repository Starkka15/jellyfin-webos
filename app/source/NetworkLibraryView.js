/* A small in-app browser for the NAS and AList streaming sources. */
enyo.kind({
	name: "JF.NetworkLibraryView",
	kind: enyo.VFlexBox,
	className: "jf-view",
	events: {
		onPlayNetworkFile: "",
		onCloseNetworkSource: ""
	},
	components: [
		{kind: "PageHeader", className: "jf-header", components: [
			{kind: "Button", caption: "Back", onclick: "backClick"},
			{name: "title", content: "Network", flex: 1, className: "jf-header-title jf-header-indent"}
		]},
		{name: "scroller", kind: "Scroller", flex: 1, components: [
			{name: "path", className: "jf-message"},
			{name: "message", className: "jf-message"},
			{name: "entries", kind: "RowGroup"}
		]}
	],

	open: function(source) {
		var id = typeof source === "string" ? source : source && source.id;
		this.source = id === "nas" || id === "alist" ? id : null;
		this.path = [];
		this.requestSerial = (this.requestSerial || 0) + 1;
		this.$.title.setContent(this.sourceLabel(this.source));
		this.$.scroller.setScrollTop(0);
		this.load();
	},

	sourceLabel: function(source) {
		return source === "alist" ? "AList" : source === "nas" ? "NAS" : "Network";
	},

	setMessage: function(message) {
		this.$.message.setContent(message || "");
	},

	load: function() {
		var self = this;
		var source = this.source;
		var path = (this.path || []).slice(0);
		var serial = ++this.requestSerial;
		var title = this.sourceLabel(source);
		this.$.path.setContent(title + (path.length ? " / " + path.join(" / ") : ""));
		this.$.entries.destroyControls();
		this.$.entries.render();
		this.setMessage("Loading…");
		if (!source || typeof JF.networkBrowse !== "function") {
			this.setMessage("This network source is not available.");
			return;
		}
		JF.networkBrowse(source, path, function(ok, data) {
			if (serial !== self.requestSerial || source !== self.source) {
				return;
			}
			if (!ok) {
				self.setMessage("Could not load this location. Please try again.");
				return;
			}
			var entries = data && enyo.isArray(data.entries) ? data.entries : [];
			self.renderEntries(entries);
			self.setMessage(entries.length ? "" : "Nothing here.");
		});
	},

	renderEntries: function(entries) {
		this.$.entries.destroyControls();
		for (var i = 0; i < entries.length; i++) {
			var entry = entries[i];
			if (!entry || typeof entry.name !== "string" || !entry.name) {
				continue;
			}
			this.$.entries.createComponent({kind: "Item", entry: entry, onclick: "entryClick", owner: this,
				layoutKind: "HFlexLayout", align: "center", components: [
					{content: entry.name, flex: 1},
					{content: entry.directory ? "Folder" : entry.playable ? "Play" : "Unavailable"}
				]});
		}
		this.$.entries.render();
	},

	entryClick: function(inSender) {
		var entry = inSender && inSender.entry;
		if (!entry || typeof entry.name !== "string") {
			return;
		}
		if (entry.directory) {
			this.path.push(entry.name);
			this.load();
		} else if (entry.playable) {
			this.doPlayNetworkFile(this.source, (this.path || []).concat([entry.name]));
		}
	},

	backClick: function() {
		if (this.path && this.path.length) {
			this.path.pop();
			this.load();
			return;
		}
		this.doCloseNetworkSource();
	}
});
