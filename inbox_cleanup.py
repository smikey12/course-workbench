"""下载件预清理：保留原目录，可恢复；不提供删除操作。"""
import calendar
import os
from datetime import datetime, timezone, timedelta
from pathlib import Path

FOLDER = "预清理"
LOCAL = timezone(timedelta(hours=8))


def setup(conn):
    conn.execute("""CREATE TABLE IF NOT EXISTS inbox_usage (
        path TEXT COLLATE NOCASE PRIMARY KEY, last_used REAL NOT NULL,
        observed_access REAL NOT NULL)""")
    conn.execute("""CREATE TABLE IF NOT EXISTS inbox_moves (
        target TEXT COLLATE NOCASE PRIMARY KEY, original TEXT NOT NULL,
        moved REAL NOT NULL)""")


def cutoff(now=None):
    now = (now or datetime.now(LOCAL)).astimezone(LOCAL)
    month = now.year * 12 + now.month - 1 - 6
    year, month = divmod(month, 12)
    month += 1
    return now.replace(year=year, month=month,
                       day=min(now.day, calendar.monthrange(year, month)[1])).timestamp()


def observe(conn, path, info):
    previous = conn.execute("SELECT last_used,observed_access FROM inbox_usage WHERE path=?",
                            (str(path),)).fetchone()
    last_used = max(info.st_mtime, info.st_ctime)
    if previous:
        last_used = max(last_used, previous[0])
        if info.st_atime != previous[1]:
            last_used = max(last_used, info.st_atime)
    else:
        last_used = max(last_used, info.st_atime)
    conn.execute("INSERT OR REPLACE INTO inbox_usage VALUES (?,?,?)",
                 (str(path), last_used, info.st_atime))
    return last_used


def mark_used(conn, path):
    path = Path(path)
    info = path.stat()
    conn.execute("INSERT OR REPLACE INTO inbox_usage VALUES (?,?,?)",
                 (str(path), datetime.now().timestamp(), info.st_atime))


def finish_scan(conn, items):
    # 重复文件比对由程序读取，不能被当成用户重新使用了资料。
    for item in items:
        try:
            accessed = Path(item["path"]).stat().st_atime
        except OSError:
            continue
        conn.execute("UPDATE inbox_usage SET observed_access=? WHERE path=?",
                     (accessed, item["path"]))


def safe_path(root, path):
    root = root.resolve(strict=True)
    path = Path(path)
    if not path.is_absolute() or not path.is_relative_to(root) or path == root:
        raise ValueError("文件必须位于下载收件箱中")
    for segment in (path, *path.parents):
        if segment == root:
            break
        if segment.is_symlink() or segment.is_junction():
            raise ValueError("预清理不处理快捷链接或目录联接")
    if path.resolve() != path:
        raise ValueError("文件路径已变动")
    return path


def move_old(conn, root, items, now=None):
    root = root.resolve(strict=True)
    destination = safe_path(root, root / FOLDER)
    destination.mkdir(exist_ok=True)
    linked = {p.casefold() for (p,) in conn.execute("SELECT path FROM links")}
    moved, warnings = 0, []
    for item in items:
        if not item.get("cleanupCandidate") or item["path"].casefold() in linked:
            continue
        source = Path(item["path"])
        try:
            source = safe_path(root, source)
            info = source.stat()
            if observe(conn, source, info) >= cutoff(now):
                continue
            target = safe_path(root, destination / source.relative_to(root))
            if target.exists():
                raise ValueError("预清理中已有同路径文件，请先查看或恢复")
            target.parent.mkdir(parents=True, exist_ok=True)
            # 先持久化原路径，进程中断后仍能恢复已经移入的文件。
            conn.execute("INSERT OR REPLACE INTO inbox_moves VALUES (?,?,?)",
                         (str(target), str(source), datetime.now().timestamp()))
            conn.commit()
            os.rename(source, target)
            moved += 1
        except (OSError, ValueError) as exc:
            warnings.append(f"{source.name}：{exc}")
    return dict(moved=moved, warnings=warnings, folder=str(destination))


def restore(conn, root, raw_path):
    root = root.resolve(strict=True)
    target = safe_path(root, Path(raw_path))
    if not target.is_relative_to(root / FOLDER):
        raise ValueError("请选择预清理中的文件")
    record = conn.execute("SELECT original FROM inbox_moves WHERE target=?", (str(target),)).fetchone()
    if not record:
        raise ValueError("该文件没有原路径记录，请在资源管理器中手动移出")
    if conn.execute("SELECT 1 FROM links WHERE path=?", (str(target),)).fetchone():
        raise ValueError("该文件已关联作业，请先解除关联再恢复，原件会保留")
    original = safe_path(root, Path(record[0]))
    if original.exists():
        raise ValueError("原位置已有同名文件，恢复不会覆盖它，请先处理同名文件")
    original.parent.mkdir(parents=True, exist_ok=True)
    os.rename(target, original)
    mark_used(conn, original)
    conn.execute("DELETE FROM inbox_moves WHERE target=?", (str(target),))
    return dict(restored=str(original))
