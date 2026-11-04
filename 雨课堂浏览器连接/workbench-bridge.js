"use strict";
if(location.origin==="http://127.0.0.1:8765") {
 let lastOpen=0;
 chrome.runtime.sendMessage({type:"connector-handshake"}).then(result=>window.postMessage({type:"kecang-extension-ready",ok:!!result?.ok},location.origin)).catch(()=>{});
 window.addEventListener("message",event=>{
  if(event.source!==window || event.origin!==location.origin || event.data?.type!=="kecang-connect") return;
  const platform=event.data.platform;
  if(!["rain","cx","mooc","pta"].includes(platform) || Date.now()-lastOpen<3000) return;
  lastOpen=Date.now();
  chrome.runtime.sendMessage({type:"connector-open",platform}).then(result=>window.postMessage({type:"kecang-connect-result",platform,...result},location.origin)).catch(()=>window.postMessage({type:"kecang-connect-result",platform,ok:false,issue:"扩展暂不可用"},location.origin));
 });
}
