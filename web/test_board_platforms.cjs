const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const web = process.argv[2] || __dirname;
const source = fs.readFileSync(path.join(web,'board.js'),'utf8').split('byId("bind").onsubmit')[0];
const context = vm.createContext({
  document:{addEventListener() {}},
  IntersectionObserver:class {observe() {} disconnect() {}},
  setTimeout,clearTimeout,
  localStorage:{getItem() {return null;},setItem() {}},
});
vm.runInContext(source,context);
const run = code => vm.runInContext(code,context);
context.fixture = {
  courses:[{id:'rain-1',name:'Rain',listed:true,checked:'2026-11-03'},
    {id:'mooc-1',name:'MOOC',listed:true,platform:'中国大学 MOOC',checked:''}],
  cxCourses:[{id:'cx-1',name:'CX',listed:true,platform:'学习通'}],
  assignments:[],sync:{running:false},moocSync:{checked:'',issue:''},
};
run('board=fixture');
assert.deepEqual(JSON.parse(JSON.stringify(run('courseDirectory().map(c=>[c.id,c.platform])'))),
  [['rain-1','雨课堂'],['mooc-1','中国大学 MOOC'],['cx-1','学习通']]);
run('board.courses[1].term="2026秋"');
assert.equal(run('courseTerm(board.courses[1])'),'2026秋');
assert.equal(run('completedSummary(board.courses[1],[])'),'待同步');
assert.equal(run('pendingSummary(board.courses[1],[],Date.now()).count'),'待同步');
run('board.courses[1].checked="2026-11-03"');
assert.equal(run('completedSummary(board.courses[1],[])'),'0 项');
assert.equal(run('completedSummary(board.courses[1],[{completion:"待核实"}])'),'待核实');
assert.equal(run('completedSummary(board.courses[1],[{completion:"已完成"},{completion:"待核实"}])'),'至少 1 项');
assert.equal(run('courseFeeds(board.courses[1],"","",new Set()).length'),0);
assert.match(run('platformSyncNote("中国大学 MOOC")'),/中国大学 MOOC/);
assert.doesNotMatch(run('platformSyncNote("中国大学 MOOC")'),/雨课堂|学习通/);
assert.doesNotMatch(run('platformSyncNote("雨课堂")'),/中国大学 MOOC|学习通/);
assert.match(run('platformSyncNote("")'),/中国大学 MOOC/);
run('board.moocSync={checked:"2026-11-03T00:00:00Z",issue:"部分班级读取失败"}');
assert.match(run('moocNote()'),/保留上次记录.*部分班级读取失败/);
context.task={platform:'中国大学 MOOC',completion:'未完成',deadlineAt:new Date(Date.now()+48*3600000).toISOString()};
assert.equal(run('taskKind(task)'),'unfinished');
assert.equal(run('pendingSummary(board.courses[1],[task],Date.now()).tone'),'urgent');
context.task.deadlineAt=new Date(Date.now()+96*3600000).toISOString();
assert.equal(run('pendingSummary(board.courses[1],[task],Date.now()).tone'),'later');
context.task.deadlineAt='2000-01-01T00:00:00Z';
assert.equal(run('taskKind(task)'),'missed');
assert.equal(run('pendingSummary(board.courses[1],[task],Date.now()).count'),'0 项');
console.log('PASS platform identity, unsynced/unknown/zero/completed counts, isolated status and MOOC deadline reminders: '+web);

run('platformPreferences={configured:false,selected:["rain","cx","mooc"]}');
assert.equal(run('platformEnabled("中国大学 MOOC")'),true);
assert.ok(run('courseDirectory().some(c => c.platform === "中国大学 MOOC")'));
run('platformPreferences={configured:true,selected:["pta"]}');
assert.equal(run('platformEnabled("中国大学 MOOC")'),false);
assert.equal(run('platformEnabled("PTA（拼题 A）")'),true);
assert.equal(run('connectionGuidance("pta",{enabled:true,connections:{pta:{selected:true,connected:false}}}).label'),'等待首次同步');
assert.equal(run('connectionGuidance("pta",{enabled:true,connections:{pta:{permission:false,permissionCheckedAt:new Date().toISOString()}}}).label'),'需要授权');
console.log('PASS legacy configured=false selection remains visible; selected platform is not a connection claim.');
