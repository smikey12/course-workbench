"""启动入口测试：不打开真实浏览器、弹窗或访问 GitHub。"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

import launcher


class UpdatePromptTests(unittest.TestCase):
    def exercise(self, info=None, accepted=True, owned=True, check_error=None, apply_error=None):
        events = []
        updater = types.SimpleNamespace()
        def check():
            events.append("check")
            if check_error:
                raise check_error
            return info
        def apply(value):
            events.append("apply")
            self.assertIs(value, info)
            if apply_error:
                raise apply_error
            return {"status":"updated", "version":"2.0.0", "message":"更新完成"}
        updater.check_update, updater.apply_update = check, apply
        with patch.dict(sys.modules, {"updater":updater}), \
             patch.object(launcher, "ask_update", side_effect=lambda _:events.append("ask") or accepted), \
             patch.object(launcher, "stop_owned_service", side_effect=lambda _:events.append("stop") or owned), \
             patch.object(launcher, "ensure_service", side_effect=lambda _:events.append("start")), \
             patch.object(launcher, "open_browser", side_effect=lambda _:events.append("browser")), \
             patch.object(launcher, "notify") as notify:
            launcher.offer_update(12345)
        return events, notify

    def test_current_version_is_quiet(self):
        events, notify = self.exercise()
        self.assertEqual(events, ["check"])
        notify.assert_not_called()

    def test_offline_does_not_interrupt_current_service(self):
        events, notify = self.exercise(check_error=OSError("offline"))
        self.assertEqual(events, ["check"])
        notify.assert_not_called()

    def test_decline_does_not_stop_or_update(self):
        events, _ = self.exercise({"version":"2.0.0"}, accepted=False)
        self.assertEqual(events, ["check", "ask"])

    def test_accept_stops_updates_and_starts_in_order(self):
        events, notify = self.exercise({"version":"2.0.0"})
        self.assertEqual(events, ["check", "ask", "stop", "apply", "start", "browser"])
        notify.assert_called_once_with("更新完成")

    def test_failed_update_still_restarts(self):
        events, notify = self.exercise({"version":"2.0.0"}, apply_error=RuntimeError("回滚完成"))
        self.assertEqual(events, ["check", "ask", "stop", "apply", "start"])
        self.assertIn("回滚完成", notify.call_args.args[0])
        self.assertTrue(notify.call_args.kwargs["error"])

    def test_unfinished_recovery_does_not_restart(self):
        error = RuntimeError("请保留备份")
        error.recovery_required = True
        events, notify = self.exercise({"version":"2.0.0"}, apply_error=error)
        self.assertEqual(events, ["check", "ask", "stop", "apply"])
        self.assertIn("暂停启动", notify.call_args.args[0])

    def test_recovery_precedes_service_and_update_check(self):
        events = []
        updater = types.SimpleNamespace(recover_update=lambda:events.append("recover"))
        from contextlib import nullcontext
        with patch.dict(sys.modules, {"updater":updater}), \
             patch.object(launcher,"startup_lock",return_value=nullcontext()), \
             patch.object(launcher,"ensure_service",side_effect=lambda _:events.append("start")), \
             patch.object(launcher,"open_browser",side_effect=lambda _:events.append("browser")), \
             patch.object(launcher,"offer_update",side_effect=lambda _:events.append("check")):
            self.assertEqual(launcher.main([]),0)
        self.assertEqual(events,["recover","start","browser","check"])

    def test_recovery_failure_blocks_service(self):
        updater = types.SimpleNamespace(recover_update=lambda:(_ for _ in ()).throw(RuntimeError("恢复失败")))
        from contextlib import nullcontext
        with patch.dict(sys.modules, {"updater":updater}), \
             patch.object(launcher,"startup_lock",return_value=nullcontext()), \
             patch.object(launcher,"ensure_service") as start, \
             patch.object(launcher,"notify"):
            self.assertEqual(launcher.main([]),1)
        start.assert_not_called()

    def test_foreign_service_is_not_updated(self):
        events, _ = self.exercise({"version":"2.0.0"}, owned=False)
        self.assertEqual(events, ["check", "ask", "stop", "start"])

    def test_malformed_result_cannot_trigger_update(self):
        events, _ = self.exercise({"release_url":"unused"})
        self.assertEqual(events, ["check"])


@unittest.skipUnless(os.name == "nt", "Windows 服务与文件锁验收")
class LauncherServiceTests(unittest.TestCase):
    def test_real_child_ownership_stop_and_lock(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            names = [p.name for p in launcher.BASE.glob("*.py")]
            for name in names:
                shutil.copyfile(launcher.BASE / name, root / name)
            shutil.copytree(launcher.BASE / "web", root / "web", ignore=shutil.ignore_patterns(".qa", "node_modules"))
            env = os.environ.copy()
            env.pop("KECANG_COURSES_ROOT", None)
            env.pop("KECANG_INBOX", None)
            script = r'''
import json, socket, subprocess, sys
import launcher
with socket.socket() as reserve:
    reserve.bind(("127.0.0.1", 0))
    port = reserve.getsockname()[1]
try:
    launcher.ensure_service(port)
    state = launcher.read_state(port)
    assert state and launcher.control(port, "identity", state)
    assert not launcher.control(port, "stop", dict(state, token="wrong-token"))
    assert launcher.workbench_is_running(port)
    launcher.ensure_service(port)
    assert launcher.read_state(port)["pid"] == state["pid"]
    with launcher.startup_lock():
        code = "import launcher; launcher.startup_lock(timeout=0.1).__enter__()"
        child = subprocess.run([sys.executable,"-B","-c",code],capture_output=True,timeout=5)
        assert child.returncode != 0
    with launcher.startup_lock(timeout=0.1):
        pass
    assert launcher.stop_owned_service(port)
    assert not launcher.workbench_is_running(port)
    launcher.ensure_service(port)
    assert launcher.workbench_is_running(port)
    assert launcher.read_state(port)["token"] != state["token"]
    print(json.dumps({"reuse":True,"ownership":True,"stop":True,"restart":True,"lock":True}))
finally:
    launcher.stop_owned_service(port)
'''
            result = subprocess.run([sys.executable,"-B","-X","utf8","-c",script], cwd=root, env=env,
                                    capture_output=True,text=True,encoding="utf-8",timeout=40)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertTrue(json.loads(result.stdout)["restart"])


if __name__ == "__main__":
    unittest.main()
