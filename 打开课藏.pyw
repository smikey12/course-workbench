"""桌面快捷方式入口，由 pythonw 在后台运行。"""
import ctypes
import http.client
import os
import socket
import sys
from http.server import ThreadingHTTPServer

from server import DEFAULT_ROOT, make_handler
from public_settings import ensure_data_dirs

HOST = "127.0.0.1"
PORT = 8765
URL = f"http://{HOST}:{PORT}/"


def workbench_is_running():
    connection = http.client.HTTPConnection(HOST, PORT, timeout=2)
    try:
        connection.request("GET", "/")
        response = connection.getresponse()
        return response.status == 200 and "<title>课藏 · 作业工作台</title>".encode() in response.read(4096)
    except (OSError, http.client.HTTPException):
        return False
    finally:
        connection.close()


class BackgroundServer(ThreadingHTTPServer):
    allow_reuse_address = False

    def server_bind(self):
        self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def open_workbench():
    ensure_data_dirs()
    # 先占用端口。连续双击时，只会有一个进程成功启动服务。
    try:
        service = BackgroundServer((HOST, PORT), make_handler(DEFAULT_ROOT, PORT))
    except OSError as error:
        if workbench_is_running():
            os.startfile(URL)
            return
        raise RuntimeError(f"无法启动课藏。请检查本机端口 {PORT} 是否被其他程序占用。\n{error}") from error
    with service:
        os.startfile(URL)
        service.serve_forever()


if __name__ == "__main__":
    # pythonw 没有命令窗口，HTTP 请求日志仍需要一个可写的输出流。
    if sys.stderr is None:
        sys.stderr = open(os.devnull, "w")
    try:
        open_workbench()
    except Exception as error:
        ctypes.windll.user32.MessageBoxW(None, str(error), "课藏启动提示", 0x10)
