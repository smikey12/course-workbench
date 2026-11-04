const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
function setup(selected=['pta'],allowed=true){const runs=[],writes=[],tabs=[];const e={addListener(){}};const c=vm.createContext({URL,console,Date,local:async p=>{writes.push(p);return {enabled:p.platform?selected.includes(p.platform):true,selected,requests:{}};},synchronize:async()=>runs.push('rain'),wakeCX:async()=>runs.push('cx'),wakeMooc:async()=>runs.push('mooc'),wakePta:async()=>runs.push('pta'),chrome:{permissions:{contains:async()=>allowed,onAdded:e,onRemoved:e},runtime:{id:'test',getManifest:()=>({version:'0.5.0'}),getURL:p=>'chrome-extension://test/'+p,onInstalled:e,onStartup:e,onMessage:e},alarms:{create(){},onAlarm:e},tabs:{create:async p=>tabs.push(p)}}});vm.runInContext(fs.readFileSync(__dirname+'/connector-global.js','utf8'),c);return {c,runs,writes,tabs};}
test('只对已选择且已授权的平台调度，重试不会重复整轮',async()=>{const {c,runs}=setup();await c.reconnectSelected();await c.reconnectSelected();assert.deepEqual(runs,['pta']);});
test('无权限不发平台请求、不打开页面',async()=>{const {c,runs,tabs}=setup(['pta'],false);await c.reconnectSelected();assert.deepEqual(runs,[]);assert.deepEqual(tabs,[]);assert.equal(await c.platformGate('pta'),false);});
test('未选择的平台即便有权限也被禁止',async()=>{const {c}=setup([]);assert.equal(await c.platformGate('rain'),false);});
test('握手上报权限但不报告虚假平台成功',async()=>{const {c,writes}=setup(['rain','mooc']);await c.reconnectSelected();assert.equal(writes[0].ptaAccess,true);assert.equal(writes[0].action,'check');assert.equal(writes.some(x=>x.action==='pta'),false);});

function installSetup(tabs,failIds=[]){
 const installed=[],injected=[],runs=[],alarms=[];
 const e={addListener(){}};
 const c=vm.createContext({URL,local:async()=>({enabled:true,selected:['pta'],requests:{}}),
  synchronize:async()=>{},wakeCX:async()=>{},wakeMooc:async()=>{},wakePta:async()=>runs.push('pta'),
  chrome:{permissions:{contains:async()=>true,onAdded:e,onRemoved:e},
   runtime:{getManifest:()=>({version:'test'}),onInstalled:{addListener:f=>installed.push(f)},onStartup:e,onMessage:e},
   alarms:{create:(...a)=>alarms.push(a),onAlarm:e},
   tabs:{query:async options=>{assert.equal(options.url,'http://127.0.0.1:8765/*');return tabs;}},
   scripting:{executeScript:async spec=>{injected.push(spec);if(failIds.includes(spec.target.tabId))throw Error('tab closed');}}
  }});
 vm.runInContext(fs.readFileSync(__dirname+'/connector-global.js','utf8'),c);
 return {c,installed,injected,runs,alarms};
}
test('安装后补注入已打开的本机顶层页面，同时启动已选平台首次同步',async()=>{
 const {installed,injected,runs,alarms}=installSetup([{id:1,url:'http://127.0.0.1:8765/'},{id:2,url:'http://127.0.0.1:8765/library#x'}]);
 await installed[0]();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(injected.length,2);
 for(const spec of injected){assert.deepEqual(Array.from(spec.target.frameIds),[0]);assert.deepEqual(Array.from(spec.files),['workbench-bridge.js']);assert.equal(spec.world,'ISOLATED');assert.equal(spec.target.allFrames,undefined);}
 assert.deepEqual(runs,['pta']);assert.equal(alarms[0][0],'connector-retry');
});
test('即便query返回异常结果，也拒绝非本机源、其他端口、无效ID和带凭据地址',async()=>{
 const {c,injected}=installSetup([
  {id:1,url:'https://127.0.0.1:8765/'},{id:2,url:'http://127.0.0.1:8766/'},
  {id:3,url:'http://127.0.0.1:8765.evil.test/'},{id:4,url:'http://localhost:8765/'},
  {id:5,url:'http://user@127.0.0.1:8765/'},{id:6,url:'not a url'},
  {id:-1,url:'http://127.0.0.1:8765/'},{url:'http://127.0.0.1:8765/'}]);
 await c.injectExistingWorkbenches();assert.equal(injected.length,0);
});
test('单个页面关闭或拒绝注入不影响其他标签，也不会拒绝安装回调',async()=>{
 const {installed,injected,runs}=installSetup([{id:1,url:'http://127.0.0.1:8765/'},{id:2,url:'http://127.0.0.1:8765/'}],[1]);
 await installed[0]();await new Promise(resolve=>setImmediate(resolve));
 assert.equal(injected.length,2);assert.deepEqual(runs,['pta']);
});
test('标签查询失败时安装仍能完成，保留后台握手与重连入口',async()=>{
 const {c,installed,runs}=installSetup([]);
 c.chrome.tabs.query=async()=>{throw Error('browser unavailable');};
 await installed[0]();await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(runs,['pta']);
});
