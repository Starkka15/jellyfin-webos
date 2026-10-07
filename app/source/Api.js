/* Jellyfin API client. ES5 only: this runs on the TouchPad's 2011 WebKit.
 *
 * Written against Jellyfin 12, which dropped the old per-user paths
 * (/Users/{id}/Items...) and the X-Emby-Authorization header. Everything goes
 * through the Authorization header; the user is passed as a userId parameter.
 */
var JF = window.JF || {};

JF.CLIENT = "Jellyfin for webOS";
JF.VERSION = "0.2.0";

JF.log = function(msg) {
	console.log("[jellyfin] " + msg);
};

JF.api = {
	baseUrl: "",
	userId: "",
	userName: "",
	token: "",

	// ---- session ----------------------------------------------------------

	restore: function() {
		this.baseUrl = localStorage.getItem("jf.url") || "";
		this.userId = localStorage.getItem("jf.userId") || "";
		this.userName = localStorage.getItem("jf.userName") || "";
		this.token = localStorage.getItem("jf.token") || "";
		return !!(this.baseUrl && this.userId && this.token);
	},

	save: function() {
		localStorage.setItem("jf.url", this.baseUrl);
		localStorage.setItem("jf.userId", this.userId);
		localStorage.setItem("jf.userName", this.userName);
		localStorage.setItem("jf.token", this.token);
	},

	signOut: function() {
		this.userId = "";
		this.token = "";
		localStorage.removeItem("jf.userId");
		localStorage.removeItem("jf.token");
	},

	deviceId: function() {
		var id = localStorage.getItem("jf.deviceId");
		if (!id) {
			id = "webos-" + Math.floor(Math.random() * 0x7fffffff).toString(16) +
				new Date().getTime().toString(16);
			localStorage.setItem("jf.deviceId", id);
		}
		return id;
	},

	authHeader: function() {
		var h = 'MediaBrowser Client="' + JF.CLIENT + '", Device="HP TouchPad", ' +
			'DeviceId="' + this.deviceId() + '", Version="' + JF.VERSION + '"';
		if (this.token) {
			h += ', Token="' + this.token + '"';
		}
		return h;
	},

	// ---- transport --------------------------------------------------------

	query: function(params) {
		var parts = [];
		for (var k in params) {
			if (params.hasOwnProperty(k) && params[k] !== undefined && params[k] !== null && params[k] !== "") {
				parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(params[k]));
			}
		}
		return parts.length ? "?" + parts.join("&") : "";
	},

	// callback(ok, data, status)
	request: function(method, path, params, body, callback) {
		var url = (path.indexOf("http") === 0 ? path : this.baseUrl + path) + this.query(params || {});
		var req = new XMLHttpRequest();
		var done = false;
		var finish = function(ok, data, status) {
			if (!done) {
				done = true;
				clearTimeout(timer);
				callback(ok, data, status);
			}
		};
		// The old WebKit has no xhr.timeout; do it by hand.
		var timer = setTimeout(function() {
			JF.log(method + " " + path + " timed out");
			try { req.abort(); } catch (e) {}
			finish(false, null, 0);
		}, 20000);

		req.open(method, url, true);
		req.setRequestHeader("Authorization", this.authHeader());
		req.setRequestHeader("Accept", "application/json");
		if (body) {
			req.setRequestHeader("Content-Type", "application/json");
		}
		req.onreadystatechange = function() {
			if (req.readyState !== 4) {
				return;
			}
			var ok = req.status >= 200 && req.status < 300;
			var data = null;
			if (req.responseText) {
				try { data = JSON.parse(req.responseText); } catch (e) { data = null; }
			}
			if (!ok) {
				JF.log(method + " " + path + " -> " + req.status);
			}
			finish(ok, data, req.status);
		};
		req.send(body ? JSON.stringify(body) : null);
	},

	get: function(path, params, callback) {
		this.request("GET", path, params, null, callback);
	},

	post: function(path, body, callback) {
		this.request("POST", path, null, body, callback || function() {});
	},

	// ---- calls ------------------------------------------------------------

	normalizeUrl: function(url) {
		url = (url || "").replace(/^\s+|\s+$/g, "").replace(/\/+$/, "");
		if (url && !/^https?:\/\//i.test(url)) {
			url = "http://" + url;
		}
		return url;
	},

	// callback(ok, message)
	signIn: function(url, user, password, callback) {
		var self = this;
		url = this.normalizeUrl(url);
		this.token = "";
		this.get(url + "/System/Info/Public", null, function(ok, info, status) {
			if (!ok || !info || !info.Version) {
				callback(false, status ? "That address answered, but not like a Jellyfin server (" + status + ")." :
					"No answer from " + url + ". Check the address and the Wi-Fi.");
				return;
			}
			self.request("POST", url + "/Users/AuthenticateByName", null, {Username: user, Pw: password},
				function(ok2, data, status2) {
					if (ok2 && data && data.AccessToken && data.User) {
						self.baseUrl = url;
						self.token = data.AccessToken;
						self.userId = data.User.Id;
						self.userName = data.User.Name;
						self.save();
						callback(true, "");
					} else if (status2 === 401) {
						callback(false, "Wrong user name or password.");
					} else {
						callback(false, "Sign-in failed (" + (status2 || "no answer") + ").");
					}
				});
		});
	},

	views: function(callback) {
		this.get("/UserViews", {userId: this.userId}, callback);
	},

	resume: function(callback) {
		this.get("/UserItems/Resume", {userId: this.userId, limit: 12, mediaTypes: "Video",
			fields: "PrimaryImageAspectRatio"}, callback);
	},

	latest: function(callback) {
		this.get("/Items/Latest", {userId: this.userId, limit: 24, fields: "PrimaryImageAspectRatio"}, callback);
	},

	item: function(id, callback) {
		this.get("/Items/" + id, {userId: this.userId}, callback);
	},

	nextUp: function(callback) {
		this.get("/Shows/NextUp", {userId: this.userId, limit: 12, fields: "PrimaryImageAspectRatio"}, callback);
	},

	// The episode after this one in its series, or null. callback(item)
	nextEpisode: function(episode, callback) {
		if (!episode.SeriesId) {
			callback(null);
			return;
		}
		this.get("/Shows/" + episode.SeriesId + "/Episodes", {userId: this.userId, adjacentTo: episode.Id},
			function(ok, data) {
				var items = (ok && data && data.Items) || [];
				for (var i = 0; i < items.length - 1; i++) {
					if (items[i].Id === episode.Id) {
						callback(items[i + 1]);
						return;
					}
				}
				callback(null);
			});
	},

	// The tracks of an album, in disc and track order. callback(ok, {Items: [...]})
	albumTracks: function(album, callback) {
		this.get("/Items", {userId: this.userId, parentId: album.Id, includeItemTypes: "Audio", recursive: true,
			sortBy: "ParentIndexNumber,IndexNumber,SortName", sortOrder: "Ascending"}, callback);
	},

	// Mark an item watched or unwatched. callback(ok)
	setPlayed: function(id, played, callback) {
		this.request(played ? "POST" : "DELETE", "/UserPlayedItems/" + id, {userId: this.userId}, null,
			function(ok) { callback(ok); });
	},

	// The children of a library, folder, series or season.
	// callback(ok, {Items: [...], TotalRecordCount: n})
	children: function(parent, startIndex, limit, callback) {
		var wrap = function(ok, data, status) {
			callback(ok, data || {Items: [], TotalRecordCount: 0}, status);
		};
		if (parent.Type === "Search") {
			this.get("/Items", {userId: this.userId, searchTerm: parent.term, recursive: true,
				includeItemTypes: "Movie,Series,Episode,MusicAlbum,Audio", startIndex: startIndex, limit: limit,
				fields: "PrimaryImageAspectRatio"}, wrap);
			return;
		}
		if (parent.Type === "Series") {
			this.get("/Shows/" + parent.Id + "/Seasons", {userId: this.userId}, wrap);
			return;
		}
		if (parent.Type === "Season") {
			this.get("/Shows/" + parent.SeriesId + "/Episodes",
				{userId: this.userId, seasonId: parent.Id, fields: "Overview"}, wrap);
			return;
		}
		var params = {
			userId: this.userId,
			parentId: parent.Id,
			startIndex: startIndex,
			limit: limit,
			sortBy: "IsFolder,SortName",
			sortOrder: "Ascending",
			fields: "PrimaryImageAspectRatio"
		};
		// A movie or show library is shown flat, whatever its folders look like.
		if (parent.CollectionType === "movies") {
			params.recursive = true;
			params.includeItemTypes = "Movie";
			params.sortBy = "SortName";
		} else if (parent.CollectionType === "music") {
			params.recursive = true;
			params.includeItemTypes = "MusicAlbum";
			params.sortBy = "SortName";
		} else if (parent.CollectionType === "tvshows") {
			params.recursive = true;
			params.includeItemTypes = "Series";
			params.sortBy = "SortName";
		}
		this.get("/Items", params, wrap);
	},

	// ---- asking the server how to play something ---------------------------

	// What this device can play. The server uses it to decide between sending
	// a file as it is and converting it, and builds the address to play.
	deviceProfile: function() {
		return {
			Name: "HP TouchPad",
			MaxStreamingBitrate: 3000000,
			MaxStaticBitrate: 8000000,
			DirectPlayProfiles: [
				{Container: "mp4,m4v", Type: "Video", VideoCodec: "h264", AudioCodec: "aac,mp3"}
			],
			TranscodingProfiles: [
				// One continuous MPEG-TS stream, not HLS. The TouchPad's HLS reader
				// stalls after a jump and loses the picture or the sound
				// ("Could not fetch the child playlist"); the Plex client hit the same
				// wall. A plain TS stream decoded steadily at the film's frame rate.
				// CopyTimestamps: without it the server decodes a film with text
				// subtitles from its beginning before sending anything.
				{Container: "ts", Type: "Video", VideoCodec: "h264", AudioCodec: "aac", Protocol: "http",
					Context: "Streaming", MaxAudioChannels: "2", CopyTimestamps: true}
			],
			CodecProfiles: [
				{Type: "Video", Codec: "h264", Conditions: [
					{Condition: "EqualsAny", Property: "VideoProfile", Value: "baseline|constrained baseline", IsRequired: false},
					{Condition: "LessThanEqual", Property: "VideoLevel", Value: "31", IsRequired: false},
					{Condition: "LessThanEqual", Property: "Width", Value: "1024", IsRequired: false},
					{Condition: "LessThanEqual", Property: "Height", Value: "768", IsRequired: false}
				]}
			],
			SubtitleProfiles: [
				{Format: "ass", Method: "Encode"}, {Format: "ssa", Method: "Encode"},
				{Format: "srt", Method: "Encode"}, {Format: "subrip", Method: "Encode"},
				{Format: "pgssub", Method: "Encode"}, {Format: "dvdsub", Method: "Encode"},
				{Format: "vtt", Method: "Encode"}
			]
		};
	},

	// What this device can play for music. MP3, AAC and WAV play as they are,
	// so the server sends the file and the player can seek in it; anything else
	// is converted to MP3.
	audioProfile: function() {
		return {
			Name: "HP TouchPad",
			MaxStreamingBitrate: 3000000,
			MaxStaticBitrate: 8000000,
			DirectPlayProfiles: [
				{Container: "mp3", Type: "Audio", AudioCodec: "mp3"},
				{Container: "m4a,mp4,aac", Type: "Audio", AudioCodec: "aac"},
				{Container: "wav", Type: "Audio"}
			],
			TranscodingProfiles: [
				{Container: "mp3", Type: "Audio", AudioCodec: "mp3", Protocol: "http",
					Context: "Streaming", MaxAudioChannels: "2"}
			]
		};
	},

	// Ask the server how to play an item. options: {audioIndex, subtitleIndex, startTicks, maxBitrate};
	// subtitleIndex -1 means no subtitles.
	// callback({url, playSessionId, mediaSourceId, method: "DirectPlay" | "Transcode"}) or callback(null)
	playbackInfo: function(item, options, callback) {
		var self = this;
		options = options || {};
		var body = {
			UserId: this.userId,
			// Without MediaSourceId the server ignores the audio and subtitle
			// choice below and uses its defaults.
			MediaSourceId: item.MediaSources && item.MediaSources[0] ? item.MediaSources[0].Id : item.Id,
			MaxStreamingBitrate: options.maxBitrate || 3000000,
			StartTimeTicks: options.startTicks || 0,
			EnableDirectPlay: true,
			EnableDirectStream: false,
			EnableTranscoding: true,
			DeviceProfile: item.MediaType === "Audio" ? this.audioProfile() : this.deviceProfile()
		};
		if (options.audioIndex !== undefined && options.audioIndex !== null) {
			body.AudioStreamIndex = options.audioIndex;
		}
		// Sent even when off (-1): left out, the server burns in a default track.
		if (options.subtitleIndex !== undefined && options.subtitleIndex !== null) {
			body.SubtitleStreamIndex = options.subtitleIndex;
		}
		this.request("POST", "/Items/" + item.Id + "/PlaybackInfo", {userId: this.userId}, body,
			function(ok, data) {
				var source = ok && data && data.MediaSources && data.MediaSources[0];
				if (!source) {
					callback(null);
					return;
				}
				if (source.SupportsDirectPlay) {
					callback({method: "DirectPlay", playSessionId: data.PlaySessionId, mediaSourceId: source.Id,
						url: self.baseUrl + (item.MediaType === "Audio" ? "/Audio/" : "/Videos/") + item.Id +
							"/stream." + source.Container +
							self.query({static: true, mediaSourceId: source.Id, api_key: self.token})});
				} else if (source.TranscodingUrl) {
					callback({method: "Transcode", playSessionId: data.PlaySessionId, mediaSourceId: source.Id,
						url: self.baseUrl + source.TranscodingUrl});
				} else {
					callback(null);
				}
			});
	},

	// Tell the server to stop making a stream we no longer read.
	stopEncoding: function(playSessionId) {
		this.request("DELETE", "/Videos/ActiveEncodings", {deviceId: this.deviceId(), playSessionId: playSessionId}, null,
			function() {});
	},

	// ---- URLs -------------------------------------------------------------

	// A downloaded item's poster comes from the tablet, so it shows offline too.
	imageUrl: function(item, maxHeight) {
		var local = JF.downloads && item.Id && JF.downloads.localImage(item.Id);
		return local ? "file://" + local : this.serverImageUrl(item, maxHeight);
	},

	serverImageUrl: function(item, maxHeight) {
		var id = item.Id;
		var tag = item.ImageTags && item.ImageTags.Primary;
		if (!tag && item.SeriesPrimaryImageTag && item.SeriesId) {
			id = item.SeriesId;
			tag = item.SeriesPrimaryImageTag;
		}
		if (!tag) {
			return "";
		}
		return this.baseUrl + "/Items/" + id + "/Images/Primary" +
			this.query({maxHeight: maxHeight, quality: 85, tag: tag});
	},

	isFolder: function(item) {
		return !!item.IsFolder || item.Type === "Series" || item.Type === "Season" ||
			item.Type === "CollectionFolder" || item.Type === "BoxSet" || item.Type === "Folder" ||
			item.Type === "UserView";
	},

	// The audio and subtitle tracks to start with, from the languages last chosen
	// in the player. audioIndex null lets the server pick; subtitleIndex -1 is off.
	defaultTracks: function(item) {
		var audio = this.streams(item, "Audio");
		var subs = this.streams(item, "Subtitle");
		var audioIndex = null;
		var language = localStorage.getItem("jf.audioLanguage");
		for (var i = 0; language && i < audio.length; i++) {
			if (audio[i].language === language) {
				audioIndex = audio[i].index;
				break;
			}
		}
		var subtitleIndex = -1;
		if (localStorage.getItem("jf.subtitles") === "on") {
			// Prefer full subtitles over the signs-and-songs tracks anime releases carry.
			language = localStorage.getItem("jf.subtitleLanguage");
			for (i = 0; i < subs.length; i++) {
				if (language && subs[i].language !== language) {
					continue;
				}
				if (subtitleIndex < 0) {
					subtitleIndex = subs[i].index;
				}
				if (!/sign|song/i.test(subs[i].title)) {
					subtitleIndex = subs[i].index;
					break;
				}
			}
		}
		return {audioIndex: audioIndex, subtitleIndex: subtitleIndex};
	},

	// Audio or subtitle streams of a full item record, as [{index, title, language}].
	streams: function(item, type) {
		var out = [];
		var all = item.MediaStreams || [];
		for (var i = 0; i < all.length; i++) {
			if (all[i].Type === type) {
				out.push({index: all[i].Index, title: all[i].DisplayTitle || (type + " " + all[i].Index),
					language: all[i].Language || "", isDefault: !!all[i].IsDefault,
					isText: !!all[i].IsTextSubtitleStream});
			}
		}
		return out;
	},

	// 1:02:03 or 2:03
	ticksToClock: function(ticks) {
		var total = Math.max(0, Math.floor((ticks || 0) / 10000000));
		var h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), sec = total % 60;
		var mm = (h && m < 10 ? "0" : "") + m, ss = (sec < 10 ? "0" : "") + sec;
		return (h ? h + ":" : "") + mm + ":" + ss;
	},

	ticksToText: function(ticks) {
		var minutes = Math.round((ticks || 0) / 600000000);
		if (minutes < 60) {
			return minutes + " min";
		}
		return Math.floor(minutes / 60) + " h " + (minutes % 60) + " min";
	}
};
