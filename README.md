# 课藏 · 本地课程与作业工作台

在 Windows 浏览器中查看课程文件、作业截止时间和提交状态，将自己的报告与老师的附件关联到同一份作业。首次启动是空工作台，资料和平台账号由每位使用者在自己的电脑上建立。

## 本次源码更新

已接入中国大学 MOOC 的课程与作业读取，按需授权后使用浏览器内自己的登录会话。部分 SPOC 源课程仍可能未完全覆盖；此时显示“已收录”或“待核实”，不将缺失记录视为零项。有待办的课程优先进入默认六行，72 小时内截止标红，超过三天标橙。

本次只更新仓库源码，不创建 Release。要取得这次改动，在仓库页面选择 **Code → Download ZIP** 并完整解压；已有 Release 附件可能早于本次源码。安装过早期固定白名单更新器的用户，按下文手动覆盖源码一次，保留数据，再重新加载扩展并授权 MOOC 域名。

## 第一次使用

1. 安装 Windows 版 Python 3.13，从 [GitHub Releases](https://github.com/smikey12/course-workbench/releases) 下载正式附件 `course-workbench.zip`，解压到长期保留的目录。完整保留 `web/` 和“雨课堂浏览器连接”子目录。
2. 双击“启动工具.cmd”或“打开课藏.pyw”，打开 <http://127.0.0.1:8765/>。新版启动完成后可关闭控制台，后台服务仍会运行。首次应没有课程、作业或下载记录。已有另一套课藏占用端口时，先退出对应服务。
3. 课程资料放在 `data/courses/学期/课程名/`，下载资料放在 `data/inbox/`。进入“本地文件目录”刷新即可搜索文件。
4. 要同步平台作业，在支持 Chromium 扩展和 offscreen API 的浏览器扩展管理页开启开发者模式，选择“加载已解压的扩展”，选中“雨课堂浏览器连接”文件夹。登录自己的平台账号，学习通和中国大学 MOOC 需在扩展弹窗中分别授权；MOOC 需登录自己的 icourse163.org 账号。
5. 保持浏览器和本地服务运行。“自动同步课程.cmd”可检查本轮覆盖情况。班级分批读取，失败的班级显示待重试。

先放入一个自行命名的小文件，确认搜索及原路径显示正常，再连接自己的平台账号核对一门课的作业和截止时间。

## 打开时检查更新

新入口通过 `launcher.py`、`updater.py` 检查 `smikey12/course-workbench` 的最新稳定 Release。有更新时询问是否安装；拒绝或无法联网时继续使用本机版本。

更新只替换 `prepare_release.FILES` 中的源码，保留 `data/`、数据库、课程原件和浏览器登录。安装前核对 ZIP 的 SHA256、文件集合及包内 `VERSION`。扩展脚本变化后，仍需在浏览器扩展管理页重新加载扩展。

## 旧版第一次手动升级

没有更新器的旧入口不能自行获得这次更新，需要手动升级一次。

MOOC 版本新增了后端和扩展文件。安装过早期固定白名单更新器的用户，也需按以下步骤手动覆盖完整源码一次；旧客户端拒绝新文件集合是预期保护，不应关闭校验绕过。已经手动迁移到相同文件集合后，后续兼容版本才可自动更新。

1. 退出正在运行的课藏后台服务。仅关闭网页不会停止服务；在启动服务的命令窗口按 `Ctrl+C`，或退出对应后台进程。不要同时运行新旧两套 8765 服务。
2. 备份原安装目录，尤其是 `data/`、数据库；安装目录外的课程和下载资料保留原路径。
3. 从同一正式 Release 下载 `course-workbench.zip` 和 `course-workbench.sha256`。在下载目录核对下面两条命令的摘要是否一致：

   ```powershell
   (Get-FileHash -Algorithm SHA256 -LiteralPath ./course-workbench.zip).Hash.ToLower()
   Get-Content -LiteralPath ./course-workbench.sha256
   ```

4. 解压到临时目录，确认最外层直接有 `VERSION`、`launcher.py`、`updater.py`、`web/`。把解压出的源码与子目录复制到旧安装目录，覆盖同名源码；保留原来的 `data/`、数据库和个人文件。
5. 公开版默认使用 `data/courses/` 和 `data/inbox/`。若旧版资料在其他位置，先设置 `KECANG_COURSES_ROOT`、`KECANG_INBOX` 指向原位置，再启动。这只改变读取位置，不移动文件。
6. 使用新“启动工具.cmd”打开，检查原文件关联和课程数据，以后从新入口检查更新。

## 本地目录设置

默认课程目录为 `data/courses/`，收件箱为 `data/inbox/`，首次启动自动建立空目录。启动前可设置环境变量 `KECANG_COURSES_ROOT`、`KECANG_INBOX`；相对路径以程序目录为准，例如 `./我的课程`、`./我的下载`。公开默认配置不写入个人路径。

## 维护者：构建干净发布包

只在独立公开源码目录中操作。根目录 `VERSION` 是纯文本三段稳定版本号，当前 `1.1.0`，对应标签为 `v1.1.0`。下一次发布先修改 `VERSION`，再用对应标签执行：

```powershell
python -B -m unittest -v test_public_release test_prepare_release test_updater test_launcher test_mooc_sync
node test_board_display.cjs
node web/test_board_platforms.cjs
node --test 雨课堂浏览器连接/mooc-reader.test.cjs 雨课堂浏览器连接/mooc-background.test.cjs
python -B prepare_release.py --check --tag v1.1.0
python -B prepare_release.py --tag v1.1.0
```

测试使用隔离环境，覆盖空数据、模拟同步、发布包、更新器及启动入口。第二条只检查版本、空白配置和源码清单，第三条在 `release/` 中生成：

| 文件 | 用途 |
| --- | --- |
| `course-workbench.zip` | 必传附件；源码位于 ZIP 根目录，不带父目录 |
| `course-workbench.sha256` | 必传附件；单行小写 64 位 SHA256、两个空格、`course-workbench.zip` |
| `course-workbench.files.txt` | 本地审核用源码清单 |
| `course-workbench.files.json` | 本地审核用版本、总摘要和逐文件 SHA256 |

后续版本沿用固定附件名，每个版本建立独立 Release，不复用旧标签。更新器只需要 ZIP 和 `.sha256`，两个清单留作审核记录。

导出严格使用 `prepare_release.FILES` 白名单，不包含 `.git/`、`data/`、数据库、日志、截图、个人文件、缓存、临时目录和旧发布包。新增或移除源码文件时同步维护白名单，再运行全部检查。相同源码内容生成相同 ZIP；任何源码或说明修改后都要重新构建，不能沿用旧摘要。

当前更新器要求下载包与旧客户端已安装的白名单完全一致。因此，日常自动升级应保持本次文件集合；需要增减文件时，先设计兼容迁移或安排一次手动升级，不能只修改新版本白名单就向旧客户端发包。更新协议详见 `UPDATE_FORMAT.md`。

## 维护者：发布到 GitHub Releases

1. 检查公开仓库的 Changes，将最终源码（含 `VERSION`、更新器、启动入口和白名单）提交并推送到 `smikey12/course-workbench`。`.gitignore` 不会移除已跟踪的个人文件；提交前检查差异，不要把私人运行目录整包复制进仓库。
2. 用这份最终源码运行上面的测试、检查和构建命令，核对摘要。只选本次生成的两个必传附件。
3. 在仓库选择 **Releases → Draft a new release**，选择刚推送的目标提交，创建与 `VERSION` 一致的标签，如 `v1.1.0`，标题可填“课藏 v1.1.0”。
4. 填写变化、旧版首次手动升级方法、扩展是否需要重新加载。附上 `course-workbench.zip` 和 `course-workbench.sha256`，先保存草稿核对。
5. 准备正式发布时，不勾选预发布，设为最新正式 Release，再发布。草稿和预发布不供日常稳定更新使用。本轮开发仅生成本地包，不执行提交、推送或发布。
6. 发布后用独立测试安装验证版本发现、下载摘要和升级。本地模拟验收不能代替真实 Release 验收。

GitHub 自动生成的 **Source code (zip)** 是标签对应的仓库归档，不是这里审核过的更新附件。流程见 [GitHub 官方 Release 文档](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository)。

尚未建立远端仓库时，可先用 [GitHub Desktop](https://desktop.github.com/) 添加本地公开仓库，检查差异并提交，再由仓库拥有者发布。参见 [GitHub Desktop 官方文档](https://docs.github.com/en/desktop/adding-and-cloning-repositories/adding-a-repository-from-your-local-computer-to-github-desktop)。
