import io
import http.client
import json
import os
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest import mock
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).parent))
import media_bridge
import update_nas_smb


CAPABILITY = "A" * 24


class BrokenOutput:
    def write(self, _data):
        raise BrokenPipeError()

    def flush(self):
        raise AssertionError("flush is not reached after a disconnect")


class FakeProcess:
    def __init__(self):
        self.stdout = io.BytesIO(b"later bytes")

    def poll(self):
        return None


class FakeStartupStdout:
    def fileno(self):
        return 7


class FakeStartupProcess:
    def __init__(self):
        self.stdout = FakeStartupStdout()

    def poll(self):
        return None


class FakeStreamProcess:
    def __init__(self):
        self.stdout = io.BytesIO()

    def poll(self):
        return None


class FakeWarmProcess:
    def __init__(self, later=b"later bytes"):
        self.stdout = io.BytesIO(later)

    def poll(self):
        return None


class FakeSmbConnection:
    instances = []

    def __init__(self, _guid, server, port, require_signing):
        self.server = server
        self.port = port
        self.require_signing = require_signing
        self.receive_calls = []
        self.disconnected = False
        self.__class__.instances.append(self)

    def connect(self, timeout):
        self.timeout = timeout

    def receive(self, _request, *args, **kwargs):
        self.receive_calls.append(kwargs)

    def disconnect(self):
        self.disconnected = True


class FakeSmbSession:
    instances = []

    def __init__(self, connection, username, password, require_encryption):
        self.connection = connection
        self.username = username
        self.password = password
        self.require_encryption = require_encryption
        self.disconnected = False
        self.__class__.instances.append(self)

    def connect(self):
        self.connected = True

    def disconnect(self):
        self.disconnected = True


class FakeSmbTree:
    instances = []

    def __init__(self, session, share):
        self.session = session
        self.share = share
        self.is_dfs_share = False
        self.disconnected = False
        self.__class__.instances.append(self)

    def connect(self):
        self.connected = True

    def disconnect(self):
        self.disconnected = True


class FakeSmbOpen:
    instances = []
    reparse_paths = set()

    def __init__(self, tree, path):
        self.tree = tree
        self.path = path
        self.file_attributes = 0x80 if path in self.reparse_paths else 0
        self.end_of_file = 6
        self.closed = False
        self.create_args = None
        self.__class__.instances.append(self)

    def create(self, *args):
        self.create_args = args
        self.tree.session.connection.receive("create")

    def read(self, offset, size):
        return b"abcdef"[offset:offset + size]

    def close(self):
        self.closed = True


class FakeImpersonation:
    Impersonation = 1


class FakeAccessMask:
    FILE_READ_ATTRIBUTES = 0x01
    FILE_READ_DATA = 0x02


class FakeShareAccess:
    FILE_SHARE_READ = 0x01
    FILE_SHARE_WRITE = 0x02
    FILE_SHARE_DELETE = 0x04


class FakeCreateDisposition:
    FILE_OPEN = 1


class FakeCreateOptions:
    FILE_OPEN_REPARSE_POINT = 0x01
    FILE_DIRECTORY_FILE = 0x02
    FILE_NON_DIRECTORY_FILE = 0x04


class FakeFileAttributes:
    FILE_ATTRIBUTE_DIRECTORY = 0x10
    FILE_ATTRIBUTE_NORMAL = 0x20
    FILE_ATTRIBUTE_REPARSE_POINT = 0x80


class FakeTcp:
    def __init__(self, server, port, timeout=None):
        self.server = server
        self.port = port
        self.timeout = timeout
        self.connected = False
        self._sock_lock = threading.Lock()


class FakeSocket:
    def settimeout(self, _timeout):
        return None


def fake_smb_bindings():
    FakeSmbConnection.instances = []
    FakeSmbSession.instances = []
    FakeSmbTree.instances = []
    FakeSmbOpen.instances = []
    FakeSmbOpen.reparse_paths = set()
    return media_bridge.SmbBindings(
        FakeSmbConnection, FakeSmbSession, FakeSmbTree, FakeSmbOpen,
        FakeImpersonation, FakeAccessMask, FakeShareAccess, FakeCreateDisposition,
        FakeCreateOptions, FakeFileAttributes,
    )


def bridge_config():
    return media_bridge.Config("http://upstream.invalid", "private-token", "a" * 32,
                               "192.168.50.20", 18099, CAPABILITY, "/ffmpeg", "/ffprobe")


def ffprobe_payload(color_transfer="bt709", dolby_vision_profile=None):
    video = {
        "index": 0,
        "codec_type": "video",
        "codec_name": "hevc",
        "profile": "Main 10",
        "pix_fmt": "yuv420p10le",
        "bits_per_raw_sample": "10",
        "width": 1920,
        "height": 800,
        "color_transfer": color_transfer,
        "color_primaries": "bt2020",
        "color_space": "bt2020nc",
        "color_range": "pc",
    }
    if dolby_vision_profile is not None:
        video["side_data_list"] = [{
            "side_data_type": "DOVI configuration record",
            "dv_profile": dolby_vision_profile,
            "rpu_present_flag": 1,
            "bl_present_flag": 1,
            "el_present_flag": 0,
        }]
    return {"streams": [video, {"index": 1, "codec_type": "audio", "codec_name": "eac3", "channels": 6}]}


class FakeProbeUpstream:
    def __init__(self):
        self.calls = 0

    def prepare(self, spec, _requested_audio_index, _audio_decoders, select_audio=True):
        self.calls += 1
        spec.selected_source_id = spec.media_source_id or "selected-source"
        spec.audio_stream_index = 1 if select_audio else None
        spec.direct_path = "/safe/direct-path"


class FakeProbeBridge:
    def __init__(self, result):
        self.config = bridge_config()
        self.audio_decoders = {"aac", "eac3"}
        self.hdr_tonemap_available = True
        self.sources = media_bridge.SourceRegistry()
        self.transcode_slots = threading.BoundedSemaphore(1)
        self.processes = media_bridge.ProcessRegistry()
        self.warm_sessions = media_bridge.WarmSessionRegistry(self)
        self.upstream = FakeProbeUpstream()
        self.video_encoder = "h264_videotoolbox"
        self.audio_encoder = "aac_at"
        self.result = result
        self.probe_calls = 0

    def source_url(self, key):
        return "http://127.0.0.1/source/%s" % key

    def probe_source(self, _key, _spec):
        self.probe_calls += 1
        return self.result


class MediaBridgeTests(unittest.TestCase):
    def _start_server(self, bridge):
        server = media_bridge.BridgeServer(("127.0.0.1", 0), media_bridge.BridgeHandler)
        server.bridge = bridge
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        return server, thread

    def _request_from(self, server, path, method="GET"):
        connection = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=2)
        try:
            connection.request(method, path)
            response = connection.getresponse()
            return response.status, response.read()
        finally:
            connection.close()

    def _request(self, bridge, path, method="GET"):
        server, thread = self._start_server(bridge)
        try:
            return self._request_from(server, path, method)
        finally:
            server.shutdown()
            thread.join(timeout=2)
            server.server_close()

    def test_range_proxy_accepts_only_one_byte_range(self):
        self.assertEqual(media_bridge.safe_range_header(" bytes=0-65535 "), "bytes=0-65535")
        self.assertEqual(media_bridge.safe_range_header("bytes=-1024"), "bytes=-1024")
        self.assertIsNone(media_bridge.safe_range_header("bytes=0-1,2-3"))
        self.assertIsNone(media_bridge.safe_range_header("items=0-1"))

    def test_stream_request_rejects_bad_input(self):
        with self.assertRaises(media_bridge.BridgeError) as bad_item:
            media_bridge.parse_stream_request("/v1/%s/stream/../secret" % CAPABILITY, CAPABILITY)
        self.assertEqual(bad_item.exception.status, 404)
        for query in ("startSeconds=-1", "startSeconds=1e4", "audioStreamIndex=-1", "bad=1"):
            with self.assertRaises(media_bridge.BridgeError) as invalid:
                media_bridge.parse_stream_request("/v1/%s/stream/abc?%s" % (CAPABILITY, query), CAPABILITY)
            self.assertEqual(invalid.exception.status, 400)
        parsed = media_bridge.parse_stream_request(
            "/v1/%s/stream/abc?mediaSourceId=source:main_01" % CAPABILITY, CAPABILITY
        )
        self.assertEqual(parsed.media_source_id, "source:main_01")

    def test_stream_protocol_defaults_to_ts_and_allows_opt_in_formats(self):
        default = media_bridge.parse_stream_request("/v1/%s/stream/abc" % CAPABILITY, CAPABILITY)
        mp4 = media_bridge.parse_stream_request("/v1/%s/stream/abc?format=mp4" % CAPABILITY, CAPABILITY)
        mkv = media_bridge.parse_stream_request("/v1/%s/stream/abc?format=mkv" % CAPABILITY, CAPABILITY)
        self.assertEqual(default.output_format, "ts")
        self.assertEqual(mp4.output_format, "mp4")
        self.assertEqual(mkv.output_format, "mkv")
        for query in ("format=webm", "format=mp4&format=ts"):
            with self.assertRaises(media_bridge.BridgeError) as invalid:
                media_bridge.parse_stream_request("/v1/%s/stream/abc?%s" % (CAPABILITY, query), CAPABILITY)
            self.assertEqual(invalid.exception.status, 400)

    def test_warm_request_requires_mkv_and_ready_id_is_opaque(self):
        warm = media_bridge.parse_warm_request(
            "/v1/%s/warm/abc?mediaSourceId=source-main&format=mkv" % CAPABILITY, CAPABILITY,
        )
        self.assertEqual(warm.item_id, "abc")
        self.assertEqual(warm.output_format, "mkv")
        for query in ("", "?format=ts", "?format=mp4"):
            with self.assertRaises(media_bridge.BridgeError) as invalid:
                media_bridge.parse_warm_request("/v1/%s/warm/abc%s" % (CAPABILITY, query), CAPABILITY)
            self.assertEqual(invalid.exception.status, 400)
        session_id = "a" * 32
        self.assertEqual(
            media_bridge.parse_warm_ready_request("/v1/%s/ready/%s" % (CAPABILITY, session_id), CAPABILITY),
            session_id,
        )
        for path in (
            "/v1/%s/ready/%s?x=1" % (CAPABILITY, session_id),
            "/v1/%s/ready/%s" % (CAPABILITY, "A" * 32),
        ):
            with self.assertRaises(media_bridge.BridgeError) as invalid:
                media_bridge.parse_warm_ready_request(path, CAPABILITY)
            self.assertEqual(invalid.exception.status, 404)

    def test_public_headers_are_live_and_format_specific(self):
        ts_headers = dict(media_bridge.public_stream_headers("ts"))
        mp4_headers = dict(media_bridge.public_stream_headers("mp4"))
        mkv_headers = dict(media_bridge.public_stream_headers("mkv"))
        self.assertEqual(ts_headers["Content-Type"], "video/mp2t")
        self.assertEqual(mp4_headers["Content-Type"], "video/mp4")
        self.assertEqual(mkv_headers["Content-Type"], "video/x-matroska")
        self.assertEqual(mp4_headers["Accept-Ranges"], "none")
        self.assertEqual(mkv_headers["Accept-Ranges"], "none")
        self.assertEqual(mp4_headers["Cache-Control"], "no-store")
        self.assertEqual(mkv_headers["Cache-Control"], "no-store")

    def test_nas_protocol_rejects_traversal_encoded_separator_and_non_video(self):
        accepted = media_bridge.parse_nas_request("/v1/%s/nas/folder/video.mp4" % CAPABILITY, CAPABILITY)
        self.assertEqual(accepted, ("folder", "video.mp4"))
        for path in (
            "/v1/%s/nas/../secret.mp4" % CAPABILITY,
            "/v1/%s/nas/%%2e%%2e/secret.mp4" % CAPABILITY,
            "/v1/%s/nas/folder%%2fsecret.mp4" % CAPABILITY,
            "/v1/%s/nas//secret.mp4" % CAPABILITY,
            "/v1/%s/nas/folder/secret.txt" % CAPABILITY,
        ):
            with self.assertRaises(media_bridge.BridgeError) as invalid:
                media_bridge.parse_nas_request(path, CAPABILITY)
            self.assertIn(invalid.exception.status, {400, 404})

    def test_nas_open_stays_beneath_root_and_rejects_symlink(self):
        with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as outside:
            folder = os.path.join(root, "folder")
            os.mkdir(folder)
            file_path = os.path.join(folder, "clip.mp4")
            with open(file_path, "wb") as output:
                output.write(b"abcdef")
            fd, size = media_bridge.open_nas_file(("folder", "clip.mp4"), root)
            try:
                self.assertEqual(size, 6)
                self.assertEqual(os.read(fd, 6), b"abcdef")
            finally:
                os.close(fd)
            os.symlink(os.path.join(outside, "outside.mp4"), os.path.join(root, "escape.mp4"))
            with self.assertRaises(media_bridge.NasFileError) as blocked:
                media_bridge.open_nas_file(("escape.mp4",), root)
            self.assertEqual(blocked.exception.status, 404)

    def test_nas_single_range_and_headers(self):
        self.assertEqual(media_bridge.file_byte_range("bytes=2-20", 10), (206, 2, 9))
        self.assertEqual(media_bridge.file_byte_range("bytes=-3", 10), (206, 7, 9))
        self.assertEqual(media_bridge.file_byte_range(None, 10), (200, 0, 9))
        with self.assertRaises(media_bridge.NasFileError) as invalid:
            media_bridge.file_byte_range("bytes=10-11", 10)
        self.assertEqual(invalid.exception.status, 416)
        headers = dict(media_bridge.nas_response_headers("clip.mp4", 10, 206, 2, 9))
        self.assertEqual(headers["Content-Range"], "bytes 2-9/10")
        self.assertEqual(headers["Content-Length"], "8")
        self.assertEqual(headers["Accept-Ranges"], "bytes")

    def test_nas_smb_settings_are_strictly_validated(self):
        settings = media_bridge.parse_nas_smb_config({
            "server": "nas.example", "share": "Media", "username": "reader", "password": "private-value",
        })
        self.assertEqual(settings.server, "nas.example")
        self.assertEqual(
            media_bridge.parse_nas_smb_config({
                "server": "NAS._smb._tcp.local", "share": "Media", "username": "reader", "password": "private-value",
            }).server,
            "NAS._smb._tcp.local",
        )
        for invalid in (
            {"server": "nas/example", "share": "Media", "username": "reader", "password": "private-value"},
            {"server": "999.999.999.999", "share": "Media", "username": "reader", "password": "private-value"},
            {"server": "nas.example", "share": "Media/escape", "username": "reader", "password": "private-value"},
            {"server": "nas.example", "share": "Media", "username": "reader"},
        ):
            with self.assertRaises(ValueError):
                media_bridge.parse_nas_smb_config(invalid)

    def test_smb_updater_reads_only_validated_stdin_json(self):
        with tempfile.TemporaryDirectory() as root:
            os.chmod(root, 0o700)
            config_path = Path(root) / "bridge-config.json"
            original = {"emby_token": "preserved"}
            config_path.write_text(json.dumps(original), encoding="utf-8")
            os.chmod(config_path, 0o600)
            payload = json.dumps({
                "server": "nas.example", "share": "Media", "username": "reader", "password": "private-value",
            }).encode("utf-8")
            self.assertEqual(update_nas_smb.update_smb_config(config_path, io.BytesIO(payload)), 0)
            updated = json.loads(config_path.read_text(encoding="utf-8"))
            self.assertEqual(updated["emby_token"], "preserved")
            self.assertEqual(updated["nas_smb"]["share"], "Media")
            self.assertEqual(config_path.stat().st_mode & 0o777, 0o600)
            before_invalid = config_path.read_bytes()
            invalid = b'{"server":"nas.example","share":"Media","username":"reader","password":"x","extra":"x"}'
            self.assertEqual(update_nas_smb.update_smb_config(config_path, io.BytesIO(invalid)), 1)
            self.assertEqual(config_path.read_bytes(), before_invalid)

    def test_smb_fallback_only_runs_after_local_nas_unavailable(self):
        settings = media_bridge.NasSmbConfig("nas.example", "Media", "reader", "private-value")
        calls = []

        def unavailable(_segments):
            raise media_bridge.NasFileError(503, "NAS unavailable")

        reader = io.BytesIO(b"abcdef")
        fallback = lambda segments, config: calls.append((segments, config)) or (reader, 6)
        result, size = media_bridge.open_nas_reader(("folder", "clip.mp4"), settings, unavailable, fallback)
        self.assertIs(result, reader)
        self.assertEqual(size, 6)
        self.assertEqual(calls, [(("folder", "clip.mp4"), settings)])

        bound_calls = []
        bound_reader = io.BytesIO(b"abcdef")
        result, size = media_bridge.open_nas_reader(
            ("folder", "clip.mp4"), settings, unavailable,
            lambda segments, config, source: bound_calls.append((segments, config, source)) or (bound_reader, 6),
            "192.168.50.20",
        )
        self.assertIs(result, bound_reader)
        self.assertEqual(size, 6)
        self.assertEqual(bound_calls, [(("folder", "clip.mp4"), settings, "192.168.50.20")])

        with self.assertRaises(media_bridge.NasFileError):
            media_bridge.open_nas_reader(
                ("folder", "clip.mp4"), settings,
                lambda _segments: (_ for _ in ()).throw(media_bridge.NasFileError(404, "not found")),
                lambda *_args: self.fail("SMB fallback must not run for a missing local file"),
            )

    def test_smb_open_uses_signed_no_follow_components_and_rejects_reparse(self):
        bindings = fake_smb_bindings()
        settings = media_bridge.NasSmbConfig("nas.example", "Media", "reader", "private-value")
        reader, size = media_bridge.open_smb_nas_file(("folder", "clip.mp4"), settings, bindings=bindings)
        self.assertEqual(size, 6)
        self.assertEqual(reader.read(2), b"ab")
        connection = FakeSmbConnection.instances[0]
        session = FakeSmbSession.instances[0]
        self.assertTrue(connection.require_signing)
        self.assertFalse(session.require_encryption)
        self.assertEqual(
            connection.receive_calls,
            [
                {"resolve_symlinks": False, "timeout": media_bridge.SMB_OPERATION_TIMEOUT_SECONDS},
                {"resolve_symlinks": False, "timeout": media_bridge.SMB_OPERATION_TIMEOUT_SECONDS},
            ],
        )
        self.assertEqual(len(FakeSmbOpen.instances), 2)
        for opened in FakeSmbOpen.instances:
            self.assertTrue(opened.create_args[-1] & FakeCreateOptions.FILE_OPEN_REPARSE_POINT)
        reader.close()
        self.assertTrue(connection.disconnected)

        bindings = fake_smb_bindings()
        FakeSmbOpen.reparse_paths = {"folder"}
        with self.assertRaises(media_bridge.NasFileError) as blocked:
            media_bridge.open_smb_nas_file(("folder", "clip.mp4"), settings, bindings=bindings)
        self.assertEqual(blocked.exception.status, 404)
        self.assertEqual(len(FakeSmbOpen.instances), 1)

    def test_smb_source_selection_and_socket_binding(self):
        ifconfig_output = """\
en0: flags=8863<UP,BROADCAST>
\tinet 192.168.50.20 netmask 0xffffff00 broadcast 192.168.50.255
utun10: flags=8051<UP,POINTOPOINT>
\tinet 10.0.0.2 netmask 0xffffff00
"""

        class Completed:
            returncode = 0
            stdout = ifconfig_output

        source = media_bridge.select_smb_source_address(
            "nas.example", "192.168.50.20", runner=lambda *_args, **_kwargs: Completed(),
            resolver=lambda *_args: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("192.168.50.30", 445))],
        )
        self.assertEqual(source, "192.168.50.20")
        with self.assertRaises(media_bridge.NasFileError):
            media_bridge.select_smb_source_address(
                "nas.example", "10.0.0.3", runner=lambda *_args, **_kwargs: Completed(),
                resolver=lambda *_args: [
                    (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("192.168.50.30", 445)),
                    (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.0.0.9", 445)),
                ],
            )

        bound_tcp = media_bridge._bound_smb_tcp_class(FakeTcp, source)
        with mock.patch.object(media_bridge.socket, "create_connection", return_value=FakeSocket()) as create_connection:
            transport = bound_tcp("192.168.50.30", 445, 5)
            transport.connect()
        self.assertTrue(transport.connected)
        create_connection.assert_called_once_with(
            ("192.168.50.30", 445), timeout=5, source_address=("192.168.50.20", 0),
        )

    def test_ffmpeg_muxer_parameters_keep_ts_default_and_make_opt_in_containers(self):
        config = media_bridge.Config("http://upstream.invalid", "private-token", "a" * 32,
                                     "192.168.50.20", 18099, CAPABILITY, "/ffmpeg", "/ffprobe")
        spec = media_bridge.SourceSpec("abc", None, audio_stream_index=1)
        ts_request = media_bridge.StreamRequest("abc", "0", None, None, "ts")
        mp4_request = media_bridge.StreamRequest("abc", "0", None, None, "mp4")
        mkv_request = media_bridge.StreamRequest("abc", "0", None, None, "mkv")
        ts_command = media_bridge.build_ffmpeg_command(config, "http://127.0.0.1/source", ts_request, spec, "h264_videotoolbox", "aac_at")
        mp4_command = media_bridge.build_ffmpeg_command(config, "http://127.0.0.1/source", mp4_request, spec, "h264_videotoolbox", "aac_at")
        mkv_command = media_bridge.build_ffmpeg_command(config, "http://127.0.0.1/source", mkv_request, spec, "h264_videotoolbox", "aac_at")
        self.assertIn("mpegts", ts_command)
        self.assertNotIn("-movflags", ts_command)
        self.assertIn("mp4", mp4_command)
        at = mp4_command.index("-map_chapters")
        self.assertEqual(mp4_command[at + 1], "-1")
        self.assertNotIn("-map_chapters", ts_command)
        self.assertNotIn("-map_chapters", mkv_command)
        self.assertIn("+frag_keyframe+empty_moov", mp4_command)
        self.assertNotIn("default_base_moof", " ".join(mp4_command))
        self.assertIn("1000000", mp4_command)
        self.assertEqual(
            mkv_command[-7:],
            ["-f", "matroska", "-live", "1", "-cluster_time_limit", "1000", "pipe:1"],
        )
        self.assertNotIn("-movflags", mkv_command)
        self.assertNotIn(config.emby_token, mp4_command)
        self.assertNotIn(config.emby_token, mkv_command)

    def test_transcoder_cleanup_falls_back_to_owned_child(self):
        process = mock.Mock(pid=42)
        process.poll.return_value = None
        process.wait.side_effect = [subprocess.TimeoutExpired("ffmpeg", 3), 0]
        with mock.patch.object(media_bridge.os, "killpg", side_effect=PermissionError):
            media_bridge.terminate_process(process)
        self.assertEqual(process.send_signal.call_args_list, [mock.call(signal.SIGTERM), mock.call(signal.SIGKILL)])

    def test_unsupported_requested_audio_falls_back_to_decodable_track(self):
        streams = [
            {"Type": "Audio", "Index": 0, "Codec": "av3a"},
            {"Type": "Audio", "Index": 1, "Codec": "eac3"},
            {"Type": "Audio", "Index": 3, "Codec": "aac"},
        ]
        decoders = {"eac3", "aac"}
        self.assertEqual(media_bridge.select_audio_stream(streams, None, decoders), 1)
        self.assertEqual(media_bridge.select_audio_stream(streams, 3, decoders), 3)
        self.assertEqual(media_bridge.select_audio_stream(streams, 0, decoders), 1)

    def test_client_disconnect_stops_transcoder(self):
        process = FakeProcess()
        stopped = []
        completed = media_bridge.write_transcoder_output(
            process, BrokenOutput(), b"initial", stop=lambda value: stopped.append(value)
        )
        self.assertFalse(completed)
        self.assertEqual(stopped, [process])

    def test_mkv_startup_buffer_collects_only_the_bounded_burst(self):
        process = FakeStartupProcess()
        chunks = [b"x" * media_bridge.TRANSCODER_CHUNK_BYTES] * (
            media_bridge.MKV_STARTUP_PREBUFFER_BYTES // media_bridge.TRANSCODER_CHUNK_BYTES
        )
        with mock.patch.object(media_bridge.select, "select", return_value=([process.stdout], [], [])), \
             mock.patch.object(media_bridge.os, "read", side_effect=chunks) as read:
            buffered = media_bridge._mkv_startup_buffer(process)
        self.assertEqual(len(buffered), media_bridge.MKV_STARTUP_PREBUFFER_BYTES)
        self.assertEqual(read.call_count, len(chunks))
        self.assertTrue(all(call.args[1] <= media_bridge.TRANSCODER_CHUNK_BYTES for call in read.call_args_list))

    def test_mkv_startup_buffer_abandons_before_headers_on_cancel_or_timeout(self):
        process = FakeStartupProcess()
        cancelled = threading.Event()
        cancelled.set()
        with mock.patch.object(media_bridge.select, "select") as select:
            self.assertIsNone(media_bridge._mkv_startup_buffer(process, cancelled))
            self.assertIsNone(media_bridge._mkv_startup_buffer(process, timeout_seconds=0))
        select.assert_not_called()

    def test_warm_startup_buffer_rejects_partial_live_output_but_keeps_clean_short_ebml(self):
        process = FakeStartupProcess()
        short_ebml = b"\x1a\x45\xdf\xa3short"
        with mock.patch.object(media_bridge.select, "select", return_value=([process.stdout], [], [])), \
             mock.patch.object(media_bridge.os, "read", side_effect=[short_ebml, b""]), \
             mock.patch.object(process, "poll", return_value=0):
            self.assertEqual(media_bridge._warm_mkv_startup_buffer(process), short_ebml)
        with mock.patch.object(media_bridge.select, "select", return_value=([process.stdout], [], [])), \
             mock.patch.object(media_bridge.os, "read", side_effect=[short_ebml, b""]), \
             mock.patch.object(process, "poll", return_value=1):
            self.assertIsNone(media_bridge._warm_mkv_startup_buffer(process))
        chunks = [b"\x1a\x45\xdf\xa3" + b"x" * (media_bridge.TRANSCODER_CHUNK_BYTES - 4)]
        chunks.extend([b"x" * media_bridge.TRANSCODER_CHUNK_BYTES] * (
            media_bridge.MKV_STARTUP_PREBUFFER_BYTES // media_bridge.TRANSCODER_CHUNK_BYTES - 1
        ))
        with mock.patch.object(media_bridge.select, "select", return_value=([process.stdout], [], [])), \
             mock.patch.object(media_bridge.os, "read", side_effect=chunks), \
             mock.patch.object(process, "poll", return_value=1):
            self.assertIsNone(media_bridge._warm_mkv_startup_buffer(process))
        self.assertIsNone(media_bridge._warm_mkv_startup_buffer(process, timeout_seconds=0))

    def test_warm_route_holds_one_prepared_stream_until_single_ready_get(self):
        result = media_bridge.ProbeResult("source-main", {}, None, "sdr", True, "", False)
        bridge = FakeProbeBridge(result)
        process = FakeWarmProcess()
        burst = b"\x1a\x45\xdf\xa3prepared"
        warm_path = "/v1/%s/warm/item615879?mediaSourceId=source-main&format=mkv" % CAPABILITY
        server, thread = self._start_server(bridge)
        try:
            with mock.patch.object(media_bridge.subprocess, "Popen", return_value=process) as popen, \
                 mock.patch.object(media_bridge, "_warm_mkv_startup_buffer", return_value=burst), \
                 mock.patch.object(media_bridge, "watch_client_disconnect"), \
                 mock.patch.object(media_bridge, "terminate_process") as stop:
                status, body = self._request_from(server, warm_path)
                self.assertEqual(status, 200)
                session_id = json.loads(body.decode("utf-8"))["sessionId"]
                self.assertEqual(len(session_id), 32)
                status, _body = self._request_from(
                    server, "/v1/%s/ready/%s" % (CAPABILITY, session_id), method="HEAD",
                )
                self.assertEqual(status, 200)
                self.assertIsNotNone(bridge.warm_sessions.inspect(session_id))
                status, body = self._request_from(server, "/v1/%s/ready/%s" % (CAPABILITY, session_id))
                self.assertEqual(status, 200)
                self.assertEqual(body, burst + b"later bytes")
                status, _body = self._request_from(server, "/v1/%s/ready/%s" % (CAPABILITY, session_id))
                self.assertEqual(status, 404)
                popen.assert_called_once()
                stop.assert_called_once_with(process)
            self.assertTrue(bridge.transcode_slots.acquire(blocking=False))
            bridge.transcode_slots.release()
        finally:
            server.shutdown()
            thread.join(timeout=2)
            server.server_close()

    def test_mkv_startup_burst_is_written_in_existing_stream_chunks(self):
        class RecordingOutput:
            def __init__(self):
                self.writes = []
                self.flushes = 0

            def write(self, value):
                self.writes.append(value)

            def flush(self):
                self.flushes += 1

        output = RecordingOutput()
        burst = b"x" * media_bridge.MKV_STARTUP_PREBUFFER_BYTES
        completed = media_bridge.write_transcoder_output(FakeStreamProcess(), output, burst)
        self.assertTrue(completed)
        self.assertEqual(b"".join(output.writes), burst)
        self.assertEqual(len(output.writes), media_bridge.MKV_STARTUP_PREBUFFER_BYTES // media_bridge.TRANSCODER_CHUNK_BYTES)
        self.assertEqual(output.flushes, len(output.writes))
        self.assertTrue(all(len(chunk) <= media_bridge.TRANSCODER_CHUNK_BYTES for chunk in output.writes))

    def test_socket_eof_stops_blocked_transcoder_before_next_output(self):
        client, server = socket.socketpair()
        process = FakeProcess()
        stopped = []
        finished = threading.Event()
        cancelled = threading.Event()
        watcher = threading.Thread(
            target=media_bridge.watch_client_disconnect,
            args=(server, process, finished),
            kwargs={"cancelled": cancelled, "stop": lambda value: stopped.append(value)},
        )
        watcher.start()
        client.close()
        watcher.join(timeout=2)
        server.close()
        self.assertFalse(watcher.is_alive())
        self.assertEqual(stopped, [process])
        self.assertTrue(cancelled.is_set())

    def test_probe_route_returns_sanitized_actual_dolby_vision_facts(self):
        result = media_bridge.probe_result_from_ffprobe(
            "mediasource_634941", ffprobe_payload("smpte2084", 5), None, True,
        )
        bridge = FakeProbeBridge(result)
        status, body = self._request(
            bridge, "/v1/%s/probe/item615879?mediaSourceId=mediasource_634941" % CAPABILITY,
        )
        response = json.loads(body.decode("utf-8"))
        self.assertEqual(status, 200)
        self.assertTrue(response["returnValue"])
        self.assertEqual(response["mediaSourceId"], "mediasource_634941")
        self.assertEqual(response["video"], {
            "codec": "hevc", "profile": "Main 10", "pixFmt": "yuv420p10le", "bitDepth": 10,
            "width": 1920, "height": 800, "colorTransfer": "smpte2084", "colorPrimaries": "bt2020",
            "colorSpace": "bt2020nc", "colorRange": "pc", "dolbyVisionProfile": 5,
        })
        self.assertEqual(response["hdrKind"], "dolby-vision")
        self.assertFalse(response["miniSupported"])
        self.assertEqual(response["reason"], "Dolby Vision Profile 5 is unsupported")
        self.assertNotIn("rpu_present_flag", body.decode("utf-8"))
        self.assertEqual(bridge.upstream.calls, 1)
        self.assertEqual(bridge.probe_calls, 1)

    def test_mp4_waits_for_releasing_single_transcode_slot(self):
        bridge = FakeProbeBridge(None)
        slot = bridge.transcode_slots
        self.assertTrue(slot.acquire(blocking=False))
        attempted = threading.Event()

        class ObservedSlot:
            def acquire(self, *args, **kwargs):
                attempted.set()
                return slot.acquire(*args, **kwargs)

            def release(self):
                slot.release()

        bridge.transcode_slots = ObservedSlot()
        released = threading.Event()

        def release_old_stream():
            if attempted.wait(1):
                slot.release()
                released.set()

        releaser = threading.Thread(target=release_old_stream)
        releaser.start()

        def stream(handler, request):
            self.assertEqual(request.output_format, "mp4")
            handler.send_response(200)
            handler.send_header("Content-Length", "6")
            handler.end_headers()
            handler.wfile.write(b"stream")

        try:
            with mock.patch.object(media_bridge.BridgeHandler, "_stream", stream):
                status, body = self._request(bridge, "/v1/%s/stream/item?format=mp4" % CAPABILITY)
            self.assertTrue(released.is_set())
            self.assertEqual((status, body), (200, b"stream"))
            self.assertTrue(slot.acquire(blocking=False), "handler releases the acquired slot")
            slot.release()
        finally:
            releaser.join(timeout=2)

    def test_busy_stream_wait_is_bounded(self):
        bridge = FakeProbeBridge(None)
        self.assertTrue(bridge.transcode_slots.acquire(blocking=False))
        try:
            with mock.patch.object(media_bridge, "STREAM_RESTART_SLOT_WAIT_SECONDS", 0.05), \
                 mock.patch.object(media_bridge.BridgeHandler, "_stream") as stream:
                for fmt in ("ts", "mp4", "mkv"):
                    status, body = self._request(bridge, "/v1/%s/stream/item?format=%s" % (CAPABILITY, fmt))
                    self.assertEqual(status, 429)
                    self.assertEqual(json.loads(body)["error"], "transcoder busy")
                stream.assert_not_called()
        finally:
            bridge.transcode_slots.release()

    def test_stream_refuses_dolby_vision_profile_5_before_ffmpeg(self):
        result = media_bridge.probe_result_from_ffprobe(
            "mediasource_634941", ffprobe_payload("smpte2084", 5), 1, True,
        )
        bridge = FakeProbeBridge(result)
        with mock.patch.object(media_bridge.subprocess, "Popen") as popen:
            status, body = self._request(
                bridge, "/v1/%s/stream/item615879?mediaSourceId=mediasource_634941" % CAPABILITY,
            )
        self.assertEqual(status, 415)
        self.assertEqual(json.loads(body.decode("utf-8"))["error"], "Dolby Vision Profile 5 is unsupported")
        popen.assert_not_called()

    def test_stream_returns_safe_502_when_actual_probe_fails_before_ffmpeg(self):
        result = media_bridge.probe_result_from_ffprobe("source-main", ffprobe_payload(), 1, True)
        bridge = FakeProbeBridge(result)
        bridge.probe_source = mock.Mock(side_effect=media_bridge.ProbeError())
        with mock.patch.object(media_bridge.subprocess, "Popen") as popen:
            status, body = self._request(
                bridge, "/v1/%s/stream/item615879?mediaSourceId=source-main" % CAPABILITY,
            )
        self.assertEqual(status, 502)
        self.assertEqual(json.loads(body.decode("utf-8"))["error"], "source metadata unavailable")
        popen.assert_not_called()

    def test_mkv_startup_buffer_failure_returns_503_before_stream_headers(self):
        result = media_bridge.probe_result_from_ffprobe("source-main", ffprobe_payload(), 1, True)
        bridge = FakeProbeBridge(result)
        process = FakeStreamProcess()
        with mock.patch.object(media_bridge.subprocess, "Popen", return_value=process) as popen, \
             mock.patch.object(media_bridge, "_mkv_startup_buffer", return_value=None) as startup, \
             mock.patch.object(media_bridge, "watch_client_disconnect"), \
             mock.patch.object(media_bridge, "terminate_process") as stop:
            status, body = self._request(
                bridge, "/v1/%s/stream/item615879?mediaSourceId=source-main&format=mkv" % CAPABILITY,
            )
        self.assertEqual(status, 503)
        self.assertEqual(json.loads(body.decode("utf-8"))["error"], "transcode startup buffer unavailable")
        popen.assert_called_once()
        startup.assert_called_once()
        stop.assert_called_once_with(process)

    def test_actual_hdr_metadata_overrides_stale_sdr_and_sdr_stays_untonemapped(self):
        for color_transfer, hdr_kind in (("smpte2084", "hdr10"), ("arib-std-b67", "hlg")):
            payload = ffprobe_payload(color_transfer)
            payload["streams"][0]["VideoRange"] = "SDR"  # Stale Emby metadata is not consulted here.
            result = media_bridge.probe_result_from_ffprobe("source-hdr", payload, 1, True)
            self.assertEqual(result.hdr_kind, hdr_kind)
            self.assertTrue(result.mini_supported)
            self.assertTrue(result.requires_hdr_tonemap)
            self.assertIn("tonemap", media_bridge.video_filter(result.requires_hdr_tonemap))
        sdr = media_bridge.probe_result_from_ffprobe("source-sdr", ffprobe_payload(), 1, True)
        self.assertEqual(sdr.hdr_kind, "sdr")
        self.assertTrue(sdr.mini_supported)
        self.assertFalse(sdr.requires_hdr_tonemap)
        self.assertNotIn("tonemap", media_bridge.video_filter(sdr.requires_hdr_tonemap))

    def test_probe_uses_loopback_proxy_without_emby_credential_in_argv(self):
        config = bridge_config()
        source_url = "http://127.0.0.1:19001/source/nonce/key"
        completed = SimpleNamespace(returncode=0, stdout=json.dumps(ffprobe_payload()).encode("utf-8"))
        with mock.patch.object(media_bridge.subprocess, "run", return_value=completed) as run:
            result = media_bridge.probe_media_source(config, source_url, "source-main", 1, True)
        command = run.call_args.args[0]
        self.assertEqual(result.hdr_kind, "sdr")
        self.assertEqual(command[-1], source_url)
        self.assertNotIn(config.emby_token, command)
        self.assertNotIn("Authorization", " ".join(command))
        self.assertEqual(command[command.index("-probesize") + 1], str(media_bridge.FFPROBE_PROBESIZE_BYTES))
        self.assertEqual(run.call_args.kwargs["timeout"], media_bridge.FFPROBE_TIMEOUT_SECONDS)

    def test_probe_requires_authorized_valid_source_before_upstream_work(self):
        result = media_bridge.probe_result_from_ffprobe("source-main", ffprobe_payload(), None, True)
        bridge = FakeProbeBridge(result)
        wrong_capability = "B" * 24
        status, _body = self._request(
            bridge, "/v1/%s/probe/item615879?mediaSourceId=source-main" % wrong_capability,
        )
        self.assertEqual(status, 404)
        status, _body = self._request(bridge, "/v1/%s/probe/item615879" % CAPABILITY)
        self.assertEqual(status, 400)
        status, _body = self._request(
            bridge, "/v1/%s/probe/item615879?mediaSourceId=bad%%2Fsource" % CAPABILITY,
        )
        self.assertEqual(status, 400)
        self.assertEqual(bridge.upstream.calls, 0)
        self.assertEqual(bridge.probe_calls, 0)

    def test_prepare_requires_an_exact_requested_media_source(self):
        client = media_bridge.UpstreamClient(bridge_config())
        matching = {"Id": "source-main", "Container": "mkv", "MediaStreams": []}
        with mock.patch.object(client, "_request_json", return_value={"MediaSources": [matching]}):
            spec = media_bridge.SourceSpec("item615879", "source-main")
            client.prepare(spec, None, {"aac"}, select_audio=False)
        self.assertEqual(spec.selected_source_id, "source-main")
        with mock.patch.object(client, "_request_json", return_value={"MediaSources": [matching]}):
            with self.assertRaises(media_bridge.UpstreamError):
                client.prepare(media_bridge.SourceSpec("item615879", "other-source"), None, {"aac"}, select_audio=False)

    def test_playback_rate_limit_reaches_all_routes_without_retry(self):
        bridge = FakeProbeBridge(None)
        bridge.upstream = media_bridge.UpstreamClient(bridge_config())
        server, thread = self._start_server(bridge)
        try:
            for status, payload in ((429, {}), (200, {"MediaSources": [], "ErrorCode": "RateLimitExceeded"})):
                for route in ("probe", "warm", "stream"):
                    for source in ("source-main", None):
                        if route == "probe" and source is None:
                            continue
                        with self.subTest(status=status, route=route, source=source):
                            response = mock.Mock(status=status)
                            response.read.return_value = json.dumps(payload).encode("utf-8")
                            connection = mock.Mock()
                            connection.getresponse.return_value = response
                            query = []
                            if source is not None:
                                query.append("mediaSourceId=" + source)
                            if route == "warm":
                                query.append("format=mkv")
                            path = "/v1/%s/%s/item615879" % (CAPABILITY, route)
                            if query:
                                path += "?" + "&".join(query)
                            with mock.patch.object(bridge.upstream, "_connection", return_value=connection) as connect, \
                                 mock.patch.object(media_bridge.subprocess, "Popen") as popen:
                                actual_status, body = self._request_from(server, path)
                            self.assertEqual(actual_status, 429)
                            self.assertEqual(json.loads(body)["error"], "upstream rate limited")
                            connect.assert_called_once()
                            connection.request.assert_called_once()
                            popen.assert_not_called()
                            self.assertEqual(bridge.probe_calls, 0)
        finally:
            server.shutdown()
            thread.join(timeout=2)
            server.server_close()

    def test_other_empty_playback_results_remain_upstream_errors(self):
        client = media_bridge.UpstreamClient(bridge_config())
        for payload in ({"MediaSources": []}, {"MediaSources": [], "ErrorCode": "OtherError"},
                        {"ErrorCode": "RateLimitExceeded"}):
            with self.subTest(payload=payload), mock.patch.object(client, "_request_json", return_value=payload):
                with self.assertRaises(media_bridge.UpstreamError) as caught:
                    client.prepare(media_bridge.SourceSpec("item615879", None), None, {"aac"}, select_audio=False)
                self.assertNotIsInstance(caught.exception, media_bridge.UpstreamRateLimitError)

    def test_open_stream_retries_one_reset_before_response_headers(self):
        class Connection:
            def __init__(self, response=None, failure=None):
                self.response = response
                self.failure = failure
                self.requests = []
                self.closed = False

            def request(self, method, path, headers=None):
                self.requests.append((method, path, headers))
                if self.failure is not None:
                    raise self.failure

            def getresponse(self):
                if self.failure is not None:
                    raise self.failure
                return self.response

            def close(self):
                self.closed = True

        class Response:
            status = 206

            def close(self):
                raise AssertionError("successful response must remain open")

        client = media_bridge.UpstreamClient(bridge_config())
        first = Connection(failure=ConnectionResetError())
        second = Connection(response=Response())
        spec = media_bridge.SourceSpec("item615879", "source-main", direct_path="/safe/direct-path")
        with mock.patch.object(client, "_connection", side_effect=[first, second]) as connect:
            connection, response = client.open_stream(spec, "bytes=0-1048575", "GET")
        self.assertIs(connection, second)
        self.assertIsInstance(response, Response)
        self.assertTrue(first.closed)
        self.assertFalse(second.closed)
        self.assertEqual(connect.call_count, 2)
        self.assertEqual(first.requests, second.requests)
        method, path, headers = second.requests[0]
        self.assertEqual((method, path), ("GET", "/safe/direct-path"))
        self.assertEqual(headers["Range"], "bytes=0-1048575")

    def test_open_stream_stops_after_one_reset_retry(self):
        class Connection:
            def __init__(self):
                self.closed = False

            def request(self, _method, _path, headers=None):
                self.headers = headers

            def getresponse(self):
                raise ConnectionResetError()

            def close(self):
                self.closed = True

        client = media_bridge.UpstreamClient(bridge_config())
        first = Connection()
        second = Connection()
        spec = media_bridge.SourceSpec("item615879", "source-main", direct_path="/safe/direct-path")
        with mock.patch.object(client, "_connection", side_effect=[first, second]) as connect:
            with self.assertRaises(media_bridge.UpstreamError):
                client.open_stream(spec, None, "GET")
        self.assertEqual(connect.call_count, 2)
        self.assertTrue(first.closed)
        self.assertTrue(second.closed)

    def test_open_stream_does_not_retry_other_transport_failures(self):
        class Connection:
            def __init__(self):
                self.closed = False

            def request(self, _method, _path, headers=None):
                self.headers = headers

            def getresponse(self):
                raise OSError("not a peer reset")

            def close(self):
                self.closed = True

        client = media_bridge.UpstreamClient(bridge_config())
        first = Connection()
        unused = Connection()
        spec = media_bridge.SourceSpec("item615879", "source-main", direct_path="/safe/direct-path")
        with mock.patch.object(client, "_connection", side_effect=[first, unused]) as connect:
            with self.assertRaises(media_bridge.UpstreamError):
                client.open_stream(spec, None, "GET")
        self.assertEqual(connect.call_count, 1)
        self.assertTrue(first.closed)
        self.assertFalse(unused.closed)

    def test_probe_cache_is_bounded_and_expires(self):
        result = media_bridge.probe_result_from_ffprobe("source-main", ffprobe_payload(), None, True)
        cache = media_bridge.ProbeCache()
        with mock.patch.object(media_bridge.time, "monotonic", return_value=10):
            for index in range(17):
                cache.put("source-%d" % index, result)
        self.assertEqual(len(cache._entries), media_bridge.PROBE_CACHE_MAX_ENTRIES)
        self.assertNotIn("source-0", cache._entries)
        expiring = media_bridge.ProbeCache()
        with mock.patch.object(media_bridge.time, "monotonic", return_value=10):
            expiring.put("source-main", result)
        with mock.patch.object(media_bridge.time, "monotonic", return_value=10 + media_bridge.PROBE_CACHE_TTL_SECONDS):
            self.assertIsNone(expiring.get("source-main"))

    def test_hdr_marker_selects_tonemap_filter(self):
        self.assertTrue(media_bridge.is_hdr_stream({"ColorTransfer": "smpte2084"}))
        self.assertIn("zscale", media_bridge.video_filter(True))
        self.assertNotIn("tonemap", media_bridge.video_filter(False))


class NetworkPlaybackTests(unittest.TestCase):
    _start_server = MediaBridgeTests._start_server
    _request_from = MediaBridgeTests._request_from

    def test_network_route_security_and_seek(self):
        bridge = FakeProbeBridge(None)
        server, thread = self._start_server(bridge)
        try:
            for route in ("library-probe", "library-transcode", "library-subtitle"):
                filename = "clip.srt" if route == "library-subtitle" else "clip.mp4"
                for path in ("/v1/%s/%s/nas/%%2e%%2e/%s" % (CAPABILITY, route, filename),
                             "/v1/%s/%s/nas/a%%2fb/%s" % (CAPABILITY, route, filename)):
                    self.assertEqual(self._request_from(server, path)[0], 400)
                self.assertEqual(self._request_from(server, "/v1/%s/%s/nas/%s" % ("B" * 24, route, filename))[0], 404)
            for query in ("startSeconds=-1", "startSeconds=2&startSeconds=3", "format=mp4", "extra=1"):
                self.assertEqual(self._request_from(server, "/v1/%s/library-transcode/nas/clip.mp4?%s" % (CAPABILITY, query))[0], 400)
        finally:
            server.shutdown()
            thread.join(timeout=2)
            server.server_close()
        self.assertEqual(bridge.probe_calls, 0)
        self.assertEqual(bridge.upstream.calls, 0)

    def test_probe_and_subtitle_routes(self):
        result = media_bridge.probe_result_from_ffprobe("source-main", ffprobe_payload(), None, True)
        bridge = FakeProbeBridge(result)
        with tempfile.TemporaryDirectory() as root:
            bridge.config = media_bridge.replace(bridge.config, nas_root=root)
            Path(root, "clip.srt").write_bytes(b"\xef\xbb\xbf1\n00:00:00,000 --> 00:00:01,000\nHello\n")
            server, thread = self._start_server(bridge)
            try:
                status, body = self._request_from(server, "/v1/%s/library-probe/nas/clip.mp4" % CAPABILITY)
                self.assertEqual(status, 200)
                self.assertTrue(json.loads(body)["miniSupported"])
                status, body = self._request_from(server, "/v1/%s/library-subtitle/nas/clip.srt" % CAPABILITY)
                self.assertEqual(status, 200)
                self.assertTrue(body.startswith(b"1\n"))
                self.assertIn(b"Hello", body)
            finally:
                server.shutdown()
                thread.join(timeout=2)
                server.server_close()
        self.assertEqual(bridge.upstream.calls, 0)

    def test_probe_duration_and_command_are_confined(self):
        payload = ffprobe_payload()
        payload["format"] = {"duration": "61.5"}
        completed = SimpleNamespace(returncode=0, stdout=json.dumps(payload).encode())
        with mock.patch.object(media_bridge.subprocess, "run", return_value=completed) as run:
            result = media_bridge.probe_media_source(bridge_config(), "http://127.0.0.1/source/key", "network", None, True, network=True)
        self.assertEqual(result.payload()["durationSeconds"], 61.5)
        self.assertIn("-protocol_whitelist", run.call_args.args[0])
        spec = media_bridge.SourceSpec("network", "network", network_file=("nas", ("clip.mp4",)))
        request = media_bridge.StreamRequest("network", "12.5", None, "network", "ts")
        command = media_bridge.build_ffmpeg_command(bridge_config(), "http://127.0.0.1/source/key", request, spec, "libx264", "aac")
        self.assertEqual(command[command.index("-ss") + 1], "12.5")
        self.assertIn("0:a:0?", command)
        self.assertIn("-protocol_whitelist", command)
        self.assertEqual(command[command.index("-f") + 1], "mpegts")
        self.assertEqual(command[-1], "pipe:1")


if __name__ == "__main__":
    unittest.main()
