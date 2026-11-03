"""验证发布白名单、可重现打包、版本与敏感运行目录排除。"""
import hashlib
import json
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

import prepare_release as release


class ReleaseBuildTests(unittest.TestCase):
    def test_full_release_package_is_accepted_by_updater(self):
        import updater
        snapshot = release.source_snapshot()
        version = release.release_version(snapshot)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            installation = root / "installed"
            installation.mkdir()
            for name, content in snapshot.items():
                target = installation / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(content)
            (installation / "VERSION").write_text("0.0.0\n", encoding="utf-8")
            private = {"data/inbox/report.docx": b"keep report", "作业关联.sqlite3": b"keep links",
                       "custom.txt": b"keep custom file"}
            for name, content in private.items():
                target = installation / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(content)
            archive = root / updater.ARCHIVE
            digest = release.build_archive(archive, snapshot)
            prefix = f"https://github.com/{updater.REPOSITORY}/releases/download/v{version}/"
            metadata = dict(tag_name="v" + version, draft=False, prerelease=False,
                            assets=[dict(name=name, state="uploaded", browser_download_url=prefix + name)
                                    for name in (updater.ARCHIVE, updater.CHECKSUM)])
            def fetch(url, limit):
                if url.endswith("/latest"):
                    return json.dumps(metadata).encode()
                if url.endswith(".sha256"):
                    return (digest + "  " + updater.ARCHIVE + "\n").encode()
                if url.endswith(".zip"):
                    return archive.read_bytes()
                raise AssertionError("unexpected request")
            with patch.object(updater, "BASE", installation), patch.object(updater, "_fetch", side_effect=fetch):
                info = updater.check_update()
                self.assertEqual(info["version"], version)
                self.assertEqual(updater.apply_update(info)["status"], "updated")
                self.assertEqual(updater.current_version(), version)
            for name, content in {**snapshot, **private}.items():
                self.assertEqual((installation / name).read_bytes(), content, name)

    def test_clean_deterministic_package_and_reject_invalid_inputs(self):
        names = ("public_settings.py", "VERSION", "main.py")
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            (root / "public_settings.py").write_text(
                'from pathlib import Path\nBASE = Path(__file__).resolve().parent\n'
                'def _directory(variable, default): return default\n'
                'COURSE_ROOT = _directory("KECANG_COURSES_ROOT", BASE / "data" / "courses")\n'
                'INBOX = _directory("KECANG_INBOX", BASE / "data" / "inbox")\n', encoding="utf-8")
            (root / "VERSION").write_text("1.1.0\n", encoding="utf-8")
            (root / "main.py").write_text('print("public")\n', encoding="utf-8")
            for name in ("data/inbox/private.docx", "private.sqlite3", "debug.log", ".git/config", "release/old.zip"):
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b"PRIVATE_RUNTIME_MARKER")
            with patch.object(release, "BASE", root), patch.object(release, "FILES", names):
                first, second = root / "release/first.zip", root / "release/second.zip"
                digest = release.build_archive(first)
                self.assertEqual(digest, release.build_archive(second))
                self.assertEqual(digest, hashlib.sha256(first.read_bytes()).hexdigest())
                with zipfile.ZipFile(first) as bundle:
                    self.assertEqual(tuple(bundle.namelist()), names)
                    self.assertIsNone(bundle.testzip())
                    for name in names:
                        self.assertEqual(bundle.read(name), (root / name).read_bytes())
                        self.assertNotIn(b"PRIVATE_RUNTIME_MARKER", bundle.read(name))
                with self.assertRaises(ValueError):
                    release.build_archive(root / "VERSION")
                for invalid in ("v1.1.0", "01.1.0", "1.1", "1.1.0-beta", "1.1.0/../x"):
                    (root / "VERSION").write_text(invalid, encoding="utf-8")
                    with self.assertRaises(ValueError):
                        release.validate()
                (root / "VERSION").write_text("1.1.0\n", encoding="utf-8")
                (root / "main.py").unlink()
                with self.assertRaises(ValueError):
                    release.build_archive(root / "release/missing.zip")

    def test_default_manifest_excludes_runtime_and_includes_update_entry(self):
        for name in ("VERSION", "updater.py", "launcher.py", "UPDATE_FORMAT.md"):
            self.assertIn(name, release.FILES)
        self.assertEqual(len(release.FILES), len(set(release.FILES)))
        for name in release.FILES:
            self.assertFalse(Path(name).is_absolute())
            self.assertNotIn("..", Path(name).parts)
            self.assertNotIn(Path(name).parts[0], ("data", ".git", "release", "__pycache__"))
            self.assertNotIn(Path(name).suffix.lower(), (".sqlite3", ".db", ".log", ".zip", ".doc", ".docx"))


if __name__ == "__main__":
    unittest.main()
