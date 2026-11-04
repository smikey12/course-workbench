"""雨课堂账号目录和章节作业的本地快照，只存课程与作业元数据。"""
import json
import re
import sqlite3
from datetime import date
import retention
import course_scope
import mooc_sync
from datetime import datetime, timedelta, timezone

CHINA = timezone(timedelta(hours=8))


def classroom_id(value):
    if not isinstance(value, str) or not re.fullmatch(r"[1-9][0-9]{0,19}", value):
        raise ValueError("班级或作业编号无效")
    return value


def label(value, limit=300):
    if not isinstance(value, str) or len(value) > limit:
        raise ValueError("课程或作业名称无效")
    return value.strip()


def open_db(path):
    conn = sqlite3.connect(path, timeout=8)
    conn.row_factory = sqlite3.Row
    conn.execute("CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, record TEXT NOT NULL)")
    conn.execute("CREATE TABLE IF NOT EXISTS retired (id TEXT PRIMARY KEY, course TEXT, leaf TEXT, title TEXT)")
    conn.execute("CREATE TABLE IF NOT EXISTS cx_meta(key TEXT PRIMARY KEY,value TEXT)")
    conn.execute("""CREATE TABLE IF NOT EXISTS cx_groups(id TEXT PRIMARY KEY,clazz TEXT,name TEXT,listed INTEGER DEFAULT 1,
                 note TEXT DEFAULT '排队检查作业',checked TEXT DEFAULT '',attempted TEXT DEFAULT '')""")
    conn.execute("CREATE TABLE IF NOT EXISTS cx_work(id TEXT PRIMARY KEY,course TEXT,due TEXT,body TEXT)")
    conn.execute("""CREATE TABLE IF NOT EXISTS courses (
        id TEXT PRIMARY KEY, name TEXT, section TEXT, archived INTEGER, listed INTEGER DEFAULT 1,
        attempted TEXT DEFAULT '', checked TEXT DEFAULT '', note TEXT DEFAULT '排队检查中')""")
    conn.execute("CREATE TABLE IF NOT EXISTS sync_meta (key TEXT PRIMARY KEY, value TEXT)")
    conn.execute("CREATE TABLE IF NOT EXISTS outlines (course TEXT PRIMARY KEY, tree TEXT NOT NULL)")
    conn.execute("CREATE TABLE IF NOT EXISTS course_dates (id TEXT PRIMARY KEY, started TEXT NOT NULL)")
    conn.execute("""CREATE TABLE IF NOT EXISTS feeds (
        scope TEXT PRIMARY KEY, checked TEXT DEFAULT '', attempted TEXT, issue TEXT, items TEXT DEFAULT '[]')""")
    mooc_sync.install(conn)
    course_scope.install(conn)
    return conn


def platform_day(value):
    if re.fullmatch(r"\d{10}|\d{13}",str(value)):
        seconds = int(value) / (1000 if len(str(value)) == 13 else 1)
        if 946684800 <= seconds < 4102444800:
            value = datetime.fromtimestamp(seconds, CHINA).date().isoformat()
    elif isinstance(value,str) and re.match(r"^20\d\d-\d\d-\d\d[ T]",value):
        value = value[:10]
    if isinstance(value, str) and re.fullmatch(r"20\d\d-\d\d-\d\d", value):
        try:
            date.fromisoformat(value)
        except ValueError:
            return
        return value


def save_dates(conn, key, row):
    started = platform_day(row.get("started"))
    if started:
        conn.execute("INSERT OR REPLACE INTO course_dates VALUES (?,?)", (key,started))
    if "ended" in row:
        ended = platform_day(row["ended"])
        if ended or row["ended"] in (None,"",0,"0"):
            course_scope.remember_end(conn,key,ended)


def save_feed(conn, payload, now):
    scope = payload.get("scope")
    if scope != "exams":
        classroom_id(scope)
        if not conn.execute("SELECT 1 FROM courses WHERE id=? AND listed=1", (scope,)).fetchone():
            raise ValueError("班级不在账号目录内")
    if "issue" in payload:
        conn.execute("""INSERT INTO feeds(scope,attempted,issue) VALUES(?,?,?)
            ON CONFLICT(scope) DO UPDATE SET attempted=excluded.attempted,issue=excluded.issue""",
            (scope, now, label(payload["issue"]) or "本次读取失败"))
        return
    items = payload.get("items")
    if not isinstance(items, list) or len(items) > 2000:
        raise ValueError("活动清单不完整")
    clean = []
    for item in items:
        row = {"id": classroom_id(item.get("id")), "kind": label(item.get("kind"), 30),
               "title": label(item.get("title")), "course": classroom_id(item["course"]) if item.get("course") else ""}
        if not row["title"] or scope != "exams" and row["course"] != scope:
            raise ValueError("活动名称或所属班级无效")
        for field in ("due", "published"):
            stamp = item.get(field)
            if stamp:
                dt = datetime.fromisoformat(stamp)
                if not dt.tzinfo:
                    raise ValueError("时间缺少时区")
                row[field] = dt.isoformat()
        if row["kind"] in ("测验", "考试") and isinstance(item.get("completed"), bool):
            row["completed"] = item["completed"]
        clean.append(row)
    conn.execute("""INSERT INTO feeds VALUES(?,?,?,'',?) ON CONFLICT(scope) DO UPDATE SET
        checked=excluded.checked,attempted=excluded.attempted,issue='',items=excluded.items""",
        (scope, now, now, json.dumps(clean, ensure_ascii=False)))


def save_index(conn, payload, now=None):
    items = payload.get("courses")
    if not isinstance(items, list) or len(items) > 2000:
        raise ValueError("课程目录无效")
    if payload.get("archiveOk") is True:
        conn.execute("UPDATE courses SET listed=0")
    else:
        conn.execute("UPDATE courses SET listed=0 WHERE archived=0")
    for row in items:
        key, name = classroom_id(row["id"]), label(row["name"])
        save_dates(conn, key, row)
        if not name:
            raise ValueError("课程名称为空")
        conn.execute("""INSERT INTO courses (id,name,section,archived) VALUES (?,?,?,?)
            ON CONFLICT(id) DO UPDATE SET name=excluded.name, section=excluded.section,
            archived=excluded.archived, listed=1""",
            (key, name, label(row.get("section", "")), row.get("archived") is True))
    course_scope.refresh(conn,"rain",now or datetime.now(CHINA))
    ids = [row[0] for row in conn.execute("SELECT id FROM active_courses ORDER BY attempted,archived,id")]
    return {"count": len(ids), "next": ids[:6]}


def save_course(conn, payload, now):
    key = classroom_id(payload.get("course"))
    course = conn.execute("SELECT name FROM courses WHERE id=? AND listed=1", (key,)).fetchone()
    if not course:
        raise ValueError("课程尚未进入目录")
    if payload.get("action") == "courseIssue":
        note = label(payload.get("message", "课程读取失败"))
        conn.execute("UPDATE courses SET attempted=?,note=? WHERE id=?", (now, note, key))
        return
    items = payload.get("tasks")
    if not isinstance(items, list) or len(items) > 2000:
        raise ValueError("作业列表无效")
    existing = {r["id"]: json.loads(r["record"]) for r in conn.execute("SELECT * FROM tasks")}
    by_leaf = {r["leaf"]: rid for rid, r in existing.items() if r.get("courseId") == key and "leaf" in r}
    seen = set()
    for item in items:
        leaf, title = classroom_id(item.get("leaf")), label(item.get("title"))
        if not title or leaf in seen:
            raise ValueError("作业名称为空或编号重复")
        seen.add(leaf)
        old_record = conn.execute("SELECT id FROM retired WHERE course=? AND leaf=?", (key,leaf)).fetchone()
        if old_record:
            if "deadline" not in item or retention.expired(item.get("deadline"), datetime.fromisoformat(now)):
                continue
            conn.execute("DELETE FROM retired WHERE id=?", (old_record[0],))
        rid = by_leaf.get(leaf, f"yuketang-{key}-{leaf}")
        if old_record:
            rid = old_record[0]
        row = dict(existing.get(rid, {}), id=rid, courseId=key, course=course[0], platform="雨课堂",
                   title=title, leaf=leaf, observedAt=now, listed=True)
        row["url"] = f"https://www.yuketang.cn/ai-workspace/lms-graph/{key}/exercise/{leaf}?is_chapter=1"
        if item.get("node") and re.fullmatch(r"[0-9]{1,20}", str(item["node"])):
            row["url"] += "&node_id=" + item["node"]
        if "deadline" in item:
            due = item["deadline"]
            if due:
                dt = datetime.fromisoformat(due)
                if not dt.tzinfo:
                    raise ValueError("截止时间缺少时区")
                row.update(deadlineAt=dt.isoformat(), deadlineDisplayed=dt.astimezone(CHINA).strftime("%Y-%m-%d %H:%M"))
            else:
                row.update(deadlineAt=None, deadlineDisplayed="平台未设置截止时间")
        if isinstance(item.get("completed"), bool):
            row["completionState"] = "已完成" if item["completed"] else "未完成"
            row["platformStatus"] = row["completionState"]
            row["statusBasis"] = "雨课堂个人作业进度记录"
        progress = item.get("progress")
        if isinstance(progress, list) and len(progress) == 2 and all(type(n) is int and n >= 0 for n in progress):
            row["progressDisplayed"] = f"{progress[0]}/{progress[1]} 题"
        conn.execute("INSERT OR REPLACE INTO tasks VALUES (?,?)", (rid, json.dumps(row, ensure_ascii=False)))
        existing[rid] = row
    for rid, row in existing.items():
        if row.get("courseId") == key and row.get("leaf") not in seen and row.get("listed", True):
            row["listed"] = False
            conn.execute("UPDATE tasks SET record=? WHERE id=?", (json.dumps(row, ensure_ascii=False), rid))
    missing = int(payload.get("missingDetails", 0))
    if isinstance(payload.get("outline"), list):
        conn.execute("INSERT OR REPLACE INTO outlines VALUES (?,?)",
                     (key, json.dumps(payload["outline"], ensure_ascii=False)))
    note = f"{len(items)} 项章节作业" + (f"，{missing} 项详情待重试" if missing else "")
    if payload.get("scheduleIssue"):
        note += " · " + label(payload["scheduleIssue"])
    conn.execute("UPDATE courses SET attempted=?,checked=?,note=? WHERE id=?", (now, now, note, key))
