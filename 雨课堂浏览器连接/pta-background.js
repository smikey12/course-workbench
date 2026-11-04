"use strict";
// 独立定时器不改变已有学习通/雨课堂队列；不保存账号或课程快照。
const ptaOrigins=["https://pintia.cn/*"];
let ptaBusy=false;
async function wakePta() {
  if (ptaBusy) return {issue:"PTA 正在读取，请稍后查看工作台"};
  ptaBusy=true;
  let createdTab=null;
  try {
    const allowed=await chrome.permissions.contains({origins:ptaOrigins});
    const config=await local({action:"check",platform:"pta",ptaAccess:allowed});
    if (!allowed) return {issue:"PTA 尚未单独授权"};
    if (!config.enabled) return {issue:config.selected && !config.selected.includes("pta") ? "该平台未被选择，已停止检查；已有数据保留" : "工作台已暂停接收"};
    if (typeof collectPta!=="function") throw new Error("PTA 读取器尚未安装，其他平台不受影响");
    const tabs=await chrome.tabs.query({url:"https://pintia.cn/*"});
    // 路径只用于排除作答区，个人页面必须由可见标题证明；不能把公开题库当个人记录。
    let tab=null, personalLink=null;
    for (const candidate of tabs) {
      if(!candidate.url) continue;
      const overview=/^https:\/\/pintia\.cn\/problem-sets\/[1-9][0-9]{0,24}\/exam\/overview\/?(?:[?#]|$)/.test(candidate.url);
      if(overview) {tab=candidate;break;}
      if (/(?:problem-sets\/\d|problems\/|exam|submission|auth\/)/i.test(candidate.url)) continue;
      const probe=(await chrome.scripting.executeScript({target:{tabId:candidate.id},world:"MAIN",func:()=>{
        const titles=["我的题集","我的题目","个人题集","My Problem Sets","My Problems"];
        const visible=n=>n.getClientRects().length>0 && getComputedStyle(n).visibility!=="hidden";
        const root=document.querySelector("main,[role=main]") || document.body;
        const personal=[...root.querySelectorAll("h1,h2")].some(n=>visible(n)&&titles.includes(n.innerText.trim()));
        const link=[...document.querySelectorAll("a[href]")].find(n=>visible(n)&&titles.includes(n.innerText.trim())&&new URL(n.href,location.href).origin===location.origin);
        return {personal,link:link?.href || null};
      }}))?.[0]?.result;
      if (probe?.personal) {tab=candidate;break;}
      if (probe?.link) personalLink=probe.link;
    }
    if (!tab && personalLink) {
      const target=new URL(personalLink);
      if(target.origin!=="https://pintia.cn" || /(?:problem-sets\/\d|problems\/|exam|submission|auth\/)/i.test(target.pathname+target.hash)) throw new Error("个人题集链接尚未核实");
      tab=tabs.find(t=>t.url===target.href);
      if(!tab) {tab=await chrome.tabs.create({url:target.href,active:false});createdTab=tab.id;}
    }
    if (!tab) throw new Error("未找到可核验的个人题集页；请在已登录的 PTA 官网进入“我的题集/个人题集”后重试，后续定时检查会接续");
    for (let n=0;n<40;n++) {
      const state=await chrome.tabs.get(tab.id);
      // 新建页短暂没有 url 或仍是 about:blank；仅等待已发起的官方页面导航。
      const address=state.url && state.url!=="about:blank" ? state.url : state.pendingUrl;
      if (address && !address.startsWith("https://pintia.cn/")) throw new Error("PTA 读取页离开已授权域名");
      if (state.status==="complete" && state.url?.startsWith("https://pintia.cn/")) break;
      if (n===39) throw new Error("PTA 官网载入超时，请在浏览器打开官网重试");
      await new Promise(resolve=>setTimeout(resolve,500));
    }
    const results=await chrome.scripting.executeScript({target:{tabId:tab.id},world:"MAIN",func:collectPta});
    const result=results?.[0]?.result;
    if (!result || (!Array.isArray(result.courses) && typeof result.issue!=="string")) throw new Error("PTA 读取器没有返回可核验的结果");
    if (!(await local({action:"check",platform:"pta"})).enabled) return {issue:"PTA 已取消选择或暂停，本轮不写入"};
    await local({action:"pta",...result});
    return {ok:true,...(result.issue ? {issue:result.issue} : {})};
  } catch (error) {
    const issue=String(error?.message || "PTA 读取失败").slice(0,280);
    await local({action:"pta",issue}).catch(()=>{});
    return {issue};
  } finally {
    if (createdTab!==null) await chrome.tabs.remove(createdTab).catch(()=>{});
    ptaBusy=false;
  }
}
function startPtaTimer() {
  chrome.alarms.create("pta-sync",{periodInMinutes:5});
  wakePta();
}
chrome.runtime.onInstalled.addListener(startPtaTimer);
chrome.runtime.onStartup.addListener(startPtaTimer);
chrome.alarms.onAlarm.addListener(alarm=>{if(alarm.name==="pta-sync") wakePta();});
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
  if (message.type!=="pta-wake" || sender.id!==chrome.runtime.id) return;
  wakePta().then(reply,error=>reply({issue:String(error.message).slice(0,280)}));
  return true;
});
