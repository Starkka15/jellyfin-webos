# Optional LAN Media Bridge

Run this companion on a Mac on the same LAN as the TouchPad. The webOS app can continue to use its server's built-in conversion when the bridge is disabled.

## Configure and run

1. Install Python 3.9 or newer, FFmpeg and FFprobe. VideoToolbox and AAC-at are used where available. A software H.264/AAC encoder is the fallback. HDR tone mapping requires an FFmpeg build with `zscale` and `tonemap`.
2. Copy `bridge-config.example.json` to `bridge-config.json` and set the Emby URL, account user ID and API token, the Mac's private IPv4 address, and the paths to FFmpeg and FFprobe. Generate a new capability with `python3 -c 'import secrets; print(secrets.token_urlsafe(32))'` and save it in the configuration.
3. Make the configuration readable only by its owner with `chmod 600 bridge-config.json`, then run `python3 media_bridge.py --config bridge-config.json`.
4. In Jellyfin for webOS, open **LAN Media Bridge** from the app menu and enter the private URL in the form `http://192.168.50.20:18099/v1/YOUR_CAPABILITY`. Treat this URL like a password. Keep the listener on a trusted LAN and keep the port out of Internet forwarding rules.

## Optional network sources

- Set `nas_root` to the absolute path of a mounted media directory. For a direct SMB fallback, install the `smbprotocol` package and add a `nas_smb` object with `server`, `share`, `username` and `password` to the private bridge configuration. Use a read-only account.
- To add AList, copy `alist-webdav.example.json` to `alist-webdav.private.json` in this directory. Set the private WebDAV address and account, then give the file mode 600. Home can browse both sources and open compatible MP4/M4V files via byte-range reads.

## Playback limits

The installed route uses a single FFmpeg slot. Audio-track changes and seeks on transcodes start a replacement stream at the media position. Fragmented MP4 output omits chapter tracks because they can cause an early end on the legacy webOS demuxer. The player still uses server-supplied intro and credit ranges.

The bridge rejects Dolby Vision Profile 5. The in-app subtitle overlay handles text tracks exposed by the server. Bitmap subtitles and nearby subtitle files in the NAS/AList browser are not part of this implementation. The short NAS/AList playback checks do not establish full-length stability across sources.

## Checks

From the project root, run `python3 -m unittest discover -s bridge -p 'test*.py'`. Run the client checks with `for f in tests/*.test.js; do node "$f" || exit; done`.
