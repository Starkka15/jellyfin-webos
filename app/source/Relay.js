/* Hands https stream addresses to our relay service (com.stark.jellyfin.service).
 * The TouchPad's media player cannot reach a modern https server; the service
 * fetches the stream with webOS CE's curl and gives back a local http address.
 * Plain http addresses are played as they are. The App owns one of these and
 * makes it available as JF.relay.
 */
enyo.kind({
	name: "JF.Relay",
	kind: enyo.Component,
	components: [
		{name: "relaySvc", kind: "PalmService", service: "palm://com.stark.jellyfin.service/", method: "relay",
			onResponse: "relayResponse"},
		{name: "pingSvc", kind: "PalmService", service: "palm://com.stark.jellyfin.service/", method: "ping"}
	],

	needed: function(url) {
		return /^https:/i.test(url || "");
	},

	// callback(playableUrl) or callback(null) if the relay could not be started.
	// Only the latest request is answered.
	open: function(url, callback) {
		if (!this.needed(url)) {
			callback(url);
			return;
		}
		this.pending = callback;
		this.$.relaySvc.call({url: url});
	},

	relayResponse: function(inSender, inResponse) {
		var callback = this.pending;
		this.pending = null;
		if (!callback) {
			return;
		}
		if (inResponse && inResponse.returnValue && inResponse.url) {
			JF.log("relaying the stream through " + inResponse.url);
			callback(inResponse.url);
		} else {
			JF.log("relay failed: " + enyo.json.stringify(inResponse));
			callback(null);
		}
	},

	// The service stops 120 s after its last call; players call this every 30 s
	// while a relayed stream plays.
	ping: function() {
		this.$.pingSvc.call({});
	}
});
