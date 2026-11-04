const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
function setup({allowed=true,enabled=true,existing=false,result={courses:[]},badHost=false,existingUrl="https://www.icourse163.org/home.htm",loadingFirst=false}={}) {
  const writes=[],removed=[],created=[]; let reads=0;
  const event={addListener(){}};
  const c=vm.createContext({setTimeout,collectMooc(){},local:async payload=>{
    writes.push(payload);return payload.action==='check'?{enabled}:{ok:true};
  },chrome:{permissions:{contains:async()=>allowed},
    tabs:{query:async()=>existing?[{id:2,url:existingUrl}]:[],
      create:async options=>{created.push(options);return {id:5};},
      get:async id=>loadingFirst && reads++===0 ? {id,status:'loading',pendingUrl:'https://www.icourse163.org/home.htm'} : ({id,status:'complete',url:badHost?'https://example.com/':'https://www.icourse163.org/home.htm'}),
      remove:async id=>{removed.push(id);}},
    scripting:{executeScript:async()=>[{result}]},alarms:{create(){},onAlarm:event},
    runtime:{id:'synthetic-extension',onInstalled:event,onStartup:event,onMessage:event}}});
  vm.runInContext(fs.readFileSync(__dirname+'/mooc-background.js','utf8'),c);
  return {c,writes,created,removed};
}
test('未主动授权或工作台暂停时不打开网站',async()=>{
  for(const options of [{allowed:false},{enabled:false}]) {
    const {c,created,writes}=setup(options);
    assert.ok((await c.wakeMooc()).issue); assert.equal(created.length,0);
    assert.equal(writes.some(x=>x.action==='mooc'),false);
  }
});
test('只关闭扩展自己创建的后台页',async()=>{
  for(const existing of [false,true]) {
    const {c,created,removed,writes}=setup({existing});
    assert.equal((await c.wakeMooc()).ok,true);
    assert.equal(created.length,existing?0:1);
    assert.deepEqual(removed,existing?[]:[5]);
    assert.equal(writes.at(-1).action,'mooc');
    assert.ok(Array.isArray(writes.at(-1).courses));
  }
});
test('未登录结果仅报告 issue，不伪造 courses 空清单',async()=>{
  const {c,writes}=setup({result:{issue:'尚未登录'}});
  await c.wakeMooc();
  assert.equal(writes.at(-1).issue,'尚未登录'); assert.equal(writes.at(-1).courses,undefined);
});
test('读取页离开授权域名立即终止，并报告失败',async()=>{
  const {c,writes,removed}=setup({badHost:true});
  await c.wakeMooc();
  assert.match(writes.at(-1).issue,/离开已授权域名/);assert.equal(writes.at(-1).courses,undefined);
  assert.deepEqual(removed,[5]);
});

test('复用课程清单页面，不新建登录会话',async()=>{
 const {c,created,removed}=setup({existing:true,existingUrl:'https://www.icourse163.org/learn/HDU-123?tid=456#/learn/testlist'});
 assert.equal((await c.wakeMooc()).ok,true); assert.equal(created.length,0); assert.equal(removed.length,0);
});
test('新页尚无url时等待官方导航，不误报权限丢失',async()=>{
 const {c,writes}=setup({loadingFirst:true});
 assert.equal((await c.wakeMooc()).ok,true); assert.ok(Array.isArray(writes.at(-1).courses));
});
