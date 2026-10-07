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
				{kind: "RowGroup", caption: "Account", components: [
					{name: "user", kind: "Input", hint: "User name",
						autoCapitalize: "lowercase", autocorrect: false, spellcheck: false},
					{name: "password", kind: "PasswordInput", hint: "Password"}
				]},
				{name: "button", kind: "Button", caption: "Sign In", className: "enyo-button-affirmative",
					onclick: "signIn"},
				{name: "message", className: "jf-message"}
			]}
		]}
	],

	create: function() {
		this.inherited(arguments);
		this.$.url.setValue(JF.api.baseUrl || "");
		this.$.user.setValue(JF.api.userName || "");
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
