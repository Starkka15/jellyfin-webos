"""Read only the directory entries beneath the Mini's mounted NAS share."""
import os
import uuid
from pathlib import Path


MEDIA_EXTENSIONS = frozenset({".mp4", ".m4v", ".mov", ".mkv", ".ts", ".avi", ".webm", ".3gp"})


def _valid_segments(segments):
    if not isinstance(segments, tuple) or len(segments) > 64:
        raise ValueError("invalid path")
    for part in segments:
        if (not isinstance(part, str) or not part or part in {".", ".."} or len(part) > 255
                or any(char in part for char in "\\/\x00")
                or any(ord(char) < 32 or ord(char) == 127 for char in part)):
            raise ValueError("invalid path")


def _field_value(entry, name):
    value = entry[name]
    return value.get_value() if hasattr(value, "get_value") else value


def _directory_entry_name(entry):
    value = _field_value(entry, "file_name")
    if isinstance(value, bytes):
        return value.decode("utf-16-le", "strict")
    if isinstance(value, str):
        return value
    raise ValueError("invalid directory entry")


def _safe_entry(name, attributes, directory_mask, reparse_mask):
    if (not name or name in {".", ".."} or len(name) > 255 or any(char in name for char in "\\/\x00")
            or any(ord(char) < 32 or ord(char) == 127 for char in name)):
        return None
    is_reparse = bool(int(attributes) & int(reparse_mask))
    if is_reparse:
        return None
    is_directory = bool(int(attributes) & int(directory_mask))
    return {
        "name": name,
        "directory": is_directory,
        "playable": not is_directory and Path(name).suffix.lower() in MEDIA_EXTENSIONS,
    }


def _open_directory_for_listing(bridge, bindings, directory_access, tree, path):
    """Open exactly one already-validated directory with list permission only."""
    opened = bindings.open_file(tree, path)
    options = bindings.create_options.FILE_OPEN_REPARSE_POINT | bindings.create_options.FILE_DIRECTORY_FILE
    access = directory_access.FILE_READ_ATTRIBUTES | directory_access.FILE_LIST_DIRECTORY
    share_access = (
        bindings.share_access.FILE_SHARE_READ
        | bindings.share_access.FILE_SHARE_WRITE
        | bindings.share_access.FILE_SHARE_DELETE
    )
    opened.create(
        bindings.impersonation_level.Impersonation,
        access,
        bindings.file_attributes.FILE_ATTRIBUTE_DIRECTORY,
        share_access,
        bindings.create_disposition.FILE_OPEN,
        options,
    )
    if bridge._smb_has_reparse_point(opened, bindings):
        bridge._close_smb_resource(opened)
        raise bridge.NasFileError(404, "not found")
    return opened


def list_smb_entries(bridge, config, source_address, segments, limit=1000):
    """List one SMB directory through the same signed, no-follow fallback as media reads."""
    try:
        _valid_segments(segments)
    except ValueError as exc:
        raise bridge.NasFileError(400, "invalid path") from exc
    if not isinstance(limit, int) or limit < 1 or limit > 1000 or not source_address:
        raise bridge.NasFileError(503, "NAS unavailable")
    connection = session = tree = opened = None
    try:
        bindings = bridge.load_smb_bindings(
            bridge.select_smb_source_address(config.server, source_address)
        )
        from smbprotocol.exceptions import NoMoreFiles
        from smbprotocol.file_info import FileInformationClass
        from smbprotocol.open import DirectoryAccessMask, QueryDirectoryFlags

        connection = bindings.connection(uuid.uuid4(), config.server, port=445, require_signing=True)
        bridge._smb_disable_symlink_redirect(connection)
        connection.connect(timeout=bridge.SMB_OPERATION_TIMEOUT_SECONDS)
        session = bindings.session(connection, config.username, config.password, require_encryption=False)
        session.connect()
        tree = bindings.tree_connect(session, bridge._smb_share_path(config))
        tree.connect()
        if tree.is_dfs_share:
            raise bridge.NasFileError(503, "NAS unavailable")
        for index in range(1, len(segments)):
            parent = bridge._smb_open_component(bindings, tree, "\\".join(segments[:index]), True)
            bridge._close_smb_resource(parent)
        opened = _open_directory_for_listing(bridge, bindings, DirectoryAccessMask, tree, "\\".join(segments))
        try:
            entries = opened.query_directory(
                "*", FileInformationClass.FILE_DIRECTORY_INFORMATION,
                flags=QueryDirectoryFlags.SMB2_RESTART_SCANS, max_output=64 * 1024,
            )
        except NoMoreFiles:
            entries = []
        if not isinstance(entries, list) or len(entries) > limit:
            raise bridge.NasFileError(413, "directory contains too many entries")
        output = []
        for entry in entries:
            item = _safe_entry(
                _directory_entry_name(entry), _field_value(entry, "file_attributes"),
                bindings.file_attributes.FILE_ATTRIBUTE_DIRECTORY,
                bindings.file_attributes.FILE_ATTRIBUTE_REPARSE_POINT,
            )
            if item is not None:
                output.append(item)
        return sorted(output, key=lambda entry: (not entry["directory"], entry["name"].casefold()))
    except bridge.NasFileError:
        raise
    except Exception as exc:
        raise bridge.NasFileError(503, "NAS unavailable") from exc
    finally:
        bridge._close_smb_resource(opened)
        bridge._close_smb_resource(tree)
        bridge._close_smb_resource(session)
        bridge._close_smb_resource(connection)


def list_entries(root, segments, limit=1000):
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    fd = os.open(root, flags)
    try:
        for part in segments:
            if not part or part in {".", ".."} or "/" in part or "\\" in part:
                raise ValueError("invalid path")
            child = os.open(part, flags, dir_fd=fd)
            os.close(fd)
            fd = child
        out = []
        with os.scandir(fd) as listing:
            for entry in listing:
                if entry.name.startswith(".") or any(c in entry.name for c in "\\/:") or any(
                    ord(c) < 32 or ord(c) == 127 for c in entry.name
                ):
                    continue
                is_dir = entry.is_dir(follow_symlinks=False)
                if not is_dir and not entry.is_file(follow_symlinks=False):
                    continue
                out.append({"name": entry.name, "directory": is_dir,
                            "playable": not is_dir and Path(entry.name).suffix.lower() in {".mp4", ".m4v"}})
                if len(out) > limit:
                    raise ValueError("directory contains too many entries")
        return sorted(out, key=lambda entry: (not entry["directory"], entry["name"].casefold()))
    finally:
        os.close(fd)
