"use strict";
const ptaOrigins=["https://pintia.cn/*"],PTA_LIMIT_KEY="pta-read-budget-v1",PTA_PERIOD=12*60*60*1000;
let ptaBusy=false;
async function wakePta(options={}) {
 if(ptaBusy)return {issue:"PTA 正在检查"};
 ptaBusy=true;let created=null,keepForLogin=false,tabId=null,loginRequired=false;
 try {
  const allowed=await chrome.permissions.contains({origins:ptaOrigins});
  const config=await local({action:"check",platform:"pta",ptaAccess:allowed});
  if(!allowed||!config.enabled)return {issue:"PTA 未选择、未授权或已暂停，未访问网站"};
  // Fail closed if durable storage is unavailable. Reserve budget before navigation or injection.
  const stored=(await chrome.storage.local.get(PTA_LIMIT_KEY))[PTA_LIMIT_KEY]||{};
  const now=Date.now();
  const resume=options.resumeLogin===true && stored.loginPending===true && !stored.loginResumeUsed && options.tabId===stored.loginTabId;
  if(!resume&&Number.isFinite(stored.nextAt)&&now<stored.nextAt)return {issue:"PTA 限频中，下次可检查："+new Date(stored.nextAt).toLocaleString("zh-CN")};
  await chrome.storage.local.set({[PTA_LIMIT_KEY]:{...stored,nextAt:now+PTA_PERIOD,failures:stored.failures||0,loginResumeUsed:resume}});
  const tabs=await chrome.tabs.query({url:"https://pintia.cn/*"});
  const overview=t=>/^https:\/\/pintia\.cn\/problem-sets\/[1-9][0-9]{0,24}\/(?:exam\/)?overview\/?(?:[?#]|$)/.test(t.url||"");
  const directory=t=>/^https:\/\/pintia\.cn\/problem-sets\/(?:active|all)(?:[?#]|$)/.test(t.url||"");
  let tab=options.resumeLogin?tabs.find(t=>t.id===options.tabId):tabs.find(t=>t.active&&overview(t))||tabs.find(overview)||tabs.find(directory);
  if(resume&&!tab)throw new Error("等待本人返回登录前的题集目录");
  if(!tab){tab=await chrome.tabs.create({url:"https://pintia.cn/problem-sets/active",active:false});created=tab.id;}
  tabId=tab.id;
  let result=null;
  // Bounded polling of this same tab/DOM only: no navigation, refresh or site API calls.
  for(let attempt=0;attempt<60;attempt++) {
   if(!(await local({action:"check",platform:"pta"})).enabled)return {issue:"PTA 已退选或暂停，未读取"};
   const state=await chrome.tabs.get(tab.id);
   const address=state.url&&state.url!=="about:blank"?state.url:state.pendingUrl;
   if(address&&new URL(address).origin!=="https://pintia.cn")throw new Error("PTA 页面离开授权域名");
   if(state.status==="complete"&&/\/auth\/login/.test(state.url||"")) {loginRequired=true;throw new Error("请在已打开的 PTA 官网登录，登录后返回题集目录；该页完成加载会立即补读一次");}
   if(state.status==="complete"&&(overview(state)||directory(state))) {
    result=(await chrome.scripting.executeScript({target:{tabId:tab.id},world:"MAIN",func:collectPta}))?.[0]?.result;
    if(Array.isArray(result?.courses)&&(result.courses.length>0||result.emptyConfirmed===true))break;
    if(result?.issue&&!/就绪|加载|登录|会话/.test(result.issue))throw new Error(result.issue);
   }
   if(attempt===59)throw new Error("PTA 目录超时：尚未取得结果，保留上次记录并按错误退避；没有确认空目录");
   await new Promise(resolve=>setTimeout(resolve,500));
  }
  if(!(await local({action:"check",platform:"pta"})).enabled)return {issue:"PTA 已退选或暂停，本轮不写入"};
  await local({action:"pta",...result});
  await chrome.storage.local.set({[PTA_LIMIT_KEY]:{nextAt:now+PTA_PERIOD,failures:0}});
  return {ok:true,issue:result.issue};
 } catch(error) {
  try {
   const previous=(await chrome.storage.local.get(PTA_LIMIT_KEY))[PTA_LIMIT_KEY]||{};
   if(loginRequired){
    keepForLogin=created!==null;
    await chrome.storage.local.set({[PTA_LIMIT_KEY]:{...previous,loginPending:true,loginTabId:tabId}});
    if(keepForLogin)await chrome.tabs.update(created,{active:true}).catch(()=>{});
   }else{
   const failures=Math.min((previous.failures||0)+1,6);
   await chrome.storage.local.set({[PTA_LIMIT_KEY]:{...previous,failures,nextAt:Date.now()+Math.min(PTA_PERIOD,30*60*1000*2**(failures-1))}});
   }
  }catch{}
  const issue=String(error?.message||"PTA 检查失败，暂缓访问").slice(0,280);
  await local({action:"pta",issue}).catch(()=>{});return {issue};
 }finally{if(created!==null&&!keepForLogin)await chrome.tabs.remove(created).catch(()=>{});ptaBusy=false;}
}
function startPtaTimer(){chrome.alarms.create("pta-sync",{periodInMinutes:720});}
chrome.runtime.onInstalled.addListener(startPtaTimer);
chrome.runtime.onStartup.addListener(startPtaTimer);
chrome.alarms.onAlarm.addListener(a=>{if(a.name==="pta-sync")wakePta();});
chrome.runtime.onMessage.addListener((message,sender,reply)=>{if(message.type!=="pta-wake"||sender.id!==chrome.runtime.id)return;wakePta().then(reply,error=>reply({issue:String(error.message)}));return true;});

async function resumePtaAfterLogin(tabId,change,tab) {
 if(ptaBusy||change.status!=="complete"||!/^https:\/\/pintia\.cn\/problem-sets\/(?:active|all|[1-9][0-9]{0,24}\/(?:exam\/)?overview)(?:[/?#]|$)/.test(tab?.url||""))return;
 try{const stored=(await chrome.storage.local.get(PTA_LIMIT_KEY))[PTA_LIMIT_KEY];
 if(stored?.loginPending&&!stored.loginResumeUsed&&stored.loginTabId===tabId)await wakePta({resumeLogin:true,tabId});
 }catch{}
}
chrome.tabs.onUpdated?.addListener(resumePtaAfterLogin);
