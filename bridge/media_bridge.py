#!/usr/bin/env python3
"""LAN-only, capability-protected, on-demand Emby transcoding bridge.

The public listener never receives the Emby credential. FFmpeg and FFprobe read
through a separate loopback-only Range proxy, which attaches Authorization internally.
No request path, media title, token, or upstream URL is logged.
"""

import argparse
from collections import OrderedDict
import hmac
import http.client
import ipaddress
import json
import logging
import mimetypes
import os
import re
import secrets
import select
import signal
import socket
import stat
import subprocess
import sys
import threading
import time
import uuid
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Dict, Optional
from urllib.parse import parse_qs, quote, unquote, urlencode, urlsplit


MAX_TRANSCODES = 1
FIRST_OUTPUT_TIMEOUT_SECONDS = 15
MKV_STARTUP_PREBUFFER_BYTES = 1024 * 1024
MKV_STARTUP_PREBUFFER_TIMEOUT_SECONDS = 20
WARM_SLOT_WAIT_SECONDS = 1
STREAM_RESTART_SLOT_WAIT_SECONDS = 4
WARM_SESSION_TTL_SECONDS = 15
TRANSCODER_CHUNK_BYTES = 64 * 1024
SMB_OPERATION_TIMEOUT_SECONDS = 5
FFPROBE_TIMEOUT_SECONDS = 15
FFPROBE_PROBESIZE_BYTES = 3_000_000
FFPROBE_ANALYZE_DURATION_MICROSECONDS = 15_000_000
PROBE_CACHE_MAX_ENTRIES = 16
PROBE_CACHE_TTL_SECONDS = 300
MAX_START_SECONDS = Decimal("604800")
IDENTIFIER_RE = re.compile(r"[A-Za-z0-9-]{1,128}\Z")
SOURCE_IDENTIFIER_RE = re.compile(r"[A-Za-z0-9._~:-]{1,256}\Z")
CAPABILITY_RE = re.compile(r"[A-Za-z0-9_-]{24,128}\Z")
WARM_SESSION_ID_RE = re.compile(r"[0-9a-f]{32}\Z")
CONTAINER_RE = re.compile(r"[A-Za-z0-9]{1,32}\Z")
RANGE_RE = re.compile(r"bytes=(?:\d*)-(?:\d*)\Z")
SECONDS_RE = re.compile(r"(?:0|[1-9]\d*)(?:\.\d{1,3})?\Z")
OUTPUT_FORMATS = {
    "ts": ("mpegts", "video/mp2t"),
    "mp4": ("mp4", "video/mp4"),
    "mkv": ("matroska", "video/x-matroska"),
}
NAS_ROOT = "/Volumes/NAS"
NAS_VIDEO_EXTENSIONS = frozenset({".mp4", ".m4v", ".mov", ".mkv", ".ts", ".avi", ".webm", ".3gp"})
SMB_TRANSPORT_LOCK = threading.Lock()
IFCONFIG_INET_RE = re.compile(
    r"^\s*inet\s+(?P<address>\d{1,3}(?:\.\d{1,3}){3})\s+netmask\s+"
    r"(?P<netmask>0x[0-9A-Fa-f]{1,8}|\d{1,3}(?:\.\d{1,3}){3})\b",
    re.MULTILINE,
)
SMB_SERVER_RE = re.compile(
    r"(?:[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?\.)*"
    r"[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?\Z"
)
SMB_SHARE_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._$ -]{0,79}\Z")


class BridgeError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


class UpstreamError(Exception):
    """Upstream details must never be sent to a client or written to logs."""


class UpstreamRateLimitError(UpstreamError):
    """PlaybackInfo reported a rate limit."""


class ProbeError(Exception):
    """Actual source metadata could not be safely established."""


class UnsupportedMediaError(Exception):
    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


class NasFileError(Exception):
    def __init__(self, status: int, message: str, size: Optional[int] = None):
        super().__init__(message)
        self.status = status
        self.message = message
        self.size = size


@dataclass(frozen=True)
class NasSmbConfig:
    server: str
    share: str
    username: str
    password: str


@dataclass(frozen=True)
class Config:
    emby_base: str
    emby_token: str
    emby_user_id: str
    listen_host: str
    listen_port: int
    capability: str
    ffmpeg: str
    ffprobe: str
    nas_smb: Optional[NasSmbConfig] = None
    nas_root: str = NAS_ROOT


@dataclass(frozen=True)
class StreamRequest:
    item_id: str
    start_seconds: str
    audio_stream_index: Optional[int]
    media_source_id: Optional[str]
    output_format: str


@dataclass(frozen=True)
class ProbeRequest:
    item_id: str
    media_source_id: str


@dataclass
class SourceSpec:
    item_id: str
    media_source_id: Optional[str]
    audio_stream_index: Optional[int] = None
    requires_hdr_tonemap: bool = False
    direct_path: Optional[str] = None
    selected_source_id: Optional[str] = None
    lock: threading.Lock = field(default_factory=threading.Lock)


@dataclass(frozen=True)
class ProbeResult:
    media_source_id: str
    video: dict
    audio: Optional[dict]
    hdr_kind: str
    mini_supported: bool
    reason: str
    requires_hdr_tonemap: bool

    def payload(self) -> dict:
        payload = {
            "returnValue": True,
            "mediaSourceId": self.media_source_id,
            "video": self.video,
            "hdrKind": self.hdr_kind,
            "miniSupported": self.mini_supported,
            "reason": self.reason,
        }
        if self.audio is not None:
            payload["audio"] = self.audio
        return payload


def _required_string(data: dict, key: str) -> str:
    value = data.get(key)
    if not isinstance(value, str) or not value:
        raise ValueError("missing private configuration")
    return value


def _safe_smb_text(value: object, maximum: int) -> bool:
    return (
        isinstance(value, str)
        and bool(value)
        and len(value) <= maximum
        and "\x00" not in value
        and not any(ord(character) < 32 or ord(character) == 127 for character in value)
    )


def _valid_smb_server(value: object) -> bool:
    if not _safe_smb_text(value, 253) or not SMB_SERVER_RE.fullmatch(value):
        return False
    if re.fullmatch(r"[0-9.]+", value):
        try:
            return isinstance(ipaddress.ip_address(value), ipaddress.IPv4Address)
        except ValueError:
            return False
    return True


def parse_nas_smb_config(data: object) -> Optional[NasSmbConfig]:
    if data is None:
        return None
    if not isinstance(data, dict) or set(data) != {"server", "share", "username", "password"}:
        raise ValueError("SMB configuration is invalid")
    server = data["server"]
    share = data["share"]
    username = data["username"]
    password = data["password"]
    if not _valid_smb_server(server):
        raise ValueError("SMB server is invalid")
    if not _safe_smb_text(share, 80) or not SMB_SHARE_RE.fullmatch(share):
        raise ValueError("SMB share is invalid")
    if not _safe_smb_text(username, 256) or not _safe_smb_text(password, 1024):
        raise ValueError("SMB credential is invalid")
    return NasSmbConfig(server, share, username, password)


def load_config(path: Path) -> Config:
    try:
        if path.stat().st_mode & 0o077:
            raise ValueError("private configuration permissions are too broad")
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("private configuration is unavailable") from exc
    if not isinstance(data, dict):
        raise ValueError("private configuration is invalid")
    base = _required_string(data, "emby_base")
    parsed = urlsplit(base)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("upstream address is invalid")
    host = _required_string(data, "listen_host")
    try:
        address = ipaddress.ip_address(host)
    except ValueError as exc:
        raise ValueError("listener address is invalid") from exc
    if not address.is_private or address.is_loopback or address.is_unspecified:
        raise ValueError("listener must be a specific private LAN address")
    port = data.get("listen_port")
    if not isinstance(port, int) or not 1024 <= port <= 65535:
        raise ValueError("listener port is invalid")
    capability = _required_string(data, "capability")
    if not CAPABILITY_RE.fullmatch(capability):
        raise ValueError("capability is invalid")
    user_id = _required_string(data, "emby_user_id")
    if not IDENTIFIER_RE.fullmatch(user_id):
        raise ValueError("user identifier is invalid")
    token = _required_string(data, "emby_token")
    ffmpeg = _required_string(data, "ffmpeg")
    ffprobe = _required_string(data, "ffprobe")
    if not os.path.isabs(ffmpeg) or not os.path.isabs(ffprobe):
        raise ValueError("media tool paths must be absolute")
    nas_smb = parse_nas_smb_config(data.get("nas_smb"))
    nas_root = data.get("nas_root", NAS_ROOT)
    if not isinstance(nas_root, str) or not Path(nas_root).is_absolute():
        raise ValueError("NAS root must be an absolute directory")
    return Config(base.rstrip("/"), token, user_id, host, port, capability, ffmpeg, ffprobe, nas_smb, nas_root)


def safe_range_header(value: Optional[str]) -> Optional[str]:
    """Only forward a single conventional byte range to the authorized source."""
    if value is None:
        return None
    value = value.strip()
    return value if RANGE_RE.fullmatch(value) else None


def _query_value(query: Dict[str, list], name: str) -> Optional[str]:
    values = query.get(name)
    if values is None:
        return None
    if len(values) != 1:
        raise BridgeError(400, "invalid query")
    return values[0]


def _parse_transcode_request(path: str, capability: str, endpoint: str) -> StreamRequest:
    parsed = urlsplit(path)
    parts = parsed.path.split("/")
    if len(parts) != 5 or parts[0] or parts[1] != "v1" or parts[3] != endpoint:
        raise BridgeError(404, "not found")
    if not hmac.compare_digest(parts[2], capability):
        raise BridgeError(404, "not found")
    item_id = parts[4]
    if not IDENTIFIER_RE.fullmatch(item_id):
        raise BridgeError(400, "invalid item identifier")
    query = parse_qs(parsed.query, keep_blank_values=True, strict_parsing=False)
    if set(query).difference({"startSeconds", "audioStreamIndex", "mediaSourceId", "format"}):
        raise BridgeError(400, "invalid query")
    start_seconds = _query_value(query, "startSeconds") or "0"
    if not SECONDS_RE.fullmatch(start_seconds):
        raise BridgeError(400, "invalid start time")
    try:
        if Decimal(start_seconds) > MAX_START_SECONDS:
            raise BridgeError(400, "start time is too large")
    except InvalidOperation as exc:
        raise BridgeError(400, "invalid start time") from exc
    audio_text = _query_value(query, "audioStreamIndex")
    audio_stream_index = None
    if audio_text is not None:
        if not re.fullmatch(r"\d{1,2}", audio_text):
            raise BridgeError(400, "invalid audio stream")
        audio_stream_index = int(audio_text)
    media_source_id = _query_value(query, "mediaSourceId")
    if media_source_id is not None and not SOURCE_IDENTIFIER_RE.fullmatch(media_source_id):
        raise BridgeError(400, "invalid media source")
    output_format = _query_value(query, "format") or "ts"
    if output_format not in OUTPUT_FORMATS:
        raise BridgeError(400, "invalid output format")
    return StreamRequest(item_id, start_seconds, audio_stream_index, media_source_id, output_format)


def parse_stream_request(path: str, capability: str) -> StreamRequest:
    return _parse_transcode_request(path, capability, "stream")


def is_warm_request(path: str) -> bool:
    parts = urlsplit(path).path.split("/")
    return len(parts) >= 4 and not parts[0] and parts[1] == "v1" and parts[3] == "warm"


def parse_warm_request(path: str, capability: str) -> StreamRequest:
    request = _parse_transcode_request(path, capability, "warm")
    if request.output_format != "mkv":
        raise BridgeError(400, "warmup requires mkv")
    return request


def is_warm_ready_request(path: str) -> bool:
    parts = urlsplit(path).path.split("/")
    return len(parts) >= 4 and not parts[0] and parts[1] == "v1" and parts[3] == "ready"


def parse_warm_ready_request(path: str, capability: str) -> str:
    parsed = urlsplit(path)
    parts = parsed.path.split("/")
    if len(parts) != 5 or parts[0] or parts[1] != "v1" or parts[3] != "ready":
        raise BridgeError(404, "not found")
    if not hmac.compare_digest(parts[2], capability):
        raise BridgeError(404, "not found")
    if parsed.query or not WARM_SESSION_ID_RE.fullmatch(parts[4]):
        raise BridgeError(404, "not found")
    return parts[4]


def is_probe_request(path: str) -> bool:
    parts = urlsplit(path).path.split("/")
    return len(parts) >= 4 and not parts[0] and parts[1] == "v1" and parts[3] == "probe"


def parse_probe_request(path: str, capability: str) -> ProbeRequest:
    parsed = urlsplit(path)
    parts = parsed.path.split("/")
    if len(parts) != 5 or parts[0] or parts[1] != "v1" or parts[3] != "probe":
        raise BridgeError(404, "not found")
    if not hmac.compare_digest(parts[2], capability):
        raise BridgeError(404, "not found")
    item_id = parts[4]
    if not IDENTIFIER_RE.fullmatch(item_id):
        raise BridgeError(400, "invalid item identifier")
    query = parse_qs(parsed.query, keep_blank_values=True, strict_parsing=False)
    if set(query).difference({"mediaSourceId"}):
        raise BridgeError(400, "invalid query")
    media_source_id = _query_value(query, "mediaSourceId")
    if media_source_id is None or not SOURCE_IDENTIFIER_RE.fullmatch(media_source_id):
        raise BridgeError(400, "invalid media source")
    return ProbeRequest(item_id, media_source_id)


def parse_health_request(path: str, capability: str) -> bool:
    parts = urlsplit(path).path.split("/")
    return (
        len(parts) == 4
        and not parts[0]
        and parts[1] == "v1"
        and parts[3] == "health"
        and hmac.compare_digest(parts[2], capability)
    )


def is_nas_request(path: str) -> bool:
    parts = urlsplit(path).path.split("/")
    return len(parts) >= 4 and not parts[0] and parts[1] == "v1" and parts[3] == "nas"


def parse_nas_request(path: str, capability: str) -> tuple:
    """Return validated relative path segments beneath the fixed NAS root."""
    parsed = urlsplit(path)
    parts = parsed.path.split("/")
    if len(parts) < 5 or parts[0] or parts[1] != "v1" or parts[3] != "nas":
        raise BridgeError(404, "not found")
    if not hmac.compare_digest(parts[2], capability):
        raise BridgeError(404, "not found")
    if parsed.query:
        raise BridgeError(400, "invalid query")
    segments = []
    for raw_segment in parts[4:]:
        try:
            segment = unquote(raw_segment, encoding="utf-8", errors="strict")
        except UnicodeDecodeError as exc:
            raise BridgeError(400, "invalid path") from exc
        if (
            not segment or segment in {".", ".."} or "/" in segment or "\\" in segment
            or ":" in segment or "\x00" in segment
        ):
            raise BridgeError(400, "invalid path")
        segments.append(segment)
    if Path(segments[-1]).suffix.lower() not in NAS_VIDEO_EXTENSIONS:
        raise BridgeError(404, "not found")
    return tuple(segments)


def parse_library_request(path: str, capability: str, route: str) -> tuple:
    parsed = urlsplit(path)
    parts = parsed.path.split("/")
    if (len(parts) < 5 or parts[:2] != ["", "v1"] or parts[3] != route
            or not hmac.compare_digest(parts[2], capability)):
        raise BridgeError(404, "not found")
    if parsed.query or parsed.fragment:
        raise BridgeError(400, "invalid path")
    source = parts[4] if route == "library" else "alist"
    if source not in {"nas", "alist"}:
        raise BridgeError(404, "not found")
    raw_segments = parts[5:] if route == "library" else parts[4:]
    if len(raw_segments) > 24:
        raise BridgeError(400, "invalid path")
    segments = []
    for raw in raw_segments:
        try:
            name = unquote(raw, encoding="utf-8", errors="strict")
        except UnicodeDecodeError as exc:
            raise BridgeError(400, "invalid path") from exc
        if (not name or len(name) > 255 or name in {".", ".."} or any(c in name for c in "/\\:")
                or any(ord(c) < 32 or ord(c) == 127 for c in name)):
            raise BridgeError(400, "invalid path")
        segments.append(name)
    if route == "alist-media" and Path(segments[-1]).suffix.lower() not in {".mp4", ".m4v"}:
        raise BridgeError(404, "not found")
    return source, tuple(segments)


def open_nas_file(segments: tuple, root: str = NAS_ROOT) -> tuple:
    """Open one regular file by no-follow descriptor walk; never leave root."""
    directory_fd = None
    file_fd = None
    directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    try:
        try:
            directory_fd = os.open(root, directory_flags)
        except OSError as exc:
            raise NasFileError(503, "NAS unavailable") from exc
        for segment in segments[:-1]:
            next_fd = os.open(segment, directory_flags, dir_fd=directory_fd)
            os.close(directory_fd)
            directory_fd = next_fd
        file_fd = os.open(segments[-1], os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory_fd)
        file_stat = os.fstat(file_fd)
        if not stat.S_ISREG(file_stat.st_mode):
            raise NasFileError(404, "not found")
        return file_fd, file_stat.st_size
    except NasFileError:
        if file_fd is not None:
            os.close(file_fd)
        raise
    except OSError as exc:
        if file_fd is not None:
            os.close(file_fd)
        raise NasFileError(404, "not found") from exc
    finally:
        if directory_fd is not None:
            os.close(directory_fd)


class LocalNasReader:
    def __init__(self, file_fd: int):
        self._file_fd = file_fd

    def seek(self, offset: int, whence: int = os.SEEK_SET) -> int:
        return os.lseek(self._file_fd, offset, whence)

    def read(self, size: int) -> bytes:
        return os.read(self._file_fd, size)

    def close(self) -> None:
        os.close(self._file_fd)


@dataclass(frozen=True)
class SmbBindings:
    connection: object
    session: object
    tree_connect: object
    open_file: object
    impersonation_level: object
    access_mask: object
    share_access: object
    create_disposition: object
    create_options: object
    file_attributes: object


def _private_smb_site_packages() -> Path:
    return (
        Path(__file__).resolve().parent / "smb-venv" / "lib"
        / ("python%d.%d" % (sys.version_info.major, sys.version_info.minor)) / "site-packages"
    )


def _parse_ifconfig_ipv4_networks(output: str) -> tuple:
    networks = []
    for match in IFCONFIG_INET_RE.finditer(output):
        try:
            address = ipaddress.IPv4Address(match.group("address"))
            raw_netmask = match.group("netmask")
            netmask = str(
                ipaddress.IPv4Address(int(raw_netmask, 16))
                if raw_netmask.startswith("0x") else ipaddress.IPv4Address(raw_netmask)
            )
            network = ipaddress.IPv4Network((str(address), netmask), strict=False)
        except ValueError:
            continue
        if not address.is_loopback and not address.is_unspecified:
            networks.append((address, network))
    return tuple(networks)


def select_smb_source_address(server: str, preferred_address: str, runner=subprocess.run,
                              resolver=socket.getaddrinfo) -> str:
    """Choose a directly connected IPv4 source; never follow the system VPN route."""
    try:
        resolved = resolver(server, 445, socket.AF_INET, socket.SOCK_STREAM)
        targets = {ipaddress.IPv4Address(result[4][0]) for result in resolved}
        completed = runner(
            ["/sbin/ifconfig"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, timeout=3, check=False,
        )
        if completed.returncode:
            raise OSError()
        preferred = ipaddress.IPv4Address(preferred_address)
    except (OSError, socket.gaierror, ValueError, IndexError):
        raise NasFileError(503, "NAS unavailable")
    candidates = {
        address for address, network in _parse_ifconfig_ipv4_networks(completed.stdout)
        if any(target in network for target in targets)
    }
    if preferred in candidates:
        return str(preferred)
    if len(candidates) == 1:
        return str(next(iter(candidates)))
    raise NasFileError(503, "NAS unavailable")


def _bound_smb_tcp_class(tcp_class, source_address: str):
    class BoundTcp(tcp_class):
        _bridge_original_tcp = tcp_class
        _bridge_source_address = source_address

        def connect(self):
            with self._sock_lock:
                if self.connected:
                    return
                try:
                    self._sock = socket.create_connection(
                        (self.server, self.port), timeout=self.timeout,
                        source_address=(self._bridge_source_address, 0),
                    )
                except (OSError, socket.gaierror) as exc:
                    raise ValueError("SMB connection unavailable") from exc
                self._sock.settimeout(None)
                self.connected = True

    return BoundTcp


def _bind_smb_transport(smb_connection, source_address: str) -> None:
    with SMB_TRANSPORT_LOCK:
        current_tcp = smb_connection.Tcp
        if getattr(current_tcp, "_bridge_source_address", None) == source_address:
            return
        original_tcp = getattr(current_tcp, "_bridge_original_tcp", current_tcp)
        smb_connection.Tcp = _bound_smb_tcp_class(original_tcp, source_address)


def load_smb_bindings(source_address: Optional[str] = None) -> SmbBindings:
    """Load the bridge-private SMB2/3 client only when a fallback is needed."""
    site_packages = _private_smb_site_packages()
    if not site_packages.is_dir():
        raise NasFileError(503, "NAS unavailable")
    site_packages_text = str(site_packages)
    if site_packages_text not in sys.path:
        sys.path.insert(0, site_packages_text)
    for logger_name in ("smbprotocol", "smbclient"):
        logger = logging.getLogger(logger_name)
        logger.setLevel(logging.CRITICAL + 1)
        logger.propagate = False
        if not logger.handlers:
            logger.addHandler(logging.NullHandler())
    try:
        import smbprotocol.connection as smb_connection
        from smbprotocol.connection import Connection
        from smbprotocol.open import (
            CreateDisposition,
            CreateOptions,
            FileAttributes,
            FilePipePrinterAccessMask,
            ImpersonationLevel,
            Open,
            ShareAccess,
        )
        from smbprotocol.session import Session
        from smbprotocol.tree import TreeConnect
    except (ImportError, OSError) as exc:
        raise NasFileError(503, "NAS unavailable") from exc
    if source_address is not None:
        _bind_smb_transport(smb_connection, source_address)
    return SmbBindings(
        Connection, Session, TreeConnect, Open,
        ImpersonationLevel, FilePipePrinterAccessMask, ShareAccess, CreateDisposition,
        CreateOptions, FileAttributes,
    )


def _smb_share_path(config: NasSmbConfig) -> str:
    return "\\\\%s\\%s" % (config.server, config.share)


def _smb_disable_symlink_redirect(connection) -> None:
    receive = connection.receive

    def receive_without_symlink_redirect(request, *args, **kwargs):
        kwargs["resolve_symlinks"] = False
        kwargs.setdefault("timeout", SMB_OPERATION_TIMEOUT_SECONDS)
        return receive(request, *args, **kwargs)

    connection.receive = receive_without_symlink_redirect


def _smb_has_reparse_point(opened, bindings: SmbBindings) -> bool:
    return bool(int(opened.file_attributes) & int(bindings.file_attributes.FILE_ATTRIBUTE_REPARSE_POINT))


def _close_smb_resource(resource) -> None:
    if resource is None:
        return
    try:
        resource.close() if hasattr(resource, "close") else resource.disconnect()
    except Exception:
        pass


def _smb_open_component(bindings: SmbBindings, tree, path: str, directory: bool):
    opened = bindings.open_file(tree, path)
    options = bindings.create_options.FILE_OPEN_REPARSE_POINT
    desired_access = bindings.access_mask.FILE_READ_ATTRIBUTES
    attributes = bindings.file_attributes.FILE_ATTRIBUTE_DIRECTORY if directory else bindings.file_attributes.FILE_ATTRIBUTE_NORMAL
    if directory:
        options |= bindings.create_options.FILE_DIRECTORY_FILE
    else:
        options |= bindings.create_options.FILE_NON_DIRECTORY_FILE
        desired_access |= bindings.access_mask.FILE_READ_DATA
    share_access = (
        bindings.share_access.FILE_SHARE_READ
        | bindings.share_access.FILE_SHARE_WRITE
        | bindings.share_access.FILE_SHARE_DELETE
    )
    opened.create(
        bindings.impersonation_level.Impersonation,
        desired_access,
        attributes,
        share_access,
        bindings.create_disposition.FILE_OPEN,
        options,
    )
    if _smb_has_reparse_point(opened, bindings):
        _close_smb_resource(opened)
        raise NasFileError(404, "not found")
    return opened


class SmbNasReader:
    def __init__(self, connection, session, tree, opened):
        self._connection = connection
        self._session = session
        self._tree = tree
        self._opened = opened
        self._offset = 0
        self._closed = False

    def seek(self, offset: int, whence: int = os.SEEK_SET) -> int:
        if whence == os.SEEK_SET:
            position = offset
        elif whence == os.SEEK_CUR:
            position = self._offset + offset
        elif whence == os.SEEK_END:
            position = self._opened.end_of_file + offset
        else:
            raise OSError("invalid seek")
        if position < 0:
            raise OSError("invalid seek")
        self._offset = position
        return position

    def read(self, size: int) -> bytes:
        try:
            data = self._opened.read(self._offset, size)
        except Exception as exc:
            raise NasFileError(503, "NAS unavailable") from exc
        self._offset += len(data)
        return data

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        _close_smb_resource(self._opened)
        _close_smb_resource(self._tree)
        _close_smb_resource(self._session)
        _close_smb_resource(self._connection)


def open_smb_nas_file(segments: tuple, config: NasSmbConfig, source_address: Optional[str] = None,
                      bindings: Optional[SmbBindings] = None) -> tuple:
    """Open a single SMB2/3 media file without following reparse points or DFS."""
    if bindings is None:
        if source_address is None:
            raise NasFileError(503, "NAS unavailable")
        bindings = load_smb_bindings(select_smb_source_address(config.server, source_address))
    connection = session = tree = opened = None
    try:
        connection = bindings.connection(uuid.uuid4(), config.server, port=445, require_signing=True)
        _smb_disable_symlink_redirect(connection)
        connection.connect(timeout=SMB_OPERATION_TIMEOUT_SECONDS)
        # SMB2 has no encryption; a server that requires SMB3 encryption still enforces it.
        session = bindings.session(connection, config.username, config.password, require_encryption=False)
        session.connect()
        tree = bindings.tree_connect(session, _smb_share_path(config))
        tree.connect()
        if tree.is_dfs_share:
            raise NasFileError(503, "NAS unavailable")
        for index in range(1, len(segments)):
            component = _smb_open_component(bindings, tree, "\\".join(segments[:index]), True)
            _close_smb_resource(component)
        opened = _smb_open_component(bindings, tree, "\\".join(segments), False)
        size = opened.end_of_file
        if not isinstance(size, int) or size < 0:
            raise NasFileError(404, "not found")
        return SmbNasReader(connection, session, tree, opened), size
    except NasFileError:
        _close_smb_resource(opened)
        _close_smb_resource(tree)
        _close_smb_resource(session)
        _close_smb_resource(connection)
        raise
    except Exception as exc:
        _close_smb_resource(opened)
        _close_smb_resource(tree)
        _close_smb_resource(session)
        _close_smb_resource(connection)
        raise NasFileError(503, "NAS unavailable") from exc


def open_nas_reader(segments: tuple, nas_smb: Optional[NasSmbConfig] = None,
                    local_opener=open_nas_file, smb_opener=open_smb_nas_file,
                    smb_source_address: Optional[str] = None) -> tuple:
    """Prefer the mounted root; use direct SMB only when that root is unavailable."""
    try:
        file_fd, size = local_opener(segments)
    except NasFileError as exc:
        if exc.status != 503 or nas_smb is None:
            raise
        if smb_source_address is None:
            return smb_opener(segments, nas_smb)
        return smb_opener(segments, nas_smb, smb_source_address)
    return LocalNasReader(file_fd), size


def file_byte_range(value: Optional[str], size: int) -> tuple:
    """Return (status, start, end) for a single RFC 7233 byte range."""
    if value is None:
        return 200, 0, max(size - 1, -1)
    match = re.fullmatch(r"bytes=(\d*)-(\d*)", value.strip())
    if not match or size <= 0:
        raise NasFileError(416, "range not satisfiable", size)
    start_text, end_text = match.groups()
    if not start_text and not end_text:
        raise NasFileError(416, "range not satisfiable", size)
    if start_text:
        start = int(start_text)
        end = min(int(end_text), size - 1) if end_text else size - 1
        if start >= size or start > end:
            raise NasFileError(416, "range not satisfiable", size)
    else:
        suffix_length = int(end_text)
        if suffix_length <= 0:
            raise NasFileError(416, "range not satisfiable", size)
        start = max(0, size - suffix_length)
        end = size - 1
    return 206, start, end


def nas_response_headers(file_name: str, size: int, status: int, start: int, end: int) -> tuple:
    content_type = mimetypes.guess_type(file_name)[0] or "application/octet-stream"
    headers = [
        ("Content-Type", content_type),
        ("Content-Length", str(max(0, end - start + 1))),
        ("Accept-Ranges", "bytes"),
        ("Cache-Control", "no-store"),
        ("Connection", "close"),
    ]
    if status == 206:
        headers.append(("Content-Range", "bytes %d-%d/%d" % (start, end, size)))
    return tuple(headers)


def public_stream_headers(output_format: str) -> tuple:
    """Headers safe for a public live response or a no-side-effect HEAD probe."""
    return (
        ("Content-Type", OUTPUT_FORMATS[output_format][1]),
        ("Cache-Control", "no-store"),
        ("Accept-Ranges", "none"),
        ("Connection", "close"),
    )


def _ffmpeg_listing(ffmpeg: str, option: str) -> str:
    try:
        completed = subprocess.run(
            [ffmpeg, "-hide_banner", option], stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=10, check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise ValueError("FFmpeg capability check failed") from exc
    if completed.returncode:
        raise ValueError("FFmpeg capability check failed")
    return completed.stdout.decode("utf-8", "replace")


def choose_encoder(listing: str, preferred: str, fallback: str) -> str:
    if re.search(r"\b" + re.escape(preferred) + r"\b", listing):
        return preferred
    if re.search(r"\b" + re.escape(fallback) + r"\b", listing):
        return fallback
    raise ValueError("required media encoder is unavailable")


def decoder_names(listing: str) -> set:
    names = set()
    for line in listing.splitlines():
        match = re.match(r"\s*[A-Z\.]{6}\s+(\S+)", line)
        if match:
            names.add(match.group(1).lower())
    return names


def is_hdr_stream(stream: dict) -> bool:
    fields = ("VideoRange", "VideoRangeType", "ColorTransfer", "ColorPrimaries", "ColorSpace", "HdrFormat")
    description = " ".join(str(stream.get(field, "")) for field in fields).lower()
    return any(marker in description for marker in ("hdr", "hlg", "dovi", "dolby vision", "smpte2084", "pq", "bt2020"))


def _safe_probe_text(value: object) -> Optional[str]:
    if not isinstance(value, str):
        return None
    value = value.strip()
    if not value or len(value) > 96 or not re.fullmatch(r"[A-Za-z0-9 ._+:-]+", value):
        return None
    return value


def _safe_probe_integer(value: object, maximum: int) -> Optional[int]:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        number = value
    elif isinstance(value, str) and re.fullmatch(r"\d{1,6}", value):
        number = int(value)
    else:
        return None
    return number if 1 <= number <= maximum else None


def _probe_bit_depth(stream: dict, pix_fmt: Optional[str]) -> Optional[int]:
    bit_depth = _safe_probe_integer(stream.get("bits_per_raw_sample"), 64)
    if bit_depth is not None:
        return bit_depth
    if pix_fmt is None:
        return None
    match = re.search(r"p(\d{1,2})(?:le|be)?\Z", pix_fmt)
    return _safe_probe_integer(match.group(1), 64) if match else None


def _dolby_vision_info(stream: dict) -> tuple:
    side_data_list = stream.get("side_data_list")
    if not isinstance(side_data_list, list):
        return False, None
    for side_data in side_data_list:
        if not isinstance(side_data, dict):
            continue
        side_data_type = str(side_data.get("side_data_type", "")).lower()
        if "dovi" in side_data_type or "dolby vision" in side_data_type or "dv_profile" in side_data:
            return True, _safe_probe_integer(side_data.get("dv_profile"), 127)
    return False, None


def _probe_audio(streams: list, selected_audio_index: Optional[int]) -> Optional[dict]:
    audio_streams = [
        stream for stream in streams
        if isinstance(stream, dict) and str(stream.get("codec_type", "")).lower() == "audio"
    ]
    if not audio_streams:
        return None
    selected = next(
        (stream for stream in audio_streams if _safe_probe_integer(stream.get("index"), 255) == selected_audio_index),
        audio_streams[0],
    )
    codec = _safe_probe_text(selected.get("codec_name"))
    channels = _safe_probe_integer(selected.get("channels"), 64)
    if codec is None and channels is None:
        return None
    return {"codec": codec, "channels": channels}


def probe_result_from_ffprobe(media_source_id: str, payload: object, selected_audio_index: Optional[int],
                              hdr_tonemap_available: bool) -> ProbeResult:
    """Reduce FFprobe's local-proxy output to non-sensitive, playback-relevant facts."""
    if not isinstance(payload, dict) or not SOURCE_IDENTIFIER_RE.fullmatch(media_source_id):
        raise ProbeError()
    streams = payload.get("streams")
    if not isinstance(streams, list):
        raise ProbeError()
    video_stream = next(
        (stream for stream in streams if isinstance(stream, dict) and str(stream.get("codec_type", "")).lower() == "video"),
        None,
    )
    if video_stream is None:
        raise ProbeError()
    pix_fmt = _safe_probe_text(video_stream.get("pix_fmt"))
    has_dolby_vision, dolby_vision_profile = _dolby_vision_info(video_stream)
    video = {
        "codec": _safe_probe_text(video_stream.get("codec_name")),
        "profile": _safe_probe_text(video_stream.get("profile")),
        "pixFmt": pix_fmt,
        "bitDepth": _probe_bit_depth(video_stream, pix_fmt),
        "width": _safe_probe_integer(video_stream.get("width"), 16384),
        "height": _safe_probe_integer(video_stream.get("height"), 16384),
        "colorTransfer": _safe_probe_text(video_stream.get("color_transfer")),
        "colorPrimaries": _safe_probe_text(video_stream.get("color_primaries")),
        "colorSpace": _safe_probe_text(video_stream.get("color_space")),
        "colorRange": _safe_probe_text(video_stream.get("color_range")),
        "dolbyVisionProfile": dolby_vision_profile,
    }
    if has_dolby_vision:
        reason = (
            "Dolby Vision Profile 5 is unsupported"
            if dolby_vision_profile == 5 else "Dolby Vision is unsupported"
        )
        return ProbeResult(media_source_id, video, _probe_audio(streams, selected_audio_index),
                           "dolby-vision", False, reason, False)
    color_transfer = (video["colorTransfer"] or "").lower()
    if color_transfer in {"smpte2084", "pq"}:
        hdr_kind = "hdr10"
    elif color_transfer in {"arib-std-b67", "hlg"}:
        hdr_kind = "hlg"
    else:
        hdr_kind = "sdr"
    if hdr_kind != "sdr":
        if not hdr_tonemap_available:
            return ProbeResult(media_source_id, video, _probe_audio(streams, selected_audio_index), hdr_kind,
                               False, "HDR to SDR conversion is unavailable", False)
        return ProbeResult(media_source_id, video, _probe_audio(streams, selected_audio_index), hdr_kind,
                           True, "%s will be tone-mapped to SDR" % hdr_kind.upper(), True)
    return ProbeResult(media_source_id, video, _probe_audio(streams, selected_audio_index), "sdr",
                       True, "SDR source is supported", False)


def probe_media_source(config: Config, source_url: str, media_source_id: str,
                       selected_audio_index: Optional[int], hdr_tonemap_available: bool) -> ProbeResult:
    """Probe only the loopback Range proxy; never pass Emby credentials to FFprobe."""
    command = [
        config.ffprobe, "-hide_banner", "-v", "error", "-rw_timeout", "10000000",
        "-probesize", str(FFPROBE_PROBESIZE_BYTES),
        "-analyzeduration", str(FFPROBE_ANALYZE_DURATION_MICROSECONDS),
        "-show_streams", "-of", "json", source_url,
    ]
    try:
        completed = subprocess.run(
            command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            timeout=FFPROBE_TIMEOUT_SECONDS, check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise ProbeError() from exc
    if completed.returncode:
        raise ProbeError()
    try:
        payload = json.loads(completed.stdout.decode("utf-8"))
    except (AttributeError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ProbeError() from exc
    return probe_result_from_ffprobe(media_source_id, payload, selected_audio_index, hdr_tonemap_available)


def select_audio_stream(media_streams: object, requested: Optional[int], decoders: set) -> int:
    if not isinstance(media_streams, list):
        raise UnsupportedMediaError("no decodable audio stream")
    candidates = []
    for stream in media_streams:
        if not isinstance(stream, dict) or str(stream.get("Type", "")).lower() != "audio":
            continue
        index = stream.get("Index")
        codec = stream.get("Codec")
        if isinstance(index, int) and isinstance(codec, str) and codec.lower() in decoders:
            candidates.append((index, codec.lower()))
    if not candidates:
        raise UnsupportedMediaError("no decodable audio stream")
    if requested is not None:
        for index, _codec in candidates:
            if index == requested:
                return index
    return candidates[0][0]


def video_filter(requires_hdr_tonemap: bool) -> str:
    scale = "scale=1024:768:force_original_aspect_ratio=decrease:force_divisible_by=2"
    if not requires_hdr_tonemap:
        return scale + ",format=yuv420p"
    return (
        "zscale=t=linear:npl=100,format=gbrpf32le,"
        "tonemap=tonemap=hable:desat=0,"
        "zscale=p=bt709:t=bt709:m=bt709:r=tv,"
        + scale + ",format=yuv420p"
    )


def build_ffmpeg_command(config: Config, source_url: str, request: StreamRequest, spec: SourceSpec,
                         video_encoder: str, audio_encoder: str) -> list:
    """Build argv only. The Emby token is never a command-line argument."""
    command = [
        config.ffmpeg, "-hide_banner", "-nostdin", "-loglevel", "error", "-rw_timeout", "20000000",
        "-ss", request.start_seconds, "-i", source_url,
        "-map", "0:v:0", "-map", "0:%d" % spec.audio_stream_index, "-sn", "-dn",
        "-vf", video_filter(spec.requires_hdr_tonemap), "-r", "30",
        "-c:v", video_encoder, "-profile:v", "baseline", "-level:v", "3.1",
        "-b:v", "1800k", "-maxrate:v", "2200k", "-bufsize:v", "3600k",
        "-g", "60", "-keyint_min", "60",
    ]
    if video_encoder == "h264_videotoolbox":
        command.extend(["-realtime", "1"])
    else:
        command.extend(["-preset", "veryfast", "-tune", "zerolatency"])
    command.extend([
        "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv",
        "-c:a", audio_encoder, "-b:a", "128k", "-ac", "2", "-ar", "48000",
    ])
    if audio_encoder != "aac_at":
        command.extend(["-profile:a", "aac_low"])
    if request.output_format == "mp4":
        command.extend([
            # QuickTime chapter tracks are legal in fMP4 but cause early EOS
            # in the TouchPad's old MP4 demuxer. Intro/credit data stays in Jelly.
            "-map_chapters", "-1",
            "-movflags", "+frag_keyframe+empty_moov",
            "-frag_duration", "1000000",
            "-f", "mp4", "pipe:1",
        ])
    elif request.output_format == "mkv":
        command.extend([
            "-f", "matroska", "-live", "1", "-cluster_time_limit", "1000", "pipe:1",
        ])
    else:
        command.extend([
            "-f", "mpegts", "-mpegts_flags", "+resend_headers", "-muxdelay", "0", "-flush_packets", "1", "pipe:1",
        ])
    return command


def terminate_process(process: subprocess.Popen) -> None:
    def signal_ffmpeg(sig):
        try:
            os.killpg(process.pid, sig)
        except PermissionError:
            # macOS can reject the group signal while the old stream is closing.
            # Signal the owned FFmpeg child directly so it can release its slot.
            process.send_signal(sig)

    if process.poll() is not None:
        return
    try:
        signal_ffmpeg(signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        process.wait(timeout=3)
        return
    except subprocess.TimeoutExpired:
        pass
    try:
        signal_ffmpeg(signal.SIGKILL)
    except ProcessLookupError:
        return
    try:
        process.wait(timeout=2)
    except subprocess.TimeoutExpired:
        pass


def write_transcoder_output(process: subprocess.Popen, output, first_chunk: bytes, stop=terminate_process) -> bool:
    """A downstream disconnect always stops its ffmpeg process group."""
    try:
        offset = 0
        while offset < len(first_chunk):
            output.write(first_chunk[offset:offset + TRANSCODER_CHUNK_BYTES])
            output.flush()
            offset += TRANSCODER_CHUNK_BYTES
        while True:
            chunk = process.stdout.read(TRANSCODER_CHUNK_BYTES)
            if not chunk:
                return True
            output.write(chunk)
            output.flush()
    except (BrokenPipeError, ConnectionResetError):
        stop(process)
        return False


def watch_client_disconnect(connection: socket.socket, process: subprocess.Popen, finished: threading.Event,
                            cancelled: Optional[threading.Event] = None, stop=terminate_process) -> None:
    """Stop FFmpeg even when it is blocked before its next stdout write."""
    while not finished.is_set() and process.poll() is None:
        try:
            readable, _, _ = select.select([connection], [], [], 0.25)
        except (OSError, ValueError):
            if not finished.is_set():
                if cancelled is not None:
                    cancelled.set()
                stop(process)
            return
        if not readable:
            continue
        if finished.is_set():
            return
        try:
            byte = connection.recv(1, socket.MSG_PEEK)
        except (BlockingIOError, InterruptedError):
            continue
        except OSError:
            if not finished.is_set():
                if cancelled is not None:
                    cancelled.set()
                stop(process)
            return
        if not byte:
            if finished.is_set():
                return
            if cancelled is not None:
                cancelled.set()
            stop(process)
        # A GET has no permitted request body. Avoid spinning if a client sends
        # unexpected bytes, while preserving the normal EOF behavior above.
        return


class SourceRegistry:
    def __init__(self):
        self._entries: Dict[str, SourceSpec] = {}
        self._lock = threading.Lock()

    def add(self, request: StreamRequest) -> str:
        return self.add_source(request.item_id, request.media_source_id)

    def add_source(self, item_id: str, media_source_id: Optional[str]) -> str:
        key = secrets.token_urlsafe(18)
        with self._lock:
            self._entries[key] = SourceSpec(item_id, media_source_id)
        return key

    def get(self, key: str) -> Optional[SourceSpec]:
        with self._lock:
            return self._entries.get(key)

    def remove(self, key: str) -> None:
        with self._lock:
            self._entries.pop(key, None)


class ProbeCache:
    """Small TTL cache of sanitized FFprobe facts keyed by selected source ID."""
    def __init__(self):
        self._entries = OrderedDict()
        self._lock = threading.Lock()

    def get(self, media_source_id: str) -> Optional[ProbeResult]:
        now = time.monotonic()
        with self._lock:
            entry = self._entries.get(media_source_id)
            if entry is None:
                return None
            expires_at, result = entry
            if expires_at <= now:
                self._entries.pop(media_source_id, None)
                return None
            self._entries.move_to_end(media_source_id)
            return result

    def put(self, media_source_id: str, result: ProbeResult) -> None:
        with self._lock:
            self._entries[media_source_id] = (time.monotonic() + PROBE_CACHE_TTL_SECONDS, result)
            self._entries.move_to_end(media_source_id)
            while len(self._entries) > PROBE_CACHE_MAX_ENTRIES:
                self._entries.popitem(last=False)


class ProcessRegistry:
    def __init__(self):
        self._processes = set()
        self._lock = threading.Lock()

    def add(self, process: subprocess.Popen) -> None:
        with self._lock:
            self._processes.add(process)

    def remove(self, process: subprocess.Popen) -> None:
        with self._lock:
            self._processes.discard(process)

    def terminate_all(self) -> None:
        with self._lock:
            processes = list(self._processes)
        for process in processes:
            terminate_process(process)


class WarmSession:
    """One prepared MKV stream, held briefly for its single public consumer."""
    def __init__(self, request: StreamRequest):
        self.session_id = secrets.token_hex(16)
        self.request = request
        self.key: Optional[str] = None
        self.process: Optional[subprocess.Popen] = None
        self.first_chunk = b""
        self.slot_held = False
        self._claimed = False
        self._closed = False
        self._published = False
        self._lock = threading.Lock()

    def publish(self) -> bool:
        with self._lock:
            if self._closed or self._published or not self.first_chunk or self.process is None:
                return False
            self._published = True
            return True

    def is_published(self) -> bool:
        with self._lock:
            return self._published and not self._closed

    def claim(self) -> bool:
        with self._lock:
            if not self._published or self._closed or self._claimed or not self.first_chunk or self.process is None:
                return False
            self._claimed = True
            return True

    def close(self, bridge) -> None:
        """Release each owned resource once, whether expiry or a client ends it."""
        with self._lock:
            if self._closed:
                return
            self._closed = True
            process = self.process
            key = self.key
            slot_held = self.slot_held
            self.process = None
            self.key = None
            self.slot_held = False
        if process is not None:
            terminate_process(process)
            bridge.processes.remove(process)
        if key is not None:
            bridge.sources.remove(key)
        if slot_held:
            bridge.transcode_slots.release()


class WarmSessionRegistry:
    """Keep at most one unclaimed warm session and expire it promptly."""
    def __init__(self, bridge):
        self._bridge = bridge
        self._session: Optional[WarmSession] = None
        self._lock = threading.Lock()

    def reserve(self, request: StreamRequest) -> Optional[WarmSession]:
        with self._lock:
            if self._session is not None:
                return None
            session = WarmSession(request)
            self._session = session
            return session

    def publish(self, session: WarmSession) -> bool:
        with self._lock:
            if self._session is not session:
                return False
            if not session.publish():
                return False
            timer = threading.Timer(WARM_SESSION_TTL_SECONDS, self.expire, args=(session,))
            timer.daemon = True
            timer.start()
            return True

    def abort(self, session: WarmSession) -> None:
        with self._lock:
            if self._session is not session:
                return
            self._session = None
        session.close(self._bridge)

    def inspect(self, session_id: str) -> Optional[WarmSession]:
        with self._lock:
            session = self._session
            if session is None or not hmac.compare_digest(session.session_id, session_id) or not session.is_published():
                return None
            return session

    def claim(self, session_id: str) -> Optional[WarmSession]:
        with self._lock:
            session = self._session
            if session is None or not hmac.compare_digest(session.session_id, session_id):
                return None
            if not session.claim():
                return None
            self._session = None
            return session

    def expire(self, session: WarmSession) -> None:
        self.abort(session)


class UpstreamClient:
    def __init__(self, config: Config):
        self._config = config
        self._base = urlsplit(config.emby_base)
        self._prefix = self._base.path.rstrip("/")

    def _connection(self):
        connection_class = http.client.HTTPSConnection if self._base.scheme == "https" else http.client.HTTPConnection
        return connection_class(self._base.hostname, self._base.port, timeout=30)

    def _headers(self) -> dict:
        return {
            "Authorization": (
                'MediaBrowser Client="TouchPad Media Bridge", Device="Mac mini", '
                'DeviceId="touchpad-media-bridge", Version="1.0", Token="%s"' % self._config.emby_token
            ),
            "Accept": "application/json",
        }

    def _request_json(self, method: str, path: str, body: dict) -> dict:
        connection = self._connection()
        headers = self._headers()
        headers["Content-Type"] = "application/json"
        payload = json.dumps(body, separators=(",", ":")).encode("utf-8")
        try:
            connection.request(method, self._prefix + path, body=payload, headers=headers)
            response = connection.getresponse()
            if response.status != 200:
                status = response.status
                response.close()
                if status == 429:
                    raise UpstreamRateLimitError()
                raise UpstreamError()
            payload = response.read()
            response.close()
            parsed = json.loads(payload.decode("utf-8"))
        except (OSError, http.client.HTTPException, UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise UpstreamError() from exc
        finally:
            connection.close()
        if not isinstance(parsed, dict):
            raise UpstreamError()
        return parsed

    def prepare(self, spec: SourceSpec, requested_audio_index: Optional[int], audio_decoders: set,
                select_audio: bool = True) -> None:
        """Resolve a direct-play source before launching FFmpeg, without logging it."""
        with spec.lock:
            if spec.direct_path is not None:
                return
            requested_source = spec.media_source_id or spec.item_id
            playback = self._request_json(
                "POST",
                "/Items/%s/PlaybackInfo?%s" % (
                    quote(spec.item_id, safe=""), urlencode({"userId": self._config.emby_user_id}),
                ),
                {
                    "UserId": self._config.emby_user_id,
                    "MediaSourceId": requested_source,
                    "EnableDirectPlay": True,
                    "EnableDirectStream": False,
                    "EnableTranscoding": False,
                    "StartTimeTicks": 0,
                },
            )
            sources = playback.get("MediaSources")
            if sources == [] and playback.get("ErrorCode") == "RateLimitExceeded":
                raise UpstreamRateLimitError()
            if not isinstance(sources, list):
                raise UpstreamError()
            source = None
            for candidate in sources:
                if not isinstance(candidate, dict):
                    continue
                if spec.media_source_id is None:
                    source = candidate
                    break
                if candidate.get("Id") == spec.media_source_id:
                    source = candidate
                    break
            if not isinstance(source, dict) or source.get("SupportsDirectPlay") is False:
                raise UpstreamError()
            source_id = source.get("Id")
            container = source.get("Container")
            if not isinstance(source_id, str) or not SOURCE_IDENTIFIER_RE.fullmatch(source_id):
                raise UpstreamError()
            if spec.media_source_id is not None and source_id != spec.media_source_id:
                raise UpstreamError()
            if not isinstance(container, str) or not CONTAINER_RE.fullmatch(container):
                raise UpstreamError()
            media_streams = source.get("MediaStreams")
            if select_audio:
                spec.audio_stream_index = select_audio_stream(media_streams, requested_audio_index, audio_decoders)
            else:
                try:
                    spec.audio_stream_index = select_audio_stream(media_streams, None, audio_decoders)
                except UnsupportedMediaError:
                    spec.audio_stream_index = None
            spec.selected_source_id = source_id
            spec.direct_path = "/Videos/%s/stream.%s?%s" % (
                quote(spec.item_id, safe=""), quote(container, safe=""),
                urlencode({"static": "true", "mediaSourceId": source_id}),
            )

    def open_stream(self, spec: SourceSpec, range_header: Optional[str], method: str):
        if spec.direct_path is None:
            raise UpstreamError()
        # A peer reset before response headers means no media body has been
        # exposed yet. One fresh connection is safe for GET/HEAD and avoids
        # retrying a partially delivered stream.
        for attempt in range(2):
            connection = self._connection()
            headers = self._headers()
            if range_header:
                headers["Range"] = range_header
            try:
                connection.request(method, self._prefix + spec.direct_path, headers=headers)
                response = connection.getresponse()
            except ConnectionResetError as exc:
                connection.close()
                if attempt == 0:
                    continue
                raise UpstreamError() from exc
            except (OSError, http.client.HTTPException) as exc:
                connection.close()
                raise UpstreamError() from exc
            if response.status not in {200, 206}:
                response.close()
                connection.close()
                raise UpstreamError()
            return connection, response
        raise UpstreamError()


class QuietHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, _format, *_args) -> None:
        return

    def send_safe_error(self, status: int, message: str) -> None:
        payload = json.dumps({"error": message}, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        if self.command != "HEAD":
            try:
                self.wfile.write(payload)
            except (BrokenPipeError, ConnectionResetError):
                pass
        self.close_connection = True


class SourceHandler(QuietHandler):
    """Loopback-only Range proxy. It never exposes upstream headers or URLs."""

    def do_GET(self) -> None:
        self._proxy("GET")

    def do_HEAD(self) -> None:
        self._proxy("HEAD")

    def _proxy(self, method: str) -> None:
        bridge = self.server.bridge
        parts = urlsplit(self.path).path.split("/")
        if len(parts) != 4 or parts[0] or parts[1] != "source":
            self.send_safe_error(404, "not found")
            return
        if not hmac.compare_digest(parts[2], bridge.source_nonce):
            self.send_safe_error(404, "not found")
            return
        spec = bridge.sources.get(parts[3])
        if spec is None:
            self.send_safe_error(404, "not found")
            return
        try:
            connection, response = bridge.upstream.open_stream(spec, safe_range_header(self.headers.get("Range")), method)
        except UpstreamError:
            self.send_safe_error(502, "upstream unavailable")
            return
        try:
            self.send_response(response.status)
            self.send_header("Content-Type", response.getheader("Content-Type") or "application/octet-stream")
            content_length = response.getheader("Content-Length")
            if content_length and content_length.isdecimal():
                self.send_header("Content-Length", content_length)
            content_range = response.getheader("Content-Range")
            if content_range and re.fullmatch(r"bytes \d+-\d+/\d+", content_range):
                self.send_header("Content-Range", content_range)
            if response.getheader("Accept-Ranges") == "bytes":
                self.send_header("Accept-Ranges", "bytes")
            self.send_header("Connection", "close")
            self.end_headers()
            if method == "HEAD":
                return
            while True:
                chunk = response.read(64 * 1024)
                if not chunk:
                    return
                self.wfile.write(chunk)
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            return
        finally:
            response.close()
            connection.close()
            self.close_connection = True


def _first_output(process: subprocess.Popen) -> bytes:
    deadline = time.monotonic() + FIRST_OUTPUT_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        if process.poll() is not None:
            return b""
        ready, _, _ = select.select([process.stdout], [], [], min(0.25, deadline - time.monotonic()))
        if ready:
            chunk = os.read(process.stdout.fileno(), 64 * 1024)
            if chunk:
                return chunk
            if process.poll() is not None:
                return b""
    return b""


def _mkv_startup_buffer(process: subprocess.Popen, cancelled: Optional[threading.Event] = None,
                        timeout_seconds: int = MKV_STARTUP_PREBUFFER_TIMEOUT_SECONDS) -> Optional[bytes]:
    """Collect one bounded MKV startup burst before public response headers exist."""
    deadline = time.monotonic() + timeout_seconds
    buffered = bytearray()
    while len(buffered) < MKV_STARTUP_PREBUFFER_BYTES and time.monotonic() < deadline:
        if (cancelled is not None and cancelled.is_set()) or process.poll() is not None:
            return None
        ready, _, _ = select.select([process.stdout], [], [], min(0.25, deadline - time.monotonic()))
        if not ready:
            continue
        chunk = os.read(process.stdout.fileno(), min(TRANSCODER_CHUNK_BYTES,
                                                     MKV_STARTUP_PREBUFFER_BYTES - len(buffered)))
        if not chunk:
            return None
        buffered.extend(chunk)
    if len(buffered) != MKV_STARTUP_PREBUFFER_BYTES:
        return None
    return bytes(buffered)


def _warm_mkv_startup_buffer(process: subprocess.Popen,
                             timeout_seconds: int = MKV_STARTUP_PREBUFFER_TIMEOUT_SECONDS) -> Optional[bytes]:
    """Collect exactly one MiB, or a complete short EBML stream at clean EOF."""
    deadline = time.monotonic() + timeout_seconds
    buffered = bytearray()
    while len(buffered) < MKV_STARTUP_PREBUFFER_BYTES and time.monotonic() < deadline:
        ready, _, _ = select.select([process.stdout], [], [], min(0.25, deadline - time.monotonic()))
        if not ready:
            if process.poll() is not None:
                return None
            continue
        chunk = os.read(process.stdout.fileno(), min(TRANSCODER_CHUNK_BYTES,
                                                     MKV_STARTUP_PREBUFFER_BYTES - len(buffered)))
        if not chunk:
            data = bytes(buffered)
            return data if process.poll() == 0 and data.startswith(b"\x1a\x45\xdf\xa3") else None
        buffered.extend(chunk)
    data = bytes(buffered)
    return (
        data if len(data) == MKV_STARTUP_PREBUFFER_BYTES
        and data.startswith(b"\x1a\x45\xdf\xa3") and process.poll() in {None, 0}
        else None
    )


class BridgeHandler(QuietHandler):
    def do_GET(self) -> None:
        bridge = self.server.bridge
        if self._network_library("GET"):
            return
        if parse_health_request(self.path, bridge.config.capability):
            self._send_health(bridge)
            return
        if is_warm_request(self.path):
            try:
                request = parse_warm_request(self.path, bridge.config.capability)
            except BridgeError as exc:
                self.send_safe_error(exc.status, exc.message)
                return
            self._warm(request)
            return
        if is_warm_ready_request(self.path):
            try:
                session_id = parse_warm_ready_request(self.path, bridge.config.capability)
            except BridgeError as exc:
                self.send_safe_error(exc.status, exc.message)
                return
            session = bridge.warm_sessions.claim(session_id)
            if session is None:
                self.send_safe_error(404, "warmup unavailable")
                return
            self._serve_warm_session(session)
            return
        if is_probe_request(self.path):
            try:
                request = parse_probe_request(self.path, bridge.config.capability)
            except BridgeError as exc:
                self.send_safe_error(exc.status, exc.message)
                return
            self._probe(request)
            return
        if is_nas_request(self.path):
            try:
                segments = parse_nas_request(self.path, bridge.config.capability)
            except BridgeError as exc:
                self.send_safe_error(exc.status, exc.message)
                return
            self._serve_nas(segments, True)
            return
        try:
            request = parse_stream_request(self.path, bridge.config.capability)
        except BridgeError as exc:
            self.send_safe_error(exc.status, exc.message)
            return
        # Seeking or changing audio closes the old connection before opening
        # its replacement. Give that encoder a short window to free the slot.
        if request.output_format in {"ts", "mp4"}:
            acquired = bridge.transcode_slots.acquire(timeout=STREAM_RESTART_SLOT_WAIT_SECONDS)
        else:
            acquired = bridge.transcode_slots.acquire(blocking=False)
        if not acquired:
            self.send_safe_error(429, "transcoder busy")
            return
        try:
            self._stream(request)
        finally:
            bridge.transcode_slots.release()

    def do_HEAD(self) -> None:
        bridge = self.server.bridge
        if self._network_library("HEAD"):
            return
        if parse_health_request(self.path, bridge.config.capability):
            self._send_health(bridge)
            return
        if is_warm_ready_request(self.path):
            try:
                session_id = parse_warm_ready_request(self.path, bridge.config.capability)
            except BridgeError as exc:
                self.send_safe_error(exc.status, exc.message)
                return
            session = bridge.warm_sessions.inspect(session_id)
            if session is None:
                self.send_safe_error(404, "warmup unavailable")
                return
            self._send_stream_headers(session.request.output_format)
            return
        if is_nas_request(self.path):
            try:
                segments = parse_nas_request(self.path, bridge.config.capability)
            except BridgeError as exc:
                self.send_safe_error(exc.status, exc.message)
                return
            self._serve_nas(segments, False)
            return
        try:
            request = parse_stream_request(self.path, bridge.config.capability)
        except BridgeError as exc:
            self.send_safe_error(exc.status, exc.message)
            return
        self._send_stream_headers(request.output_format)

    def do_POST(self) -> None:
        self.send_safe_error(405, "method not allowed")

    def _network_library(self, method: str) -> bool:
        parts = urlsplit(self.path).path.split("/")
        if len(parts) < 4 or parts[3] not in {"library", "alist-media"}:
            return False
        route = parts[3]
        try:
            source, segments = parse_library_request(self.path, self.server.bridge.config.capability, route)
        except BridgeError as exc:
            self.send_safe_error(exc.status, exc.message)
            return True
        if route == "alist-media":
            self._serve_alist(segments, method)
        elif method == "GET":
            self._browse_library(source, segments)
        else:
            self.send_safe_error(405, "method not allowed")
        return True

    @staticmethod
    def _alist_config():
        from library_webdav import load_config
        return load_config(Path(__file__).resolve().with_name("alist-webdav.private.json"))

    def _browse_library(self, source: str, segments: tuple) -> None:
        if source == "nas":
            from library_nas import list_entries, list_smb_entries
            try:
                entries = list_entries(self.server.bridge.config.nas_root, segments)
            except OSError:
                config = self.server.bridge.config
                if config.nas_smb is None:
                    self.send_safe_error(503, "NAS directory unavailable")
                    return
                try:
                    entries = list_smb_entries(sys.modules[__name__], config.nas_smb, config.listen_host, segments)
                except (NasFileError, ValueError):
                    self.send_safe_error(503, "NAS directory unavailable")
                    return
            except ValueError:
                self.send_safe_error(503, "NAS directory unavailable")
                return
        else:
            from library_webdav import list_entries, WebDavError
            try:
                entries = list_entries(self._alist_config(), segments)
            except (WebDavError, OSError, ValueError):
                self.send_safe_error(503, "AList directory unavailable")
                return
        payload = json.dumps({"returnValue": True, "entries": entries}, separators=(",", ":")).encode("utf-8")
        try:
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError):
            pass
        self.close_connection = True

    def _serve_alist(self, segments: tuple, method: str) -> None:
        from library_webdav import open_file, WebDavError
        supplied_range = self.headers.get("Range")
        byte_range = safe_range_header(supplied_range)
        if supplied_range is not None and byte_range is None:
            self.send_safe_error(416, "range not satisfiable")
            return
        try:
            connection, response = open_file(self._alist_config(), segments, method, byte_range)
        except WebDavError as exc:
            status = exc.status if exc.status in {404, 416} else 503
            self.send_safe_error(status, "AList stream unavailable")
            return
        except (OSError, ValueError):
            self.send_safe_error(503, "AList stream unavailable")
            return
        try:
            if response.status not in {200, 206, 416}:
                self.send_safe_error(404 if response.status == 404 else 503, "AList stream unavailable")
                return
            self.send_response(response.status)
            self.send_header("Content-Type", "video/mp4")
            length = response.getheader("Content-Length")
            if length and length.isascii() and length.isdecimal():
                self.send_header("Content-Length", length)
            content_range = response.getheader("Content-Range")
            if content_range and re.fullmatch(r"bytes (?:[0-9]+-[0-9]+|\*)/[0-9]+", content_range):
                self.send_header("Content-Range", content_range)
            if response.status == 206 or response.getheader("Accept-Ranges") == "bytes":
                self.send_header("Accept-Ranges", "bytes")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self.end_headers()
            if method == "GET":
                while True:
                    chunk = response.read(TRANSCODER_CHUNK_BYTES)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
        except (OSError, http.client.HTTPException):
            pass
        finally:
            response.close()
            connection.close()
            self.close_connection = True

    def _send_health(self, bridge) -> None:
        payload = json.dumps({
            "ok": True, "container": "mpegts", "video": "h264-baseline", "audio": "aac-lc-stereo",
            "hdrToSdr": bridge.hdr_tonemap_available,
        }, separators=(",", ":")).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        if self.command != "HEAD":
            try:
                self.wfile.write(payload)
            except (BrokenPipeError, ConnectionResetError):
                pass
        self.close_connection = True

    def _send_stream_headers(self, output_format: str) -> None:
        self.send_response(200)
        for name, value in public_stream_headers(output_format):
            self.send_header(name, value)
        self.end_headers()
        self.close_connection = True

    def _send_probe(self, result: ProbeResult) -> None:
        payload = json.dumps(result.payload(), separators=(",", ":")).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        try:
            self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError):
            pass
        self.close_connection = True

    def _send_warm_ready(self, session: WarmSession) -> bool:
        payload = json.dumps({
            "returnValue": True, "sessionId": session.session_id, "ready": True,
        }, separators=(",", ":")).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        try:
            self.wfile.write(payload)
            return True
        except (BrokenPipeError, ConnectionResetError):
            return False

    def _probe(self, request: ProbeRequest) -> None:
        bridge = self.server.bridge
        key = bridge.sources.add_source(request.item_id, request.media_source_id)
        try:
            spec = bridge.sources.get(key)
            bridge.upstream.prepare(spec, None, bridge.audio_decoders, select_audio=False)
            self._send_probe(bridge.probe_source(key, spec))
        except UpstreamRateLimitError:
            self.send_safe_error(429, "upstream rate limited")
        except (ProbeError, UpstreamError):
            self.send_safe_error(502, "source metadata unavailable")
        finally:
            bridge.sources.remove(key)

    def _serve_nas(self, segments: tuple, send_body: bool) -> None:
        reader = None
        try:
            reader, size = open_nas_reader(
                segments, self.server.bridge.config.nas_smb,
                local_opener=lambda path: open_nas_file(path, self.server.bridge.config.nas_root),
                smb_source_address=self.server.bridge.config.listen_host,
            )
            status, start, end = file_byte_range(self.headers.get("Range"), size)
        except NasFileError as exc:
            if reader is not None:
                reader.close()
            if exc.status == 416:
                payload = json.dumps({"error": exc.message}, separators=(",", ":")).encode("utf-8")
                self.send_response(416)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.send_header("Content-Range", "bytes */%d" % (exc.size or 0))
                self.send_header("Cache-Control", "no-store")
                self.send_header("Connection", "close")
                self.end_headers()
                if send_body:
                    try:
                        self.wfile.write(payload)
                    except (BrokenPipeError, ConnectionResetError):
                        pass
                self.close_connection = True
                return
            self.send_safe_error(exc.status, exc.message)
            return
        try:
            self.send_response(status)
            for name, value in nas_response_headers(segments[-1], size, status, start, end):
                self.send_header(name, value)
            self.end_headers()
            self.close_connection = True
            if not send_body:
                return
            reader.seek(start, os.SEEK_SET)
            remaining = end - start + 1
            while remaining:
                chunk = reader.read(min(64 * 1024, remaining))
                if not chunk:
                    return
                self.wfile.write(chunk)
                self.wfile.flush()
                remaining -= len(chunk)
        except (BrokenPipeError, ConnectionResetError, NasFileError):
            return
        finally:
            if reader is not None:
                reader.close()

    def _warm(self, request: StreamRequest) -> None:
        bridge = self.server.bridge
        session = bridge.warm_sessions.reserve(request)
        if session is None:
            self.send_safe_error(429, "transcoder busy")
            return
        published = False
        watcher_finished = None
        try:
            if not bridge.transcode_slots.acquire(timeout=WARM_SLOT_WAIT_SECONDS):
                self.send_safe_error(429, "transcoder busy")
                return
            session.slot_held = True
            session.key = bridge.sources.add(request)
            spec = bridge.sources.get(session.key)
            if spec is None:
                raise OSError()
            bridge.upstream.prepare(spec, request.audio_stream_index, bridge.audio_decoders)
            result = bridge.probe_source(session.key, spec)
            if not result.mini_supported:
                raise UnsupportedMediaError(result.reason)
            command = build_ffmpeg_command(
                bridge.config, bridge.source_url(session.key), request, spec, bridge.video_encoder, bridge.audio_encoder,
            )
            session.process = subprocess.Popen(
                command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                bufsize=0, start_new_session=True,
            )
            bridge.processes.add(session.process)
            watcher_finished = threading.Event()
            threading.Thread(
                target=watch_client_disconnect,
                args=(self.connection, session.process, watcher_finished),
                name="warm-request-disconnect-watcher",
                daemon=True,
            ).start()
            session.first_chunk = _warm_mkv_startup_buffer(session.process)
            watcher_finished.set()
            if not session.first_chunk:
                self.send_safe_error(503, "transcode startup buffer unavailable")
                return
            if not bridge.warm_sessions.publish(session):
                self.send_safe_error(503, "transcode warmup unavailable")
                return
            published = True
            if not self._send_warm_ready(session):
                bridge.warm_sessions.abort(session)
        except UnsupportedMediaError as exc:
            self.send_safe_error(415, exc.message)
        except ProbeError:
            self.send_safe_error(502, "source metadata unavailable")
        except UpstreamRateLimitError:
            self.send_safe_error(429, "upstream rate limited")
        except (OSError, UpstreamError):
            self.send_safe_error(502, "transcode unavailable")
        finally:
            if watcher_finished is not None:
                watcher_finished.set()
            if not published:
                bridge.warm_sessions.abort(session)

    def _serve_warm_session(self, session: WarmSession) -> None:
        bridge = self.server.bridge
        process = session.process
        watcher_finished = threading.Event()
        if process is None:
            self.send_safe_error(404, "warmup unavailable")
            session.close(bridge)
            return
        try:
            threading.Thread(
                target=watch_client_disconnect,
                args=(self.connection, process, watcher_finished),
                name="warm-client-disconnect-watcher",
                daemon=True,
            ).start()
            self._send_stream_headers(session.request.output_format)
            write_transcoder_output(process, self.wfile, session.first_chunk)
        finally:
            watcher_finished.set()
            session.close(bridge)

    def _stream(self, request: StreamRequest) -> None:
        bridge = self.server.bridge
        key = bridge.sources.add(request)
        process = None
        watcher_finished = threading.Event()
        client_cancelled = threading.Event()
        try:
            spec = bridge.sources.get(key)
            bridge.upstream.prepare(spec, request.audio_stream_index, bridge.audio_decoders)
            result = bridge.probe_source(key, spec)
            if not result.mini_supported:
                raise UnsupportedMediaError(result.reason)
            command = build_ffmpeg_command(
                bridge.config, bridge.source_url(key), request, spec, bridge.video_encoder, bridge.audio_encoder,
            )
            process = subprocess.Popen(
                command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                bufsize=0, start_new_session=True,
            )
            bridge.processes.add(process)
            threading.Thread(
                target=watch_client_disconnect,
                args=(self.connection, process, watcher_finished),
                kwargs={"cancelled": client_cancelled},
                name="client-disconnect-watcher",
                daemon=True,
            ).start()
            if request.output_format == "mkv":
                first_chunk = _mkv_startup_buffer(process, client_cancelled)
                if first_chunk is None:
                    self.send_safe_error(503, "transcode startup buffer unavailable")
                    return
            else:
                first_chunk = _first_output(process)
            if not first_chunk:
                self.send_safe_error(502, "transcode could not start")
                return
            self._send_stream_headers(request.output_format)
            write_transcoder_output(process, self.wfile, first_chunk)
        except UnsupportedMediaError as exc:
            self.send_safe_error(415, exc.message)
        except ProbeError:
            self.send_safe_error(502, "source metadata unavailable")
        except UpstreamRateLimitError:
            self.send_safe_error(429, "upstream rate limited")
        except (OSError, UpstreamError):
            self.send_safe_error(502, "transcode unavailable")
        finally:
            watcher_finished.set()
            bridge.sources.remove(key)
            if process is not None:
                terminate_process(process)
                bridge.processes.remove(process)


class BridgeApplication:
    def __init__(self, config: Config):
        self.config = config
        encoders = _ffmpeg_listing(config.ffmpeg, "-encoders")
        self.video_encoder = choose_encoder(encoders, "h264_videotoolbox", "libx264")
        self.audio_encoder = choose_encoder(encoders, "aac_at", "aac")
        filters = _ffmpeg_listing(config.ffmpeg, "-filters")
        self.hdr_tonemap_available = bool(re.search(r"\bzscale\b", filters) and re.search(r"\btonemap\b", filters))
        self.audio_decoders = decoder_names(_ffmpeg_listing(config.ffmpeg, "-decoders"))
        self.upstream = UpstreamClient(config)
        self.sources = SourceRegistry()
        self.probe_cache = ProbeCache()
        self.processes = ProcessRegistry()
        self.transcode_slots = threading.BoundedSemaphore(MAX_TRANSCODES)
        self.warm_sessions = WarmSessionRegistry(self)
        self.source_nonce = secrets.token_urlsafe(24)
        self.source_port = 0

    def source_url(self, key: str) -> str:
        return "http://127.0.0.1:%d/source/%s/%s" % (self.source_port, self.source_nonce, key)

    def probe_source(self, key: str, spec: SourceSpec) -> ProbeResult:
        media_source_id = spec.selected_source_id
        if not isinstance(media_source_id, str) or not SOURCE_IDENTIFIER_RE.fullmatch(media_source_id):
            raise ProbeError()
        result = self.probe_cache.get(media_source_id)
        if result is None:
            result = probe_media_source(
                self.config, self.source_url(key), media_source_id, spec.audio_stream_index, self.hdr_tonemap_available,
            )
            self.probe_cache.put(media_source_id, result)
        spec.requires_hdr_tonemap = result.requires_hdr_tonemap
        return result


class BridgeServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def run(config: Config) -> None:
    app = BridgeApplication(config)
    source_server = BridgeServer(("127.0.0.1", 0), SourceHandler)
    source_server.bridge = app
    app.source_port = source_server.server_address[1]
    public_server = BridgeServer((config.listen_host, config.listen_port), BridgeHandler)
    public_server.bridge = app
    threading.Thread(target=source_server.serve_forever, name="source-proxy", daemon=True).start()
    stopping = threading.Event()

    def request_stop(_signum, _frame):
        if not stopping.is_set():
            stopping.set()
            threading.Thread(target=public_server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)
    try:
        public_server.serve_forever(poll_interval=0.5)
    finally:
        public_server.server_close()
        source_server.shutdown()
        source_server.server_close()
        app.processes.terminate_all()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", default=str(Path(__file__).resolve().with_name("bridge-config.json")))
    args = parser.parse_args()
    try:
        run(load_config(Path(args.config)))
    except (ValueError, OSError):
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
