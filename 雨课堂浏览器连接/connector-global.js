"use strict";
const platformOrigins={rain:["https://www.yuketang.cn/*"],cx:["https://mooc1-api.chaoxing.com/*","https://mooc1.chaoxing.com/*","https://mooc2-ans.chaoxing.com/*"],mooc:["https://www.icourse163.org/*"],pta:["https://pintia.cn/*"]};
async function platformGate(platform) {
 const allowed=await chrome.permissions.contains({origins:platformOrigins[platform]});
 const result=await local({action:"check",platform,[platform+"Access"]:allowed,extensionVersion:chrome.runtime.getManifest().version});
 return result.enabled && allowed;
}
let lastSelected=[],lastRequests={},receiverOnline=false;
async function reconnectSelected() {
 try {
  const reports={};
  for(const key of Object.keys(platformOrigins)) reports[key+"Access"]=await chrome.permissions.contains({origins:platformOrigins[key]});
  const state=await local({action:"check",...reports,extensionVersion:chrome.runtime.getManifest().version});
  const resumed=!receiverOnline;receiverOnline=true;
  for(const key of state.selected || []) {
   const request=state.requests?.[key];
   if(state.enabled && reports[key+"Access"] && (resumed || !lastSelected.includes(key) || request && lastRequests[key]!==request)) {
    const run={rain:()=>synchronize(),cx:()=>wakeCX(),mooc:()=>wakeMooc(),pta:()=>wakePta()}[key];
    run().catch(()=>{});
   }
  }
  lastSelected=state.selected || [];lastRequests=state.requests || {};
 } catch {receiverOnline=false;}
}
function startConnector() {chrome.alarms.create("connector-retry",{periodInMinutes:1});reconnectSelected();}
async function injectExistingWorkbenches() {
 // 声明式 content_scripts 不会补跑安装前已打开的页面。只补注入本机源的顶层帧，
 // 沿用 manifest 已有 host_permissions；bridge 自身处理重复注入和页面新挑战。
 try {
  const tabs=await chrome.tabs.query({url:"http://127.0.0.1:8765/*"});
  await Promise.allSettled(tabs.filter(tab=>{
   if(!Number.isInteger(tab.id) || tab.id<0) return false;
   try {const url=new URL(tab.url);return url.origin==="http://127.0.0.1:8765" && !url.username && !url.password;}
   catch{return false;}
  }).map(async tab=>{
   // 标签关闭、导航离开本机源或页面暂不可注入，不影响其余标签及后台重连。
   await chrome.scripting.executeScript({target:{tabId:tab.id,frameIds:[0]},world:"ISOLATED",files:["workbench-bridge.js"]});
  }));
 } catch { /* 查询失败时保留定时重连；新导航仍由声明式 content_script 连接。 */ }
}
chrome.runtime.onInstalled.addListener(()=>{startConnector();return injectExistingWorkbenches();});
chrome.runtime.onStartup.addListener(startConnector);
chrome.alarms.onAlarm.addListener(a=>{if(a.name==="connector-retry") reconnectSelected();});
chrome.permissions.onAdded.addListener(()=>reconnectSelected());
chrome.permissions.onRemoved.addListener(()=>reconnectSelected());
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
 if(message.type==="connector-handshake") {reconnectSelected().then(()=>reply({ok:receiverOnline}));return true;}
 if(message.type!=="connector-open") return;
 let url;try {url=new URL(sender.tab?.url || "");}catch{return;}
 if(url.origin!=="http://127.0.0.1:8765" || !Object.hasOwn(platformOrigins,message.platform)) return;
 (async()=>{
  const state=await local({action:"check",platform:message.platform});
  if(!state.selected?.includes(message.platform)) return {ok:false,issue:"请先选择并保存该平台"};
  await chrome.tabs.create({url:chrome.runtime.getURL("connect.html?platform="+message.platform),active:true});
  return {ok:true};
 })().then(reply,()=>reply({ok:false,issue:"本机工作台暂不可用"}));return true;
});
