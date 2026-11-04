/* Self-contained MAIN-world injection entry. No fetch, cookies, storage or form values. */
async function collectPta() {
  const url = new URL(location.href);
  const fail = issue => ({issue});
  if (url.origin !== "https://pintia.cn") return fail("PTA 页面不在已授权官网域名");
  if (url.pathname.replace(/\/$/, "") === "/auth/login") return fail("PTA 登录页面，请先在浏览器登录");
  const visible = node => {
    for (let current = node; current; current = current.parentElement) {
      const style = getComputedStyle(current);
      if (current.hidden || current.getAttribute("aria-hidden") === "true" ||
          style.display === "none" || style.visibility === "hidden" ||
          ["NAV", "HEADER", "FOOTER"].includes(current.tagName)) return false;
    }
    return node.getClientRects().length > 0;
  };
  const root = document.querySelector("main, [role=main]") || document.body;
  const overview=/^\/problem-sets\/([1-9][0-9]{0,24})\/exam\/overview\/?$/.exec(url.pathname);
  if(overview && document.querySelector("#exam-app")) {
    const body=root.innerText || "";
    if(!/答题信息/.test(body) || !/答题开始时间/.test(body)) return fail("PTA 概览缺少可核验的个人答题信息");
    const link=[...root.querySelectorAll("a[href]")].find(n=>visible(n)&&new URL(n.getAttribute("href"),url).pathname===url.pathname&&n.innerText.trim()!=="概览"&&n.innerText.trim().length>2);
    const name=link?.innerText.trim();
    if(!name) return fail("PTA 个人概览缺少题集名称");
    const date=/答题结束时间\s*(20\d\d)[/-](\d{1,2})[/-](\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(body);
    const due=date ? `${date[1]}-${date[2].padStart(2,"0")}-${date[3].padStart(2,"0")}T${date[4].padStart(2,"0")}:${date[5]}:${date[6]||"00"}+08:00` : null;
    const state=/答题中/.test(body)?"答题中":/已结束/.test(body)?"已结束":"未核实";
    return {courses:[{id:overview[1],name,section:"PTA 个人题集概览",checked:false,partial:true,issue:"仅当前题集个人概览；进度或分数不能证明整份提交已完成",tasks:[{id:"set-"+overview[1],title:name,status:"待核实（页面："+state+"）",completion:"待核实",deadlineAt:due}]}],issue:"仅读取当前题集个人概览，未核验其他题集与题目明细"};
  }
  const personalTitles = ["我的题集", "我的题目", "个人题集", "My Problem Sets", "My Problems"];
  const personal = [...root.querySelectorAll("h1,h2")].some(node => visible(node) && personalTitles.includes(node.innerText.trim()));
  if (!personal) return fail("未发现受支持的个人页面证据；公开题库或尚未渲染的页面不能作为个人记录");
  const groups = new Map();
  let accepted = false;
  for (const table of root.querySelectorAll("table")) {
    if (!visible(table)) continue;
    const rows = [...table.rows].filter(visible);
    if (!rows.length) continue;
    const headers = [...rows[0].cells].map(cell => visible(cell) ? cell.innerText.trim() : "");
    const statusIndex = headers.findIndex(text => ["我的状态", "个人状态", "My Status"].includes(text));
    if (statusIndex < 0) continue;
    accepted = true;
    for (const row of rows.slice(1)) {
      if (row.cells.length !== headers.length) continue;
      const links = [...row.querySelectorAll("a[href]")].filter(visible);
      const targets = new Map();
      for (const link of links) {
        let target;
        try {target = new URL(link.getAttribute("href"), url);} catch {continue;}
        const match = /^\/problem-sets\/([1-9][0-9]{0,24})\/?$/.exec(target.pathname);
        const title = link.innerText.trim();
        if (target.origin === "https://pintia.cn" && match && title && title.length <= 500)
          targets.set(match[1], {id: match[1], title});
      }
      if (targets.size !== 1) continue;
      const {id, title} = [...targets.values()][0];
      const raw = visible(row.cells[statusIndex]) ? row.cells[statusIndex].innerText.trim() : "";
      const states = {"已完成":"已完成", "未完成":"未完成", "未提交":"未完成", "Completed":"已完成", "Not submitted":"未完成"};
      const completion = states[raw] || "待核实";
      // The backend infers status even when completion is unknown. Prefix unknown labels to prevent that fallback.
      const status = completion === "待核实" ? "待核实" + (raw ? "（页面：" + raw.slice(0, 400) + "）" : "") : completion;
      if (groups.has(id)) {
        const previous = groups.get(id);
        if (previous.tasks[0].completion !== completion) {
          previous.tasks[0].completion = "待核实";
          previous.tasks[0].status = "待核实（本页重复记录状态冲突）";
        }
        continue;
      }
      groups.set(id, {id, name:title, section:"PTA 个人题集", checked:false, partial:true,
        issue:"仅当前页题集级记录，未核验题目明细、分页与课程归属，不是完整班级清单",
        tasks:[{id:"set-" + id, title, completion, status, deadlineAt:null}]});
    }
  }
  if (!accepted) return fail("个人页面布局不受支持：未找到可核验的个人状态表格");
  // Always issue-mark partial pages so the backend cannot hide unseen courses, including zero-record pages.
  return {courses:[...groups.values()], issue:"仅读取当前页个人题集；分页和题目级进度未核验，保留旧记录"};
}
if (typeof module !== "undefined") module.exports = {collectPta};
