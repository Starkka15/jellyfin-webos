/* Server address and sign-in. Shown when there is no stored session. */
enyo.kind({
	name: "JF.LoginView",
	kind: enyo.VFlexBox,
	className: "jf-view",
	events: {
		onSignedIn: ""
	},
	components: [
		{kind: "Scroller", flex: 1, components: [
			{className: "jf-login-box", components: [
				{content: "Jellyfin", className: "jf-brand"},
				{kind: "RowGroup", caption: "Server", components: [
					{name: "url", kind: "Input", hint: "Server address, e.g. https://jellyfin.example.com", inputType: "url",
						autoCapitalize: "lowercase", autocorrect: false, spellcheck: false}
				]},
				// Servers that answered the local network search (see searchServers).
				{name: "searching", className: "jf-login-note", showing: false},
				{name: "found", kind: "RowGroup", caption: "Found on this network", showing: false},
				{kind: "RowGroup", caption: "Account", components: [
					{name: "user", kind: "Input", hint: "User name",
						autoCapitalize: "lowercase", autocorrect: false, spellcheck: false},
					{name: "password", kind: "PasswordInput", hint: "Password"}
				]},
				{name: "button", kind: "Button", caption: "Sign In", className: "enyo-button-affirmative",
					onclick: "signIn"},
				{name: "message", className: "jf-message"}
			]}
		]},
		{name: "discoverSvc", kind: "PalmService", service: "palm://com.stark.jellyfin.service/",
			method: "discover", onResponse: "serversFound"}
	],

	create: function() {
		this.inherited(arguments);
		if (JF.phone) {
			// The example address does not fit across a phone.
			this.$.url.setHint("Server address");
		}
		this.$.url.setValue(JF.api.baseUrl || "");
		this.$.user.setValue(JF.api.userName || "");
	},

	// Ask the local network for Jellyfin servers, as the official apps do. Only
	// servers with Auto Discovery switched on (Jellyfin's default) answer.
	searchServers: function() {
		if (!window.PalmSystem || this.searchingNow) {
			return;
		}
		this.searchingNow = true;
		this.$.searching.setContent("Looking for servers on this network…");
		this.$.searching.setShowing(true);
		this.$.discoverSvc.call({});
	},

	serversFound: function(inSender, inResponse) {
		this.searchingNow = false;
		var servers = (inResponse && inResponse.servers) || [];
		JF.log("found " + servers.length + " server(s) on the network");
		this.$.found.destroyControls();
		for (var i = 0; i < servers.length; i++) {
			this.$.found.createComponent({kind: "Item", server: servers[i], onclick: "serverClick", owner: this,
				components: [
					{content: servers[i].name || "Jellyfin", className: "jf-found-name"},
					{content: servers[i].address, className: "jf-found-address"}
				]});
		}
		this.$.found.render();
		this.$.found.setShowing(servers.length > 0);
		this.$.searching.setContent(servers.length ? "" : "No servers found on this network. Enter the address above.");
		this.$.searching.setShowing(!servers.length);
	},

	serverClick: function(inSender) {
		this.$.url.setValue(inSender.server.address);
	},

	signIn: function() {
		var url = this.$.url.getValue();
		var user = this.$.user.getValue();
		if (!url || !user) {
			this.$.message.setContent("Enter the server address and your user name.");
			return;
		}
		this.$.button.setDisabled(true);
		this.$.message.setContent("Signing in…");
		JF.api.signIn(url, user, this.$.password.getValue() || "", enyo.bind(this, function(ok, message) {
			this.$.button.setDisabled(false);
			if (ok) {
				this.$.password.setValue("");
				this.$.message.setContent("");
				this.doSignedIn();
			} else {
				this.$.message.setContent(message);
			}
		}));
	}
});
