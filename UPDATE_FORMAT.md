# Windows 公开版更新协议

- 官方仓库固定为 `smikey12/course-workbench`；仅从其 GitHub REST `releases/latest` 接受稳定发布，不接收草稿和预发布。
- 根目录 `VERSION` 为 UTF-8 纯文本三段数字，当前为 `1.1.0`。Release 标签严格为 `v<版本>`。
- Release 手动上传 `course-workbench.zip` 与 `course-workbench.sha256` 两个附件。GitHub 自动生成的 Source code ZIP 不适用于更新。
- SHA256 文件只含一行：64 位十六进制摘要、两个空格、`course-workbench.zip`，可有末尾换行。
- ZIP 根目录直接包含 `prepare_release.FILES` 中的全部文件，保持子目录。禁止额外文件、缺失文件、重复路径、链接或加密项。更新包内 VERSION 必须与 Release 一致。
- 更新器使用安装时本机的可信 FILES 白名单，不执行下载包内的打包器。新发布若增减白名单文件，需要先规划兼容更新；不能直接给旧客户端发不同文件集。

## 启动器接口

`current_version()` 返回本机版本字符串。
`check_update()` 无新版本返回 None，有新版本返回含 version、current_version、release_url 的字典。网络/格式失败抛中文 `UpdateError`。
`apply_update(info)` 只使用传入的 version 标识，再次从官方来源获取元数据、清单和 ZIP，拒绝信任调用方传入的 URL 与摘要。调用前由启动器取得启动锁并停止同目录服务，调用后成功或正常回滚均由启动器重启服务。同步成功返回 `status='updated'`、version、message、`restart_required=True`。更新器不停止或启动进程。
`recover_update()` 必须在服务启动前调用，以恢复上次断电/终止留下的事务；返回是否处理过旧事务。若恢复失败应显示错误并停止启动服务，保留备份供恢复。

## 落盘与失败行为

更新器另有系统文件锁防止两个安装事务并发。先校验 ZIP SHA256 和包结构，再将新文件解压到 `.kecang-update/new`；覆盖前将原应用文件移动至 `.kecang-update/backup`。每次替换前持久化恢复记录，VERSION 最后替换。失败按记录恢复，提交成功后清理备份。断电后由 recover_update 重放恢复；已提交的记录只清理备份。不得删除该状态目录来绕过失败。

只替换白名单内应用文件，不迁移、不删除用户数据库、课程原件、下载收件箱与其他运行数据。拒绝本机覆盖路径中的符号链接、Windows junction 和重解析点。包上限 32 MiB，展开上限 128 MiB。更新后需重新加载浏览器扩展。

SHA256 校验保护下载完整性，官方仓库与 HTTPS 是信任来源；该方案没有独立代码签名，不能抵御官方 GitHub 账号或发布权限被攻破。更新不执行数据库迁移，因此后续发布必须继续兼容已有用户数据库。

## 隔离验收

运行 `python -B -m unittest -v test_updater`，仅使用系统临时目录和模拟 GitHub 回复，不联网、不更新本机应用，也不读取私人资料。覆盖新版本更新、用户数据保留、降级拒绝、清单与哈希异常、异常包、晚期替换失败回滚、事务中断恢复及并发锁。

GitHub API 依据：[GitHub 官方 Release 接口](https://docs.github.com/en/rest/releases/releases)。
