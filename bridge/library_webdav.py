"""Small, private WebDAV reader for the TouchPad media bridge.

It deliberately accepts only the saved private-LAN HTTP AList root.  This
module does not create routes, follow redirects, log URLs, or expose upstream
credentials to callers.
"""

import base64
import http.client
import ipaddress
import json
import re
import stat
import xml.etree.ElementTree as element_tree
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, List, Optional, Tuple
from urllib.parse import quote, unquote, urlsplit


MAX_LIST_BODY_BYTES = 256 * 1024
MAX_LIST_ENTRIES = 256
DIRECT_EXTENSIONS = frozenset((".mp4", ".m4v"))
RANGE_RE = re.compile(r"bytes=(?:\d*)-(?:\d*)\Z")


class WebDavError(Exception):
    """Safe, status-only failure for malformed or unavailable WebDAV input."""

    def __init__(self, status: int):
        self.status = status
        super().__init__("webdav error")


@dataclass(frozen=True)
class WebDavConfig:
    endpoint: str
    host: str
    port: int
    root: str
    username: str
    password: str
    source_address: Optional[str] = None


def _text(value: object, maximum: int) -> str:
    if not isinstance(value, str) or not value or len(value) > maximum:
        raise WebDavError(400)
    if any(ord(character) < 32 or ord(character) == 127 for character in value):
        raise WebDavError(400)
    return value


def load_config(path: Path) -> WebDavConfig:
    """Load exactly a 0600 private AList WebDAV configuration."""
    try:
        file_path = Path(path)
        if not stat.S_ISREG(file_path.stat().st_mode) or stat.S_IMODE(file_path.stat().st_mode) != 0o600:
            raise WebDavError(503)
        data = json.loads(file_path.read_text(encoding="utf-8"))
    except WebDavError:
        raise
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        raise WebDavError(503)
    required = {"endpoint", "username", "password"}
    allowed = required | {"source_address"}
    if not isinstance(data, dict) or not required.issubset(data) or not set(data).issubset(allowed):
        raise WebDavError(400)

    endpoint = _text(data["endpoint"], 512)
    username = _text(data["username"], 256)
    password = _text(data["password"], 1024)
    try:
        parsed = urlsplit(endpoint)
        port = parsed.port or 80
        address = ipaddress.IPv4Address(parsed.hostname or "")
    except (TypeError, ValueError):
        raise WebDavError(400)
    if (parsed.scheme != "http" or parsed.username or parsed.password or parsed.query or parsed.fragment or
            not address.is_private or parsed.path.rstrip("/") != "/dav"):
        raise WebDavError(400)
    root = "/dav"
    normalized = "http://%s%s%s" % (
        str(address), ":%d" % port if parsed.port else "", root
    )
    source_address = data.get("source_address")
    if source_address is not None:
        try:
            source_address = str(ipaddress.IPv4Address(_text(source_address, 64)))
        except (ValueError, WebDavError):
            raise WebDavError(400)
        if not ipaddress.IPv4Address(source_address).is_private:
            raise WebDavError(400)
    return WebDavConfig(normalized, str(address), port, root, username, password, source_address)


def _segments(segments: Iterable[str], require_file: bool = False) -> Tuple[str, ...]:
    if not isinstance(segments, (tuple, list)):
        raise WebDavError(400)
    values = tuple(segments)
    if require_file and not values:
        raise WebDavError(400)
    for value in values:
        if (not isinstance(value, str) or not value or len(value) > 255 or value in (".", "..") or
                "/" in value or "\\" in value or "\x00" in value or
                any(ord(character) < 32 or ord(character) == 127 for character in value)):
            raise WebDavError(400)
    return values


def _target(config: WebDavConfig, segments: Tuple[str, ...], collection: bool = False) -> str:
    value = config.root
    if segments:
        value += "/" + "/".join(quote(segment, safe="") for segment in segments)
    return value + "/" if collection and not value.endswith("/") else value


def _headers(config: WebDavConfig) -> dict:
    token = (config.username + ":" + config.password).encode("utf-8")
    return {"Authorization": "Basic " + base64.b64encode(token).decode("ascii"), "Connection": "close"}


def _connection(config: WebDavConfig) -> http.client.HTTPConnection:
    if config.source_address:
        return http.client.HTTPConnection(config.host, config.port, timeout=15,
                                          source_address=(config.source_address, 0))
    return http.client.HTTPConnection(config.host, config.port, timeout=15)


def _read_limited(response: http.client.HTTPResponse) -> bytes:
    chunks = []
    total = 0
    while True:
        chunk = response.read(min(16384, MAX_LIST_BODY_BYTES - total + 1))
        if not chunk:
            return b"".join(chunks)
        total += len(chunk)
        if total > MAX_LIST_BODY_BYTES:
            raise WebDavError(502)
        chunks.append(chunk)


def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _parse_entries(config: WebDavConfig, segments: Tuple[str, ...], body: bytes) -> List[dict]:
    try:
        document = element_tree.fromstring(body)
    except element_tree.ParseError:
        raise WebDavError(502)
    parent = unquote(_target(config, segments)).rstrip("/") or "/"
    prefix = parent + "/" if parent != "/" else "/"
    entries = []
    seen = set()
    for response in document.iter():
        if _local_name(response.tag) != "response":
            continue
        href = None
        for child in response:
            if _local_name(child.tag) == "href":
                href = child.text
                break
        if not isinstance(href, str) or not href:
            raise WebDavError(502)
        parsed = urlsplit(href)
        if parsed.query or parsed.fragment:
            raise WebDavError(502)
        if parsed.scheme or parsed.netloc:
            if (parsed.scheme != "http" or parsed.hostname != config.host or
                    (parsed.port or 80) != config.port):
                raise WebDavError(502)
        path = unquote(parsed.path).rstrip("/") or "/"
        if path == parent:
            continue
        if not path.startswith(prefix):
            raise WebDavError(502)
        name = path[len(prefix):]
        if not name or "/" in name or name in seen or name in (".", ".."):
            raise WebDavError(502)
        seen.add(name)
        directory = any(_local_name(node.tag) == "collection" for node in response.iter())
        entries.append({
            "name": name,
            "directory": directory,
            "playable": not directory and Path(name).suffix.lower() in DIRECT_EXTENSIONS,
        })
        if len(entries) > MAX_LIST_ENTRIES:
            raise WebDavError(502)
    return entries


def list_entries(config: WebDavConfig, segments: Iterable[str]) -> List[dict]:
    """Read one WebDAV folder and return only validated immediate children."""
    values = _segments(segments)
    body = b'<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>'
    connection = _connection(config)
    response = None
    try:
        headers = _headers(config)
        headers.update({"Depth": "1", "Content-Type": "application/xml; charset=utf-8", "Content-Length": str(len(body))})
        connection.request("PROPFIND", _target(config, values, collection=True), body=body, headers=headers)
        response = connection.getresponse()
        if response.status != 207:
            raise WebDavError(503)
        return _parse_entries(config, values, _read_limited(response))
    except WebDavError:
        raise
    except (OSError, http.client.HTTPException):
        raise WebDavError(503)
    finally:
        if response is not None:
            response.close()
        connection.close()


def open_file(config: WebDavConfig, segments: Iterable[str], method: str,
              range_header: Optional[str]) -> Tuple[http.client.HTTPConnection, http.client.HTTPResponse]:
    """Open one validated file without following redirects; caller owns close()."""
    values = _segments(segments, require_file=True)
    if method not in ("GET", "HEAD"):
        raise WebDavError(400)
    if range_header is not None and (not isinstance(range_header, str) or not RANGE_RE.fullmatch(range_header.strip())):
        raise WebDavError(400)
    connection = _connection(config)
    try:
        headers = _headers(config)
        if range_header:
            headers["Range"] = range_header.strip()
        connection.request(method, _target(config, values), headers=headers)
        response = connection.getresponse()
        if 300 <= response.status < 400:
            response.close()
            connection.close()
            raise WebDavError(502)
        return connection, response
    except WebDavError:
        raise
    except (OSError, http.client.HTTPException):
        connection.close()
        raise WebDavError(503)
