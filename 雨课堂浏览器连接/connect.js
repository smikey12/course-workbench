"use strict";
const options={rain:{name:"雨课堂",origins:["https://www.yuketang.cn/*"],type:"rain-wake"},cx:{name:"学习通",origins:["https://mooc1-api.chaoxing.com/*","https://mooc1.chaoxing.com/*","https://mooc2-ans.chaoxing.com/*"],type:"cx-wake"},mooc:{name:"中国大学 MOOC",origins:["https://www.icourse163.org/*"],type:"mooc-wake"},pta:{name:"PTA（拼题 A）",origins:["https://pintia.cn/*"],type:"pta-wake"}};
const key=new URLSearchParams(location.search).get("platform"),option=options[key];
const button=document.getElementById("connect"),message=document.getElementById("result");
if(!option){button.disabled=true;message.textContent="请从工作台选择平台后打开此页。";}
else {
 if(key==="pta") {
  document.getElementById("pta-help").hidden=false;
  const directory=document.getElementById("directory-only");directory.hidden=false;
  directory.onclick=async()=>{
   if(!(await chrome.permissions.contains({origins:option.origins}))){message.textContent="请先授权 PTA 后重试。";return;}
   directory.disabled=true;button.disabled=true;
   try {const result=await chrome.runtime.sendMessage({type:"pta-wake",directoryOnly:true});message.textContent=result?.issue||"进行中题集目录已刷新。";}
   catch {message.textContent="扩展暂未响应，请稍后重试。";}
   finally {directory.disabled=false;button.disabled=false;}
  };
 }
 document.getElementById("title").textContent="连接"+option.name;
 button.onclick=async()=>{
  // 权限请求必须由此页面用户点击触发；不把授权成功等同于平台登录成功。
  const granted=await chrome.permissions.contains({origins:option.origins}) || await chrome.permissions.request({origins:option.origins});
  if(!granted){message.textContent="尚未授权，等待授权后定时检查。";return;}
  button.disabled=true;message.textContent="已有网站权限，正在检查。实际结果请查看工作台。";
  try {const result=await chrome.runtime.sendMessage({type:option.type});message.textContent=result?.issue || "检查已发起，请在工作台查看最近成功时间和实际结果。";}catch{message.textContent="扩展暂未响应，后续定时检查会重试。";}
  finally {button.disabled=false;}
 };
}
