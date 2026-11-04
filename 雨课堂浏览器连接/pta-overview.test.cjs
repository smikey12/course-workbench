// Entire fixture is fictional, including titles, identifiers and timestamps.
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
test('个人概览保留答题中待核实，不按100%或分数推定已提交',async()=>{
 const link={innerText:'合成题集 ALPHA',tagName:'A',getClientRects:()=>[1],getAttribute:k=>k==='href'?'/problem-sets/123/exam/overview':null};
 const root={innerText:'答题信息\n答题中\n答题开始时间\n2042/04/12 09:17:23\n答题结束时间\n2042/05/06 18:42:51\n100\n分数\n100 %\n答题进度',querySelectorAll:s=>s==='a[href]'?[link]:[]};
 const c=vm.createContext({URL,location:{href:'https://pintia.cn/problem-sets/123/exam/overview'},document:{querySelector:s=>s==='#exam-app'?{}:root},getComputedStyle:()=>({display:'block',visibility:'visible'})});
 vm.runInContext(fs.readFileSync(__dirname+'/pta-reader.js','utf8'),c);const data=await c.collectPta();
 assert.equal(data.courses[0].partial,true);assert.equal(data.courses[0].checked,false);
 assert.equal(data.courses[0].tasks[0].completion,'待核实');assert.equal(data.courses[0].tasks[0].deadlineAt,'2042-05-06T18:42:51+08:00');
});
