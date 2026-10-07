# TODO

Ideas for what comes next, roughly in order of payoff. Several rely on what webOS
Community Edition 3.1.0 adds to the TouchPad: modern HTTPS in app requests, the
download manager and `curl`, and extra media formats (Matroska, Ogg, Opus, VP8).
The rest are stock webOS 3 features the app does not use yet.

## Most worth doing

- [x] **Downloads for offline viewing.** Done (after 0.3.0): Download on a movie or episode
  page, with a choice of audio, subtitles and quality; plays offline with instant
  seeking; Downloads row on the home screen.
  - [ ] Download a whole season at once
  - [ ] Report progress watched offline to the server when back online
  - [ ] Warn before a download that would not fit in the free space

- [x] **Music controls outside the app.** Done (after 0.3.0), following HP's Music app:
  a dashboard in the notification area while music plays in the background
  (previous, play/pause, next; tap the title to return), Bluetooth (AVRCP) buttons,
  the wired headset button (one click play/pause, two clicks next), and pausing
  music or video when headphones are unplugged.

- [x] **Find servers on the local network.** Done (after 0.3.0): the sign-in screen
  lists servers that answer Jellyfin's discovery (Auto Discovery must be on in the
  server's Networking settings, the default). (Quick Connect was considered and
  dropped: it needs a second device to approve the sign-in.)
- [x] **Home or away.** Done (after 0.3.0): when the server signed in to over https
  is also found on the home network, the app remembers its home address and uses
  it whenever it answers (no relay, faster seeking), falling back to https when away.

## Smaller wins

- [ ] **Play Ogg and Opus music as-is.** CE can play them, so the server would not
  need to convert those files, and they could be seeked within. (Matroska does not
  help video much: most MKV files are H.264 High profile, which the TouchPad's
  decoder cannot play whatever the container.)

- [ ] **Just Type search.** Offer "Search Jellyfin" from the system search bar.
  Stock webOS; the App Catalog can list apps that provide it.

- [ ] **Exhibition mode.** On a Touchstone dock, show what is playing or a slideshow of
  library artwork. Stock webOS.

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
- [ ] **Player niceties:**
  - [x] Repeat: off, the whole list, or one track
  - [x] A queue you can see and change: Play Next, Add to Queue, remove (reordering not yet)
  - [x] A full Now Playing screen with large cover art, opened from the bar
  - [x] Favorite tracks and albums (Jellyfin's favorites), and a Favorite Songs list
  - [x] Recently played and most played, from the server's history
  - [x] Instant Mix: the server's "more like this" playlist from a track, album or artist
  - [x] Remember the queue and position when the app is closed

## Missing features

- [x] Collections, as a tab in movie libraries
- [x] Sort and categories for movies and shows: Unwatched, Favorites, Genres, Studios
- [ ] Live TV, for servers that have it

## Known issues

- [ ] After a seek or track change, a converted stream takes a few seconds to start.
- [ ] A tap sometimes arrives twice; a 700 ms repeat filter covers it, cause unknown.
- [ ] Wired headset button and unplug-to-pause are untested (no wired headphones to hand);
  the dashboard and Bluetooth buttons are tested.
