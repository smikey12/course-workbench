"""从固定 GitHub Release 安全更新应用文件；调用方必须先停止本目录服务。"""
import ast
import contextlib
import hashlib
import json
import os
import re
import shutil
import stat
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

from prepare_release import FILES

BASE = Path(__file__).resolve().parent
REPOSITORY = "smikey12/course-workbench"
ARCHIVE = "course-workbench.zip"
CHECKSUM = "course-workbench.sha256"
MAX_DOWNLOAD = 32 * 1024 * 1024
MAX_EXPANDED = 128 * 1024 * 1024
STATE = ".kecang-update"


class UpdateError(RuntimeError):
    """可直接向用户显示的更新错误；恢复未完成时禁止启动服务。"""

    def __init__(self, message, *, recovery_required=False):
        super().__init__(message)
        self.recovery_required = recovery_required


def _version(value):
    if not isinstance(value, str) or not re.fullmatch(r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)", value):
        raise UpdateError("版本号格式无效，必须为三个非负整数。")
    return tuple(map(int, value.split(".")))


def current_version(root=None):
    try:
        value = (Path(root or BASE) / "VERSION").read_text(encoding="utf-8").strip()
        _version(value)
        return value
    except OSError as error:
        raise UpdateError("无法读取本地 VERSION 版本文件。") from error


class _HTTPSRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        parsed = urllib.parse.urlsplit(newurl)
        if parsed.scheme != "https" or parsed.hostname not in {
            "github.com", "api.github.com", "release-assets.githubusercontent.com",
            "objects.githubusercontent.com"} or parsed.username or parsed.password or parsed.port not in (None, 443):
            raise UpdateError("更新下载发生了不受信任的跳转。")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _fetch(url, limit):
    request = urllib.request.Request(url, headers={"User-Agent": "Kecang-Updater", "Accept": "application/vnd.github+json"})
    try:
        with urllib.request.build_opener(_HTTPSRedirect()).open(request, timeout=25) as response:
            data = response.read(limit + 1)
            if len(data) > limit:
                raise UpdateError("更新文件超过允许大小。")
            return data
    except (OSError, ValueError, urllib.error.URLError) as error:
        raise UpdateError("无法从官方 GitHub Release 下载更新，请稍后重试。") from error


def _release():
    try:
        result = json.loads(_fetch(f"https://api.github.com/repos/{REPOSITORY}/releases/latest", 1024 * 1024))
        if not isinstance(result, dict) or result.get("draft") or result.get("prerelease"):
            raise UpdateError("官方最新发布不是稳定版本。")
        tag = result["tag_name"]
        if not isinstance(tag, str) or not tag.startswith("v"):
            raise UpdateError("Release 标签格式无效。")
        version = tag[1:]
        _version(version)
        urls = {}
        for name in (ARCHIVE, CHECKSUM):
            assets = [asset for asset in result["assets"] if asset.get("name") == name]
            if len(assets) != 1 or assets[0].get("state") != "uploaded":
                raise UpdateError("官方 Release 缺少唯一且完整的更新附件。")
            url = assets[0]["browser_download_url"]
            expected = f"https://github.com/{REPOSITORY}/releases/download/{tag}/{name}"
            if url != expected:
                raise UpdateError("更新附件地址与官方仓库或版本不匹配。")
            urls[name] = url
        return {"version": version, "current_version": current_version(),
                "release_url": f"https://github.com/{REPOSITORY}/releases/tag/{tag}",
                "archive_url": urls[ARCHIVE], "checksum_url": urls[CHECKSUM]}
    except (KeyError, TypeError, ValueError, AttributeError) as error:
        raise UpdateError("官方 Release 数据格式无效。") from error


def check_update():
    """返回稳定新版本信息，无新版本返回 None；网络和格式错误抛 UpdateError。"""
    info = _release()
    return info if _version(info["version"]) > _version(info["current_version"]) else None


def _names():
    names = tuple(FILES)
    if len(names) != len(set(name.casefold() for name in names)) or "VERSION" not in names or "updater.py" not in names:
        raise UpdateError("本地应用白名单无效。")
    for name in names:
        parts = name.split("/")
        if (not name or "\\" in name or ":" in name or any(p in ("", ".", "..") or p.endswith((".", " ")) for p in parts)
                or parts[0].casefold() in ("data", ".git", "release")
                or name.lower().endswith((".sqlite3", ".db", ".log"))):
            raise UpdateError("应用白名单包含不安全路径。")
    return names


def _safe(root, name):
    target = root / name
    chain = [root] + [root / parent for parent in reversed(target.relative_to(root).parents)] + [target]
    for path in chain:
        if path.is_symlink() or (path.exists() and getattr(path, "is_junction", lambda: False)()):
            raise UpdateError("更新路径包含链接或目录联接，已拒绝覆盖。")
        if path.exists() and getattr(path.stat(), "st_file_attributes", 0) & 0x400:
            raise UpdateError("更新路径包含 Windows 重解析点。")
    if target.exists() and not target.is_file():
        raise UpdateError("应用文件位置被目录占用。")
    return target


@contextlib.contextmanager
def _locked(root):
    lock = _safe(root, STATE + ".lock")
    with lock.open("a+b") as handle:
        try:
            if os.fstat(handle.fileno()).st_size == 0:
                handle.write(b"0")
                handle.flush()
            handle.seek(0)
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            raise UpdateError("另一个更新任务正在运行。") from error
        try:
            yield
        finally:
            handle.seek(0)
            if os.name == "nt":
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def _unpack(archive, destination, version):
    names = _names()
    try:
        with zipfile.ZipFile(archive) as bundle:
            entries = bundle.infolist()
            if len(entries) != len(names) or {item.filename for item in entries} != set(names):
                raise UpdateError("更新包文件与本机应用白名单不一致。")
            if sum(item.file_size for item in entries) > MAX_EXPANDED:
                raise UpdateError("更新包展开后超过允许大小。")
            for item in entries:
                mode = item.external_attr >> 16
                if item.is_dir() or item.flag_bits & 1 or (stat.S_IFMT(mode) not in (0, stat.S_IFREG)):
                    raise UpdateError("更新包包含目录、链接或加密文件。")
                target = destination / item.filename
                target.parent.mkdir(parents=True, exist_ok=True)
                with bundle.open(item) as source, target.open("wb") as output:
                    shutil.copyfileobj(source, output)
                if target.suffix in (".py", ".pyw"):
                    ast.parse(target.read_text(encoding="utf-8-sig"), filename=item.filename)
                elif target.suffix == ".json":
                    json.loads(target.read_text(encoding="utf-8-sig"))
            if current_version(destination) != version:
                raise UpdateError("更新包内 VERSION 与官方 Release 不一致。")
    except (OSError, ValueError, SyntaxError, zipfile.BadZipFile, RuntimeError, NotImplementedError) as error:
        if isinstance(error, UpdateError):
            raise
        raise UpdateError("更新包损坏或无法安全解压。") from error


def _write_journal(state, record):
    temporary = state / "journal.tmp"
    with temporary.open("w", encoding="utf-8") as handle:
        json.dump(record, handle, ensure_ascii=False)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, state / "journal.json")


def _rollback(root, state, record):
    names = _names()
    for item in reversed(record["changes"]):
        name = item["name"]
        if name not in names or not isinstance(item["existed"], bool):
            raise UpdateError("更新恢复记录包含异常文件。")
        target = _safe(root, name)
        backup = _safe(state / "backup", name)
        if backup.exists():
            os.replace(backup, target)
        elif not item["existed"] and target.exists():
            target.unlink()


def _recover(root):
    state = root / STATE
    try:
        _safe(root, STATE + "/journal.json")
        if not state.exists():
            return False
        journal = state / "journal.json"
        if journal.exists():
            record = json.loads(journal.read_text(encoding="utf-8"))
            if record["status"] not in ("committed", "installing") or not isinstance(record["changes"], list):
                raise ValueError("invalid journal")
            names = _names()
            seen = set()
            for item in record["changes"]:
                if item["name"] not in names or item["name"] in seen or not isinstance(item["existed"], bool):
                    raise ValueError("invalid recovery path")
                seen.add(item["name"])
            if record["status"] == "installing":
                _rollback(root, state, record)
        elif (state / "backup").exists():
            raise ValueError("missing journal with existing backup")
        shutil.rmtree(state)
        return True
    except (OSError, ValueError, KeyError, TypeError, UpdateError) as error:
        raise UpdateError("更新恢复失败，请保留 .kecang-update 备份并停止启动服务。", recovery_required=True) from error


def recover_update():
    """服务启动前可调用：恢复上次中断的事务；不启动或停止任何服务。"""
    try:
        with _locked(BASE):
            return _recover(BASE)
    except OSError as error:
        raise UpdateError("无法恢复更新备份，请关闭占用应用文件的程序。", recovery_required=True) from error


def _install(root, archive, version):
    """仅接受已校验摘要的包；在持有更新锁且服务已停时调用。"""
    if _version(version) <= _version(current_version(root)):
        raise UpdateError("拒绝安装相同版本或降级版本。")
    state = root / STATE
    if state.exists():
        raise UpdateError("存在未完成的更新，请先执行 recover_update()。")
    state.mkdir()
    record = {"status": "installing", "changes": []}
    try:
        staged = state / "new"
        staged.mkdir()
        _unpack(archive, staged, version)
        names = sorted(_names(), key=lambda name: name == "VERSION")
        for name in names:
            _safe(root, name)
        _write_journal(state, record)
        for name in names:
            target = _safe(root, name)
            backup = state / "backup" / name
            target.parent.mkdir(parents=True, exist_ok=True)
            backup.parent.mkdir(parents=True, exist_ok=True)
            record["changes"].append({"name": name, "existed": target.exists()})
            _write_journal(state, record)
            if target.exists():
                os.replace(target, backup)
            os.replace(staged / name, target)
        record["status"] = "committed"
        _write_journal(state, record)
    except BaseException as error:
        try:
            _rollback(root, state, record)
            shutil.rmtree(state)
        except BaseException as rollback_error:
            raise UpdateError("更新失败且回滚未完成，请保留 .kecang-update 备份，暂勿启动服务。", recovery_required=True) from rollback_error
        if isinstance(error, (KeyboardInterrupt, SystemExit, UpdateError)):
            raise
        raise UpdateError("更新替换失败，已恢复原版本。") from error
    # 已提交版本不因清理旧备份失败而回滚；下次恢复只清理 committed 状态。
    try:
        shutil.rmtree(state)
    except OSError:
        pass


def apply_update(info):
    """调用方先停服务。重新获取官方信息后同步安装，成功失败均由调用方重启。"""
    if not isinstance(info, dict) or not isinstance(info.get("version"), str):
        raise UpdateError("缺少待安装版本信息。")
    try:
        with _locked(BASE):
            _recover(BASE)
            official = check_update()
            if official is None or official["version"] != info["version"]:
                raise UpdateError("可用版本已变化或不比当前版本新，请重新检查更新。")
            checksum = _fetch(official["checksum_url"], 4096).decode("ascii").strip()
            match = re.fullmatch(r"([0-9a-fA-F]{64})  course-workbench\.zip", checksum)
            if not match:
                raise UpdateError("官方 SHA256 校验清单格式无效。")
            content = _fetch(official["archive_url"], MAX_DOWNLOAD)
            if hashlib.sha256(content).hexdigest() != match[1].lower():
                raise UpdateError("更新包 SHA256 校验失败，未替换任何应用文件。")
            with tempfile.TemporaryDirectory(prefix="kecang-download-") as folder:
                archive = Path(folder) / ARCHIVE
                archive.write_bytes(content)
                _install(BASE, archive, official["version"])
            return {"status": "updated", "version": official["version"], "restart_required": True,
                    "message": "更新已完成，请重新启动课藏；浏览器扩展文件更新后请在扩展管理页重新加载。"}
    except UpdateError:
        raise
    except (OSError, ValueError, UnicodeError) as error:
        raise UpdateError("更新失败，请检查网络与应用目录权限后重试。") from error
