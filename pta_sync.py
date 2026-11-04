"""PTA（拼题 A） 的独立快照。单班成功才替换；失败保留已知成功记录。"""
import hashlib
import json
import re
from contextlib import closing
from datetime import datetime

import course_scope
import retention

PLATFORM = "PTA（拼题 A）"


def install(conn):
    conn.execute("CREATE TABLE IF NOT EXISTS pta_meta(key TEXT PRIMARY KEY,value TEXT)")
    conn.execute("""CREATE TABLE IF NOT EXISTS pta_courses(
        id TEXT PRIMARY KEY,name TEXT NOT NULL,section TEXT DEFAULT '',term TEXT DEFAULT '',
        listed INTEGER DEFAULT 1,checked TEXT DEFAULT '',attempted TEXT DEFAULT '',note TEXT DEFAULT '排队检查作业')""")
    conn.execute("CREATE TABLE IF NOT EXISTS pta_work(id TEXT PRIMARY KEY,course TEXT NOT NULL,due TEXT,body TEXT NOT NULL)")


def _text(value, limit=500):
    if not isinstance(value, str) or len(value) > limit:
        raise ValueError("PTA 名称或状态格式无效")
    return value.strip()


def _id(value):
    if type(value) is int:
        value = str(value)
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", value):
        raise ValueError("PTA 班级或作业编号无效")
    return value


def course_key(value):
    return "pta-" + _id(value)


def _task(item, raw_course, name, now):
    if not isinstance(item, dict):
        raise ValueError("PTA 作业格式无效")
    raw_task = _id(item.get("id"))
    title = _text(item.get("title"))
    if not title:
        raise ValueError("PTA 作业标题缺失")
    status = _text(item.get("status") or "待核实")
    completion = item.get("completion")
    if completion is True:
        completion = "已完成"
    elif completion is False:
        completion = "未完成"
    elif completion in (None, ""):
        completion = "待核实"
    elif completion not in ("已完成", "未完成", "待核实"):
        raise ValueError("PTA 完成状态无效")
    if completion == "待核实":
        if status in ("已提交", "已完成", "已批阅", "待批阅", "已评分"):
            completion = "已完成"
        elif status in ("未提交", "未完成", "待提交", "过期未做") or status in course_scope.ACTIONABLE_AFTER_DUE:
            completion = "未完成"
    due = item.get("deadlineAt") or None
    if due is not None:
        if not isinstance(due, str) or len(due) > 80:
            raise ValueError("PTA 截止时间无效")
        try:
            parsed = datetime.fromisoformat(due)
            if parsed.tzinfo is None:
                raise ValueError("missing timezone")
            due = parsed.isoformat()
        except ValueError as error:
            raise ValueError("PTA 截止时间无效或缺少时区") from error
    digest = hashlib.sha256(json.dumps([raw_course, raw_task], ensure_ascii=False).encode()).hexdigest()
    row = dict(id="pta-task-" + digest, courseId=course_key(raw_course), course=name, title=title,
               platform=PLATFORM, platformStatus=status, completionState=completion,
               platformFilter="PTA 班级作业列表", statusBasis="PTA 个人作业列表 · " + status,
               observedAt=now, deadlineAt=due, localReportSupported=True,
               deadlineDisplayed=datetime.fromisoformat(due).astimezone(retention.CST).strftime("%Y-%m-%d %H:%M") if due else "平台列表未提供")
    return raw_task, row


def receive(conn, payload, now):
    rows = payload.get("courses")
    active_only = payload.get("scope") == "active"
    issue = _text(payload.get("issue") or "", 2000)
    if rows is None and issue:
        conn.executemany("INSERT OR REPLACE INTO pta_meta VALUES(?,?)", [("issue",issue),("attempted",now)])
        return {"ok": True, "count": 0, "failed": 1}
    if not isinstance(rows, list) or len(rows) > 3000:
        raise ValueError("PTA 课程目录无效")
    if not conn.in_transaction:
        conn.execute("BEGIN")
    failures, success, seen = [], [], set()
    keys = []
    for item in rows:
        try:
            keys.append(course_key(item.get("id")) if isinstance(item, dict) else None)
        except ValueError:
            keys.append(None)
    duplicates = {key for key in keys if key is not None and keys.count(key) > 1}
    for item, key in zip(rows, keys):
        if key is None or key in duplicates:
            failures.append("班级编号无效或重复")
            continue
        seen.add(key)
        conn.execute("SAVEPOINT pta_course")
        try:
            name = _text(item.get("name"))
            if not name:
                raise ValueError("PTA 课程名称缺失")
            section, term = _text(item.get("section") or ""), _text(item.get("term") or "")
            if type(item.get("checked")) is not bool:
                raise ValueError("PTA 班级缺少本轮读取结果")
            conn.execute("""INSERT INTO pta_courses(id,name,section,term,attempted) VALUES(?,?,?,?,?)
                ON CONFLICT(id) DO UPDATE SET listed=1,name=excluded.name,section=excluded.section,
                term=excluded.term,attempted=excluded.attempted""", (key,name,section,term,now))
            partial = item.get("partial", False)
            if type(partial) is not bool:
                raise ValueError("PTA 部分清单标记无效")
            if item["checked"] or partial:
                tasks = item.get("tasks")
                if not isinstance(tasks, list) or len(tasks) > 5000:
                    raise ValueError("PTA 作业清单无效")
                prepared, task_ids = [], set()
                for task in tasks:
                    raw_id, record = _task(task, _id(item["id"]), name, now)
                    record["platformFilter"] = section or "PTA 本人题集元数据"
                    record["statusBasis"] = (section or "PTA 本人题集元数据") + " · " + record["platformStatus"]
                    if section == "PTA 个人题集概览":
                        record["platformFilter"] = "PTA 个人题集概览"
                        record["statusBasis"] = "PTA 个人题集概览中的可见元数据 · " + record["platformStatus"]
                    previous = conn.execute("SELECT body FROM pta_work WHERE id=?", (record["id"],)).fetchone()
                    old = json.loads(previous[0]) if previous else {}
                    # A missing date is not evidence that the platform removed its deadline.
                    if not record.get("deadlineAt") and old.get("deadlineAt"):
                        record["deadlineAt"] = old["deadlineAt"]
                        record["deadlineDisplayed"] = old.get("deadlineDisplayed") or datetime.fromisoformat(old["deadlineAt"]).astimezone(retention.CST).strftime("%Y-%m-%d %H:%M")
                    proof = task.get("evidence")
                    if proof is not None:
                        if not isinstance(proof, dict) or proof.get("kind") != "problem_id_states" or proof.get("course") != str(item["id"]):
                            raise ValueError("PTA 本人状态证据的题集归属无效")
                        required, states = proof.get("requiredProblemIds"), proof.get("problemStates")
                        if not isinstance(required, list) or not 0 < len(required) <= 5000 or any(not isinstance(p,str) or not re.fullmatch(r"[1-9][0-9]{0,24}",p) for p in required) or len(set(required)) != len(required):
                            raise ValueError("PTA 全量题目 ID 证据无效")
                        if not isinstance(states,list) or len(states) != len(required) or any(not isinstance(p,dict) or not isinstance(p.get("id"),str) for p in states) or len({p["id"] for p in states}) != len(states) or {p["id"] for p in states} != set(required):
                            raise ValueError("PTA 本人状态未与全量题目 ID 逐项匹配")
                        statuses = [p.get("status") for p in states]
                        if any(s not in ("PROBLEM_ACCEPTED","PROBLEM_NO_ANSWER","PROBLEM_WRONG_ANSWER") for s in statuses):
                            raise ValueError("PTA 本人状态仍在评判或未识别")
                        expected = "已完成" if all(s == "PROBLEM_ACCEPTED" for s in statuses) else "未完成"
                        if record["completionState"] != expected:
                            raise ValueError("PTA 完成状态与题目 ID 证据矛盾")
                        record.update(statusEvidence="problem_id_states",submissionEvidence=proof,statusVerifiedAt=now)
                    elif active_only:
                        record.update(completionState="待核实",platformStatus="待核实（本轮未取得完整本人题目状态证据）")
                    if proof is None and not active_only and record["completionState"] == "已完成" and record["platformStatus"].startswith("本人全部"):
                        record["statusEvidence"] = "accepted_all"
                    if record["completionState"] == "待核实" and (old.get("statusEvidence") in ("accepted_all","problem_id_states") or old.get("completionState") == "已完成" and old.get("platformStatus", "").startswith("本人全部")):
                        record.update(completionState=old["completionState"],statusEvidence=old.get("statusEvidence","accepted_all"),
                            observedAt=old["observedAt"],directoryObservedAt=now,
                            platformStatus=old["completionState"]+"（沿用上次核实结果，本轮详情待核实）",
                            statusBasis="沿用 "+old["observedAt"]+" 的个人状态证据；本轮只更新目录，未重新核实提交")
                        for field in ("submissionEvidence","statusVerifiedAt"):
                            if field in old:
                                record[field] = old[field]
                    if raw_id in task_ids:
                        raise ValueError("PTA 作业编号重复，保留上次清单")
                    task_ids.add(raw_id)
                    if not retention.expired(record["deadlineAt"], datetime.fromisoformat(now)):
                        prepared.append(record)
                if item["checked"]:
                    conn.execute("DELETE FROM pta_work WHERE course=?", (key,))
                # 部分范围只合并读到的记录，绝不把没有读到的旧作业删除。
                conn.executemany("INSERT OR REPLACE INTO pta_work VALUES(?,?,?,?)", [
                    (r["id"],key,r["deadlineAt"],json.dumps(r,ensure_ascii=False)) for r in prepared])
            if not item["checked"]:
                why = _text(item.get("issue") or "本轮作业列表读取失败", 2000)
                prefix = "部分读取 · " if partial else "待重试 · "
                conn.execute("UPDATE pta_courses SET note=? WHERE id=?", (prefix + why,key))
                failures.append(name + "：" + why)
            else:
                warning = _text(item.get("issue") or "", 2000)
                note = f"{len(prepared)} 项保留作业" + (" · " + warning if warning else "")
                conn.execute("UPDATE pta_courses SET checked=?,note=? WHERE id=?", (now,note,key))
                success.append(key)
            conn.execute("RELEASE pta_course")
        except (ValueError, TypeError, KeyError) as error:
            conn.execute("ROLLBACK TO pta_course")
            conn.execute("RELEASE pta_course")
            why = str(error)
            failures.append(why)
            conn.execute("UPDATE pta_courses SET attempted=?,note=? WHERE id=?", (now,"待重试 · "+why,key))
    if issue:
        failures.insert(0,issue)
    if not failures and not active_only:
        # 只有整份目录及各班成功时，才把未出现的班级收起；部分失败不得清空缓存。
        conn.execute("UPDATE pta_courses SET listed=0")
        conn.executemany("UPDATE pta_courses SET listed=1 WHERE id=?", [(key,) for key in seen])
        conn.execute("INSERT OR REPLACE INTO pta_meta VALUES('checked',?)", (now,))
    if active_only and not failures:
        conn.executemany("INSERT OR REPLACE INTO pta_meta VALUES(?,?)", [("activeChecked",now),("activeIds",json.dumps(sorted(seen))),("readerBuild",_text(payload.get("readerBuild") or "",100))])
    summary = "；".join(failures[:10])
    if len(failures) > 10:
        summary += f"；另有 {len(failures)-10} 项失败"
    warning = _text(payload.get("warning") or "", 2000)
    if warning:
        summary = (summary + "；" if summary else "") + warning
    conn.executemany("INSERT OR REPLACE INTO pta_meta VALUES(?,?)", [("issue",summary),("attempted",now)])
    course_scope.refresh(conn,"pta",datetime.fromisoformat(now))
    return {"ok": True, "count":len(success), "failed":len(failures)}


def read(path):
    import rain_catalog
    with closing(rain_catalog.open_db(path)) as conn:
        meta = dict(conn.execute("SELECT key,value FROM pta_meta"))
        courses = [dict(row,platform=PLATFORM,archived=0,outline=[])
                   for row in conn.execute("SELECT * FROM active_pta_courses ORDER BY name,id")]
        tasks = [json.loads(row[0]) for row in conn.execute(
            "SELECT body FROM pta_work w JOIN active_pta_courses c ON c.id=w.course")]
    return dict(courses=courses,tasks=tasks,checked=meta.get("checked",""),
                attempted=meta.get("attempted",""),issue=meta.get("issue",""))
