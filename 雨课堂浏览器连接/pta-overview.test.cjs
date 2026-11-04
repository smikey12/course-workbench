// 全部题集、日期和时间均为虚构测试值，不使用真实用户页面数据。
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
test('个人概览保留答题中待核实，不按100%或分数推定已提交',async()=>{
 const link={innerText:'合成题集 ALPHA',tagName:'A',getClientRects:()=>[1],getAttribute:k=>k==='href'?'/problem-sets/123/exam/overview':null};
 const root={innerText:'答题信息\n答题中\n答题开始时间\n2032/04/05 09:10:11\n答题结束时间\n2032/05/06 17:18:19\n100\n分数\n100 %\n答题进度',querySelectorAll:s=>s==='a[href]'?[link]:[]};
 const c=vm.createContext({URL,setTimeout,location:{href:'https://pintia.cn/problem-sets/123/exam/overview'},document:{querySelector:s=>s==='#exam-app'||s==='table tbody tr'?{}:root},getComputedStyle:()=>({display:'block',visibility:'visible'})});
 vm.runInContext(fs.readFileSync(__dirname+'/pta-reader.js','utf8'),c);const data=await c.collectPta();
 assert.equal(data.courses[0].partial,true);assert.equal(data.courses[0].checked,false);
 assert.equal(data.courses[0].tasks[0].completion,'待核实');assert.equal(data.courses[0].tasks[0].deadlineAt,'2032-05-06T17:18:19+08:00');
});
