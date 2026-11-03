"""更新器隔离验证：模拟 GitHub 附件和故障，不联网、不更新真实目录。"""
import hashlib
import io
import json
import os
import subprocess
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

import updater
import prepare_release


class UpdaterTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.names = ("VERSION", "updater.py", "web/app.js")
        self.old = {"VERSION": b"1.1.0\n", "updater.py": b"# old updater\n", "web/app.js": b"old web"}
        for name, content in self.old.items():
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
        (self.root / "data").mkdir()
        self.user_data = {"data/report.docx": b"my report", "data/courses.sqlite3": b"database", "作业关联.sqlite3": b"links"}
        for name, content in self.user_data.items():
            (self.root / name).write_bytes(content)
        self.addCleanup(patch.stopall)
        patch.object(updater, "BASE", self.root).start()
        patch.object(updater, "FILES", self.names).start()

    def package(self, extra=None, version="1.2.0"):
        output = io.BytesIO()
        contents = {"VERSION": version.encode(), "updater.py": b"# new updater\n", "web/app.js": b"new web"}
        contents.update(extra or {})
        with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as bundle:
            for name, content in contents.items():
                bundle.writestr(name, content)
        return output.getvalue()

    def release(self, version="1.2.0"):
        tag = "v" + version
        prefix = f"https://github.com/{updater.REPOSITORY}/releases/download/{tag}/"
        return {"tag_name": tag, "draft": False, "prerelease": False,
                "assets": [{"name": name, "state": "uploaded", "browser_download_url": prefix + name}
                           for name in (updater.ARCHIVE, updater.CHECKSUM)]}

    def network(self, content=None, metadata=None, checksum=None):
        content = content if content is not None else self.package()
        metadata = metadata if metadata is not None else self.release()
        checksum = checksum if checksum is not None else hashlib.sha256(content).hexdigest() + "  " + updater.ARCHIVE + "\n"
        def fetch(url, limit):
            if url.endswith("/latest"):
                return json.dumps(metadata).encode()
            if url.endswith(".sha256"):
                return checksum.encode()
            if url.endswith(".zip"):
                return content
            self.fail("unexpected URL " + url)
        return patch.object(updater, "_fetch", side_effect=fetch)

    def assert_untouched(self):
        for name, content in {**self.old, **self.user_data}.items():
            self.assertEqual((self.root / name).read_bytes(), content, name)

    def test_check_and_install_preserves_user_data(self):
        with self.network():
            info = updater.check_update()
            self.assertEqual(info["version"], "1.2.0")
            result = updater.apply_update({**info, "archive_url": "https://invalid.example/evil.zip"})
        self.assertEqual(result["status"], "updated")
        self.assertTrue(result["restart_required"])
        self.assertEqual(updater.current_version(), "1.2.0")
        self.assertEqual((self.root / "web/app.js").read_bytes(), b"new web")
        for name, content in self.user_data.items():
            self.assertEqual((self.root / name).read_bytes(), content)
        self.assertFalse((self.root / updater.STATE).exists())

    def test_equal_and_older_release_are_not_updates(self):
        for version in ("1.1.0", "1.0.9"):
            with self.subTest(version=version), self.network(metadata=self.release(version)):
                self.assertIsNone(updater.check_update())
                with self.assertRaises(updater.UpdateError):
                    updater.apply_update({"version": version})
        self.assert_untouched()

    def test_bad_release_metadata(self):
        for change in ({"prerelease": True}, {"draft": True}, {"tag_name": "v1.2"}, {"assets": []}):
            with self.subTest(change=change), self.network(metadata={**self.release(), **change}):
                with self.assertRaises(updater.UpdateError):
                    updater.check_update()
        metadata = self.release()
        metadata["assets"][0]["browser_download_url"] = "https://example.com/course-workbench.zip"
        with self.network(metadata=metadata), self.assertRaises(updater.UpdateError):
            updater.check_update()

    def test_tampered_hash_and_checksum(self):
        for checksum in ("0" * 64 + "  course-workbench.zip", "bad hash", "0" * 64 + "  another.zip"):
            with self.subTest(checksum=checksum), self.network(checksum=checksum):
                with self.assertRaises(updater.UpdateError):
                    updater.apply_update({"version": "1.2.0"})
        self.assert_untouched()

    def test_refuses_version_race(self):
        with self.network(), self.assertRaises(updater.UpdateError):
            updater.apply_update({"version": "1.3.0"})
        self.assert_untouched()

    def test_bad_zip_and_package_version(self):
        for content in (b"not a zip", self.package(version="1.1.0"), self.package(version="1.3.0")):
            with self.subTest(content=content[:16]), self.network(content=content):
                with self.assertRaises(updater.UpdateError):
                    updater.apply_update({"version": "1.2.0"})
                self.assert_untouched()

    def test_reject_extra_traversal_data_and_case_collision(self):
        for name in ("../outside.py", "data/report.docx", "VERSION ", "version", "web\\bad.js", "web/file.js:stream"):
            with self.subTest(name=name), self.network(content=self.package({name: b"bad"})):
                with self.assertRaises(updater.UpdateError):
                    updater.apply_update({"version": "1.2.0"})
                self.assert_untouched()

    def test_duplicate_and_symlink_entries(self):
        output = io.BytesIO(self.package())
        import warnings
        with warnings.catch_warnings(), zipfile.ZipFile(output, "a") as bundle:
            warnings.simplefilter("ignore")
            bundle.writestr("VERSION", b"1.2.0")
        with self.network(content=output.getvalue()), self.assertRaises(updater.UpdateError):
            updater.apply_update({"version": "1.2.0"})
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w") as bundle:
            bundle.writestr("VERSION", b"1.2.0")
            entry = zipfile.ZipInfo("updater.py")
            entry.create_system = 3
            entry.external_attr = (0o120777 << 16)
            bundle.writestr(entry, b"outside.py")
            bundle.writestr("web/app.js", b"new")
        with self.network(content=output.getvalue()), self.assertRaises(updater.UpdateError):
            updater.apply_update({"version": "1.2.0"})
        self.assert_untouched()

    def test_reject_invalid_python_before_replacement(self):
        with self.network(content=self.package({"updater.py": b"def broken("})), self.assertRaises(updater.UpdateError):
            updater.apply_update({"version": "1.2.0"})
        self.assert_untouched()

    def test_expanded_size_limit(self):
        with patch.object(updater, "MAX_EXPANDED", 1), self.network(), self.assertRaises(updater.UpdateError):
            updater.apply_update({"version": "1.2.0"})
        self.assert_untouched()

    def test_late_write_failure_rolls_back_every_file(self):
        replace = os.replace
        failed = False
        def fail_late(source, target):
            nonlocal failed
            if Path(source).parts[-2:] == ("new", "VERSION") and not failed:
                failed = True
                raise PermissionError("simulated locked file")
            return replace(source, target)
        with self.network(), patch.object(updater.os, "replace", side_effect=fail_late):
            with self.assertRaisesRegex(updater.UpdateError, "已恢复原版本"):
                updater.apply_update({"version": "1.2.0"})
        self.assertTrue(failed)
        self.assert_untouched()
        self.assertFalse((self.root / updater.STATE).exists())

    def test_interrupted_transaction_can_be_recovered(self):
        state = self.root / updater.STATE
        backup = state / "backup"
        backup.mkdir(parents=True)
        os.replace(self.root / "updater.py", backup / "updater.py")
        (self.root / "updater.py").write_bytes(b"half installed")
        updater._write_journal(state, {"status": "installing", "changes": [{"name": "updater.py", "existed": True}]})
        self.assertTrue(updater.recover_update())
        self.assertFalse(updater.recover_update())
        self.assert_untouched()

    def test_update_lock(self):
        with updater._locked(self.root):
            with self.assertRaisesRegex(updater.UpdateError, "另一个更新"):
                updater.recover_update()
        self.assert_untouched()

    def test_rollback_failure_is_recoverable_and_blocks_restart(self):
        replace = os.replace
        def fail_install_and_restore(source, target):
            source = Path(source)
            if source.parts[-2:] == ("new", "VERSION") or "backup" in source.parts:
                raise PermissionError("simulated installation and rollback lock")
            return replace(source, target)
        with self.network(), patch.object(updater.os, "replace", side_effect=fail_install_and_restore):
            with self.assertRaises(updater.UpdateError) as caught:
                updater.apply_update({"version": "1.2.0"})
        self.assertTrue(caught.exception.recovery_required)
        self.assertTrue((self.root / updater.STATE / "journal.json").exists())
        self.assertTrue(updater.recover_update())
        self.assert_untouched()

    def test_invalid_recovery_record_keeps_backup_and_blocks_restart(self):
        state = self.root / updater.STATE
        state.mkdir()
        updater._write_journal(state, {"status": "installing", "changes": [{"name": "data/report.docx", "existed": True}]})
        with self.assertRaises(updater.UpdateError) as caught:
            updater.recover_update()
        self.assertTrue(caught.exception.recovery_required)
        self.assertTrue(state.exists())
        self.assert_untouched()

    def test_committed_transaction_only_removes_backup(self):
        state = self.root / updater.STATE
        (state / "backup").mkdir(parents=True)
        (state / "backup" / "VERSION").write_text("1.0.0", encoding="utf-8")
        updater._write_journal(state, {"status": "committed", "changes": [{"name": "VERSION", "existed": True}]})
        self.assertTrue(updater.recover_update())
        self.assert_untouched()

    def test_reject_actual_directory_junction_or_symlink(self):
        outside = self.root / "user-web"
        outside.mkdir()
        (outside / "app.js").write_bytes(b"user file")
        (self.root / "web").rename(self.root / "original-web")
        junction = self.root / "web"
        if os.name == "nt":
            result = subprocess.run(["cmd.exe", "/c", "mklink", "/J", str(junction), str(outside)], capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
        else:
            junction.symlink_to(outside, target_is_directory=True)
        try:
            with self.network(), self.assertRaises(updater.UpdateError):
                updater.apply_update({"version": "1.2.0"})
            self.assertEqual((outside / "app.js").read_bytes(), b"user file")
        finally:
            if os.name == "nt":
                junction.rmdir()
            else:
                junction.unlink()
            (self.root / "original-web").rename(junction)
        self.assert_untouched()

    def test_redirect_rejects_http_and_foreign_hosts(self):
        handler = updater._HTTPSRedirect()
        for url in ("http://github.com/x", "https://evil.example/file", "https://github.com@evil.example/file"):
            with self.subTest(url=url), self.assertRaises(updater.UpdateError):
                handler.redirect_request(None, None, 302, "redirect", {}, url)

    def test_real_release_builder_package_can_update_isolated_installation(self):
        snapshot = prepare_release.source_snapshot()
        for name, content in snapshot.items():
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
        snapshot["VERSION"] = b"1.2.0\n"
        archive = self.root / "candidate.zip"
        prepare_release.build_archive(archive, snapshot)
        with patch.object(updater, "FILES", prepare_release.FILES), self.network(content=archive.read_bytes()):
            result = updater.apply_update(updater.check_update())
        self.assertEqual(result["status"], "updated")
        self.assertEqual(updater.current_version(), "1.2.0")
        for name, content in snapshot.items():
            self.assertEqual((self.root / name).read_bytes(), content, name)
        for name, content in self.user_data.items():
            self.assertEqual((self.root / name).read_bytes(), content, name)


if __name__ == "__main__":
    unittest.main()
