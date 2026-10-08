/* The app: one Pane holding the five screens, and a stack of where we have been. */
enyo.kind({
	name: "JF.App",
	kind: enyo.VFlexBox,
	className: "jf-app",
	components: [
		{kind: "ApplicationEvents", onBack: "backGesture", onUnload: "unload",
			onWindowActivated: "windowActivated", onWindowDeactivated: "windowDeactivated",
			onWindowParamsChange: "windowParamsChanged", onApplicationRelaunch: "relaunched"},
		// Bluetooth (AVRCP) media buttons, and the wired headset's button and plug,
		// as HP's Music app listens to them.
		{name: "mediaKeys", kind: "PalmService", service: "palm://com.palm.keys/media/", method: "status",
			subscribe: true, onSuccess: "mediaKey"},
		{name: "headsetKeys", kind: "PalmService", service: "palm://com.palm.keys/headset/", method: "status",
			subscribe: true, onSuccess: "headsetKey"},
		{name: "pane", kind: "Pane", flex: 1, transitionKind: "enyo.transitions.Simple", components: [
			{name: "login", kind: "JF.LoginView", onSignedIn: "signedIn"},
			{name: "home", kind: "JF.HomeView", onOpen: "openItem", onSearch: "search", onSignOut: "signOut"},
			{name: "browse", kind: "JF.BrowseView", onOpen: "openItem", onBack: "goBack"},
			{name: "detail", kind: "JF.DetailView", onPlay: "playItem", onBack: "goBack"},
			{name: "album", kind: "JF.AlbumView", onPlayTracks: "playTracks", onBack: "goBack"},
			{name: "player", kind: "JF.PlayerView", onBack: "goBack"},
			{name: "nowplayingView", kind: "JF.NowPlayingView", onBack: "goBack"}
		]},
		// Music keeps playing while browsing; its bar sits under every screen.
		{name: "nowPlaying", kind: "JF.NowPlaying", onOpen: "openNowPlaying"},
		{name: "relay", kind: "JF.Relay"},
		// A yes-or-no question any screen can ask through JF.confirm.
		{name: "confirmDialog", kind: "ModalDialog", lazy: false, components: [
			{name: "confirmText", className: "jf-dialog-note"},
			{kind: "HFlexBox", components: [
				{kind: "Button", caption: "Cancel", flex: 1, onclick: "confirmCancel"},
				{name: "confirmOk", kind: "Button", caption: "OK", flex: 1, className: "enyo-button-affirmative",
					onclick: "confirmOkClick"}
			]}
		]},
		// Under the app's name, top left. On a phone, Refresh and Sign Out live only here.
		{kind: "AppMenu", components: [
			{caption: "Refresh", onclick: "refreshClick"},
			{caption: "Sign Out", onclick: "signOut"}
		]},
		{name: "downloads", kind: "JF.Downloads"},
		// Was the app removed and installed again? (see checkInstall)
		{name: "installSvc", kind: "PalmService", service: "palm://com.stark.jellyfin.service/",
			method: "installed", onResponse: "installResponse"}
	],

	create: function() {
		// Phones (the Pre3, for one) are under 600 pixels across in either direction;
		// they get the compact layout under .jf-phone in app.css, held upright.
		JF.phone = Math.min(window.innerWidth || 1024, window.innerHeight || 768) < 600;
		if (JF.phone) {
			// On <html>, not <body>: on a device renderInto(document.body) replaces the body's classes.
			document.documentElement.className += " jf-phone";
			if (window.PalmSystem) {
				enyo.setAllowedOrientation("up");
			}
		}
		this.inherited(arguments);
		// Each entry is {view: "browse" | "detail", item: {...}}; home is the bottom.
		this.stack = [];
		JF.relay = this.$.relay;
		JF.music = this.$.nowPlaying;
		JF.downloads = this.$.downloads;
		JF.confirm = enyo.bind(this, "confirm");
	},

	rendered: function() {
		this.inherited(arguments);
		if (!this.started) {
			this.started = true;
			if (window.PalmSystem) {
				this.$.mediaKeys.call({});
				this.$.headsetKeys.call({});
			}
			this.checkInstall();
		}
	},

	// webOS keeps localStorage when an app is removed, so a new install would
	// come up signed in and listing downloads whose files are gone. The service
	// keeps a marker beside the downloads folder, which removal deletes: once this
	// app has seen its marker ("jf.marker"), a missing one means a new install,
	// and everything stored is forgotten. Then on with the start.
	checkInstall: function() {
		var self = this;
		var done = false;
		var go = function(inSender, inResponse) {
			if (done) {
				return;
			}
			done = true;
			// No "existed" in the answer: the service could not tell. Leave everything be.
			if (inResponse && typeof inResponse.existed === "boolean") {
				if (!inResponse.existed && localStorage.getItem("jf.marker")) {
					JF.log("new install: forgetting what the last one stored");
					for (var i = localStorage.length - 1; i >= 0; i--) {
						var key = localStorage.key(i);
						if (key && key.indexOf("jf.") === 0) {
							localStorage.removeItem(key);
						}
					}
					self.$.downloads.entries = {};
				}
				localStorage.setItem("jf.marker", "1");
			}
			self.begin();
		};
		if (!window.PalmSystem) {
			go();
			return;
		}
		this.installAnswer = go;
		this.$.installSvc.call({});
		// A service that does not answer must not keep the app from starting.
		setTimeout(go, 4000);
	},

	installResponse: function(inSender, inResponse) {
		this.installAnswer(inSender, inResponse);
	},

	begin: function() {
		if (JF.api.restore()) {
			this.$.downloads.restore();
			var self = this;
			// Home address or signed-in address, whichever answers (see chooseAddress).
			JF.api.chooseAddress(function() {
				self.showHome();
				self.$.nowPlaying.restoreState();
				if (!self.justType(enyo.windowParams || {})) {
					self.testLaunch(enyo.windowParams || {});
				}
			});
		} else {
			this.$.pane.selectViewByName("login");
			this.$.login.searchServers();
		}
	},

	// Just Type's "Search Using: Jellyfin" (appinfo.json, universalSearch) launches
	// the app with {query: "what was typed"}, or sends it to the open app.
	justType: function(params) {
		var term = String(params.query || "").replace(/^\s+|\s+$/g, "");
		if (!term) {
			return false;
		}
		this.search(this, term);
		return true;
	},

	// For testing from a PC, with no one tapping the screen:
	//   palm-launch -p "{play: '<item id>', startSeconds: 0}" com.stark.jellyfin
	// plays that item straight away; {audio: <stream index>, subtitles: <stream index>}
	// pick tracks as the menus would. {open: '<item id>'} opens that item's page and
	// {search: 'words'} runs a search, so screens can be checked by screenshot.
	// Test playback does not report to the server, so it leaves the watch history alone.
	testLaunch: function(params) {
		var self = this;
		// {downloadAlbum: '<id>'} downloads every track, as the More menu's Download does.
		if (params.downloadAlbum) {
			JF.api.item(params.downloadAlbum, function(ok, album) {
				if (ok && album) {
					JF.api.albumTracks(album, function(ok2, data) {
						var tracks = (ok2 && data && data.Items) || [];
						var list = [];
						for (var i = 0; i < tracks.length; i++) {
							list.push({item: tracks[i]});
						}
						JF.downloads.startAll(list);
					});
				}
			});
			return;
		}
		// {playAlbum: '<id>', shuffle: true, nowPlaying: true} plays an album (or playlist)
		// and can open the Now Playing screen.
		if (params.playAlbum) {
			JF.api.item(params.playAlbum, function(ok, album) {
				if (!ok || !album) {
					return;
				}
				JF.api.albumTracks(album, function(ok2, data) {
					var tracks = (ok2 && data && data.Items) || [];
					if (album.Type !== "Playlist") {
						tracks = self.$.album.inOrder(tracks);  // as the album screen orders them
					}
					if (tracks.length) {
						self.$.nowPlaying.playTracks(tracks, params.shuffle ? "shuffle" : 0);
						if (params.nowPlaying) {
							self.lastAction = 0;
							self.openNowPlaying();
						}
					}
				});
			});
			return;
		}
		// {showLogin: true} shows the sign-in screen (and its server search) without signing out.
		if (params.showLogin) {
			this.$.pane.selectViewByName("login");
			this.$.login.searchServers();
			return;
		}
		if (params.search) {
			this.search(this, params.search);
			return;
		}
		if (params.open) {
			JF.api.item(params.open, function(ok, item) {
				if (ok && item) {
					self.lastAction = 0;
					// {open: "<library id>", tab: "artists"} picks the tab.
					// {..., sort: "DateCreated", order: "Ascending"} picks the sort first;
					// {..., sortMenu: true} opens the sort menu.
					if (params.tab) {
						item.category = params.tab;
					}
					if (params.sort) {
						JF.api.setSort(item.CollectionType, params.sort, params.order);
					}
					// {..., tile: 3} then opens the fourth tile in the grid.
					if (params.tile !== undefined) {
						setTimeout(function() {
							var tiles = self.$.browse.$.grid.getControls();
							if (tiles[params.tile]) {
								self.$.browse.tileClick(self, tiles[params.tile].item);
							}						}, 4000);
					}
					if (params.sortMenu) {
						setTimeout(function() { self.$.browse.sortClick(); }, 3000);
					}
					self.openItem(self, item);
					// {open: '<album id>', menu: true} also opens its More menu.
					// {..., addToPlaylist: true} opens Add to Playlist for the whole album.
					if (params.addToPlaylist) {
						setTimeout(function() {
							self.$.album.target = {tracks: self.$.album.tracks};
							self.$.album.openPlaylistDialog();
						}, 3000);
					}
					if (params.menu) {
						setTimeout(function() { self.$.album.moreClick(); }, 3000);
					}
					// {open: '<id>', options: true} also opens the download options.
					if (params.options) {
						setTimeout(function() { self.$.detail.openOptions(); }, 2500);
						// {..., options: "subtitles"} also opens that dropdown, as a tap would.
						if (params.options === "subtitles") {
							setTimeout(function() {
								var ev = document.createEvent("MouseEvents");
								ev.initMouseEvent("click", true, true, window, 1, 0, 0, 0, 0, false, false, false, false, 0, null);
								self.$.detail.$.dlSubtitles.hasNode().dispatchEvent(ev);
							}, 4000);
						}
					}
				}
			});
			return;
		}
		// {download: '<item id>'} starts a download, as the item page's button does.
		if (params.download) {
			JF.api.item(params.download, function(ok, item) {
				if (ok && item) {
					JF.downloads.start(item);
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
		this.$.downloads.restore();
		this.showHome();
	},

	// Ask, and call onOk only if the answer is yes.
	confirm: function(title, text, okCaption, onOk) {
		this.confirmAction = onOk;
		this.$.confirmDialog.openAtCenter();
		this.$.confirmDialog.setCaption(title);
		this.$.confirmText.setContent(text);
		this.$.confirmOk.setCaption(okCaption || "OK");
	},

	confirmOkClick: function() {
		var action = this.confirmAction;
		this.confirmAction = null;
		this.$.confirmDialog.close();
		if (action) {
			action();
		}
	},

	confirmCancel: function() {
		this.confirmAction = null;
		this.$.confirmDialog.close();
	},

	refreshClick: function() {
		this.$.home.load();
	},

	signOut: function() {
		this.$.nowPlaying.stopAll();
		JF.api.signOut();
		this.stack = [];
		this.$.pane.selectViewByName("login");
		this.$.login.searchServers();
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
		var view = /^(MusicAlbum|Playlist|TrackList)$/.test(item.Type) ? "album" : JF.api.isFolder(item) ? "browse" : "detail";
		this.stack.push({view: view, item: item});
		this.showView(view, item);
	},

	showView: function(view, item) {
		this.$.pane.selectViewByName(view);
		if (view === "nowplayingView") {
			this.$.nowplayingView.showQueue();
		} else {
			this.$[view].open(item);
		}
		this.showMusicBar(view);
	},

	// The music bar sits under every screen except the Now Playing screen itself.
	// The view is passed in: while the Pane is still animating, getViewName()
	// still names the screen being left.
	showMusicBar: function(view) {
		this.$.nowPlaying.setShowing(!!JF.music.queue && (view || this.$.pane.getViewName()) !== "nowplayingView");
	},

	openNowPlaying: function() {
		if (this.$.pane.getViewName() === "nowplayingView" || this.tooSoon()) {
			return;
		}
		this.stack.push({view: "nowplayingView"});
		this.showView("nowplayingView");
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
			this.showMusicBar("home");
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

	// ---- control from outside the app ---------------------------------------

	// The music controls go in the notification area while the app is in the background.
	windowActivated: function() {
		this.$.nowPlaying.appInBackground(false);
		// Coming back may mean coming home, or leaving: check which address answers.
		if (JF.api.token && new Date().getTime() - (JF.api.lastChoice || 0) > 60000) {
			JF.api.chooseAddress(function() {});
		}
	},

	windowDeactivated: function() {
		this.$.nowPlaying.appInBackground(true);
	},

	// The dashboard's buttons arrive as window params.
	// Put on a Touchstone dock while the app is open: show the exhibition in a
	// window of its own (Exhibition.js), and leave this card as it is.
	relaunched: function() {
		var p = enyo.windowParams || {};
		if (p.dockMode || p.windowType === "dockModeWindow") {
			enyo.windows.activate("index.html", "jfExhibition", {dockMode: true}, {window: "dockmode"});
			return true;
		}
	},

	windowParamsChanged: function() {
		var p = enyo.windowParams || {};
		if (JF.api.token) {
			this.justType(p);
		}
		if (p.musicCommand) {
			this.$.nowPlaying.command(p.musicCommand);
		}
	},

	videoPlaying: function() {
		return this.$.pane.getViewName() === "player" && this.$.player.playing;
	},

	// Bluetooth buttons: keys play, pause, togglePausePlay, next, prev, stop.
	mediaKey: function(inSender, r) {
		if (!r || r.state !== "down") {
			return;
		}
		JF.log("media key " + r.key);
		var names = {play: "play", pause: "pause", stop: "pause", togglePausePlay: "playpause",
			next: "next", prev: "previous"};
		var name = names[r.key];
		if (!name) {
			return;
		}
		if (this.videoPlaying()) {
			if (name === "pause" || name === "playpause" || name === "play") {
				if (name !== "play" || this.$.player.paused) {
					this.$.player.pauseClick();
				}
			}
			return;
		}
		this.$.nowPlaying.command(name);
	},

	// The wired headset: one click play/pause, two clicks next; unplugging pauses.
	headsetKey: function(inSender, r) {
		if (!r) {
			return;
		}
		JF.log("headset " + r.key + " " + r.state);
		if (r.key === "headset" && r.state === "up") {
			this.$.player.pauseVideo();
			this.$.nowPlaying.command("pause");
		} else if (r.key === "headset_button") {
			this.mediaKey(this, {state: "down",
				key: r.state === "double_click" ? "next" : r.state === "single_click" ? "togglePausePlay" : ""});
		}
	},

	unload: function() {
		this.$.nowPlaying.shutdown();
		this.$.player.stopStream();
	}
});
