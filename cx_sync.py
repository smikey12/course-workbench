"""学习通班级按编号区分。仅在整份班级作业列表读取成功后替换本班数据。"""
import json
from contextlib import closing
from datetime import datetime
import rain_catalog
import retention
import course_scope

def read(path):
    with closing(rain_catalog.open_db(path)) as conn:
        meta = dict(conn.execute("SELECT key,value FROM cx_meta"))
        courses = [dict(r,platform="学习通",listed=True,section="班级 "+r["clazz"]) for r in conn.execute(
            "SELECT * FROM active_cx_groups ORDER BY name,clazz")]
        tasks = [json.loads(r[0]) for r in conn.execute("SELECT body FROM cx_work JOIN active_cx_groups g ON g.id=cx_work.course")]
    return dict(courses=courses,tasks=tasks,checked=meta.get("checked",""),issue=meta.get("issue",""))


def receive(conn, payload, now):
    if "issue" in payload and "course" not in payload:
        conn.execute("INSERT OR REPLACE INTO cx_meta VALUES('issue',?)",(rain_catalog.label(payload["issue"]),))
        return {}
    if "courses" in payload:
        rows=payload["courses"]
        if not isinstance(rows,list) or not 0<len(rows)<=3000:
            raise ValueError("学习通账号课程目录为空或无效")
        conn.execute("UPDATE cx_groups SET listed=0")
        for item in rows:
            cid,clazz=[rain_catalog.classroom_id(item[k]) for k in ("cid","clazz")]
            key=f"cx-{cid}-{clazz}"
            rain_catalog.save_dates(conn,key,item)
            name=rain_catalog.label(item["name"])
            if not name:
                raise ValueError("课程名称缺失")
            conn.execute("""INSERT INTO cx_groups(id,clazz,name) VALUES(?,?,?) ON CONFLICT(id)
                         DO UPDATE SET listed=1,name=excluded.name""",(key,clazz,name))
        conn.executemany("INSERT OR REPLACE INTO cx_meta VALUES(?,?)",[("checked",now),("issue","")])
        course_scope.refresh(conn,"cx",datetime.fromisoformat(now))
        queue=conn.execute("SELECT id FROM active_cx_groups ORDER BY attempted,id LIMIT 12")
        return {"next":[r[0] for r in queue]}
    course=conn.execute("SELECT * FROM cx_groups WHERE id=? AND listed=1",(payload.get("course"),)).fetchone()
    if not course:
        raise ValueError("未识别班级")
    key=course["id"]
    if "issue" in payload:
        conn.execute("UPDATE cx_groups SET note=?,attempted=? WHERE id=?",("待重试 · "+rain_catalog.label(payload["issue"]),now,key))
        return {}
    rows=payload.get("tasks")
    if not isinstance(rows,list) or len(rows)>5000:
        raise ValueError("学习通作业清单无效")
    scan=payload.get("scan")
    evidence=""
    if scan is not None:
        pages=scan.get("pages") if isinstance(scan,dict) else None
        if (not isinstance(pages,list) or not 1<=len(pages)<=100
                or type(scan.get("totalPages")) is not int or scan["totalPages"]!=len(pages)
                or any(type(n) is not int or n<0 for n in pages)
                or (len(pages)>1 and any(n==0 for n in pages)) or sum(pages)!=len(rows)):
            raise ValueError("学习通分页核验记录不完整，保留上次清单")
        evidence=f" · 本轮完整读取 {len(pages)} 页 {len(rows)} 项（逐页 "+"/".join(map(str,pages))+"）"
    conn.execute("DELETE FROM cx_work WHERE course=?",(key,))
    count=0
    for item in rows:
        wid=rain_catalog.classroom_id(item["wid"])
        kind=item.get("kind","work")
        if kind not in ("work","activity"):
            raise ValueError("未知的作业类型")
        title=rain_catalog.label(item["title"])
        if not title:
            raise ValueError("作业标题缺失")
        rid=f"{key}-{kind}-{wid}"
        status=rain_catalog.label(item["status"])
        state="待核实"
        if status in ("未提交","待提交","未交","待完成","未完成","待做","未做","过期未做") or status in course_scope.ACTIONABLE_AFTER_DUE:
            state="未完成"
        if status in ("待批阅","已批阅","已提交","已完成","已交","已评分"):
            state="已完成"
        due=item.get("due")
        if due and not datetime.fromisoformat(due).tzinfo:
            raise ValueError("截止时间缺少时区")
        if retention.expired(due,datetime.fromisoformat(now)):
            continue
        row=dict(id=rid,courseId=key,course=course["name"],title=title,platform="学习通",platformStatus=status or "待核实",
                 completionState=state, platformFilter="班级作业列表",statusBasis="学习通班级作业列表 · "+status,
                 observedAt=now,localReportSupported=True,deadlineAt=due)
        when=rain_catalog.label(item.get("when",""))
        if due:
            row["deadlineDisplayed"]=datetime.fromisoformat(due).astimezone(retention.CST).strftime("%Y-%m-%d %H:%M")
        elif when:
            row["deadlineDisplayed"]=when+"（读取时）"
        conn.execute("INSERT INTO cx_work VALUES(?,?,?,?)",(rid,key,due,json.dumps(row,ensure_ascii=False)))
        count+=1
    conn.execute("UPDATE cx_groups SET note=?,attempted=?,checked=? WHERE id=?",(f"{count} 项保留作业"+evidence,now,now,key))
    return {}
