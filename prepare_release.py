"""只从公开目录的源码白名单生成 ZIP，不读取私人版本或运行数据。"""
import argparse
import ast
import hashlib
import re
import zipfile
from pathlib import Path

BASE = Path(__file__).resolve().parent
FILES = (
    ".gitignore", "README.md", "public_settings.py", "prepare_release.py",
    "test_public_release.py", "course_scope.py", "cx_sync.py", "inbox_cleanup.py",
    "platform_sync.py", "rain_catalog.py", "retention.py", "server.py",
    "sync_courses.py", "workbench.py", "启动工具.cmd", "自动同步课程.cmd", "打开课藏.pyw",
    "web/board.html", "web/board.js", "web/board.css", "web/index.html",
    "web/app.js", "web/style.css", "雨课堂浏览器连接/manifest.json",
    "雨课堂浏览器连接/background.js", "雨课堂浏览器连接/cx-reader.js",
    "雨课堂浏览器连接/cx-reader.html", "雨课堂浏览器连接/cx-access.js",
    "雨课堂浏览器连接/cx-access.html",
)


def validate():
    """检查全部发布文件及空白目录设置；不修改被检查文件。"""
    for name in FILES:
        path = BASE / name
        if path.is_symlink() or not path.is_file() or not path.resolve().is_relative_to(BASE):
            raise ValueError(f"发布文件缺失或路径无效：{name}")
        text = path.read_text(encoding="utf-8-sig")
        if re.search(r"(?i)(?<![a-z\\])[a-z]:[\\/]", text):
            raise ValueError(f"发现固定的 Windows 绝对路径：{name}")
    tree = ast.parse((BASE / "public_settings.py").read_text(encoding="utf-8"))
    assignments = {node.targets[0].id: ast.dump(node.value) for node in tree.body
                   if isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name)}
    for key, variable, folder in (("COURSE_ROOT", "KECANG_COURSES_ROOT", "courses"),
                                  ("INBOX", "KECANG_INBOX", "inbox")):
        expected = ast.dump(ast.parse(f'_directory("{variable}", BASE / "data" / "{folder}")', mode="eval").body)
        if assignments.get(key) != expected:
            raise ValueError(f"请恢复空白默认配置后再发布：{key}")
    return FILES


def build_archive(destination):
    names = validate()
    destination = Path(destination)
    if destination.resolve().is_relative_to(BASE) and destination.resolve().relative_to(BASE).as_posix() in FILES:
        raise ValueError("导出位置不能覆盖源码")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(destination, "w", zipfile.ZIP_DEFLATED) as bundle:
        for name in names:
            bundle.write(BASE / name, name)
    return hashlib.sha256(destination.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="只检查并列出待上传源码")
    parser.add_argument("--output", type=Path, default=BASE / "release" / "课藏-公开源码.zip")
    args = parser.parse_args()
    try:
        names = validate()
        if args.check:
            print("\n".join(names))
            print(f"检查通过：{len(names)} 个发布文件；不含数据库、资料、日志和 Git 历史。")
        else:
            digest = build_archive(args.output)
            args.output.with_suffix(".sha256").write_text(digest + "  " + args.output.name + "\n", encoding="utf-8")
            args.output.with_suffix(".files.txt").write_text("\n".join(names) + "\n", encoding="utf-8")
            print(f"已导出 {len(names)} 个文件：{args.output}\nSHA256 {digest}")
    except (OSError, ValueError) as error:
        parser.exit(1, f"导出失败：{error}\n")


if __name__ == "__main__":
    main()
