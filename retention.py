"""以平台明确给出的截止时刻为准，北京时间满一个自然月清理。"""
import calendar
import json
import re
from datetime import datetime, timedelta, timezone

CST = timezone(timedelta(hours=8))


def expired(value, now=None):
    if not value:
        return False
    try:
        due = datetime.fromisoformat(value)
        if not due.tzinfo:
            return False
        due = due.astimezone(CST)
        year, month = due.year + (due.month == 12), due.month % 12 + 1
        end = due.replace(year=year, month=month, day=min(due.day, calendar.monthrange(year, month)[1]))
        return (now or datetime.now(CST)) >= end
    except (TypeError, ValueError, OverflowError):
        return False


def clean(conn, now=None):
    for rid, course, due in conn.execute("SELECT id,course,due FROM cx_work WHERE due IS NOT NULL").fetchall():
        if expired(due,now):
            conn.execute("DELETE FROM cx_work WHERE id=?",(rid,))
            conn.execute("""UPDATE cx_groups SET note=(SELECT count(*) FROM cx_work WHERE course=?) || ' 项保留作业'
                         WHERE id=? AND note LIKE '%项保留作业'""",(course,course))
    # 核心记录删除后，仅保留识别旧快照、目录引用和后续延期所需的键。
    for rid, course, leaf, title, due in conn.execute("""SELECT id,json_extract(record,'$.courseId'),
            json_extract(record,'$.leaf'),json_extract(record,'$.title'),json_extract(record,'$.deadlineAt')
            FROM tasks WHERE json_extract(record,'$.deadlineAt') IS NOT NULL""").fetchall():
        if expired(due, now):
            conn.execute("INSERT OR REPLACE INTO retired VALUES(?,?,?,?)", (rid,course,leaf,title))
            conn.execute("DELETE FROM tasks WHERE id=?", (rid,))
    retired = list(conn.execute("SELECT course,leaf,title FROM retired"))
    by_course = {}
    for course, leaf, title in retired:
        leaves, names = by_course.setdefault(course, (set(), set()))
        leaves.add(leaf)
        names.add(title)
    def without_old(nodes, leaves):
        result = []
        for item in nodes:
            if item.get("type") == 6 and item.get("leaf") in leaves:
                continue
            if "children" in item:
                item["children"] = without_old(item["children"], leaves)
            result.append(item)
        return result
    for course, (leaves, names) in by_course.items():
        row = conn.execute("SELECT tree FROM outlines WHERE course=?", (course,)).fetchone()
        if row:
            original = json.loads(row[0])
            tree = without_old(json.loads(row[0]), leaves)
            if tree != original:
                conn.execute("UPDATE outlines SET tree=? WHERE course=?", (json.dumps(tree,ensure_ascii=False),course))
        row = conn.execute("SELECT note FROM courses WHERE id=?", (course,)).fetchone()
        if row and re.match(r"^\d+ 项章节作业", row[0]):
            count = conn.execute("""SELECT count(*) FROM tasks WHERE json_extract(record,'$.courseId')=?
                AND json_extract(record,'$.listed')=1""",(course,)).fetchone()[0]
            note = re.sub(r"^\d+ 项章节作业", f"{count} 项章节作业", row[0])
            if note != row[0]:
                conn.execute("UPDATE courses SET note=? WHERE id=?", (note,course))
    for scope, raw in conn.execute("SELECT scope,items FROM feeds").fetchall():
        items = json.loads(raw)
        def keep(item):
            if item.get("kind") in ("考试","测验","章节考试","章节作业") and expired(item.get("due"),now):
                return False
            if item.get("kind") == "章节作业" and item.get("title") in by_course.get(scope,((),()))[1]:
                return bool(conn.execute("""SELECT 1 FROM tasks WHERE json_extract(record,'$.courseId')=?
                    AND json_extract(record,'$.title')=? AND json_extract(record,'$.listed')=1""",(scope,item["title"])).fetchone())
            return True
        remaining = [item for item in items if keep(item)]
        if len(remaining) != len(items):
            conn.execute("UPDATE feeds SET items=? WHERE scope=?", (json.dumps(remaining,ensure_ascii=False),scope))
