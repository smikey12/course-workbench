const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
function setup({selected=true,allowed=true,personal=true,link=null,cancel=false}={}) {
 const writes=[],created=[],removed=[],calls=[];let checks=0;const event={addListener(){}};
 const tabs=[{id:1,url:'https://pintia.cn/'},{id:2,url:'https://pintia.cn/home?tab=personal'}];
 const c=vm.createContext({URL,collectPta:async function collectPta(){},setTimeout,local:async p=>{writes.push(p);if(p.action==='check')return {enabled:selected&&!(cancel&&checks++>0),selected:selected&&!cancel?['pta']:[]};return {ok:true};},chrome:{permissions:{contains:async()=>allowed},tabs:{query:async()=>tabs,create:async p=>{created.push(p);return {id:3};},get:async id=>({id,status:'complete',url:link||tabs.find(t=>t.id===id)?.url}),remove:async id=>removed.push(id)},scripting:{executeScript:async o=>{calls.push(o);return [{result:o.func.name==='collectPta'?{courses:[{id:'101',name:'合成题集',checked:false,partial:true,tasks:[]}],issue:'仅当前页'}:{personal:personal&&o.target.tabId===2,link}}];}},alarms:{create(){},onAlarm:event},runtime:{id:'test',onInstalled:event,onStartup:event,onMessage:event}}});
 vm.runInContext(fs.readFileSync(__dirname+'/pta-background.js','utf8'),c);return {c,writes,created,removed,calls};
}
test('个人题集页面优先于官网首页，无额外新页',async()=>{const x=setup();assert.equal((await x.c.wakePta()).ok,true);assert.equal(x.created.length,0);assert.equal(x.calls.at(-1).target.tabId,2);assert.equal(x.removed.length,0);});
test('找不到个人页面则明确引导，不反复打开官网首页',async()=>{const x=setup({personal:false});assert.match((await x.c.wakePta()).issue,/个人题集页/);assert.equal(x.created.length,0);assert.equal(x.writes.at(-1).courses,undefined);});
test('取消单个平台不误报全局暂停且不调用读取器',async()=>{const x=setup({selected:false});assert.match((await x.c.wakePta()).issue,/未被选择/);assert.equal(x.calls.length,0);});
test('在途取消禁止结果入库',async()=>{const x=setup({cancel:true});assert.match((await x.c.wakePta()).issue,/取消选择/);assert.equal(x.writes.some(p=>p.action==='pta'&&p.courses),false);});
test('未授权不读取页面',async()=>{const x=setup({allowed:false});assert.match((await x.c.wakePta()).issue,/未单独授权/);assert.equal(x.calls.length,0);});
