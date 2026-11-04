const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const source = fs.readFileSync(__dirname + "/pta-reader.js", "utf8");
function node(text = "", tagName = "TD", attrs = {}) {
  return {innerText:text, tagName, parentElement:null, hidden:false,
    getAttribute:key => attrs[key] ?? null, getClientRects:() => [1], querySelectorAll:() => []};
}
function fixture(title = "我的题集", status = "已完成") {
  const head = { ...node(), cells:[node("题集"), node("我的状态")] };
  const link = node("合成题集", "A", {href:"/problem-sets/101"});
  const row = {...node(), cells:[node("合成题集"), node(status)], querySelectorAll:() => [link]};
  const table = {...node(), rows:[head,row]};
  return {querySelectorAll:selector => selector === "h1,h2" ? [node(title,"H1")] : [table]};
}
async function run(root, url = "https://pintia.cn/") {
  const sandbox = {URL, location:{href:url}, document:{querySelector:() => root},
    getComputedStyle:() => ({display:"block",visibility:"visible"})};
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  // Execute the function serialization in a fresh world, proving it has no external lexical dependencies.
  const serialized = sandbox.collectPta.toString();
  return JSON.parse(JSON.stringify(await vm.runInContext("(" + serialized + ")()", sandbox)));
}
(async () => {
  assert.match((await run(fixture(), "https://pintia.cn/auth/login")).issue, /登录/);
  assert.equal((await run(fixture("公开题库"))).courses, undefined);
  const normal = await run(fixture());
  assert.equal(normal.courses[0].checked, false);
  assert.equal(normal.courses[0].partial, true);
  assert.equal(normal.courses[0].tasks[0].completion, "已完成");
  assert.ok(normal.issue);
  for (const raw of ["AC", "已提交", "100分", "进行中", "已结束", ""]) {
    const task = (await run(fixture("我的题集",raw))).courses[0].tasks[0];
    assert.equal(task.completion, "待核实");
    assert.ok(task.status.startsWith("待核实"));
  }
  assert.equal((await run(fixture("我的题集","未提交"))).courses[0].tasks[0].completion, "未完成");
  assert.equal((await run(fixture(), "https://evil.test/")).courses, undefined);
  console.log("PASS: serialized MAIN-world entry; login, public, normal, unknown, incomplete, origin");
})().catch(error => {console.error(error); process.exitCode = 1;});
