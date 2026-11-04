// node --test 雨课堂浏览器连接/mooc-reader.test.cjs
// 所有返回均为合成测试数据；不访问真实账号或保存课程记录。
const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
function setup(handler, loggedIn=true) {
  const calls=[];
  const c=vm.createContext({location:{origin:'https://www.icourse163.org'},
    window:{webUser:loggedIn?{id:'1'}:null,NEJ:{P:()=>({geneAuthHeaders:()=>({'Content-Type':'application/json','Auth-Signature':'0'.repeat(32)})})}},
    document:{cookie:'NTESSTUDYSI=synthetic-session'},URL,URLSearchParams,AbortSignal,setTimeout,
    fetch:async (url,options)=>{
      const params=options.headers['Content-Type']==='application/json'?JSON.parse(options.body):Object.fromEntries(new URLSearchParams(options.body));
      const call={url,params}; calls.push(call);
      const result=await handler(call);
      return {ok:true,status:200,url:'https://www.icourse163.org'+url,json:async()=>({code:0,result})};
    }});
  vm.runInContext(fs.readFileSync(__dirname+'/mooc-reader.js','utf8'),c);
  return {c,calls};
}
const catalog=(rows,page=1,total=1,count=rows.length)=>({list:rows,query:{pageIndex:page,totlePageCount:total,totleCount:count}});
const course=n=>({id:n,name:'合成课程'+n,termPanel:{id:n+100,name:'合成班期'}});
const empty=()=>catalog([],1,0,0);
const dataHandler=({url,params})=>{
  if(url.includes('learnerCourseRpcBean')) return +params.courseType===1?catalog([course(1)]):empty();
  if(url.includes('courseBean')) return {mocTermDto:{id:101,chapters:[{quizs:[{contentType:2,test:{id:201,name:'合成测验',deadline:1893456000000}}],homeworks:[{contentType:3,test:{id:202,name:'合成作业',deadline:0}}]}]}};
  if(url.includes('getOpenQuizInfo')) return {usedTryCount:1,deadline:1893456000000};
  if(url.includes('getOpenHomeworkInfo')) return {submitStatus:1,deadline:0};
  throw Error('不允许的接口');
};
test('未登录不请求目录、不发送虚假空清单',async()=>{
  const {c,calls}=setup(()=>{throw Error('不应调用');},false);
  const result=await c.collectMooc();
  assert.match(result.issue,/尚未登录/); assert.equal(result.courses,undefined); assert.equal(calls.length,0);
});
test('官方目录字段、两类课程、提交状态和毫秒截止时间',async()=>{
  const {c,calls}=setup(dataHandler);
  const result=await c.collectMooc();
  assert.equal(result.courses.length,1); assert.equal(result.courses[0].checked,true);
  const tasks=result.courses[0].tasks;
  assert.equal(tasks[0].id,'quiz-201');
  assert.equal(tasks[0].completion,'已完成'); assert.equal(tasks[1].completion,'未完成');
  assert.equal(tasks[0].deadlineAt,'2030-01-01T00:00:00.000Z'); assert.equal(tasks[1].deadlineAt,null);
  assert.deepEqual(calls.filter(x=>x.url.includes('learnerCourseRpcBean')).map(x=>x.params.courseType),['1','2']);
  assert.equal(calls.some(x=>/Paper|submit|start|answer/i.test(x.url)),false);
  assert.equal(JSON.stringify(result).includes('synthetic-session'),false);
});
test('重复目录页失败，不返回部分目录',async()=>{
  const {c}=setup(()=>catalog([course(1)],1,2,2));
  const result=await c.collectMooc();
  assert.match(result.issue,/分页/); assert.equal(result.courses,undefined);
});
test('未知个人状态保留待核实，缺失分数不算未交',async()=>{
  const {c}=setup(call=>call.url.includes('getOpen') ? {} : dataHandler(call));
  const result=await c.collectMooc();
  assert.equal(result.courses[0].checked,true);
  assert.equal(result.courses[0].tasks[0].completion,'待核实');
  assert.match(result.issue,/待核实/);
});
test('零分是明确评分证据；详情失败保留清单与状态待核实提示',async()=>{
  const {c}=setup(call=>{
    if(call.url.includes('courseBean')) {
      const r=dataHandler(call);r.mocTermDto.chapters[0].quizs[0].test.userScore=0;return r;
    }
    if(call.url.includes('getOpen')) throw Error('合成网络失败');
    return dataHandler(call);
  });
  const result=await c.collectMooc();
  assert.equal(result.courses[0].tasks[0].completion,'已完成');
  assert.equal(result.courses[0].checked,true);
  assert.match(result.issue,/网络失败/);
});
test('完整目录所有班期均检查；不暴露内部班期对象',async()=>{
  const {c}=setup(({url,params})=>{
    if(url.includes('learnerCourseRpcBean')) return +params.courseType===1?catalog([1,2,3,4,5,6].map(course)):empty();
    return {mocTermDto:{id:+params.termId,chapters:[]}};
  });
  const first=await c.collectMooc();
  assert.equal(first.courses.filter(x=>x.checked).length,6);
  assert.equal(first.courses.some(x=>'_tid' in x || '_panel' in x),false);
});

test('个人详情明确无记录可确认未完成，缺字段或编号不符仍待核实',async()=>{
 for(const [info,expected] of [[{tid:202,aid:null,submitStatus:null},'未完成'],
   [{tid:999,aid:null,submitStatus:null},'待核实'],[{tid:202},'待核实'],[{},'待核实']]) {
  const {c}=setup(call=>call.url.includes('getOpenHomeworkInfo') ? info : dataHandler(call));
  const result=await c.collectMooc();
  assert.equal(result.courses[0].tasks[1].completion,expected);
 }
});
test('同步源课程范围不完整时只发送部分合并标记，不声称整班成功',async()=>{
 const {c}=setup(call=>{
  if(call.url.includes('learnerCourseRpcBean') && +call.params.courseType===1) {
   const row=course(1);row.termPanel.mode=10;return catalog([row]);
  }
  return dataHandler(call);
 });
 const result=await c.collectMooc();
 assert.equal(result.courses[0].checked,false);assert.equal(result.courses[0].partial,true);
 assert.equal(result.courses[0].tasks.length,2);assert.match(result.issue,/源课程/);
});
