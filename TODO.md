# TODO

Ideas for what comes next, roughly in order of payoff. Several rely on what webOS
Community Edition 3.1.0 adds to the TouchPad: modern HTTPS in app requests, the
download manager and `curl`, and extra media formats (Matroska, Ogg, Opus, VP8).
The rest are stock webOS 3 features the app does not use yet.

## Most worth doing

- [x] **Downloads for offline viewing.** Done in 0.4.0: Download on a movie or episode
  page, with a choice of audio, subtitles and quality; plays offline with instant
  seeking; Downloads row on the home screen.
  - [x] Download a whole season at once (all or unwatched episodes, with a quality choice)
  - [x] Report progress watched offline to the server when back online
  - [x] Warn before a download that would not fit in the free space

- [x] **Music controls outside the app.** Done in 0.4.0, following HP's Music app:
  a dashboard in the notification area while music plays in the background
  (previous, play/pause, next; tap the title to return), Bluetooth (AVRCP) buttons,
  the wired headset button (one click play/pause, two clicks next), and pausing
  music or video when headphones are unplugged.

- [x] **Find servers on the local network.** Done in 0.4.0: the sign-in screen
  lists servers that answer Jellyfin's discovery (Auto Discovery must be on in the
  server's Networking settings, the default). (Quick Connect was considered and
  dropped: it needs a second device to approve the sign-in.)
- [x] **Home or away.** Done in 0.4.0: when the server signed in to over https
  is also found on the home network, the app remembers its home address and uses
  it whenever it answers (no relay, faster seeking), falling back to https when away.

## Smaller wins

- [x] **Play Ogg, Opus and FLAC music as-is.** Done: CE's GStreamer decodes them, over http
  and from downloads, with seeking, so the server sends the files unchanged. WMA has no
  decoder and is still converted. (Matroska does not
  help video much: most MKV files are H.264 High profile, which the TouchPad's
  decoder cannot play whatever the container.)

- [x] **Just Type search.** Done: type in card view or the launcher and pick Jellyfin under
  Search Using. Off until turned on in Just Type's preferences, as for any app.

- [x] **Exhibition mode.** Done: pick Jellyfin in Exhibition's menu. Shows the track playing
  with its controls, or else movie and show artwork every 12 seconds, with a clock.

## Music

- [x] **Shuffle.** A Shuffle button on every album and playlist, and shuffle on or off
  for whatever is playing.
- [x] **Playlists.** Play the server's playlists; create new ones and add tracks or
  whole albums to them from the tablet (saved on the server, so other Jellyfin
  apps see them too).
- [x] **Browse by category.** Artists (today they are only reachable through search),
  genres, and perhaps years, next to the album grid; an artist page with their albums.
- [x] **Downloads for music.** Download an album, playlist or track to play offline,
  as for video; downloaded albums in the home screen's Downloads row.
- [x] **Player niceties:**
  - [x] Repeat: off, the whole list, or one track
  - [x] A queue you can see and change: Play Next, Add to Queue, move up or down, remove
  - [x] A full Now Playing screen with large cover art, opened from the bar
  - [x] Favorite tracks and albums (Jellyfin's favorites), and a Favorite Songs list
  - [x] Recently played and most played, from the server's history
  - [x] Instant Mix: the server's "more like this" playlist from a track, album or artist
  - [x] Remember the queue and position when the app is closed

## Missing features

- [x] Collections, as a tab in movie libraries
- [x] Sort and categories for movies and shows: Unwatched, Favorites, Genres, Studios

## Next

Roughly in the order to do them.

- [x] **Skip intros and credits.** Done: by itself or with a Skip button (app menu,
  Intros and Credits), from the media segments the server's Intro Skipper plugin makes.
- [ ] **The phone release.** The Pre3 video failure and a layout check on a real phone
  (see Known issues); the phone tab bar and the LuneOS playback fix are in as work in
  progress and not yet checked on those devices.
- [ ] **Skip recaps and previews too.** The server marks them the same way (segment types
  Recap and Preview); same three choices as for intros and credits.
- [ ] **Chapters.** A Chapters menu in the player, beside Audio and Subtitles, to jump
  to one. The server sends the list with the item.
- [ ] **Lyrics** on the Now Playing screen, for tracks the server has them for.
- [ ] **Play To.** The tablet as a target in other Jellyfin apps: pick something on a
  phone and it plays here. The biggest piece: it needs a live connection to the server.
- [ ] **A real icon.**
- [ ] **Streaming quality.** Check whether streaming has a quality choice as downloads
  do; if not, add one for watching away from home.

## Later

- [ ] Live TV, for servers that have it. Left out of 0.4.0: there was no tuner or IPTV
  source to build and test it against.
- [ ] Seek-preview thumbnails (the server's trickplay images). Anything drawn over the
  video drops the TouchPad's playback to a few frames a second, so only while paused.

## Known issues

- [ ] Video on a Pre3 fails with error 2 (a tester's report); cause not known yet.
- [ ] The phone layout is checked in a desktop preview only; not yet on a real phone.

- [ ] After a seek or track change, a converted stream takes a few seconds to start.
- [ ] A tap sometimes arrives twice; a 700 ms repeat filter covers it, cause unknown.
- [ ] Wired headset button and unplug-to-pause are untested (no wired headphones to hand);
  the dashboard and Bluetooth buttons are tested.
