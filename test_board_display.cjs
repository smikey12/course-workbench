// Run: node test_board_display.cjs (no browser, network or third-party dependencies).
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(__dirname+'/web/board.js','utf8').split('byId("bind").onsubmit')[0];
const context=vm.createContext({document:{addEventListener(){}},IntersectionObserver:class{observe(){}disconnect(){}},setTimeout,clearTimeout,localStorage:{getItem(){return null},setItem(){}}});
vm.runInContext(source,context);
const run=code=>vm.runInContext(code,context);
const now=Date.parse('2026-11-03T12:00:00Z');
context.now=now;
context.course={id:'pending',name:'Pending',checked:'',note:'部分读取 · 源课程尚未覆盖'};
context.tasks=[{id:'todo',courseId:'pending',completion:'未完成',deadlineAt:'2099-12-29T12:00:00Z'},
 {id:'dismissed',courseId:'pending',completion:'未完成',reminderDismissed:true,deadlineAt:'2099-12-29T12:00:00Z'}];
assert.equal(run('pendingSummary(course,tasks,now).count'),'已收录 1 项');
assert.equal(run('completedSummary(course,[])'),'待同步');
context.course.checked='2026-11-03';
assert.equal(run('pendingSummary(course,[],now).count'),'待核实');
assert.equal(run('completedSummary(course,[])'),'待核实');
context.course.note='';
assert.equal(run('pendingSummary(course,[],now).count'),'0 项');
context.rows=[];
for(let i=0;i<20;i++) context.rows.push({course:{id:'zero-'+i,name:'A zero '+i,started:'2026-10-01'},summary:{order:4},term:'2026秋',total:0});
for(const platform of ['雨课堂','学习通','中国大学 MOOC']) {
 const key='todo-'+platform;
 context.rows.push({course:{id:key,name:'Z '+platform,started:'2020-01-01'},summary:{order:2},term:'',total:1});
}
for(const mode of ['work','name','time']) {
 context.mode=mode;
 const sorted=JSON.parse(JSON.stringify(run('[...rows].sort((a,b)=>compareCourses(a,b,"2026秋",mode))')));
 assert.equal(sorted.filter(r=>r.total>0).length,3);
 assert.ok(sorted.slice(0,3).every(r=>r.total>0),mode+' keeps actual work ahead of current-term zero rows');
 assert.equal(sorted.slice(0,6).length,6);
}
context.rows=[{course:{id:'old',name:'Old'},summary:{order:0},term:'2025秋',total:4},
 {course:{id:'current',name:'Current'},summary:{order:2},term:'2026秋',total:1}];
assert.equal(run('[...rows].sort((a,b)=>compareCourses(a,b,"2026秋","work"))[0].course.id'),'current');
for(const [hours,tone] of [[1,'unfinished'],[72,'unfinished'],[72.001,'later'],[200,'later']]) {
 context.task={completion:'未完成',deadlineAt:new Date(now+hours*3600000).toISOString()};
 assert.equal(run('taskTone(task,"unfinished",now)'),tone,'Boundary '+hours);
}
assert.equal(run('taskTone({completion:"未完成"},"unfinished",now)'),'unsure');
assert.equal(run('taskTone({deadlineAt:"2000-01-01T00:00:00Z"},"unfinished",now)'),'overdue');
assert.equal(run('taskTone({},"completed",now)'),'completed');
assert.equal(run('taskKind(tasks[1])'),'dismissed');
assert.equal(run('pendingSummary(course,[tasks[1]],now).count'),'0 项');
console.log('PASS: pending-first ranking across three platforms/modes; six-row preview; term priority; partial coverage; dismissed tasks; 72h tone boundaries.');
