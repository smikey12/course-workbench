"""作业卡引用原件的路径。SQLite 中只保存关联关系。"""
import hashlib
import os
import sqlite3
import stat
import re
import tempfile
import zipfile
import retention
import cx_sync
import mooc_sync
import pta_sync
import course_scope
import inbox_cleanup
import rain_catalog
from public_settings import INBOX
from collections import defaultdict
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path

BASE = Path(__file__).resolve().parent
DATABASE = BASE / "作业关联.sqlite3"
# 空字符串表示尚未选择作业，供服务路由和首次打开的前端使用。
TASK = ""


def apply_deadline_state(task, now=None):
    task = dict(task)
    if task.get("completionState") == "未完成" and task.get("platformStatus") in course_scope.ACTIONABLE_AFTER_DUE:
        task.update(displayStatus=task["platformStatus"], deadlineState="可继续提交")
        return task
    if not task.get("deadlineAt"):
        return task
    deadline = datetime.fromisoformat(task["deadlineAt"])
    closed = (now or datetime.now(timezone.utc)) >= deadline
    task["deadlineState"] = "已截止" if closed else "进行中"
    completion = task.get("completionState", "待核实")
    if closed and completion == "未完成":
        task["displayStatus"] = "过期未做"
    elif closed and completion == "已完成":
        task["displayStatus"] = "已结束 · 已完成"
    else:
        task["displayStatus"] = task["deadlineState"] + " · " + completion
    return task


def task_record(task_id):
    if not isinstance(task_id, str) or not task_id.strip():
        raise ValueError("请先选择作业")
    for task, snapshot in all_task_records():
        if task["id"] == task_id:
            return task, snapshot
    raise ValueError("作业不存在")


def all_task_records(feeds=None, courses=None, cx=None, history=None, mooc=None, pta=None):
    """只展示当前用户同步到本机的记录，不加载验证样例或预置课程。"""
    records = {}
    import platform_sync
    if cx is None:
        cx = cx_sync.read(platform_sync.DATABASE)
    if feeds is None:
        feeds = platform_sync.feeds()
    if courses is None:
        courses = platform_sync.courses()
    if mooc is None:
        mooc = mooc_sync.read(platform_sync.DATABASE)
    if pta is None:
        pta = pta_sync.read(platform_sync.DATABASE)
    for remote in platform_sync.saved_tasks() + platform_sync.assessment_tasks(feeds, courses) + cx["tasks"] + mooc["tasks"] + pta["tasks"]:
        key = remote["id"]
        previous = records.get(key, ({}, {}))[0]
        task = dict(previous, **remote)
        task.setdefault("teacherAttachments", [])
        task.setdefault("localReportSupported", False)
        task.setdefault("platformStatus", "待核实")
        task.setdefault("platformFilter", "章节作业")
        task.setdefault("deadlineDisplayed", "平台列表未提供")
        task.setdefault("course", "")
        snapshot = {"course": task["course"], "verificationDate": task.get("observedAt", "")}
        if remote.get("listed", True):
            records[key] = (apply_deadline_state(task), snapshot)
        else:
            records.pop(key, None)
    retired = platform_sync.retired_ids()
    if history is None:
        with closing(rain_catalog.open_db(platform_sync.DATABASE)) as conn:
            history = course_scope.history(conn)
    skipped = {item["id"] for item in history if not item["pinned"]}
    return [(record, source) for key, (record, source) in records.items()
            if key not in retired and not retention.expired(record.get("deadlineAt"))
            and record.get("courseId", "") not in skipped]


def connect(database):
    conn = sqlite3.connect(database, timeout=5)
    conn.execute("""CREATE TABLE IF NOT EXISTS links (
        task TEXT NOT NULL, role TEXT NOT NULL, path TEXT COLLATE NOCASE NOT NULL,
        basis TEXT NOT NULL, PRIMARY KEY(task, role, path))""")
    conn.execute("""CREATE TABLE IF NOT EXISTS reminder_preferences (
        task TEXT PRIMARY KEY, reason TEXT NOT NULL, updated TEXT NOT NULL)""")
    inbox_cleanup.setup(conn)
    return conn


def update_reminder(task_id, dismissed, reason="", database=DATABASE):
    if type(dismissed) is not bool:
        raise ValueError("请选择无需提醒或恢复提醒")
    if not isinstance(reason,str) or len(reason)>300:
        raise ValueError("提醒备注最多 300 字")
    task_record(task_id)
    with closing(connect(database)) as conn, conn:
        if dismissed:
            conn.execute("INSERT OR REPLACE INTO reminder_preferences VALUES(?,?,?)",
                         (task_id,reason.strip() or "已自行处理或无需完成",datetime.now(timezone.utc).isoformat()))
        else:
            conn.execute("DELETE FROM reminder_preferences WHERE task=?",(task_id,))


def apply_reminder_preferences(records, database):
    with closing(connect(database)) as conn:
        preferences=dict(conn.execute("SELECT task,reason FROM reminder_preferences"))
    return [(dict(task,reminderDismissed=task["id"] in preferences,
                  reminderReason=preferences.get(task["id"],"")),source) for task,source in records]


def update_link(role, raw_path, action, database=DATABASE, inbox=INBOX, basis="手动指定", task_id=TASK):
    task, _ = task_record(task_id)
    if role == "report" and not task["localReportSupported"]:
        raise ValueError("这项在线作业使用平台作答，请将本地参考文件关联为资料")
    if role not in ("report", "material") or action not in ("link", "unlink"):
        raise ValueError("关联类型或操作无效")
    if not isinstance(raw_path, str) or not raw_path.strip():
        raise ValueError("请填写文件的完整本地路径")
    path = Path(raw_path.strip().strip('"'))
    if not path.is_absolute() or str(path).startswith(("\\\\", "//")):
        raise ValueError("请选择本机磁盘中的绝对路径")
    if action == "link":
        path = path.resolve(strict=True)
        if not path.is_file():
            raise ValueError("请选择文件")
        if role == "report" and path.suffix.lower() not in (".doc", ".docx"):
            raise ValueError("这项作业要求关联 Word 报告")
        if role == "material" and not path.is_relative_to(inbox.resolve()):
            raise ValueError("请从下载收件箱选择资料")
    with closing(connect(database)) as conn, conn:
        if action == "unlink":
            conn.execute("DELETE FROM links WHERE task=? AND role=? AND path=?", (task_id, role, str(path)))
        else:
            if role == "report":
                conn.execute("DELETE FROM links WHERE task=? AND role='report'", (task_id,))
            conn.execute("INSERT OR REPLACE INTO links VALUES (?,?,?,?)", (task_id, role, str(path), basis))
            inbox_cleanup.mark_used(conn, path)


def inbox_files(root, database=None):
    if database is None:
        return _inbox_files(root)
    with closing(connect(database)) as conn, conn:
        return _inbox_files(root, conn)


def _inbox_files(root, conn=None):
    items, warnings = [], []
    if not root.is_dir():
        return [], [f"无法读取下载目录 {root}"]
    linked = {p.casefold() for (p,) in conn.execute("SELECT path FROM links")} if conn else set()
    threshold = inbox_cleanup.cutoff()
    def warn(error):
        warnings.append(f"无法读取 {error.filename}")
    for directory, dirs, files in os.walk(root, onerror=warn):
        dirs[:] = [d for d in dirs if d not in (".git", "node_modules", "__pycache__")
                   and not os.path.islink(Path(directory) / d) and not os.path.isjunction(Path(directory) / d)]
        for filename in files:
            path = Path(directory, filename)
            try:
                info = path.lstat()
                if not stat.S_ISREG(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
                    continue
                archived = path.relative_to(root).parts[0] == inbox_cleanup.FOLDER
                last_used = inbox_cleanup.observe(conn, path, info) if conn else max(info.st_atime, info.st_mtime, info.st_ctime)
                items.append(dict(name=filename, path=str(path), relative=str(path.relative_to(root)),
                                  size=info.st_size, modified=info.st_mtime, duplicates=[],
                                  lastUsed=last_used, precleaned=archived,
                                  cleanupCandidate=not archived and last_used < threshold and str(path).casefold() not in linked))
            except OSError as error:
                warn(error)
    # 不同大小一定不是相同文件。只在大小相同时逐块读取并比较内容摘要。
    sizes = defaultdict(list)
    for item in items:
        sizes[item["size"]].append(item)
    for group in sizes.values():
        if len(group) < 2:
            continue
        hashes = defaultdict(list)
        for item in group:
            try:
                with open(item["path"], "rb") as stream:
                    hashes[hashlib.file_digest(stream, "sha256").hexdigest()].append(item)
            except OSError as error:
                warn(error)
        for twins in hashes.values():
            for item in twins:
                item["duplicates"] = [t["relative"] for t in twins if t is not item]
    if conn:
        inbox_cleanup.finish_scan(conn, items)
    return sorted(items, key=lambda i: (-i["modified"], i["relative"])), warnings


def cleanup_inbox(action, raw_path=None, database=DATABASE, inbox=INBOX):
    if action not in ("move", "restore"):
        raise ValueError("预清理操作无效")
    with closing(connect(database)) as conn, conn:
        if action == "restore":
            if not isinstance(raw_path, str) or not raw_path:
                raise ValueError("请选择要恢复的文件")
            return inbox_cleanup.restore(conn, inbox, raw_path)
        items, warnings = _inbox_files(inbox, conn)
        if warnings:
            raise ValueError("收件箱读取不完整，请先处理：" + "；".join(warnings))
        return inbox_cleanup.move_old(conn, inbox, items)


def assignment_zip(task_id, database=DATABASE, inbox=INBOX):
    task, _ = task_record(task_id)
    with closing(connect(database)) as conn:
        links = list(conn.execute("SELECT role,path FROM links WHERE task=? ORDER BY role,path", (task_id,)))
    if not links:
        raise ValueError("请先关联报告或资料，再打包")
    with closing(connect(database)) as conn, conn:
        for _, location in links:
            if Path(location).is_file():
                inbox_cleanup.mark_used(conn, location)
    archive = tempfile.SpooledTemporaryFile(max_size=8 * 1024**2)
    try:
        remaining = 256 * 1024**2
        used = set()
        with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as bundle:
            for role, location in links:
                path = Path(location)
                resolved = path.resolve(strict=True)
                if resolved != path or not path.is_file():
                    raise ValueError("文件路径已变动，请重新关联：" + path.name)
                if role == "report" and path.suffix.lower() in (".doc", ".docx"):
                    member = Path("我的报告") / path.name
                elif role == "material" and resolved.is_relative_to(inbox.resolve()):
                    member = Path("关联资料") / path.relative_to(inbox.resolve())
                else:
                    raise ValueError("请检查文件关联：" + path.name)
                if member.as_posix().casefold() in used:
                    raise ValueError("资料包内出现同名文件，请检查关联")
                used.add(member.as_posix().casefold())
                with path.open("rb") as source, bundle.open(member.as_posix(), "w") as target:
                    while block := source.read(1024**2):
                        remaining -= len(block)
                        if remaining < 0:
                            raise ValueError("关联文件超过单个资料包的 256 MB 上限")
                        target.write(block)
        archive.seek(0)
        name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", task["title"]).strip(". ")[:100] or "作业"
        return archive, name + ".zip"
    except BaseException:
        archive.close()
        raise


def read_board(database=DATABASE, inbox=INBOX, task_id=TASK):
    import platform_sync
    platform_sync.clean_due()
    feeds, courses = platform_sync.feeds(), platform_sync.courses()
    cx = cx_sync.read(platform_sync.DATABASE)
    mooc = mooc_sync.read(platform_sync.DATABASE)
    pta = pta_sync.read(platform_sync.DATABASE)
    with closing(rain_catalog.open_db(platform_sync.DATABASE)) as conn:
        conn.row_factory = sqlite3.Row
        history = course_scope.history(conn)
        starts = dict(conn.execute("SELECT id,started FROM course_dates"))
    for course in courses + cx["courses"] + mooc["courses"] + pta["courses"]:
        course["started"] = starts.get(course["id"])
    records = apply_reminder_preferences(all_task_records(feeds, courses, cx, history, mooc, pta),database)
    selected = next(((task, source) for task, source in records if task["id"] == task_id), None)
    task, snapshot = selected or ({}, {})
    assignments = []
    for record, source in records:
        assignments.append(dict(id=record["id"], title=record["title"], platform=record["platform"],
                                course=record.get("course", source["course"]),
                                courseId=record.get("courseId", ""),
                                deadline=record["deadlineDisplayed"], deadlineAt=record.get("deadlineAt"), leaf=record.get("leaf"),
                                completion=record.get("completionState", "待核实"),
                                reminderDismissed=record["reminderDismissed"], reminderReason=record["reminderReason"],
                                deadlineState=record.get("deadlineState", ""),
                                verified=record.get("observedAt", source["verificationDate"]),
                                status=record.get("displayStatus", record["platformStatus"])))
    items, warnings = inbox_files(inbox, database)
    with closing(connect(database)) as conn:
        links = [dict(role=r, path=p, basis=b, available=Path(p).is_file())
                 for r, p, b in conn.execute("SELECT role,path,basis FROM links WHERE task=? ORDER BY path", (task_id,))] if task else []
    return dict(task=task, course=snapshot.get("course",""), verified=task.get("observedAt", snapshot.get("verificationDate","")),
                sync=platform_sync.status(), courses=courses + mooc["courses"] + pta["courses"], feeds=feeds, cxCourses=cx["courses"], courseScope=history,
                cxSync={"checked":cx["checked"],"issue":cx["issue"]},
                ptaSync={"checked":pta["checked"],"issue":pta["issue"]},
                moocSync={"checked":mooc["checked"],"issue":mooc["issue"]},
                assignments=assignments, links=links, inbox=str(inbox), files=items, warnings=warnings,
                cleanupFolder=str(inbox / inbox_cleanup.FOLDER),
                scanned=datetime.now(timezone.utc).isoformat())
