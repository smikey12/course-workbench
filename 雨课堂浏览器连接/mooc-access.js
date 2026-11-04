"use strict";
const moocButton=document.getElementById("mooc-grant");
const moocMessage=document.getElementById("mooc-message");
const moocPermissions={origins:["https://www.icourse163.org/*"]};
async function updateMoocAccess() {
  const allowed=await chrome.permissions.contains(moocPermissions);
  moocButton.textContent=allowed ? "立即检查中国大学 MOOC" : "允许读取中国大学 MOOC";
}
moocButton.onclick=async()=>{
  try {
    // 权限只在用户主动点击时申请，与学习通授权分开。
    const allowed=await chrome.permissions.request(moocPermissions);
    if (!allowed) {moocMessage.textContent="尚未授权，不读取 MOOC；其他平台不受影响。";return;}
    moocButton.disabled=true;
    moocMessage.textContent="正在读取，本轮最多等待 90 秒；各班期成功或待核实结果会写入本机工作台。";
    const result=await chrome.runtime.sendMessage({type:"mooc-wake"});
    moocMessage.textContent=result?.issue || (result?.ok ? "本批读取已结束。请在工作台查看各班期检查状态。" : "本批结果尚未确认，请查看工作台。");
  } catch {moocMessage.textContent="读取器未能响应，请重新加载课藏扩展并检查本机服务。";}
  finally {moocButton.disabled=false;await updateMoocAccess();}
};
updateMoocAccess();
