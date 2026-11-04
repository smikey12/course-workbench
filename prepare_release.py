"""只从公开目录的源码白名单生成 ZIP，不读取私人版本或运行数据。"""
import argparse
import ast
import hashlib
import json
import os
import re
import tempfile
import zipfile
from pathlib import Path

BASE = Path(__file__).resolve().parent
FILES = (
    ".gitignore", "README.md", "VERSION", "UPDATE_FORMAT.md", "public_settings.py", "prepare_release.py",
    "updater.py", "test_updater.py", "launcher.py", "test_launcher.py", "test_prepare_release.py",
    "test_public_release.py", "test_board_display.cjs", "web/test_board_platforms.cjs", "mooc_sync.py", "test_mooc_sync.py", "course_scope.py", "cx_sync.py", "inbox_cleanup.py",
    "platform_sync.py", "rain_catalog.py", "retention.py", "server.py",
    "sync_courses.py", "workbench.py", "启动工具.cmd", "自动同步课程.cmd", "打开课藏.pyw",
    "web/board.html", "web/board.js", "web/board.css", "web/index.html",
    "web/app.js", "web/style.css", "雨课堂浏览器连接/manifest.json",
    "雨课堂浏览器连接/background.js", "雨课堂浏览器连接/cx-reader.js",
    "雨课堂浏览器连接/cx-reader.html", "雨课堂浏览器连接/cx-access.js",
    "雨课堂浏览器连接/cx-access.html",
    "雨课堂浏览器连接/mooc-reader.js", "雨课堂浏览器连接/mooc-background.js",
    "雨课堂浏览器连接/mooc-access.js", "雨课堂浏览器连接/mooc-reader.test.cjs",
    "雨课堂浏览器连接/mooc-background.test.cjs",

)


def source_snapshot():
    """检查全部发布文件及空白目录设置；不修改被检查文件。"""
    snapshot = {}
    for name in FILES:
        path = BASE / name
        if path.is_symlink() or not path.is_file() or path.resolve() != path:
            raise ValueError(f"发布文件缺失或路径无效：{name}")
        snapshot[name] = path.read_bytes()
        text = snapshot[name].decode("utf-8-sig")
        if re.search(r"(?i)(?<![a-z\\])[a-z]:[\\/]", text):
            raise ValueError(f"发现固定的 Windows 绝对路径：{name}")
        if path.suffix in (".py", ".pyw"):
            ast.parse(text, filename=name)
    tree = ast.parse(snapshot["public_settings.py"].decode("utf-8-sig"))
    assignments = {node.targets[0].id: ast.dump(node.value) for node in tree.body
                   if isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name)}
    for key, variable, folder in (("COURSE_ROOT", "KECANG_COURSES_ROOT", "courses"),
                                  ("INBOX", "KECANG_INBOX", "inbox")):
        expected = ast.dump(ast.parse(f'_directory("{variable}", BASE / "data" / "{folder}")', mode="eval").body)
        if assignments.get(key) != expected:
            raise ValueError(f"请恢复空白默认配置后再发布：{key}")
    release_version(snapshot)
    return snapshot


def validate():
    source_snapshot()
    return FILES


def release_version(snapshot):
    version = snapshot["VERSION"].decode("utf-8-sig").strip()
    if not re.fullmatch(r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)", version):
        raise ValueError("VERSION 必须是三段稳定版本号，例如 1.1.0")
    return version


def build_archive(destination, snapshot=None):
    snapshot = source_snapshot() if snapshot is None else snapshot
    if tuple(snapshot) != FILES:
        raise ValueError("发布快照必须与源码白名单完全一致")
    release_version(snapshot)
    destination = Path(destination).resolve()
    if destination.suffix.lower() != ".zip":
        raise ValueError("导出文件必须使用 .zip 扩展名")
    if any(destination == (BASE / name).resolve() for name in FILES):
        raise ValueError("导出位置不能覆盖源码")
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=destination.parent, suffix=".tmp", delete=False) as stream:
            temporary = Path(stream.name)
        with zipfile.ZipFile(temporary, "w", zipfile.ZIP_DEFLATED) as bundle:
            for name, content in snapshot.items():
                # 相同源码生成相同摘要，不把本机文件时间和权限写入发布包。
                info = zipfile.ZipInfo(name, date_time=(2020, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.create_system = 3
                info.external_attr = 0o100644 << 16
                bundle.writestr(info, content)
        with zipfile.ZipFile(temporary) as bundle:
            if bundle.testzip() is not None or tuple(bundle.namelist()) != FILES:
                raise ValueError("ZIP 完整性或文件清单验证失败")
        os.replace(temporary, destination)
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()
    return hashlib.sha256(destination.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="只检查并列出待上传源码")
    parser.add_argument("--output", type=Path, default=BASE / "release" / "course-workbench.zip")
    parser.add_argument("--tag", help="可选，核对 GitHub Release 标签，例如 v1.1.0")
    args = parser.parse_args()
    try:
        snapshot = source_snapshot()
        names = tuple(snapshot)
        version = release_version(snapshot)
        if args.tag is not None and args.tag != "v" + version:
            raise ValueError(f"标签应为 v{version}，请与 VERSION 保持一致")
        if args.check:
            print("\n".join(names))
            print(f"检查通过：v{version}，{len(names)} 个发布文件；不含数据库、资料、日志和 Git 历史。")
        else:
            digest = build_archive(args.output, snapshot)
            args.output.with_suffix(".sha256").write_text(digest + "  " + args.output.name + "\n", encoding="utf-8")
            args.output.with_suffix(".files.txt").write_text("\n".join(names) + "\n", encoding="utf-8")
            args.output.with_suffix(".files.json").write_text(json.dumps({
                "version": version, "tag": "v" + version, "archive": args.output.name,
                "sha256": digest, "files": {name: hashlib.sha256(content).hexdigest()
                                              for name, content in snapshot.items()}},
                ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            print(f"已导出 {len(names)} 个文件：{args.output}\nSHA256 {digest}")
    except (OSError, ValueError) as error:
        parser.exit(1, f"导出失败：{error}\n")


if __name__ == "__main__":
    main()
