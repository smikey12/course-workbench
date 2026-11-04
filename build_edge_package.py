"""Build matched, clean Edge extension and local application packages; never upload."""
import argparse
import hashlib
import json
import zipfile
from pathlib import Path
import prepare_release

BASE = Path(__file__).resolve().parent


def runtime_snapshot(snapshot):
    prefix = "雨课堂浏览器连接/"
    files = {name[len(prefix):]: content for name, content in snapshot.items()
             if name.startswith(prefix) and Path(name).suffix in (".js", ".html", ".json", ".css", ".png")}
    manifest = json.loads(files["manifest.json"])
    refs = [manifest["background"]["service_worker"], manifest["options_page"],
            manifest["action"]["default_popup"], *manifest.get("icons", {}).values()]
    refs += [script for block in manifest.get("content_scripts", []) for script in block.get("js", [])]
    if any(ref not in files for ref in refs):
        raise ValueError("扩展包缺少运行依赖")
    return files, manifest["version"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    snapshot = prepare_release.source_snapshot()
    runtime, version = runtime_snapshot(snapshot)
    if args.check:
        print(f"验证通过：{len(snapshot)} 个源码文件，{len(runtime)} 个扩展运行文件，版本 {version}")
        return
    output = BASE / "release"
    output.mkdir(exist_ok=True)
    extension = output / f"kecang-edge-addons-{version}.zip"
    with zipfile.ZipFile(extension, "w") as bundle:
        for name, content in sorted(runtime.items()):
            entry = zipfile.ZipInfo(name, date_time=(2020, 1, 1, 0, 0, 0))
            entry.compress_type = zipfile.ZIP_DEFLATED
            entry.create_system = 3
            entry.external_attr = 0o100644 << 16
            bundle.writestr(entry, content)
    with zipfile.ZipFile(extension) as bundle:
        if bundle.testzip() is not None or set(bundle.namelist()) != set(runtime):
            raise ValueError("扩展ZIP完整性检查失败")
    app = output / "course-workbench.zip"
    app_hash = prepare_release.build_archive(app, snapshot)
    extension_hash = hashlib.sha256(extension.read_bytes()).hexdigest()
    for path, digest in ((app, app_hash), (extension, extension_hash)):
        path.with_suffix(".sha256").write_text(digest + "  " + path.name + "\n", encoding="utf-8")
    (output / "pairing.json").write_text(json.dumps({
        "extension": {"name": extension.name, "version": version, "sha256": extension_hash},
        "application": {"name": app.name, "sha256": app_hash},
        "sourceFiles": {name: hashlib.sha256(content).hexdigest() for name, content in snapshot.items()},
        "storeListingVerified": False,
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"扩展 {extension.name} SHA256 {extension_hash}\n工作台 {app.name} SHA256 {app_hash}")


if __name__ == "__main__":
    main()
