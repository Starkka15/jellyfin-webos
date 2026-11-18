import json
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))
import library_webdav as webdav


class FakeResponse:
    def __init__(self, status, body=b""):
        self.status = status
        self.body = body
        self.offset = 0
        self.closed = False

    def read(self, size=-1):
        if size < 0:
            size = len(self.body) - self.offset
        chunk = self.body[self.offset:self.offset + size]
        self.offset += len(chunk)
        return chunk

    def close(self):
        self.closed = True


class FakeConnection:
    response = None
    calls = []

    def __init__(self, host, port, timeout, source_address=None):
        self.host, self.port, self.timeout, self.source_address = host, port, timeout, source_address
        self.closed = False

    def request(self, method, target, body=None, headers=None):
        self.calls.append((method, target, body, headers))

    def getresponse(self):
        return self.response

    def close(self):
        self.closed = True


def multistatus(*hrefs):
    return ("<d:multistatus xmlns:d=\"DAV:\">" + "".join(hrefs) + "</d:multistatus>").encode("utf-8")


class LibraryWebDavTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.config_path = Path(self.temp.name) / "alist-webdav.private.json"
        self.config_path.write_text(json.dumps({
            "endpoint": "http://192.168.50.30:5244/dav",
            "username": "user",
            "password": "password",
        }), encoding="utf-8")
        self.config_path.chmod(0o600)
        self.config = webdav.load_config(self.config_path)
        FakeConnection.calls = []

    def tearDown(self):
        self.temp.cleanup()

    def test_load_config_requires_private_http_dav_and_0600(self):
        self.assertEqual(self.config.root, "/dav")
        self.config_path.chmod(0o644)
        with self.assertRaises(webdav.WebDavError) as caught:
            webdav.load_config(self.config_path)
        self.assertEqual(caught.exception.status, 503)
        self.config_path.chmod(0o600)
        self.config_path.write_text(json.dumps({
            "endpoint": "https://192.168.50.30/dav",
            "username": "user", "password": "password",
        }), encoding="utf-8")
        with self.assertRaises(webdav.WebDavError) as caught:
            webdav.load_config(self.config_path)
        self.assertEqual(caught.exception.status, 400)

    def test_load_config_allows_only_a_private_source_address(self):
        self.config_path.write_text(json.dumps({
            "endpoint": "http://192.168.50.30:5244/dav", "username": "user", "password": "password",
            "source_address": "192.168.50.20",
        }), encoding="utf-8")
        config = webdav.load_config(self.config_path)
        self.assertEqual(config.source_address, "192.168.50.20")
        self.config_path.write_text(json.dumps({
            "endpoint": "http://192.168.50.30:5244/dav", "username": "user", "password": "password",
            "source_address": "8.8.8.8",
        }), encoding="utf-8")
        with self.assertRaises(webdav.WebDavError) as caught:
            webdav.load_config(self.config_path)
        self.assertEqual(caught.exception.status, 400)

    def test_list_entries_allows_only_immediate_children_and_direct_mp4(self):
        FakeConnection.response = FakeResponse(207, multistatus(
            "<d:response><d:href>/dav/Shows/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>",
            "<d:response><d:href>/dav/clip.mp4</d:href><d:propstat><d:prop><d:resourcetype/></d:prop></d:propstat></d:response>",
            "<d:response><d:href>/dav/legacy.mkv</d:href><d:propstat><d:prop><d:resourcetype/></d:prop></d:propstat></d:response>",
        ))
        with patch.object(webdav.http.client, "HTTPConnection", FakeConnection):
            items = webdav.list_entries(self.config, ())
        self.assertEqual(items, [
            {"name": "Shows", "directory": True, "playable": False},
            {"name": "clip.mp4", "directory": False, "playable": True},
            {"name": "legacy.mkv", "directory": False, "playable": False},
        ])
        method, target, _, headers = FakeConnection.calls[-1]
        self.assertEqual((method, target, headers["Depth"]), ("PROPFIND", "/dav/", "1"))
        self.assertTrue(headers["Authorization"].startswith("Basic "))

    def test_list_entries_rejects_nested_children(self):
        FakeConnection.response = FakeResponse(207, multistatus(
            "<d:response><d:href>/dav/folder/child.mp4</d:href></d:response>",
        ))
        with patch.object(webdav.http.client, "HTTPConnection", FakeConnection):
            with self.assertRaises(webdav.WebDavError) as caught:
                webdav.list_entries(self.config, ())
        self.assertEqual(caught.exception.status, 502)

    def test_list_entries_caps_the_webdav_body(self):
        FakeConnection.response = FakeResponse(207, b"x" * (webdav.MAX_LIST_BODY_BYTES + 1))
        with patch.object(webdav.http.client, "HTTPConnection", FakeConnection):
            with self.assertRaises(webdav.WebDavError) as caught:
                webdav.list_entries(self.config, ())
        self.assertEqual(caught.exception.status, 502)

    def test_open_file_forwards_single_range_and_refuses_redirects(self):
        FakeConnection.response = FakeResponse(206, b"test")
        with patch.object(webdav.http.client, "HTTPConnection", FakeConnection):
            connection, response = webdav.open_file(self.config, ("movie.mp4",), "GET", "bytes=0-4095")
        self.assertEqual(response.status, 206)
        method, target, _, headers = FakeConnection.calls[-1]
        self.assertEqual((method, target, headers["Range"]), ("GET", "/dav/movie.mp4", "bytes=0-4095"))
        response.close()
        connection.close()
        FakeConnection.response = FakeResponse(302)
        with patch.object(webdav.http.client, "HTTPConnection", FakeConnection):
            with self.assertRaises(webdav.WebDavError) as caught:
                webdav.open_file(self.config, ("movie.mp4",), "GET", None)
        self.assertEqual(caught.exception.status, 502)


if __name__ == "__main__":
    unittest.main()
