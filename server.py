"""课程文件目录：仅扫描元数据，不提供课程文件的写入或执行接口。"""
import argparse
import json
import os
import re
import stat
import threading
import sqlite3
import shutil
import workbench
import platform_sync
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, urlsplit

from public_settings import COURSE_ROOT as DEFAULT_ROOT, ensure_data_dirs
WEB_ROOT = Path(__file__).parent / "web"
IGNORED_DIRS = {"node_modules", ".git", "__pycache__"}
SEMESTER_PATTERN = re.compile(r"^大[一二三四五六][上下]$")
YEAR_ORDER = {name: index for index, name in enumerate("一二三四五六")}


def scan_catalog(root, semester_only=None):
    """只用 scandir/stat 读取名称与属性；不打开文件内容、不解压。"""
    files, folders, warnings = [], [], []
    skipped = {"directories": 0, "temporaryFiles": 0, "links": 0}
    semesters, courses = [], []

    def is_link(entry):
        info = entry.stat(follow_symlinks=False)
        return entry.is_symlink() or bool(getattr(info, "st_file_attributes", 0)
                                         & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400))

    try:
        with os.scandir(root) as entries:
            for entry in entries:
                if semester_only and entry.name != semester_only:
                    continue
                if entry.name not in IGNORED_DIRS and entry.is_dir(follow_symlinks=False) and not is_link(entry):
                    if SEMESTER_PATTERN.fullmatch(entry.name):
                        semesters.append(entry.name)
                        try:
                            with os.scandir(entry.path) as children:
                                for child in children:
                                    if child.name not in IGNORED_DIRS and child.is_dir(follow_symlinks=False) and not is_link(child):
                                        course_id = f"{entry.name}/{child.name}"
                                        courses.append({"id": course_id, "name": child.name,
                                                        "semester": entry.name, "path": course_id})
                        except OSError as exc:
                            warnings.append({"path": entry.name, "message": str(exc)})
    except OSError as exc:
        raise RuntimeError(f"无法读取课程根目录：{exc}") from exc
    semesters.sort(key=lambda name: (YEAR_ORDER[name[1]], name[-1] == "下"))
    courses.sort(key=lambda item: (semesters.index(item["semester"]), item["name"]))
    course_ids = {item["id"] for item in courses}

    def classify(relative):
        parts = relative.split("/")
        semester = parts[0] if parts[0] in semesters else None
        course_id = "/".join(parts[:2])
        if semester and len(parts) > 2 and course_id in course_ids:
            return semester, parts[1], course_id, "目录归属", f"位于「{semester} → {parts[1]}」课程目录"
        return semester, None, None, "待确认", "未位于已识别的学期／课程目录内"

    def walk(directory, prefix=""):
        try:
            with os.scandir(directory) as entries:
                for entry in entries:
                    if semester_only and not prefix and entry.name != semester_only:
                        continue
                    relative = f"{prefix}/{entry.name}" if prefix else entry.name
                    try:
                        if is_link(entry):
                            skipped["links"] += 1
                            continue
                        if entry.is_dir(follow_symlinks=False):
                            excluded = entry.name in IGNORED_DIRS
                            folders.append({"name": entry.name, "path": relative, "parent": prefix,
                                            "excluded": excluded})
                            if excluded:
                                skipped["directories"] += 1
                                continue
                            walk(entry.path, relative)
                        elif entry.is_file(follow_symlinks=False):
                            if entry.name.startswith("~$"):
                                skipped["temporaryFiles"] += 1
                                continue
                            info = entry.stat(follow_symlinks=False)
                            semester, course, course_id, status, reason = classify(relative)
                            files.append({"name": entry.name, "path": relative, "parent": prefix,
                                          "originalPath": str(Path(entry.path).absolute()),
                                          "extension": Path(entry.name).suffix.lower() or "无扩展名",
                                          "size": info.st_size, "modified": datetime.fromtimestamp(info.st_mtime, timezone.utc).isoformat(),
                                          "semester": semester, "course": course, "courseId": course_id,
                                          "status": status, "reason": reason})
                    except OSError as exc:
                        warnings.append({"path": relative, "message": str(exc)})
        except OSError as exc:
            warnings.append({"path": prefix or ".", "message": str(exc)})

    walk(root)
    files.sort(key=lambda item: item["path"].casefold())
    folders.sort(key=lambda item: item["path"].casefold())
    return {"root": str(root), "semesters": semesters, "courses": courses, "files": files, "folders": folders,
            "skipped": skipped, "warnings": warnings,
            "scannedAt": datetime.now(timezone.utc).isoformat()}


def make_handler(root, port, database=workbench.DATABASE, inbox=workbench.INBOX):
    cache = {"catalog": None}
    lock = threading.Lock()

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            # 仅允许本机 Host；静态资源按白名单提供，无法用路径读取任意文件。
            if self.headers.get("Host") not in {f"127.0.0.1:{port}", f"localhost:{port}"}:
                self.send_error(403)
                return
            url = urlsplit(self.path)
            if url.path == "/api/platform-preferences":
                self.json_reply(platform_sync.platform_settings())
                return
            if url.path == "/api/sync/status":
                self.json_reply(platform_sync.collector_status())
                return
            if url.path == "/api/catalog":
                try:
                    with lock:
                        if cache["catalog"] is None or url.query == "refresh=1":
                            cache["catalog"] = scan_catalog(root)
                        body = json.dumps(cache["catalog"], ensure_ascii=False).encode("utf-8")
                    self.reply(body, "application/json; charset=utf-8")
                except RuntimeError as exc:
                    self.reply(json.dumps({"error": str(exc)}, ensure_ascii=False).encode("utf-8"),
                               "application/json; charset=utf-8", 503)
                return
            if url.path == "/api/workbench":
                try:
                    task_id = parse_qs(url.query).get("task", [workbench.TASK])[0]
                    with lock:
                        result = workbench.read_board(database, inbox, task_id=task_id)
                    self.json_reply(result)
                except ValueError as exc:
                    self.json_reply({"error": str(exc)}, 400)
                except (OSError, KeyError, StopIteration, sqlite3.Error):
                    self.json_reply({"error": "工作台读取失败，请检查核实记录和工具目录权限"}, 503)
                return
            assets = {"/": ("board.html", "text/html; charset=utf-8"),
                      "/board.js": ("board.js", "text/javascript; charset=utf-8"),
                      "/board.css": ("board.css", "text/css; charset=utf-8"),
                      "/library": ("index.html", "text/html; charset=utf-8"),
                      "/app.js": ("app.js", "text/javascript; charset=utf-8"),
                      "/style.css": ("style.css", "text/css; charset=utf-8")}
            if url.path not in assets:
                self.send_error(404)
                return
            filename, content_type = assets[url.path]
            self.reply((WEB_ROOT / filename).read_bytes(), content_type)

        def json_reply(self, data, status=200):
            self.reply(json.dumps(data, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8", status)

        def do_POST(self):
            if self.path not in ("/api/platform-preferences", "/api/association", "/api/reminder", "/api/package", "/api/inbox/cleanup", "/api/sync/start", "/api/sync/stop", "/api/sync/browser", "/api/sync/request", "/api/sync/course-scope"):
                self.send_error(501)
                return
            host = self.headers.get("Host")
            origin = self.headers.get("Origin", "")
            connector = (self.path == "/api/sync/browser"
                         and self.headers.get("X-Course-Connector") == "1"
                         and (not origin or re.fullmatch(r"chrome-extension://[a-p]{32}", origin)))
            if host not in {f"127.0.0.1:{port}", f"localhost:{port}"} or (not connector and origin != f"http://{host}"):
                self.send_error(403)
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                limit = 2_000_000 if connector else 65536
                if not 0 < length <= limit or self.headers.get_content_type() != "application/json":
                    raise ValueError("请求格式错误")
                data = json.loads(self.rfile.read(length))
                if not isinstance(data, dict):
                    raise ValueError("请求格式错误")
                if self.path == "/api/platform-preferences":
                    if "selected" not in data or data["selected"] is None:
                        raise ValueError("缺少 selected 列表")
                    self.json_reply(platform_sync.platform_settings(data["selected"]))
                    return
                if self.path == "/api/reminder":
                    with lock:
                        workbench.update_reminder(data.get("task"),data.get("dismissed"),data.get("reason",""),database)
                    self.json_reply({"ok":True})
                    return
                if self.path == "/api/inbox/cleanup":
                    with lock:
                        result = workbench.cleanup_inbox(data.get("action"), data.get("path"), database, inbox)
                    self.json_reply(result)
                    return
                if self.path == "/api/package":
                    archive, name = workbench.assignment_zip(data.get("task"), database, inbox)
                    with archive:
                        self.send_response(200)
                        self.send_header("Content-Type", "application/zip")
                        self.send_header("Content-Disposition", "attachment; filename*=UTF-8''" + quote(name))
                        self.send_header("Cache-Control", "no-store")
                        self.end_headers()
                        shutil.copyfileobj(archive, self.wfile)
                    return
                if self.path == "/api/sync/browser":
                    self.json_reply(platform_sync.receive(data))
                    return
                if self.path == "/api/sync/start":
                    self.json_reply(platform_sync.start())
                    return
                if self.path == "/api/sync/request":
                    self.json_reply(platform_sync.request_sweep(data.get("platform")))
                    return
                if self.path == "/api/sync/course-scope":
                    self.json_reply(platform_sync.pin_course(data.get("id"),data.get("keep")))
                    return
                if self.path == "/api/sync/stop":
                    platform_sync.stop()
                    self.json_reply(platform_sync.status())
                    return
                with lock:
                    workbench.update_link(data.get("role"), data.get("path"), data.get("action"), database, inbox,
                                          task_id=data.get("task", workbench.TASK))
                self.json_reply({"ok": True})
            except (ValueError, KeyError, TypeError, OSError) as exc:
                self.json_reply({"error": str(exc)}, 400)
            except sqlite3.Error:
                self.json_reply({"error": "无法保存关联，请检查工具目录的写入权限"}, 503)

        def do_OPTIONS(self):
            origin = self.headers.get("Origin", "")
            if (self.path != "/api/sync/browser"
                    or self.headers.get("Host") != f"127.0.0.1:{port}"
                    or not re.fullmatch(r"chrome-extension://[a-p]{32}", origin)):
                self.send_error(403)
                return
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Allow-Methods", "POST")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Course-Connector")
            self.end_headers()

        def reply(self, body, content_type, status_code=200):
            self.send_response(status_code)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            if self.path == "/api/sync/browser" and re.fullmatch(r"chrome-extension://[a-p]{32}", self.headers.get("Origin", "")):
                self.send_header("Access-Control-Allow-Origin", self.headers["Origin"])
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Content-Security-Policy", "default-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'")
            self.end_headers()
            self.wfile.write(body)

    return Handler


def main():
    parser = argparse.ArgumentParser(description="只读的本地课程文件管理工具")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    try:
        ensure_data_dirs()
    except OSError as exc:
        parser.error(f"无法创建或访问资料目录：{exc}")
    try:
        server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(DEFAULT_ROOT, args.port))
    except OSError as exc:
        parser.exit(1, f"启动失败：{exc}\n可用 python server.py --port 8766 更换端口。\n")
    print(f"课程文件管理工具：http://127.0.0.1:{args.port}", flush=True)
    print(f"只读资料目录：{DEFAULT_ROOT}\n按 Ctrl+C 停止服务。", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
