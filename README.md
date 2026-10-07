# Jellyfin for webOS

A Jellyfin client for the HP TouchPad, written in Enyo 1 (the TouchPad's own framework).

## Features

- Sign in to any Jellyfin server, over `http` or `https`
- Home screen with Continue Watching, Next Up, Latest and your libraries
- Browse movies, shows (series → seasons → episodes) and music (albums)
- Search across movies, shows, episodes, albums and tracks
- Full-screen video player with seeking, ±30 s, audio track and subtitle choice
- Resume where you left off, and play the next episode automatically
- Music player that keeps playing while you browse, with a Now Playing bar
- Playback progress, watched status and play counts reported to the server

## Requirements

- HP TouchPad running **webOS Community Edition 3.1.0** (recommended), or webOS 3.0.5.
  Stock 3.0.5 cannot reach modern HTTPS servers at all; CE can.
- Jellyfin server 10.9 or later (developed against 12.1)

## How playback works

The TouchPad's hardware decoder handles H.264 Baseline up to about 1024×576, and its media
player is from 2011. The app asks the server how to play each item, the way official clients do:
it sends a device profile to `/Items/{id}/PlaybackInfo`, and the server answers with either the
file itself (when the TouchPad can play it) or a stream it converts on the fly.

A few things the TouchPad needs, found the hard way:

- **One continuous MPEG-TS stream, not HLS.** The TouchPad's HLS reader stalls after a jump and
  loses the picture or the sound. Seeking in a converted stream asks the server for a new stream
  that starts at the new time.
- **The video fills the screen and is never resized**, with the controls floating over it. This
  follows HP's own video players; a video in a resizable box stops updating its picture.
- **Subtitles are drawn into the picture by the server.** Text laid over the video makes it stutter.
- **A small relay service for `https` servers.** The media player's network code (libsoup on
  GnuTLS 2) cannot connect to a modern HTTPS server, even on webOS CE. For an `https` address the
  app hands the stream to its bundled service (`service/relay.js`), which fetches it with CE's
  modern `curl` and passes it to the player at a local `http://127.0.0.1` address. Only addresses
  the app registers are relayed. Plain `http` addresses go straight to the player.

## Layout

```
app/       the Enyo 1 web app (appinfo.json, index.html, source/, stylesheets/)
service/   the stream relay, a Node.js 0.4 webOS service
package/   packageinfo.json, which bundles the app and service into one .ipk
art/       icon.svg, the source of the app icons
tools/     deploy.ps1 (package, install, launch) and tp-tools.ps1 (device helpers)
```

## Building

With the Palm SDK installed and a TouchPad connected over USB:

```
palm-package app service package
palm-install com.stark.jellyfin_<version>_all.ipk
```

On Windows, `tools\deploy.ps1` does all three steps and relaunches the app (edit the SDK and Java
paths at the top first).

## Known issues

- After a seek or track change, a converted stream takes a few seconds to start.
- Music artists are only reachable through search; the music library lists albums.

## License

GPL-3.0. See [LICENSE](LICENSE).

The app icon (`art/icon.svg` and `app/images/icon*.png`, `miniicon.png`) is built on the Jellyfin
logo from [jellyfin/jellyfin-ux](https://github.com/jellyfin/jellyfin-ux), © the Jellyfin contributors,
used under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). The icon is shared under
the same license. This app is not made by or affiliated with the Jellyfin project.
