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
chrome.runtime.onInstalled.addListener(startConnector);
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
