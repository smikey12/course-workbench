"""接收现有浏览器扩展读取的雨课堂作业元数据。"""
import json
import sqlite3
import threading
import rain_catalog
import retention
import cx_sync
import course_scope
import time
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path

BASE = Path(__file__).resolve().parent
DATABASE = BASE / "平台同步.sqlite3"
LOCK = threading.Lock()
WAITING = "等待浏览器后台检查账号课程。请保持浏览器运行。"
STATE = {"enabled": True, "running": False, "message": WAITING, "lastSuccess": None,
         "scope": "雨课堂课程、章节作业、课堂动态和近期考试。学习通单独读取账号课程与作业列表。"}

# 手动请求只改变下一批读取的优先级，平台请求仍由已登录浏览器中的只读脚本发出。
SWEEPS = {}
CX_ACCESS = None

def request_sweep(platform):
    names = {"all": ("rain","cx"), "rain": ("rain",), "cx": ("cx",)}.get(platform)
    if not names:
        raise ValueError("请选择雨课堂、学习通或两个平台")
    with LOCK:
        if not STATE["enabled"]:
            raise ValueError("同步已暂停，请先在工作台恢复接收")
        stamp = datetime.now(timezone.utc).isoformat()
        for name in names:
            SWEEPS[name] = (stamp, time.monotonic()+600)
    return {"since":stamp}

def sweep_queue(conn, name, result):
    job = SWEEPS.get(name)
    if job and time.monotonic() < job[1]:
        table = "courses" if name == "rain" else "cx_groups"
        batch = 6 if name == "rain" else 12
        result["next"] = [r[0] for r in conn.execute(
            f"SELECT id FROM active_{table} WHERE attempted<? ORDER BY attempted,id LIMIT ?",(job[0],batch))]
        if not result["next"]:
            SWEEPS.pop(name,None)
    return result

def collector_status():
    state = status()
    with closing(rain_catalog.open_db(DATABASE)) as conn:
        cx = dict(conn.execute("SELECT key,value FROM cx_meta"))
        def rows(table):
            return [dict(r) for r in conn.execute(f"SELECT id,name,checked,attempted,note FROM active_{table} ORDER BY name,id")]
        history = course_scope.history(conn)
        def skipped(platform):
            return sum(r["platform"]==platform and not r["pinned"] for r in history)
        return {"enabled":state["enabled"],"rain":{"directory":state["lastSuccess"],"message":state["message"],"courses":rows("courses"),"skipped":skipped("雨课堂")},
                "cx":{"directory":cx.get("checked"),"message":cx.get("issue",""),"access":CX_ACCESS,"courses":rows("cx_groups"),"skipped":skipped("学习通")}}


def pin_course(key, keep):
    if type(keep) is not bool:
        raise ValueError("请选择是否继续同步")
    with LOCK, closing(rain_catalog.open_db(DATABASE)) as conn, conn:
        if not conn.execute("UPDATE course_scope SET pinned=? WHERE id=? AND (reason<>'' OR pinned=1)",(keep,key)).rowcount:
            raise ValueError("未找到历史班级，请刷新工作台")
    return {"ok":True}


def status():
    with LOCK:
        state = dict(STATE)
    if state["running"]:
        age = datetime.now(timezone.utc) - datetime.fromisoformat(state["lastSuccess"])
        if age.total_seconds() > 150:
            state.update(running=False, message="最近未收到后台检查结果。请确认浏览器正在运行，扩展已启用。")
    return state


def saved_tasks():
    if not DATABASE.exists():
        return []
    with closing(sqlite3.connect(DATABASE)) as conn:
        return [json.loads(row[0]) for row in conn.execute("""SELECT record FROM tasks WHERE NOT EXISTS
            (SELECT 1 FROM course_scope s WHERE s.id=json_extract(record,'$.courseId') AND s.reason<>'' AND s.pinned=0)""")]


def courses():
    if not DATABASE.exists():
        return []
    with closing(sqlite3.connect(DATABASE)) as conn:
        if not conn.execute("SELECT 1 FROM sqlite_master WHERE name='courses'").fetchone():
            return []
        conn.row_factory = sqlite3.Row
        outlines = dict(conn.execute("SELECT course,tree FROM outlines WHERE course IN (SELECT id FROM active_courses)"))
        return [dict(row, outline=json.loads(outlines.get(row["id"], "[]")))
                for row in conn.execute("SELECT * FROM active_courses ORDER BY archived,name,section")]


def preference(enabled):
    with closing(rain_catalog.open_db(DATABASE)) as conn, conn:
        conn.execute("INSERT OR REPLACE INTO sync_meta VALUES ('enabled',?)", (str(int(enabled)),))


def feeds():
    if not DATABASE.exists():
        return {}
    with closing(rain_catalog.open_db(DATABASE)) as conn:
        return {r["scope"]: {"checked": r["checked"], "issue": r["issue"], "items": json.loads(r["items"])}
                for r in conn.execute("SELECT * FROM feeds WHERE scope='exams' OR scope IN (SELECT id FROM active_courses)")}


def assessment_tasks(feed_map, course_list):
    rows = []
    for course in course_list:
        scope = course["id"]
        feed = feed_map.get(scope, {})
        for item in feed.get("items", []):
            if item["kind"] not in ("测验", "考试"):
                continue
            completed = item.get("completed")
            state = "待核实" if completed is None else ("已完成" if completed else "未完成")
            due = item.get("due")
            rows.append(dict(id=f"rain-activity-{scope}-{item['id']}", courseId=scope, course=course["name"],
                             platform="雨课堂", title=item["title"], observedAt=feed["checked"],
                             completionState=state, platformStatus=state, platformFilter="课堂动态 · " + item["kind"],
                             deadlineAt=due, deadlineDisplayed=datetime.fromisoformat(due).astimezone(rain_catalog.CHINA).strftime("%Y-%m-%d %H:%M") if due else "动态中未提供",
                             statusBasis="雨课堂个人动态中的作答状态" if completed is not None else "动态清单未提供个人作答状态",
                             url=f"https://www.yuketang.cn/v2/web/studentLog/{scope}"))
    return rows


def restore():
    if DATABASE.exists():
        with closing(rain_catalog.open_db(DATABASE)) as conn, conn:
            values = dict(conn.execute("SELECT key,value FROM sync_meta"))
            for name in ("rain","cx"):
                course_scope.refresh(conn,name,datetime.now(retention.CST))
        STATE.update(lastSuccess=values.get("lastSuccess"))
        if values.get("enabled") == "0":
            STATE.update(enabled=False, message="已暂停接收")


restore()

_last_clean = 0


def clean_due():
    global _last_clean
    with LOCK:
        if time.monotonic() - _last_clean < 20 and _last_clean:
            return
        with closing(rain_catalog.open_db(DATABASE)) as conn, conn:
            retention.clean(conn)
        _last_clean = time.monotonic()


def retired_ids():
    with closing(rain_catalog.open_db(DATABASE)) as conn:
        return {r[0] for r in conn.execute("SELECT id FROM retired")}


def start():
    with LOCK:
        if not STATE["enabled"]:
            preference(True)
            STATE.update(enabled=True, running=False, message=WAITING)
    return status()


def stop():
    with LOCK:
        preference(False)
        STATE.update(enabled=False, running=False, message="已暂停接收。点击「恢复接收」后继续同步。")


def receive(payload):
    global CX_ACCESS
    if not isinstance(payload, dict):
        raise ValueError("同步格式错误")
    action = payload.get("action")
    if action == "check":
        if type(payload.get("cxAccess")) is bool:
            CX_ACCESS = {"allowed":payload["cxAccess"],"at":datetime.now(timezone.utc).isoformat()}
        return {"enabled": status()["enabled"]}
    if action in ("index", "course", "courseIssue", "issue", "feed", "chaoxing"):
        now = datetime.now(timezone.utc).isoformat()
        with LOCK:
            if not STATE["enabled"]:
                raise ValueError("工作台已暂停接收")
            if action == "issue":
                STATE.update(running=False, message=rain_catalog.label(payload.get("message")))
                return {"ok": True}
            with closing(rain_catalog.open_db(DATABASE)) as conn, conn:
                if action == "chaoxing":
                    result = cx_sync.receive(conn,payload,now)
                    return sweep_queue(conn,"cx",result) if "next" in result else result
                if action == "index":
                    result = sweep_queue(conn,"rain",rain_catalog.save_index(conn, payload))
                    result["oldLeaves"] = {}
                    for course, leaf in conn.execute("SELECT course,leaf FROM retired WHERE leaf IS NOT NULL"):
                        if course in result["next"]:
                            result["oldLeaves"].setdefault(course,[]).append(leaf)
                    result["feedCourses"] = [r[0] for r in conn.execute("""SELECT c.id FROM active_courses c
                        LEFT JOIN feeds f ON c.id=f.scope WHERE c.listed=1 AND
                        (f.attempted IS NULL OR julianday('now')-julianday(f.attempted)>=5.0/1440)
                        ORDER BY COALESCE(f.attempted,''),c.archived,c.id LIMIT 3""")]
                    note = "" if payload.get("archiveOk") else "，归档目录待重试"
                    message = f"✓ 已连接 · 同步范围 {result['count']} 个班级{note}。"
                    conn.execute("INSERT OR REPLACE INTO sync_meta VALUES ('lastSuccess',?)", (now,))
                elif action == "feed":
                    rain_catalog.save_feed(conn, payload, now)
                    result = {"ok": True}
                else:
                    rain_catalog.save_course(conn, payload, now)
                    result = {"ok": True}
                if action in ("course", "feed"):
                    retention.clean(conn)
            if action == "index":
                STATE.update(running=True, lastSuccess=now, message=message)
            return result
    raise ValueError("不支持的同步操作，请使用课程连接扩展的结构化同步接口")
