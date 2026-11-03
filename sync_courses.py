"""命令行入口。浏览器脚本负责向平台发请求，这里安排读取、核验本轮结果。"""
import argparse
import json
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

BASE = Path(__file__).resolve().parent
URL = "http://127.0.0.1:8765"
NAMES = {"rain": "雨课堂", "cx": "学习通"}


def api(path, body=None):
    headers = {"Origin": URL, "Content-Type": "application/json"}
    req = Request(URL + "/api/sync/" + path, headers=headers,
                  data=None if body is None else json.dumps(body).encode())
    try:
        with urlopen(req, timeout=8) as res:
            return json.load(res)
    except HTTPError as exc:
        if exc.code in (404, 501):
            raise ValueError("本机服务不支持课程同步命令，请重启新版课藏。") from exc
        try:
            msg = json.loads(exc.read()).get("error")
        except (ValueError, AttributeError):
            msg = None
        raise ValueError(msg or f"课藏返回 HTTP {exc.code}") from exc


def ensure_receiver():
    try:
        return api("status")
    except URLError as exc:
        if not isinstance(exc.reason, ConnectionRefusedError):
            raise
    # 只在本机服务确实没有运行时启动，不打开网页或新建浏览器登录会话。
    subprocess.Popen([sys.executable, "-B", str(BASE / "server.py")], cwd=BASE,
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                     creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    for _ in range(20):
        time.sleep(.25)
        try:
            return api("status")
        except URLError:
            pass
    raise ValueError("本机课藏没有启动成功。")


def fresh(stamp, since):
    return bool(stamp) and datetime.fromisoformat(stamp) >= since


def summary(info, since):
    courses = info["courses"]
    ok = sum(fresh(c["checked"], since) for c in courses)
    failed = [c for c in courses if fresh(c["attempted"], since) and not fresh(c["checked"], since)]
    indexed = fresh(info["directory"], since)
    return indexed, ok, failed, len(courses)


def main():
    parser = argparse.ArgumentParser(description="使用已安装课藏扩展的浏览器已登录账号，同步课藏的课程和班级作业")
    parser.add_argument("--platform", choices=["all","rain","cx"], default="all", help="all 两个平台；rain 雨课堂；cx 学习通")
    parser.add_argument("--status", action="store_true", help="只查看最近的读取记录")
    parser.add_argument("--list", action="store_true", help="列出课程名、班级编号和最近作业检查结果")
    parser.add_argument("--timeout", type=int, default=360, help="最多等待秒数，默认 360")
    args = parser.parse_args()
    if args.timeout <= 0:
        parser.error("--timeout 必须大于零")
    state = ensure_receiver()
    names = list(NAMES) if args.platform == "all" else [args.platform]
    for name in names:
        info = state[name]
        stamp = info["directory"]
        date = datetime.fromisoformat(stamp).astimezone().strftime("%Y-%m-%d %H:%M:%S") if stamp else "尚未读取"
        courses = info["courses"]
        if info.get("skipped"):
            print(f"{NAMES[name]}已跳过 {info['skipped']} 个历史班级。")
        print(f"{NAMES[name]}：上次目录 {date}；有作业检查记录的班级 {sum(bool(c['checked']) for c in courses)}/{len(courses)}。")
        if info["message"]:
            print("  " + info["message"])
    def list_courses(snapshot, platforms):
        for name in platforms:
            print(f"\n{NAMES[name]}课程目录：")
            for course in snapshot[name]["courses"]:
                print(f"  {course['name']} [{course['id']}] · {course['note'] or '尚无作业检查结果'}")
    if args.status:
        if args.list:
            list_courses(state, names)
        return 0
    since = datetime.fromisoformat(api("request", {"platform":args.platform})["since"])
    print("已安排检查同步范围内的班级。请保持已安装课藏扩展的浏览器运行。", flush=True)
    started = time.monotonic()
    last = {}
    problems = set()
    while names:
        state = api("status")
        if not state["enabled"]:
            print("接收已暂停，本次同步未完成。")
            return 2
        elapsed = time.monotonic()-started
        for name in names[:]:
            info = state[name]
            indexed, ok, failed, total = summary(info, since)
            line = f"{NAMES[name]}：本轮" + ("已读取目录" if indexed else "等待读取目录") + f"；作业列表成功 {ok}/{total}，失败 {len(failed)}。"
            if last.get(name) != line:
                print(line, flush=True)
                last[name] = line
            if indexed and ok+len(failed) == total:
                if failed:
                    problems.add(name)
                    for c in failed:
                        print("  "+c["name"]+"："+c["note"])
                names.remove(name)
                continue
            access = info.get("access") or {}
            denied = access.get("allowed") is False and fresh(access.get("at"), since)
            if denied or elapsed >= args.timeout or (not indexed and elapsed >= 100):
                help_text = "确认已安装课藏扩展的浏览器已运行、「课藏」扩展已启用，并检查平台登录。"
                if name == "cx":
                    help_text += " 在扩展中点击「允许读取学习通课程与作业」。"
                print(f"{NAMES[name]}：" + ("扩展尚未获准读取。" if denied else "等待本轮数据超时。") + help_text)
                if info["message"]:
                    print("  "+info["message"])
                problems.add(name)
                names.remove(name)
        if names:
            time.sleep(min(3, max(.1, args.timeout-elapsed)))
    if args.list:
        list_courses(state,list(NAMES) if args.platform == "all" else [args.platform])
    return 2 if problems else 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValueError, OSError) as error:
        print("同步未完成："+str(error), file=sys.stderr)
        raise SystemExit(1)
