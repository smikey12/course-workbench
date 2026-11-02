"""按班级决定下次是否进入作业检查队列。账号目录始终可以更新班级范围。"""
import json
import re
from datetime import date, datetime, time

import retention

ACTIONABLE_AFTER_DUE = {"可补交", "待补交", "允许补交", "可补做", "待补做", "待重做", "被打回", "已打回", "打回重做"}


def install(conn):
    conn.execute("""CREATE TABLE IF NOT EXISTS course_scope (
        id TEXT PRIMARY KEY, ended TEXT, reason TEXT NOT NULL DEFAULT '', pinned INTEGER NOT NULL DEFAULT 0)""")
    for table in ("courses", "cx_groups"):
        conn.execute(f"""CREATE VIEW IF NOT EXISTS active_{table} AS SELECT c.* FROM {table} c
            WHERE c.listed=1 AND NOT EXISTS (SELECT 1 FROM course_scope s
                WHERE s.id=c.id AND s.reason<>'' AND s.pinned=0)""")


def remember_end(conn, key, day):
    conn.execute("""INSERT INTO course_scope(id,ended) VALUES(?,?)
        ON CONFLICT(id) DO UPDATE SET ended=excluded.ended""", (key,day))


def old_enough(day, now):
    end = datetime.combine(day,time.max,tzinfo=retention.CST)
    return retention.expired(end.isoformat(),now)


def has_time_left(task, now):
    duration = re.fullmatch(r"剩余\s*(?:(\d+)\s*天\s*)?(?:(\d+)\s*小时\s*)?(?:(\d+)\s*分钟\s*)?(?:（读取时）)?",
                            task.get("deadlineDisplayed") or "")
    if duration and any(duration.groups()) and task.get("observedAt"):
        days, hours, minutes = (int(part or 0) for part in duration.groups())
        elapsed = now - datetime.fromisoformat(task["observedAt"])
        return (days*24*60 + hours*60 + minutes)*60 > elapsed.total_seconds()
    return False


def reason(course, tasks, now):
    # 已知近期作业（含延长截止时间）优先于历史学期。
    for task in tasks:
        if task.get("deadlineAt") and not retention.expired(task["deadlineAt"],now):
            return ""
        if task.get("platformStatus") in ACTIONABLE_AFTER_DUE or has_time_left(task,now):
            return ""
    if course["ended"]:
        return "结课已满一个月" if old_enough(date.fromisoformat(course["ended"]),now) else ""
    if not course["checked"] or course["checked"] != course["attempted"] or "待重试" in course["note"]:
        return ""
    if any(task.get("completionState") != "已完成" for task in tasks):
        return ""
    # “2025级”是年级。只有明确的春、秋字样才能推定所属学期。
    match = re.search(r"(?<!\d)(20\d\d|\d\d)年?\s*([春秋])", course["section"]+" "+course["name"])
    if match:
        year = int(match[1][-2:])+2000
        last = date(year,8,31) if match[2]=="春" else date(year+1,1,31)
        if course["started"] and date.fromisoformat(course["started"]) > last:
            return ""
        return "旧学期，未发现待办" if old_enough(last,now) else ""
    if course["started"]:
        year = date.fromisoformat(course["started"]).year
        if old_enough(date(year+1,1,31),now):
            return f"{year} 年开课，未发现待办"
    return ""


def refresh(conn, platform, now):
    table = "courses" if platform == "rain" else "cx_groups"
    section = "c.section" if platform == "rain" else "''"
    rows = conn.execute(f"""SELECT c.id,c.name,{section} AS section,c.checked,c.attempted,c.note,d.started,s.ended
        FROM {table} c LEFT JOIN course_dates d USING(id) LEFT JOIN course_scope s USING(id) WHERE c.listed=1""")
    sql = ("SELECT json_extract(record,'$.courseId'),record FROM tasks WHERE COALESCE(json_extract(record,'$.listed'),1)"
           if platform == "rain" else "SELECT course,body FROM cx_work")
    grouped = {}
    for key, raw in conn.execute(sql):
        grouped.setdefault(key,[]).append(json.loads(raw))
    if platform == "rain":
        for scope, raw in conn.execute("SELECT scope,items FROM feeds"):
            for event in json.loads(raw):
                if event.get("kind") in ("考试","测验") and (event.get("due") or event.get("completed") is False):
                    key = event.get("course") or scope
                    grouped.setdefault(key,[]).append({"deadlineAt":event.get("due"),"completionState":
                        "已完成" if event.get("completed") or retention.expired(event.get("due"),now) else "未完成"})
    for row in rows.fetchall():
        why = reason(row,grouped.get(row["id"],[]),now)
        conn.execute("""INSERT INTO course_scope(id,reason) VALUES(?,?)
            ON CONFLICT(id) DO UPDATE SET reason=excluded.reason WHERE reason<>excluded.reason""",(row["id"],why))


def history(conn):
    return [dict(r) for r in conn.execute("""SELECT c.*,s.reason,s.pinned FROM
        (SELECT id,name,'雨课堂' AS platform FROM courses WHERE listed=1
         UNION ALL SELECT id,name,'学习通' FROM cx_groups WHERE listed=1) c
        JOIN course_scope s USING(id) WHERE s.reason<>'' OR s.pinned=1 ORDER BY platform,name,id""")]
