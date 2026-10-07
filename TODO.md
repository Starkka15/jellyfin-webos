# TODO

Ideas for what comes next, roughly in order of payoff. Several rely on what webOS
Community Edition 3.1.0 adds to the TouchPad: modern HTTPS in app requests, the
download manager and `curl`, and extra media formats (Matroska, Ogg, Opus, VP8).
The rest are stock webOS 3 features the app does not use yet.

## Most worth doing

- [x] **Downloads for offline viewing.** Done in 0.4.0: Download on a movie or episode
  page, with a choice of audio, subtitles and quality; plays offline with instant
  seeking; Downloads row on the home screen.
  - [ ] Download a whole season at once
  - [ ] Report progress watched offline to the server when back online
  - [ ] Warn before a download that would not fit in the free space

- [ ] **Music controls outside the app.** A small dashboard (notification) window with
  pause and skip, so music can be controlled while another app is open. Include
  Bluetooth headset buttons, and pause when headphones are unplugged, as HP's own
  player does. Stock webOS.

- [ ] **Easier server setup and sign-in.**
  - [ ] Find Jellyfin servers on the local network (the relay service can listen for
    them), as the official apps offer "servers found nearby".
  - [ ] Jellyfin Quick Connect: sign in by entering a code shown on the TouchPad,
    instead of typing a password on the on-screen keyboard.

## Smaller wins

- [ ] **Play Ogg and Opus music as-is.** CE can play them, so the server would not
  need to convert those files, and they could be seeked within. (Matroska does not
  help video much: most MKV files are H.264 High profile, which the TouchPad's
  decoder cannot play whatever the container.)

- [ ] **Just Type search.** Offer "Search Jellyfin" from the system search bar.
  Stock webOS; the App Catalog can list apps that provide it.

- [ ] **Exhibition mode.** On a Touchstone dock, show what is playing or a slideshow of
  library artwork. Stock webOS.

## Missing features

- [ ] Browse music by artist (today artists are only reachable through search)
- [ ] Playlists
- [ ] Collections
- [ ] Live TV, for servers that have it

## Known issues

- [ ] After a seek or track change, a converted stream takes a few seconds to start.
- [ ] A tap sometimes arrives twice; a 700 ms repeat filter covers it, cause unknown.
