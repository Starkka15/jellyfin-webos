#!/usr/bin/env python3
"""Atomically install private SMB fallback settings from one stdin JSON object."""

import json
import ipaddress
import os
import re
import sys
import tempfile
from pathlib import Path


CONFIG = Path(__file__).resolve().with_name("bridge-config.json")
MAX_INPUT_BYTES = 8192
SMB_SERVER_RE = re.compile(
    r"(?:[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?\.)*"
    r"[A-Za-z0-9_](?:[A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?\Z"
)
SMB_SHARE_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._$ -]{0,79}\Z")


def _safe_text(value: object, maximum: int) -> bool:
    return (
        isinstance(value, str)
        and bool(value)
        and len(value) <= maximum
        and "\x00" not in value
        and not any(ord(character) < 32 or ord(character) == 127 for character in value)
    )


def _valid_server(value: object) -> bool:
    if not _safe_text(value, 253) or not SMB_SERVER_RE.fullmatch(value):
        return False
    if re.fullmatch(r"[0-9.]+", value):
        try:
            return isinstance(ipaddress.ip_address(value), ipaddress.IPv4Address)
        except ValueError:
            return False
    return True


def validate_smb_settings(value: object) -> dict:
    if not isinstance(value, dict) or set(value) != {"server", "share", "username", "password"}:
        raise ValueError("invalid SMB settings")
    server = value["server"]
    share = value["share"]
    username = value["username"]
    password = value["password"]
    if not _valid_server(server):
        raise ValueError("invalid SMB server")
    if not _safe_text(share, 80) or not SMB_SHARE_RE.fullmatch(share):
        raise ValueError("invalid SMB share")
    if not _safe_text(username, 256) or not _safe_text(password, 1024):
        raise ValueError("invalid SMB credential")
    return {"server": server, "share": share, "username": username, "password": password}


def update_smb_config(config_path: Path, stdin) -> int:
    try:
        payload = stdin.read(MAX_INPUT_BYTES + 1)
        if isinstance(payload, bytes):
            payload = payload.decode("utf-8")
        if len(payload.encode("utf-8")) > MAX_INPUT_BYTES:
            return 1
        settings = validate_smb_settings(json.loads(payload))
        if config_path.stat().st_mode & 0o077 or config_path.parent.stat().st_mode & 0o077:
            return 1
        config = json.loads(config_path.read_text(encoding="utf-8"))
        if not isinstance(config, dict):
            return 1
        config["nas_smb"] = settings
        os.umask(0o077)
        fd, temporary = tempfile.mkstemp(prefix=".bridge-config-", dir=str(config_path.parent), text=True)
        try:
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as output:
                json.dump(config, output, separators=(",", ":"))
                output.write("\n")
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, config_path)
        finally:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError, TypeError):
        return 1
    return 0


def main() -> int:
    return update_smb_config(CONFIG, sys.stdin.buffer)


if __name__ == "__main__":
    sys.exit(main())
