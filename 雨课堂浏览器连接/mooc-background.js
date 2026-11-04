"use strict";
// 独立定时器不改变已有学习通/雨课堂队列；不保存账号或课程快照。
const moocOrigins=["https://www.icourse163.org/*"];
let moocBusy=false;
async function wakeMooc() {
  if (moocBusy) return {issue:"MOOC 正在读取，请稍后查看工作台"};
  moocBusy=true;
  let createdTab=null;
  try {
    const allowed=await chrome.permissions.contains({origins:moocOrigins});
    const config=await local({action:"check",platform:"mooc",moocAccess:allowed});
    if (!allowed) return {issue:"中国大学 MOOC 尚未单独授权"};
    if (!config.enabled) return {issue:config.selected && !config.selected.includes("mooc") ? "该平台未被选择，已停止检查；已有数据保留" : "工作台已暂停接收"};
    const tabs=await chrome.tabs.query({url:"https://www.icourse163.org/*"});
    // 复用现有会话；没有官网标签页时，只临时创建扩展自己的后台页。
    // 避免复用答题/考试页，不接触用户正在进行的测验。
    let tab=tabs.find(t=>t.url && (
      /^https:\/\/www\.icourse163\.org\/(?:home\.htm(?:[?#]|$)|(?:[?#]|$))/.test(t.url)
      || /^https:\/\/www\.icourse163\.org\/learn\/[^?#]+\?[^#]*#\/learn\/(?:content|testlist)(?:[?&]|$)/.test(t.url)));
    if (!tab) {tab=await chrome.tabs.create({url:"https://www.icourse163.org/home.htm",active:false});createdTab=tab.id;}
    for (let n=0;n<40;n++) {
      const state=await chrome.tabs.get(tab.id);
      // 新建页短暂没有 url 或仍是 about:blank；仅等待已发起的官方页面导航。
      const address=state.url && state.url!=="about:blank" ? state.url : state.pendingUrl;
      if (address && !address.startsWith("https://www.icourse163.org/")) throw new Error("MOOC 读取页离开已授权域名");
      if (state.status==="complete" && state.url?.startsWith("https://www.icourse163.org/")) break;
      if (n===39) throw new Error("MOOC 官网载入超时，请在浏览器打开官网重试");
      await new Promise(resolve=>setTimeout(resolve,500));
    }
    const results=await chrome.scripting.executeScript({target:{tabId:tab.id},world:"MAIN",func:collectMooc});
    const result=results?.[0]?.result;
    if (!result || (!Array.isArray(result.courses) && typeof result.issue!=="string")) throw new Error("MOOC 读取器没有返回可核验的结果");
    if (!(await local({action:"check",platform:"mooc"})).enabled) return {issue:"MOOC 已取消选择或暂停，本轮不写入"};
    await local({action:"mooc",...result});
    return {ok:true,...(result.issue ? {issue:result.issue} : {})};
  } catch (error) {
    const issue=String(error?.message || "MOOC 读取失败").slice(0,280);
    await local({action:"mooc",issue}).catch(()=>{});
    return {issue};
  } finally {
    if (createdTab!==null) await chrome.tabs.remove(createdTab).catch(()=>{});
    moocBusy=false;
  }
}
function startMoocTimer() {
  chrome.alarms.create("mooc-sync",{periodInMinutes:5});
  wakeMooc();
}
chrome.runtime.onInstalled.addListener(startMoocTimer);
chrome.runtime.onStartup.addListener(startMoocTimer);
chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name==="mooc-sync") wakeMooc();});
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
  if (message.type!=="mooc-wake" || sender.id!==chrome.runtime.id) return;
  wakeMooc().then(reply,error=>reply({issue:String(error.message).slice(0,280)}));
  return true;
});
