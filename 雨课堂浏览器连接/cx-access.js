const hosts = ["mooc1-api","mooc1","mooc2-ans"].map(name=>"https://"+name+".chaoxing.com/*");
const grant = document.getElementById("grant");
async function update() {
  const allowed = await chrome.permissions.contains({origins:hosts});
  grant.textContent = allowed ? "立即同步" : "允许读取学习通课程与作业";
}
grant.onclick = async () => {
  const allowed = await chrome.permissions.request({origins:hosts});
  document.getElementById("message").textContent = allowed ? "已连接。结果将在工作台的学习通同步栏显示。" : "尚未授权，仍显示上次记录。";
  if (allowed) await chrome.runtime.sendMessage({type:"cx-wake"});
  await update();
};
update();