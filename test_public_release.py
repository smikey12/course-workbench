"""在隔离副本中验收公开版，不连接课程平台或使用日常服务。"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

import prepare_release


class PublicReleaseTests(unittest.TestCase):
    def test_export_allowlist_and_blank_settings(self):
        names = prepare_release.validate()
        with tempfile.TemporaryDirectory() as folder:
            archive = Path(folder) / "source.zip"
            digest = prepare_release.build_archive(archive)
            self.assertEqual(len(digest), 64)
            with zipfile.ZipFile(archive) as bundle:
                self.assertEqual(set(bundle.namelist()), set(names))
                self.assertIsNone(bundle.testzip())
            self.assertFalse(any(name.startswith(("data/", ".git/", "release/")) for name in names))
            self.assertFalse(any(name.endswith((".sqlite3", ".log", ".jpg")) for name in names))

    def test_isolated_first_run_sync_and_detail(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for name in prepare_release.FILES:
                target = root / name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(prepare_release.BASE / name, target)
            env = os.environ.copy()
            env.pop("KECANG_COURSES_ROOT", None)
            env.pop("KECANG_INBOX", None)
            program = r'''
import json
import threading
from datetime import datetime, timedelta, timezone
from http.server import ThreadingHTTPServer
from urllib.request import urlopen
import platform_sync, server
from public_settings import COURSE_ROOT, INBOX, ensure_data_dirs
ensure_data_dirs()
httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.make_handler(COURSE_ROOT, 0))
httpd.RequestHandlerClass = server.make_handler(COURSE_ROOT, httpd.server_port)
thread = threading.Thread(target=httpd.serve_forever, daemon=True)
thread.start()
base = "http://127.0.0.1:" + str(httpd.server_port)
def get(path):
    with urlopen(base + path, timeout=5) as response:
        return json.load(response)
try:
    empty = get("/api/workbench?task=")
    assert empty["assignments"] == [] and empty["courses"] == [] and empty["cxCourses"] == []
    assert not empty["moocSync"]["checked"] and not empty["moocSync"]["issue"]
    assert empty["task"] == {} and empty["files"] == [] and empty["links"] == []
    assert get("/api/catalog")["files"] == []
    assert get("/api/platform-preferences") == {"configured":False,"selected":[]}
    platform_sync.platform_settings(["rain","cx","mooc","pta"])
    assert get("/api/platform-preferences")["configured"] is True
    course = COURSE_ROOT / "大一上" / "测试课程"
    course.mkdir(parents=True)
    (course / "测试资料.txt").write_text("test", encoding="utf-8")
    assert len(get("/api/catalog?refresh=1")["files"]) == 1
    platform_sync.receive({"action":"index", "archiveOk":True,
                       "courses":[{"id":"101", "name":"测试课程"}]})
    deadline = (datetime.now(timezone.utc) + timedelta(days=5)).isoformat()
    platform_sync.receive({"action":"course", "course":"101", "outline":[],
                       "tasks":[{"leaf":"201", "title":"测试作业", "deadline":deadline, "completed":False}]})
    board = get("/api/workbench")
    assert len(board["courses"]) == 1 and len(board["assignments"]) == 1
    task = board["assignments"][0]
    assert task["courseId"] == "101" and task["completion"] == "未完成"
    conn = platform_sync.rain_catalog.open_db(platform_sync.DATABASE)
    with conn:
        raw = json.loads(conn.execute("SELECT record FROM tasks WHERE id=?", (task["id"],)).fetchone()[0])
        raw["publishedAt"] = "2042-01-02T03:04:05+08:00"
        conn.execute("UPDATE tasks SET record=? WHERE id=?", (json.dumps(raw), task["id"]))
    conn.close()
    summary = get("/api/workbench")["assignments"][0]
    assert summary["publishedAt"] == raw["publishedAt"]
    detail = get("/api/workbench?task=" + task["id"])
    assert detail["task"]["title"] == "测试作业" and detail["task"]["id"] == task["id"]
    assert get("/api/workbench?task=missing")["task"] == {}
    platform_sync.receive({"action":"mooc", "courses":[{
        "id":"101", "name":"MOOC测试课程", "section":"测试班", "checked":True,
        "tasks":[{"id":"201", "title":"MOOC测试作业", "completion":"未完成",
                  "status":"未提交", "deadlineAt":deadline}]}]})
    mixed = get("/api/workbench?task=")
    assert len(mixed["assignments"]) == 2 and mixed["task"] == {}
    assert {task["platform"] for task in mixed["assignments"]} == {"雨课堂", "中国大学 MOOC"}
    mooc_task = next(task for task in mixed["assignments"] if task["platform"] == "中国大学 MOOC")
    assert mooc_task["courseId"] == "mooc-101"
    assert get("/api/workbench?task=" + mooc_task["id"])["task"]["title"] == "MOOC测试作业"
    platform_sync.receive({"action":"mooc", "courses":[{
        "id":"101", "name":"MOOC测试课程", "checked":False, "issue":"模拟登录失效"}]})
    failed = get("/api/workbench?task=")
    assert len(failed["assignments"]) == 2 and "模拟登录失效" in failed["moocSync"]["issue"]
    print(json.dumps({"empty":True, "scan":True, "sync":True, "detail":True}))
finally:
    httpd.shutdown()
    httpd.server_close()
    thread.join(timeout=5)
'''
            result = subprocess.run([sys.executable, "-B", "-X", "utf8", "-c", program],
                                    cwd=root, env=env, capture_output=True, text=True, encoding="utf-8", timeout=30)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertTrue(json.loads(result.stdout)["detail"])


if __name__ == "__main__":
    unittest.main()
