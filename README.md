# 课藏 · 本地课程与作业工作台

在 Windows 浏览器中查看课程文件、作业截止时间和提交状态，也可以把自己的报告和老师的模板关联到同一份作业。首次启动是空工作台，数据由每位使用者在自己的电脑上建立。

## 第一次使用

1. 安装 Windows 版 Python 3.13。解压完整源码包，保留网页和扩展的子目录。
2. 双击「启动工具.cmd」，保持服务运行，打开 <http://127.0.0.1:8765/>。端口已被另一套课藏占用时，请在另一台电脑或停止已有服务后再测试这个版本。
3. 本地课程资料可放在 `data/courses/大一下/课程名/`（用自己的学期和课程名替换），下载的资料可放在 `data/inbox/`。进入「本地文件目录」重新扫描。
4. 要同步平台作业，用支持 Chromium 扩展和 offscreen API 的浏览器打开扩展管理页，开启开发者模式，选择「加载已解压的扩展」，选中「雨课堂浏览器连接」文件夹。用自己的账号登录平台。学习通还需在扩展弹窗中允许读取课程与作业。
5. 保持浏览器和本地服务运行。双击「自动同步课程.cmd」可检查本轮覆盖情况。不同班级分批读取，有些平台页面可能提示待重试。

## 同学可以这样验收

首次打开时检查课程、作业和下载记录是否为空。然后新建一个测试课程，在里面放一个自己命名的小文件，检查能否搜到它并看到原始路径。最后连接自己的平台账号，核对一门课的作业和截止时间。

## 将同一份源码发布到 GitHub

1. 安装并登录 [GitHub Desktop](https://desktop.github.com/)。在已经初始化为 Git 仓库的源码目录上使用 **File → Add local repository**。若使用的是刚解压的 ZIP，请先在解压目录执行 `git init -b main`。
2. 查看左侧 **Changes** 和右侧差异。首次提交应包含程序、网页、扩展、README 和 .gitignore。有个人资料时先移出发布目录。填写摘要，例如 `首次提交空白课程工作台`，点击 **Commit to main** 将此版本保存在本机。
3. 点击 **Publish repository**，仓库名可以填 `course-workbench`。仅邀请同学测试时，勾选 **Keep this code private**；希望任何人都能下载源码时再选择公开。确认名称与可见性后点击 **Publish Repository**。
4. 打开 GitHub 仓库主页核对文件列表。私有仓库在 **Settings → Collaborators → Add people** 中邀请同学。对方接受邀请后，从 **Code → Download ZIP** 下载，按上面的步骤在自己的电脑运行。
5. 以后更新源码时，在 GitHub Desktop 中检查差异，填写摘要，依次点击 **Commit to main** 和 **Push origin**。

发布操作只选独立源码目录。`.gitignore` 会忽略常见的本地数据库、日志和 data 文件夹，提交前仍需检查 Changes。每位使用者的账号登录保留在自己的浏览器内。

[GitHub 官方文档：将本地仓库添加到 GitHub Desktop](https://docs.github.com/en/desktop/adding-and-cloning-repositories/adding-a-repository-from-your-local-computer-to-github-desktop)
