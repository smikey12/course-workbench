# Edge扩展打包与上架准备

运行 python -B build_edge_package.py，在release/生成kecang-edge-addons-0.5.1.zip与配对course-workbench.zip和SHA256。扩展ZIP根manifest，仅包含运行文件及原创几何书本图标，不含测试、Python、数据库或用户资料。两个包来自同一公开源码，运行脚本逐字节配对。版本与包名以manifest实际值为准。

当前没有经核实的正式商店详情页，web/board.js的EDGE_ADDONS_DETAIL_URL保持null，首装提示未上架。不能把开发者加载、第三方包或本地ZIP称作商店安装。

发布者本人到 https://partner.microsoft.com/dashboard 核实Microsoft个人账号的Edge开发者计划、产品ID或草稿，填写真实发布者、支持/隐私邮箱、国家地区等。docs/privacy-template.md需本人确认并托管为可匿名读取的HTTPS政策后，才能填写真实政策URL。不要填写虚构URL或将未填主体的模板直接提交。

需解释alarms（定时）、offscreen（学习通后台文档）、scripting（已授权页包内DOM读取）、storage（PTA预算和登录补读去重）、回环工作台host权限与各所选平台optional host权限。课程/个人状态属于被访问数据，不能因为存本机就声明不访问数据。无开发者遥测或远程扩展代码；读取函数随包，平台自己的网页脚本与会话另行处理。

PTA保守模式正常12小时一次、失败退避，目录卡片未出现不冒充空列表。仅开放概览/目录元数据，不能核实逐题提交。首次人工授权、平台登录与安全确认不可代替。

包格式可上传不等于已批准上架。提交前检查官方要求、完整身份/政策与独立实测；由发布者决定上传和提交，本源码不自动上传。正式详情页获批后人工核对发布者/产品再回填URL，重建工作台和新摘要，从真实公开下载位置重新验收“下载→首次启动→官方商店获取→同页握手→选择授权登录→实际同步”。商店图像如需300×300可由原创书本图标缩放；不使用私人截图。

官方要求：
https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/publish-extension
https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/create-dev-account
https://learn.microsoft.com/en-us/legal/microsoft-edge/extensions/developer-policies
