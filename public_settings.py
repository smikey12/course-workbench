"""公开版本地目录配置；相对环境变量路径以工具目录为基准。"""
import os
from pathlib import Path

BASE = Path(__file__).resolve().parent


def _directory(variable, default):
    value = os.environ.get(variable, "").strip()
    path = Path(os.path.expandvars(value)).expanduser() if value else default
    return (path if path.is_absolute() else BASE / path).resolve()


COURSE_ROOT = _directory("KECANG_COURSES_ROOT", BASE / "data" / "courses")
INBOX = _directory("KECANG_INBOX", BASE / "data" / "inbox")


def ensure_data_dirs():
    """首次启动时创建空目录，不移动或改写已有课程文件。"""
    for directory in (COURSE_ROOT, INBOX):
        directory.mkdir(parents=True, exist_ok=True)
