"""平台选择持久化；选择与浏览器授权、成功连接分别记录。"""
import json
import sqlite3
from contextlib import closing

KEYS = ("rain", "cx", "mooc", "pta")


def read(path):
    with closing(sqlite3.connect(path, timeout=8)) as conn:
        conn.execute("CREATE TABLE IF NOT EXISTS platform_preferences(id INTEGER PRIMARY KEY CHECK(id=1), selected TEXT NOT NULL)")
        row = conn.execute("SELECT selected FROM platform_preferences WHERE id=1").fetchone()
        if row:
            return {"configured": True, "selected": json.loads(row[0])}
        tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        legacy = any(table in tables and conn.execute(f"SELECT 1 FROM {table} LIMIT 1").fetchone()
                     for table in ("courses", "cx_groups", "mooc_courses", "tasks", "cx_meta", "sync_meta"))
        return {"configured": False, "selected": list(KEYS[:3]) if legacy else []}


def save(path, selected):
    if not isinstance(selected, list) or any(not isinstance(k,str) or k not in KEYS for k in selected) or len(set(selected)) != len(selected):
        raise ValueError("平台选择须为 rain/cx/mooc/pta 组成的不重复列表")
    read(path)
    selected = [k for k in KEYS if k in selected]
    with closing(sqlite3.connect(path, timeout=8)) as conn, conn:
        conn.execute("INSERT OR REPLACE INTO platform_preferences VALUES(1,?)", (json.dumps(selected),))
    return {"configured": True, "selected": selected}
