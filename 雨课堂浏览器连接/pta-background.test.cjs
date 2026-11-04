const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
function setup({store={},allowed=true,selected=true,error=false,storageError=false,cancel=false,now=2000000000000}={}){
 const calls=[],writes=[];let checks=0;const event={addListener(){}};
 const tab={id:7,url:'https://pintia.cn/problem-sets/active',status:'complete'};
 const c=vm.createContext({setTimeout:callback=>{callback();return 1;},Date:class extends Date{static now(){return now;}},URL,collectPta:async function(){},local:async p=>{writes.push(p);if(p.action==='check')return {enabled:selected&&!(cancel&&++checks>2)};return {ok:true};},chrome:{storage:{local:{get:async k=>{if(storageError)throw Error('storage unavailable');return {[k]:store[k]};},set:async p=>Object.assign(store,p)}},permissions:{contains:async()=>allowed},tabs:{query:async()=>{calls.push('query');return [tab];},get:async()=>tab,create:async()=>{throw Error('unexpected navigation');},update:async()=>{throw Error('unexpected refresh');},remove:async()=>{}},scripting:{executeScript:async()=>{calls.push('read');if(error)throw Error('page rejected');return [{result:{courses:[],emptyConfirmed:true,issue:'partial'}}];}},alarms:{create(){},onAlarm:event},runtime:{id:'test',onInstalled:event,onStartup:event,onMessage:event}}});
 vm.runInContext(fs.readFileSync(__dirname+'/pta-background.js','utf8'),c);return {c,calls,writes,store};
}
test('one DOM read only; persistent 12-hour budget survives new worker',async()=>{const x=setup();assert.equal((await x.c.wakePta()).ok,true);assert.deepEqual(x.calls,['query','read']);const y=setup({store:x.store});assert.match((await y.c.wakePta()).issue,/限频/);assert.equal(y.calls.length,0);});
test('errors back off 30 then 60 minutes across worker restarts',async()=>{const x=setup({error:true});await x.c.wakePta();assert.equal(x.store['pta-read-budget-v1'].nextAt,2000000000000+1800000);const y=setup({store:x.store,error:true,now:2000000000000+1800001});await y.c.wakePta();assert.equal(y.store['pta-read-budget-v1'].failures,2);assert.equal(y.store['pta-read-budget-v1'].nextAt,2000000000000+1800001+3600000);});
for(const options of [{allowed:false},{selected:false},{storageError:true}])test('no website access when gate or durable storage unavailable '+JSON.stringify(options),async()=>{const x=setup(options);await x.c.wakePta();assert.equal(x.calls.length,0);});
test('in-flight deselection prevents result write',async()=>{const x=setup({cancel:true});await x.c.wakePta();assert.equal(x.writes.some(p=>p.action==='pta'&&p.courses),false);});
test('no submitted-answer or problem-list routes or fetch in reader',()=>{const s=fs.readFileSync(__dirname+'/pta-reader.js','utf8');assert.doesNotMatch(s,/fetch\s*\(|\/api\/|submissions|problem-status|exam-problem-types/);});

test('fresh directory waits for loading and SPA DOM in same tab, without refresh',async()=>{
 const x=setup();let loads=0,reads=0,creates=0,removes=0;
 x.c.chrome.tabs.query=async()=>[];
 x.c.chrome.tabs.create=async()=>{creates++;return {id:9};};
 x.c.chrome.tabs.get=async()=>++loads<3?{id:9,status:'loading',pendingUrl:'https://pintia.cn/problem-sets/active'}:{id:9,status:'complete',url:'https://pintia.cn/problem-sets/active'};
 x.c.chrome.scripting.executeScript=async()=>[{result:++reads<3?{issue:'本人目录尚未就绪'}:{courses:[],emptyConfirmed:true,issue:'partial'}}];
 x.c.chrome.tabs.remove=async()=>removes++;
 assert.equal((await x.c.wakePta()).ok,true);assert.equal(creates,1);assert.equal(reads,3);assert.equal(removes,1);
});
test('real login redirect stays visible and resumes exactly once on same-tab completion',async()=>{
 const x=setup();let visible=0,removed=0,reads=0;
 x.c.chrome.tabs.query=async()=>[];
 x.c.chrome.tabs.create=async()=>({id:9});
 x.c.chrome.tabs.get=async()=>({id:9,status:'complete',url:'https://pintia.cn/auth/login'});
 x.c.chrome.tabs.update=async(id,change)=>{assert.equal(id,9);assert.deepEqual(JSON.parse(JSON.stringify(change)),{active:true});visible++;};
 x.c.chrome.tabs.remove=async()=>removed++;
 assert.match((await x.c.wakePta()).issue,/登录/);
 const state=x.store['pta-read-budget-v1'];assert.equal(state.loginPending,true);assert.equal(state.failures,0);assert.equal(visible,1);assert.equal(removed,0);
 x.c.chrome.tabs.query=async()=>[{id:9,url:'https://pintia.cn/problem-sets/active'}];
 x.c.chrome.tabs.get=async()=>({id:9,status:'complete',url:'https://pintia.cn/problem-sets/active'});
 x.c.chrome.scripting.executeScript=async()=>{reads++;return [{result:{courses:[],emptyConfirmed:true,issue:'partial'}}];};
 await x.c.resumePtaAfterLogin(9,{status:'complete'},{url:'https://pintia.cn/problem-sets/active'});
 await x.c.resumePtaAfterLogin(9,{status:'complete'},{url:'https://pintia.cn/problem-sets/active'});
 await x.c.wakePta();assert.equal(reads,1);assert.equal(x.store['pta-read-budget-v1'].failures,0);
 const y=setup({store:x.store});assert.match((await y.c.wakePta()).issue,/限频/);assert.equal(y.calls.length,0);
});

function useRealReader(x,{cardsAfter=1600,empty=false,loading=false}={}) {
 let elapsed=0,reads=0;
 x.c.setTimeout=callback=>{elapsed+=500;callback();return 1;};
 const n=(text,href)=>({innerText:text,getClientRects:()=>[1],getAttribute:()=>href});
 const root={get innerText(){return empty?'共 0 条数据 暂无题目集':'';},querySelectorAll:selector=>{
  if(selector==='a[href]')return elapsed>=cardsAfter&&!empty?[n('合成题集 来源用户组：合成班级','/problem-sets/123/overview')]:[];
  if(selector.includes('aria-busy'))return loading?[n('loading')]:[];
  return empty?[n('暂无题目集')]:[];
 }};
 x.c.location={href:'https://pintia.cn/problem-sets/active'};
 x.c.document={readyState:'complete',body:root,querySelector:selector=>selector==='#problem-set-join-type'?{}:root};
 x.c.getComputedStyle=()=>({display:'block',visibility:'visible'});
 vm.runInContext(fs.readFileSync(__dirname+'/pta-reader.js','utf8'),x.c);
 x.c.chrome.scripting.executeScript=async()=>{reads++;return [{result:await x.c.collectPta()}];};
 return {elapsed:()=>elapsed,reads:()=>reads};
}
test('real reader plus worker waits for cards arriving 1.6s after control, no empty success',async()=>{
 const x=setup(),r=useRealReader(x);assert.equal((await x.c.wakePta()).ok,true);
 assert.ok(r.elapsed()>=1600);assert.ok(r.reads()>1);
 const result=x.writes.find(p=>p.action==='pta'&&p.courses);assert.equal(result.courses.length,1);assert.equal(result.emptyConfirmed,false);
});
test('real reader plus worker accepts explicit empty marker after load',async()=>{
 const x=setup(),r=useRealReader(x,{empty:true});assert.equal((await x.c.wakePta()).ok,true);assert.equal(r.reads(),1);
 const result=x.writes.find(p=>p.action==='pta'&&p.courses);assert.equal(result.emptyConfirmed,true);assert.equal(result.courses.length,0);
});
test('controls without cards or explicit empty marker time out without writing zero result',async()=>{
 const x=setup(),r=useRealReader(x,{cardsAfter:Infinity});assert.match((await x.c.wakePta()).issue,/未取得结果/);assert.equal(r.reads(),60);assert.equal(x.store['pta-read-budget-v1'].failures,1);assert.equal(x.store['pta-read-budget-v1'].nextAt,2000000000000+1800000);assert.equal(x.writes.some(p=>p.action==='pta'&&p.courses),false);
});
test('explicit empty marker while loading is not empty success',async()=>{
 const x=setup();useRealReader(x,{empty:true,loading:true});assert.equal((await x.c.wakePta()).ok,undefined);assert.equal(x.writes.some(p=>p.action==='pta'&&p.courses),false);
});
