"use strict";
// 重复注入到已打开标签页时不重复注册事件，也不重复打开权限页。
if (location.origin === "http://127.0.0.1:8765" && !globalThis.__kecangWorkbenchBridge) {
  globalThis.__kecangWorkbenchBridge = true;
  let lastOpen = 0;
  function announce(nonce) {
    try {
      const manifest = chrome.runtime.getManifest();
      if (!chrome.runtime.id || typeof nonce !== "string" || nonce.length > 200) return;
      window.postMessage({type:"kecang-extension-ready",nonce,installed:true,version:manifest.version},location.origin);
      chrome.runtime.sendMessage({type:"connector-handshake"}).catch(()=>{});
    } catch {}
  }
  window.addEventListener("message",event=>{
    if (event.source !== window || event.origin !== location.origin) return;
    if (event.data?.type === "kecang-extension-probe") {announce(event.data.nonce);return;}
    if (event.data?.type !== "kecang-connect") return;
    const platform=event.data.platform;
    if (!["rain","cx","mooc","pta"].includes(platform) || Date.now()-lastOpen < 3000) return;
    lastOpen=Date.now();
    chrome.runtime.sendMessage({type:"connector-open",platform})
      .then(result=>window.postMessage({type:"kecang-connect-result",platform,...result},location.origin))
      .catch(()=>window.postMessage({type:"kecang-connect-result",platform,ok:false,issue:"扩展暂不可用"},location.origin));
  });
  // 新安装后补注入旧页面，要求页面产生自己的新挑战，不复用旧心跳。
  window.postMessage({type:"kecang-extension-probe-request"},location.origin);
}
