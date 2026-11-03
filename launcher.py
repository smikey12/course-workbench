"""公开版启动与更新确认；服务在独立子进程中运行。"""
import argparse
from contextlib import contextmanager
import ctypes
import hashlib
import http.client
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import threading
import time

BASE = Path(__file__).resolve().parent
HOST = "127.0.0.1"
DEFAULT_PORT = 8765
IDENTITY = hashlib.sha256(str(BASE).casefold().encode()).hexdigest()
CONTROL_HEADER = "X-Kecang-Launcher"


def notify(message, error=False):
    if os.name == "nt":
        ctypes.windll.user32.MessageBoxW(None, str(message), "课藏启动提示", 0x10 if error else 0x40)
    else:
        print(message, file=sys.stderr if error else sys.stdout)


def ask_update(info):
    message = (f"发现课藏新版本 {info['version']}。是否现在更新？\n\n"
               "更新期间会短暂重启工作台，已有课程记录和个人配置会保留。\n"
               "选择“否”可继续使用当前版本。")
    if os.name != "nt":
        return False
    # 默认选“否”，避免回车误触发更新。
    return ctypes.windll.user32.MessageBoxW(None, message, "课藏有可用更新", 0x4 | 0x20 | 0x100) == 6


def url(port):
    return f"http://{HOST}:{port}/"


def open_browser(port):
    os.startfile(url(port))


def state_file(port):
    return BASE / "data" / f".launcher-{port}.json"


def read_state(port):
    try:
        value = json.loads(state_file(port).read_text(encoding="utf-8"))
        if value.get("identity") == IDENTITY and isinstance(value.get("token"), str):
            return value
    except (OSError, ValueError, AttributeError):
        pass
    return None


def control(port, action, state):
    connection = http.client.HTTPConnection(HOST, port, timeout=2)
    try:
        connection.request("POST" if action == "stop" else "GET", "/api/launcher/" + action,
                           headers={CONTROL_HEADER: state["token"], "Content-Length": "0"})
        response = connection.getresponse()
        return response.status == 200 and json.loads(response.read(4096)).get("identity") == IDENTITY
    except (OSError, ValueError, http.client.HTTPException):
        return False
    finally:
        connection.close()


def workbench_is_running(port):
    connection = http.client.HTTPConnection(HOST, port, timeout=1)
    try:
        connection.request("GET", "/")
        response = connection.getresponse()
        return response.status == 200 and "<title>课藏 · 作业工作台</title>".encode() in response.read(4096)
    except (OSError, http.client.HTTPException):
        return False
    finally:
        connection.close()


@contextmanager
def startup_lock(timeout=120):
    """覆盖检查、确认、替换和重启；并发打开时不在更新中途启动服务。"""
    import msvcrt
    path = BASE / "data" / ".startup.lock"
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+b") as stream:
        if stream.tell() == 0:
            stream.write(b"0")
            stream.flush()
        deadline = time.monotonic() + timeout
        while True:
            stream.seek(0)
            try:
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
                break
            except OSError:
                if time.monotonic() >= deadline:
                    raise RuntimeError("另一个课藏启动入口正在检查或安装更新，请稍后重新打开。")
                time.sleep(0.2)
        try:
            yield
        finally:
            stream.seek(0)
            msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)


def ensure_service(port):
    if workbench_is_running(port):
        return
    env = os.environ.copy()
    env["KECANG_LAUNCH_TOKEN"] = secrets.token_urlsafe(32)
    process = subprocess.Popen([sys.executable, "-B", str(BASE / "launcher.py"), "--serve", "--port", str(port)],
                               cwd=BASE, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    for _ in range(80):
        if workbench_is_running(port):
            return
        if process.poll() is not None:
            break
        time.sleep(0.1)
    raise RuntimeError(f"无法启动课藏，请检查本机端口 {port} 是否被其他程序占用，以及本地目录是否可访问。")


def wait_for_service_exit(pid):
    """监听端口关闭后，请求线程仍可能活着；等待真正退出才替换代码。"""
    from ctypes import wintypes
    if not isinstance(pid, int) or pid <= 0 or pid == os.getpid():
        return False
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel.WaitForSingleObject.restype = wintypes.DWORD
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.CloseHandle.restype = wintypes.BOOL
    handle = kernel.OpenProcess(0x00100000, False, pid)  # SYNCHRONIZE，不取得终止权限。
    if not handle:
        return ctypes.get_last_error() == 87  # 进程已经退出。
    try:
        return kernel.WaitForSingleObject(handle, 8000) == 0
    finally:
        kernel.CloseHandle(handle)


def stop_owned_service(port):
    if not workbench_is_running(port):
        return True
    state = read_state(port)
    if not state or not control(port, "identity", state) or not control(port, "stop", state):
        return False
    if not wait_for_service_exit(state.get("pid")):
        return False
    for _ in range(80):
        with socket.socket() as probe:
            probe.settimeout(0.1)
            if probe.connect_ex((HOST, port)) != 0:
                return True
        time.sleep(0.1)
    return False


def offer_update(port):
    # 服务和浏览器已打开，离线、仓库未配置或检查失败都不阻断使用。
    try:
        import updater
        info = updater.check_update()
    except Exception:
        return
    if not info or not isinstance(info, dict) or not info.get("version") or not ask_update(info):
        return
    if not stop_owned_service(port):
        # 停止请求超时也可能已经关闭监听端口；保证原工作台仍可继续使用。
        ensure_service(port)
        notify("当前工作台由旧版入口或其他目录运行，未进行更新。\n请先关闭该后台，再从本目录重新打开课藏。")
        return
    result = None
    failure = None
    try:
        result = updater.apply_update(info)
        if not isinstance(result, dict) or result.get("status") != "updated":
            raise RuntimeError("更新器未确认更新完成，已尝试恢复工作台。")
    except Exception as error:
        failure = error
    finally:
        if failure and getattr(failure, "recovery_required", False):
            notify(f"更新恢复尚未完成，已暂停启动以保留备份：\n{failure}\n请保留更新备份并重新打开启动入口进行恢复。", error=True)
            return
        # 不在当前进程导入 server；新进程才能载入更新后或回滚后的全部代码。
        try:
            ensure_service(port)
        except Exception as error:
            notify(f"更新后无法重新启动工作台：{error}\n请关闭此提示后重新双击启动入口。", error=True)
            return
    if failure:
        notify(f"更新未完成，已重新启动工作台：\n{failure}", error=True)
    else:
        open_browser(port)
        notify(result.get("message") or f"已更新到 {result.get('version', info['version'])}，工作台已重新启动。")


def serve(port):
    # 仅服务子进程导入后端，防止更新后的启动器复用旧 Python 模块。
    from http.server import ThreadingHTTPServer
    from public_settings import ensure_data_dirs
    from server import DEFAULT_ROOT, make_handler
    token = os.environ.get("KECANG_LAUNCH_TOKEN")
    if not token:
        raise RuntimeError("请使用启动入口打开课藏。")
    ensure_data_dirs()
    parent = make_handler(DEFAULT_ROOT, port)

    class Handler(parent):
        def authorized(self):
            return (self.headers.get("Host") in {f"{HOST}:{port}", f"localhost:{port}"}
                    and secrets.compare_digest(self.headers.get(CONTROL_HEADER, ""), token))

        def do_GET(self):
            if self.path == "/api/launcher/identity":
                self.json_reply({"identity": IDENTITY}, 200 if self.authorized() else 403)
            else:
                super().do_GET()

        def do_POST(self):
            if self.path == "/api/launcher/stop":
                if not self.authorized():
                    self.json_reply({"error": "无权停止此后台"}, 403)
                    return
                self.json_reply({"identity": IDENTITY})
                threading.Thread(target=self.server.shutdown, daemon=True).start()
            else:
                super().do_POST()

    class Service(ThreadingHTTPServer):
        allow_reuse_address = False

        def server_bind(self):
            if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
                self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            super().server_bind()

    path = state_file(port)
    with Service((HOST, port), Handler) as service:
        state = {"identity": IDENTITY, "token": token, "pid": os.getpid()}
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(f".tmp-{os.getpid()}")
        temporary.write_text(json.dumps(state), encoding="utf-8")
        temporary.replace(path)
        try:
            service.serve_forever()
        finally:
            if read_state(port) == state:
                path.unlink(missing_ok=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description="打开课藏并在后台检查更新")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--serve", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    if not 1 <= args.port <= 65535:
        parser.error("端口应在 1 到 65535 之间")
    if sys.stderr is None:
        sys.stderr = open(os.devnull, "w")
    try:
        if args.serve:
            serve(args.port)
        else:
            with startup_lock():
                # 恢复未完成的文件事务后才能启动后端；恢复异常由外层提示并终止。
                import updater
                updater.recover_update()
                ensure_service(args.port)
                open_browser(args.port)
                checker = threading.Thread(target=offer_update, args=(args.port,), name="课藏更新检查")
                checker.start()
                checker.join()
        return 0
    except Exception as error:
        notify(str(error), error=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
