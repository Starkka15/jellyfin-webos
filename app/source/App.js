/* The app: one Pane holding the five screens, and a stack of where we have been. */
enyo.kind({
	name: "JF.App",
	kind: enyo.VFlexBox,
	className: "jf-app",
	components: [
		{kind: "ApplicationEvents", onBack: "backGesture", onUnload: "unload"},
		{name: "pane", kind: "Pane", flex: 1, transitionKind: "enyo.transitions.Simple", components: [
			{name: "login", kind: "JF.LoginView", onSignedIn: "signedIn"},
			{name: "home", kind: "JF.HomeView", onOpen: "openItem", onSearch: "search", onSignOut: "signOut"},
			{name: "browse", kind: "JF.BrowseView", onOpen: "openItem", onBack: "goBack"},
			{name: "detail", kind: "JF.DetailView", onPlay: "playItem", onBack: "goBack"},
			{name: "album", kind: "JF.AlbumView", onPlayTracks: "playTracks", onBack: "goBack"},
			{name: "player", kind: "JF.PlayerView", onBack: "goBack"}
		]},
		// Music keeps playing while browsing; its bar sits under every screen.
		{name: "nowPlaying", kind: "JF.NowPlaying"},
		{name: "relay", kind: "JF.Relay"}
	],

	create: function() {
		this.inherited(arguments);
		// Each entry is {view: "browse" | "detail", item: {...}}; home is the bottom.
		this.stack = [];
		JF.relay = this.$.relay;
	},

	rendered: function() {
		this.inherited(arguments);
		if (!this.started) {
			this.started = true;
			if (JF.api.restore()) {
				this.showHome();
				this.testLaunch(enyo.windowParams || {});
			} else {
				this.$.pane.selectViewByName("login");
			}
		}
	},

	// For testing from a PC, with no one tapping the screen:
	//   palm-launch -p "{play: '<item id>', startSeconds: 0}" com.stark.jellyfin
	// plays that item straight away; {audio: <stream index>, subtitles: <stream index>}
	// pick tracks as the menus would. {open: '<item id>'} opens that item's page and
	// {search: 'words'} runs a search, so screens can be checked by screenshot.
	// Test playback does not report to the server, so it leaves the watch history alone.
	testLaunch: function(params) {
		var self = this;
		if (params.search) {
			this.search(this, params.search);
			return;
		}
		if (params.open) {
			JF.api.item(params.open, function(ok, item) {
				if (ok && item) {
					self.lastAction = 0;
					self.openItem(self, item);
				}
			});
			return;
		}
		if (!params.play) {
			return;
		}
		JF.noReport = true;
		JF.log("test launch: " + enyo.json.stringify(params));
		// Launch numbers are 32-bit, so ticks past 3:34 do not fit: {startSeconds: n} does.
		var startTicks = params.startSeconds ? params.startSeconds * 10000000 : params.startTicks || 0;
		JF.api.item(params.play, function(ok, item) {
			if (!ok || !item) {
				JF.log("test launch: could not load item " + params.play);
				return;
			}
			self.lastAction = 0;
			self.playItem(self, item, startTicks);
			if (params.audio !== undefined || params.subtitles !== undefined) {
				if (params.audio !== undefined) {
					self.$.player.audioIndex = params.audio;
				}
				if (params.subtitles !== undefined) {
					self.$.player.chooseSubtitle(params.subtitles);
				}
				self.$.player.startStream(startTicks);
			}
		});
	},

	// ---- navigation --------------------------------------------------------

	signedIn: function() {
		this.showHome();
	},

	signOut: function() {
		this.$.nowPlaying.stopAll();
		JF.api.signOut();
		this.stack = [];
		this.$.pane.selectViewByName("login");
	},

	showHome: function() {
		this.stack = [];
		this.$.pane.selectViewByName("home");
		this.$.home.load();
	},

	// One tap has been arriving as two events a fraction of a second apart,
	// which opened things twice. Ignore a repeat that comes that quickly.
	tooSoon: function() {
		var now = new Date().getTime();
		if (this.lastAction && now - this.lastAction < 700) {
			JF.log("ignored a repeated tap");
			return true;
		}
		this.lastAction = now;
		return false;
	},

	search: function(inSender, term) {
		this.lastAction = 0;
		this.openItem(this, {Type: "Search", Name: "Search: " + term, term: term, IsFolder: true, Id: "search"});
	},

	openItem: function(inSender, item) {
		if (this.tooSoon()) {
			return;
		}
		var view = item.Type === "MusicAlbum" ? "album" : JF.api.isFolder(item) ? "browse" : "detail";
		this.stack.push({view: view, item: item});
		this.showView(view, item);
	},

	showView: function(view, item) {
		this.$.pane.selectViewByName(view);
		this.$[view].open(item);
	},

	playItem: function(inSender, item, startTicks) {
		if (this.tooSoon()) {
			return;
		}
		if (item.MediaType === "Audio") {
			this.$.nowPlaying.playTracks([item], 0);
			return;
		}
		// A video takes the whole screen: stop any music first.
		this.$.nowPlaying.stopAll();
		this.stack.push({view: "player", item: item});
		this.$.pane.selectViewByName("player");
		this.$.player.playItem(item, startTicks);
	},

	playTracks: function(inSender, tracks, index) {
		if (this.tooSoon()) {
			return;
		}
		this.$.nowPlaying.playTracks(tracks, index);
	},

	goBack: function() {
		if (this.tooSoon()) {
			return;
		}
		var leaving = this.stack.pop();
		if (leaving && leaving.view === "player") {
			this.$.player.stopStream();
		}
		var top = this.stack[this.stack.length - 1];
		if (top) {
			this.showView(top.view, top.item);
		} else {
			this.$.pane.selectViewByName("home");
			this.$.home.load();
		}
	},

	// The back gesture (phones) or key. Only swallow it when there is somewhere to go.
	backGesture: function(inSender, inEvent) {
		if (this.stack.length) {
			this.goBack();
			if (inEvent) {
				inEvent.preventDefault && inEvent.preventDefault();
				inEvent.stopPropagation && inEvent.stopPropagation();
			}
			return true;
		}
	},

	unload: function() {
		this.$.nowPlaying.stopAll();
		this.$.player.stopStream();
	}
});
