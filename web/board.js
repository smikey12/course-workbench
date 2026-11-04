"use strict";

const byId = id => document.getElementById(id);
let board;
let busy = false;
let selectedTask = "";
let selectedCourse = "";
let detailOpen = false;
let allAlerts = false;
let directoryExpanded = false;
const PREVIEW_COURSES = 6;
const courseNames = new Intl.Collator("zh-CN", {numeric:true});
let readVersion = 0;
let syncPending = false;
let syncVersion = 0;
let platformPreferences = null;
let connectionStatus = null;
let preferencesEditing = false;
let settingsOpen = false;
// 上架后仅填写人工核验的 Edge Add-ons 正式详情页；未上架保持 null。
const EDGE_ADDONS_DETAIL_URL = null;
let currentPageExtension = false;
let extensionDetectedAt = 0;
let extensionProbeNonce = "";
let extensionProbeTimer;
function edgeStoreUrl() {
  if (!EDGE_ADDONS_DETAIL_URL) return null;
  try {const u=new URL(EDGE_ADDONS_DETAIL_URL);return u.protocol === "https:" && u.hostname === "microsoftedge.microsoft.com" && /^\/addons\/detail\/[^/]+\/[a-p]{32}$/.test(u.pathname) && !u.search && !u.hash ? u.href : null;} catch {return null;}
}
function probeCurrentExtension() {
  if (!connectionOriginSupported()) return;
  extensionProbeNonce = globalThis.crypto?.randomUUID?.() || String(Date.now())+Math.random();
  const nonce=extensionProbeNonce;
  clearTimeout(extensionProbeTimer);
  extensionProbeTimer=setTimeout(()=>{
    if (nonce !== extensionProbeNonce) return;
    currentPageExtension=false;
    renderPlatformSettings();
  },5000);
  window.postMessage({type:"kecang-extension-probe",nonce},location.origin);
}
function receiveExtensionReady(event) {
  const result=event.data;
  if (event.source === window && event.origin === location.origin && result?.type === "kecang-extension-probe-request") {probeCurrentExtension();return;}
  if (event.source !== window || event.origin !== location.origin || result?.type !== "kecang-extension-ready" || !extensionProbeNonce || result.nonce !== extensionProbeNonce || result.installed !== true) return;
  clearTimeout(extensionProbeTimer);
  const newlyDetected=!currentPageExtension;
  currentPageExtension=true;
  if (newlyDetected) extensionDetectedAt=Date.now();
  renderPlatformSettings();
  if (newlyDetected && board) run(read);
}
const connectionRequests = new Map();
const connectionFeedback = new Map();
const PLATFORMS = {cx:{name:"学习通",url:"https://mooc1.chaoxing.com/"},rain:{name:"雨课堂",url:"https://www.yuketang.cn/web"},mooc:{name:"中国大学 MOOC",url:"https://www.icourse163.org/"},pta:{name:"PTA（拼题 A）",url:"https://pintia.cn/"}};
function platformEnabled(name) {
  if (!platformPreferences) return true;
  const key = name === "PTA" ? "pta" : Object.keys(PLATFORMS).find(k => PLATFORMS[k].name === name);
  return platformPreferences.selected.includes(key);
}
function applyRouteVisibility() {
  byId("workbench-view").hidden = settingsOpen;
  byId("settings-view").hidden = !settingsOpen;
  document.title = settingsOpen ? "课藏 · 设置" : "课藏 · 作业工作台";
  for (const [id,active] of [["workbench-nav",!settingsOpen],["settings-nav",settingsOpen]]) {
    if (active) byId(id).setAttribute("aria-current","page"); else byId(id).removeAttribute("aria-current");
  }
}
function connectionGuidance(key, status) {
  if (!status) return {label:"连接状态暂不可用",next:"点击重新检查连接；已有记录不代表当前已连接。"};
  const state = status[key] || {};
  const connection = status.connections?.[key] || {};
  const message = connection.issue || state.issue || state.message || "";
  const permissionFresh = connection.permissionCheckedAt && Date.now() - Date.parse(connection.permissionCheckedAt) < 600000;
  if (permissionFresh && connection.permission === false) return {label:"需要授权",next:"打开浏览器工具栏的课藏扩展，允许读取此平台。"};
  if (status.enabled === false) return {label:"同步已暂停",next:"点击平台同步中的恢复接收，再保持浏览器运行。"};
  const problem = /失败|错误|待重试|未覆盖|部分|超时|error|failed|denied|timeout/i.test(message);
  const access = state.access;
  const freshAccess = access && access.at && Date.now() - Date.parse(access.at) < 150000;
  if (freshAccess && access.allowed === false) return {label:"需要授权",next:"打开浏览器工具栏的课藏扩展，允许读取此平台。"};
  if (/登录|login|未认证|401/i.test(message)) return {label:"需要登录或重新登录",next:"在安装扩展的同一浏览器登录平台，再重新检查。"};
  if (connection.connected === true) return {label:problem ? "已连接，部分结果待核实" : "已收到同步结果",next:(problem ? message : "") || "最近成功："+new Date(connection.lastSuccess).toLocaleString("zh-CN")+"。后续按扩展周期检查。"};
  const partialCourses = (state.courses || []).filter(c => c.attempted && /部分|仅当前|概览/.test(c.note || message));
  if (partialCourses.length) {
    const attempted = partialCourses.map(c=>c.attempted).sort().pop();
    return {label:"已保留部分读取记录",next:"上次部分读取："+new Date(attempted).toLocaleString("zh-CN")+"。尚未确认完整同步成功。"+message};
  }
  if (state.connected === false || status.extension?.connected === false) return {label:"未检测到扩展连接",next:"确认已安装并启用课藏扩展，保持浏览器运行，再重新检查。"};
  if (message && !state.directory) return {label:"尚未成功同步",next:message};
  if (problem) return {label:"部分结果待核实",next:message};
  if (state.directory) return {label:"已有同步记录",next:"最近成功："+new Date(state.directory).toLocaleString("zh-CN")+"。保持浏览器运行，等待下一轮检查。"};
  return {label:"等待首次同步",next:"尚不能确认扩展是否已安装。请安装并启用扩展；需要授权的平台在扩展中允许读取，再登录平台并等待同步。"};
}
function connectionOriginSupported() {
  return location.origin === "http://127.0.0.1:8765";
}
function requestPlatformConnection(key) {
  if (!connectionOriginSupported()) {
    connectionFeedback.set(key,"扩展仅连接 http://127.0.0.1:8765/。请从默认工作台入口连接；当前页面仍可浏览已有记录。");
    renderPlatformSettings();
    return;
  }
  if (!PLATFORMS[key] || !platformEnabled(PLATFORMS[key].name) || connectionRequests.has(key)) return;
  if (!currentPageExtension) {probeCurrentExtension();return;}
  connectionFeedback.set(key,"正在请求扩展打开连接页…");
  const timer=setTimeout(()=>{
    connectionRequests.delete(key);
    connectionFeedback.set(key,"扩展连接页暂未响应，请稍后重试；无需改变已保存的平台选择。");
    probeCurrentExtension();
    renderPlatformSettings();
  },8000);
  connectionRequests.set(key,timer);
  window.postMessage({type:"kecang-connect",platform:key},location.origin);
  renderPlatformSettings();
}
function receiveConnectionResult(event) {
  const result=event.data;
  if (event.source !== window || event.origin !== location.origin || !result || result.type !== "kecang-connect-result"
      || !PLATFORMS[result.platform] || !connectionRequests.has(result.platform) || typeof result.ok !== "boolean") return;
  clearTimeout(connectionRequests.get(result.platform));
  connectionRequests.delete(result.platform);
  connectionFeedback.set(result.platform,result.ok ? "已打开扩展连接页，请在该页确认授权。授权与登录后等待实际同步结果。" : "扩展未能打开连接页："+(result.issue || "请重新加载扩展后重试。"));
  renderPlatformSettings();
}
function renderPlatformSettings() {
  const settings = byId("platform-settings");
  if (platformPreferences) {
    if (!preferencesEditing) for (const input of document.querySelectorAll('#platform-preferences input[name="platform"]')) input.checked = platformPreferences.selected.includes(input.value);
    if (!settings.dataset.initialized) {settings.open = settingsOpen || !platformPreferences.configured; settings.dataset.initialized = "1";}
  }
  const selected = platformPreferences?.selected || [];
  const install=byId("extension-install");
  install.replaceChildren();
  install.append(node("b",currentPageExtension ? "当前页面已检测到课藏扩展" : "当前页面尚未检测到课藏扩展"));
  if (!connectionOriginSupported()) {
    const link=node("a","打开默认工作台");link.href="http://127.0.0.1:8765/#settings";link.target="_blank";link.rel="noopener noreferrer";install.append(link);
  } else if (!currentPageExtension) {
    const store=edgeStoreUrl();
    if (store) {const link=node("a","安装课藏扩展");link.href=store;link.target="_blank";link.rel="noopener noreferrer";install.append(link,node("p","在 Edge 商店确认安装后，保留本设置页，检测会自动继续。"));}
    else install.append(node("p","尚未上架，首次安装待开放。已经安装的用户请确认 Edge 中扩展已启用，并保留本页等待自动检测。"));
  } else install.append(node("p","从下方所选平台打开连接页，确认授权并登录。首次同步由扩展自动发起；实际记录到达后才显示数据状态。"));

  byId("setup-hint").hidden = !!platformPreferences && platformPreferences.configured;

  byId("preferences-message").textContent = !platformPreferences ? "暂时无法读取平台设置，请重新检查；现有课程仍可浏览。" : !platformPreferences.configured ? (selected.length ? "已沿用原有平台，请确认勾选并保存；现有课程可继续浏览。" : "首次使用，请选择需要连接的平台并保存。") : selected.length ? "已选择 "+selected.map(k=>PLATFORMS[k]?.name || k).join("、")+"，可随时修改。" : "暂未选择平台。需要连接时可在此勾选并保存。";
  const rows = [];
  const help = [];
  for (const key of selected) {
    if (!PLATFORMS[key]) continue;
    const platform = PLATFORMS[key], evidence = connectionGuidance(key, connectionStatus);
    const newPartial=(connectionStatus?.[key]?.courses || []).some(c=>Date.parse(c.attempted)>extensionDetectedAt && /部分|仅当前|概览/.test(c.note || ""));
    const newSuccess=Date.parse(connectionStatus?.connections?.[key]?.lastSuccess)>extensionDetectedAt;
    let guidance = currentPageExtension ? evidence : {label:"等待当前页面连接扩展",next:"请先完成上方扩展检测。其他浏览器或以前的同步记录不能证明此页面已连接。"};
    if (currentPageExtension && !/需要授权|需要登录|同步已暂停/.test(evidence.label) && newPartial && !newSuccess) guidance={label:"首批部分记录已入库",next:"尚未确认完整同步成功。"+(connectionStatus?.[key]?.message || "")};
    else if (currentPageExtension && !/需要授权|需要登录|同步已暂停/.test(evidence.label) && newSuccess) guidance={label:"检测扩展后已有新数据入库",next:evidence.next};
    else if (currentPageExtension && !/需要授权|需要登录|同步已暂停/.test(evidence.label) && connectionStatus?.connections?.[key]?.connected && !newSuccess) guidance={label:"已有记录，等待连接后首批数据",next:"历史同步记录不代表本次首次同步成功。请确认授权和登录，等待新结果。"};
    const row = node("div","","platform-connection");
    row.append(node("b",platform.name+" · "+guidance.label),node("p",guidance.next));
    const login = node("a","打开平台登录");login.href=platform.url;login.target="_blank";login.rel="noopener noreferrer";row.append(login);
    const connect=node("button","连接并授权");connect.type="button";
    connect.disabled=connectionRequests.has(key) || !connectionOriginSupported() || !currentPageExtension;connect.onclick=()=>requestPlatformConnection(key);
    if (!connectionOriginSupported()) {
      const explanation=node("p","扩展仅连接 127.0.0.1:8765；当前地址可继续浏览已有记录。连接与授权请使用默认入口。","muted");
      const defaultLink=node("a","打开默认工作台连接扩展");defaultLink.href="http://127.0.0.1:8765/";defaultLink.target="_blank";defaultLink.rel="noopener noreferrer";
      row.append(explanation,defaultLink);
    }
    const feedback=node("p",connectionFeedback.get(key) || (connectionOriginSupported() ? "连接页需要你点击授权；勾选平台不会自动授权。" : "当前地址不支持扩展连接，请使用上方默认入口。"),"muted");
    feedback.setAttribute("role","status");row.append(connect,feedback);
    rows.push(row);
    help.push(node("p",platform.name+"：在同一浏览器登录。"+(key === "rain" ? "确认扩展已启用。" : "打开课藏扩展，允许读取此平台。")+"等待实际同步结果，不会自动完成或提交作业。"));
  }
  byId("platform-connections").replaceChildren(...rows);
  byId("selected-platform-help").replaceChildren(...help);
  byId("connector-help").hidden = selected.length === 0;
  for (const option of byId("platform-filter").options) {option.hidden = !!option.value && !platformEnabled(option.value);option.disabled = option.hidden;}
  if (!platformEnabled(byId("platform-filter").value) && byId("platform-filter").value) byId("platform-filter").value="";
}


function taskKind(task) {
  if (task.reminderDismissed) return "dismissed";
  if (task.completion === "已完成") return "completed";
  const start = Date.parse(task.startAt);
  if (task.timeState === "未开放" || task.deadlineState === "未开放" || Number.isFinite(start) && start > Date.now()) return "upcoming";
  if ((task.platform === "PTA（拼题 A）" || task.platform === "PTA") && !task.timeState && !Number.isFinite(start)) return "unknown";
  if (task.timeState === "待核实") return "unknown";
  // 平台明确允许补交、重做时，即使过了截止时间也仍是待办。
  if (task.completion === "未完成" && task.deadlineState !== "可继续提交"
      && (task.status === "过期未做" || task.timeState === "已结束" || task.deadlineState === "已截止" || dueTime(task) <= Date.now())) return "missed";
  if (task.completion === "未完成") return "unfinished";
  return task.completion === "已完成" ? "completed" : "unknown";
}

// 只有提醒实际进入视口才开始计时；后台标签页、折叠目录和同步轮询都不算看过。
const seenPrefix = "ke-cang:missed:";
const seenInMemory = new Set();
const noticeTimers = new Map();
// 倒计时文本每次同步都会变化，不能用它作为“是否提醒过”的标识。
// 有明确截止日期时保留日期，老师改期后可以再次提醒。
const missedKey = t => seenPrefix + JSON.stringify([t.platform,t.courseId,t.id,t.deadlineAt || ""]);
function hasSeen(key) {
  try { return seenInMemory.has(key) || localStorage.getItem(key) === "1"; }
  catch { return seenInMemory.has(key); }
}
function remember(key) {
  seenInMemory.add(key);
  try { localStorage.setItem(key,"1"); } catch {}
}
function clearNoticeTimers() {
  noticeObserver.disconnect();
  for (const timer of noticeTimers.values()) clearTimeout(timer);
  noticeTimers.clear();
}
const noticeObserver = new IntersectionObserver(entries => {
  for (const {target,intersectionRatio} of entries) {
    clearTimeout(noticeTimers.get(target));
    noticeTimers.delete(target);
    if (intersectionRatio < 0.75 || document.hidden || !target.isConnected) continue;
    const dismiss = () => {
      noticeTimers.delete(target);
      if (!target.isConnected || document.hidden) return;
      // 键盘操作期间暂缓收起；移开焦点后继续，不丢失自动隐藏计时。
      if (target.contains(document.activeElement)) {
        noticeTimers.set(target,setTimeout(dismiss,1000));
        return;
      }
      remember(target.dataset.missedKey);
      // 同时出现在视口的其他提醒保留各自的计时器。
      target.remove();
      const box = document.getElementById("missed-notices");
      if (box && !box.querySelector(".missed-line")) renderTaskList();
    };
    noticeTimers.set(target,setTimeout(dismiss,8000));
  }
}, {threshold:[0.75]});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) clearNoticeTimers();
  else if (board) renderTaskList();
});
function missedNotices(tasks) {
  const box = node("div","","missed-notices");
  box.id = "missed-notices";
  box.append(node("h3","刚发现的过期作业"),node("p","在可见区域显示 8 秒后自动隐藏，同一作业不重复提醒；可在课程的「已过期」中回看。","muted"));
  for (const task of tasks) {
    const key = missedKey(task);
    const line = node("div","","missed-line");
    line.dataset.missedKey = key;
    const link = node("a",task.course + " · " + task.title);
    link.href = "#" + new URLSearchParams({course:task.courseId,task:task.id});
    link.onclick = () => remember(key);
    const hide = node("button","收起");
    hide.setAttribute("aria-label","收起提醒："+task.title);
    hide.onclick = () => { remember(key); renderTaskList(); };
    line.append(link,node("small","过期未做 · 截止 " + task.deadline),hide);
    box.append(line);
    noticeObserver.observe(line);
  }
  return box;
}

function navigate(course = "", task = "") {
  const hash = new URLSearchParams();
  if (course) hash.set("course", course);
  if (task) hash.set("task", task);
  location.hash = hash.toString();
}

function courseDirectory() {
  const courses = new Map(board.courses.map(course => [course.id, {...course, platform: course.platform || "雨课堂"}]));
  for (const course of board.cxCourses || []) courses.set(course.id,course);
  for (const task of board.assignments) {
    if (!courses.has(task.courseId)) courses.set(task.courseId, {id: task.courseId, name: task.course,
      platform: task.platform, listed: true, note: task.platform === "学习通" ? "本地核实记录" : "等待账号目录"});
  }
  return [...courses.values()].filter(course => course.listed && platformEnabled(course.platform));
}

function feedSummary(feed, count) {
  if (!feed?.checked) return feed?.issue ? "读取失败，将自动重试 · " + feed.issue : "等待首次读取";
  const checked = new Date(feed.checked).toLocaleString("zh-CN");
  const result = count ? count + " 条" : "0 条";
  return result + " · " + checked + (feed.issue ? " · 本次失败，保留上次记录" : "");
}

function courseFeeds(current, query, status, openSections) {
  if (current.platform !== "雨课堂" || status) return [];
  const logs = board.feeds?.[current.id];
  const exams = board.feeds?.exams;
  const groups = [["近期考试", exams, (exams?.items || []).filter(item => item.course === current.id)],
    ["课堂动态", logs, logs?.items || []]];
  const sections = [];
  for (const [name, source, items] of groups) {
    const match = items.filter(item => !query || current.name.toLowerCase().includes(query) || item.title.toLowerCase().includes(query));
    if (query && !match.length) continue;
    const section = node("details", "", "chapter feed");
    section.dataset.key = current.id + name;
    section.open = !!query || openSections.has(section.dataset.key);
    section.append(node("summary", name + " · " + feedSummary(source, items.length)));
    if (!match.length) section.append(node("p", source?.checked ? "上次成功读取时，此清单为空。" : "尚未取得平台清单。"));
    for (const item of match) {
      const text = node("p", "", "feed-line");
      text.append(node("b", item.title), node("small", [item.kind, item.published && new Date(item.published).toLocaleDateString("zh-CN"),
        item.due && "截止 " + new Date(item.due).toLocaleString("zh-CN")].filter(Boolean).join(" · ")));
      section.append(text);
    }
    sections.push(section);
  }
  return sections;
}

const HOUR = 3600000;

function dueTime(task) {
  const absolute = Date.parse(task.deadlineAt);
  if (Number.isFinite(absolute)) return absolute;
  // 学习通有时只给倒计时。以读取时刻为起点，刷新网页不会延长倒计时。
  const parts = /^剩余\s*(?:(\d+)\s*天\s*)?(?:(\d+)\s*小时\s*)?(?:(\d+)\s*分钟\s*)?(?:（读取时）)?$/.exec(task.deadline || "");
  if (!parts || !parts.slice(1).some(Boolean)) return NaN;
  return Date.parse(task.verified) + ((Number(parts[1] || 0) * 24 + Number(parts[2] || 0)) * 60 + Number(parts[3] || 0)) * 60000;
}

function coverageIncomplete(course) {
  return !course.checked || /部分读取|部分覆盖|尚未覆盖|清单不完整/.test(course.note || "");
}

function pendingSummary(course, tasks, now) {
  const pending = tasks.filter(t => taskKind(t) === "unfinished");
  const unknown = tasks.some(t => taskKind(t) === "unknown");
  if (!pending.length) {
    const label = tasks.some(t => taskKind(t) === "upcoming") && !unknown ? "未开放" : unknown ? "待核实" : !course.checked ? "待同步" : coverageIncomplete(course) ? "待核实" : "0 项";
    return {count:label, hint:"", tone:"quiet", order:4};
  }
  const count = (coverageIncomplete(course) ? "已收录 " : unknown ? "至少 " : "") + pending.length + " 项";
  const remaining = pending.map(t => dueTime(t) - now);
  const overdue = remaining.some(t => t <= 0) || pending.some(t => t.deadlineState === "已截止");
  const future = remaining.filter(t => t > 0);
  const next = Math.min(...future);
  if (next <= 72 * HOUR) {
    const hint = next <= HOUR ? "1 小时内截止" : next <= 24 * HOUR ? "24 小时内截止" : Math.ceil(next / (24 * HOUR)) + " 天内截止";
    return {count, hint: overdue ? hint + " · 含逾期" : hint, tone:"urgent", order:0};
  }
  if (overdue) return {count, hint:pending.some(t => t.deadlineState === "可继续提交") ? "可继续提交" : "截止待核实", tone:"urgent", order:1};
  if (remaining.some(t => !Number.isFinite(t))) return {count, hint:"截止待核实", tone:"unsure", order:3};
  return {count, hint:"距截止超过 3 天", tone:"later", order:2};
}

function completedSummary(course, tasks) {
  const completed = tasks.filter(t => taskKind(t) === "completed").length;
  const unknown = tasks.some(t => taskKind(t) === "unknown");
  if (completed) return (coverageIncomplete(course) ? "已收录 " : unknown ? "至少 " : "") + completed + " 项";
  if (!course.checked) return "待同步";
  return unknown || coverageIncomplete(course) ? "待核实" : "0 项";
}

function termForDate(day) {
  const year = Number(day.slice(0,4)), month = Number(day.slice(5,7));
  if (!year || !month) return "";
  return month === 1 ? (year-1)+"秋" : month < 9 ? year+"春" : year+"秋";
}

function courseTerm(course) {
  const caption = [course.term, course.section, course.name].filter(Boolean).join(" ");
  const term = caption.match(/(20\d\d)\s*(?:年)?\s*([春秋])/);
  if (term) return term[1] + term[2];
  const schoolYear = caption.match(/(20\d\d)[-–](20\d\d)[-–]([12])(?:学期|\b)/);
  if (schoolYear) return schoolYear[3] === "1" ? schoolYear[1]+"秋" : schoolYear[2]+"春";
  return course.started ? termForDate(course.started) : "";
}

function preferredTerm(courses, now) {
  const today = new Date(now + 8 * HOUR).toISOString().slice(0,10);
  const current = termForDate(today);
  const terms = [...new Set(courses.map(courseTerm).filter(t => t && t !== current))].sort().reverse();
  const selector = byId("preferred-term");
  const signature = [current,...terms].join(",");
  if (selector.dataset.terms !== signature) {
    const previous = selector.value;
    selector.replaceChildren(new Option("本学期 · "+current,""), ...terms.map(t => new Option(t,t)));
    if (terms.includes(previous)) selector.value = previous;
    selector.dataset.terms = signature;
  }
  return selector.value || current;
}

function workBusinessDate(record) {
  for (const field of ["publishedAt","publishAt","releasedAt","startAt","openAt","availableAt","deadlineAt","endAt"]) {
    const value=record[field];
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value)) continue;
    const time=Date.parse(value);
    if (Number.isFinite(time)) return time;
  }
  return null;
}
function latestCourseWorkTime(course, tasks) {
  const dates=tasks.map(workBusinessDate).filter(time=>time !== null);
  if (dates.length) return Math.max(...dates);
  return workBusinessDate(course);
}
function compareCourses(a,b,term,mode) {
  // 先把真实待办放在零项/待同步之前，再在两组内保留学期与下拉排序。
  // 学期未知不等于历史课程，不能让有待办的课程被本学期零项挤出默认六行。
  const pending = Number(b.total > 0) - Number(a.total > 0);
  if (pending) return pending;
  const priority = Number(b.term === term) - Number(a.term === term);
  if (priority) return priority;
  if (mode === "time") {
    // 有具体日期时精确比较；只有学期时，排在该学期有日期的课程之后。
    const timeKey = r => r.course.started || (r.term && r.term.slice(0,4)+(r.term.endsWith("秋") ? "-09-00" : "-02-00"));
    const diff = timeKey(b).localeCompare(timeKey(a));
    if (diff) return diff;
  } else if (mode === "work") {
    const diff = b.total - a.total || (b.completedTotal ?? -1) - (a.completedTotal ?? -1);
    if (diff) return diff;
    const aDate=a.latestWorkTime, bDate=b.latestWorkTime;
    if (Number.isFinite(aDate) !== Number.isFinite(bDate)) return Number.isFinite(bDate) ? 1 : -1;
    if (Number.isFinite(aDate) && aDate !== bDate) return bDate-aDate;
  }
  return courseNames.compare(a.course.name,b.course.name) || courseNames.compare(a.course.section || "",b.course.section || "") ||
    a.course.id.localeCompare(b.course.id);
}

function courseRow(course, summary, term) {
  const link = node("a", "", "course-row");
  link.href = "#" + new URLSearchParams({course:course.id});
  link.dataset.priority = summary.tone;
  const icon = node("span", "", "folder-icon");
  icon.setAttribute("aria-hidden","true");
  const name = node("span", "", "course-name");
  name.append(node("strong", course.name), node("small", [course.platform,term || "学期待核实",course.section,course.archived && "已归档"].filter(Boolean).join(" · ")));
  if (course.started) link.title = "开课日期 "+course.started;
  const pending = node("span", "", "course-pending");
  pending.append(node("b", summary.count));
  if (summary.hint) pending.append(node("small", summary.hint));
  const arrow = node("span","›","course-arrow");
  arrow.setAttribute("aria-hidden","true");
  link.append(icon,name,pending,node("b", summary.completed, "course-completed"),arrow);
  link.setAttribute("aria-label", [course.name,course.platform,course.section,"待完成 "+summary.count,summary.hint,"已完成 "+summary.completed].filter(Boolean).join("，"));
  return link;
}

function renderTaskList() {
  if (!board) return;
  clearNoticeTimers();
  document.getElementById("missed-notices")?.remove();
  const courses = courseDirectory();
  const current = courses.find(course => course.id === selectedCourse);
  const platform = byId("platform-filter").value;
  const query = byId("task-search").value.trim().toLowerCase();
  const status = byId("list-status").value;
  const matches = (task, courseMatch) => (!status || status === taskKind(task))
    && (courseMatch || task.title.toLowerCase().includes(query));
  const tasks = board.assignments.filter(t => platformEnabled(t.platform));
  const list = byId("task-list");
  const openChapters = new Set([...list.querySelectorAll("details[open]")].map(item => item.dataset.key));
  list.replaceChildren();
  byId("directory-title").textContent = current ? current.name : "平台课程目录";
  byId("back-courses").hidden = !selectedCourse;
  byId("platform-filter").disabled = !!current;
  byId("sync-panel").hidden = !!current;
  byId("directory-sort").hidden = !!current;
  byId("toggle-directory").hidden = true;
  byId("directory-info").textContent = current
    ? [current.platform, current.section, current.note, current.checked && "上次检查 " + new Date(current.checked).toLocaleString("zh-CN")].filter(Boolean).join(" · ")
    : "共 " + courses.length + " 门。点开课程查看班级作业和关联资料。";

  const urgent = tasks.filter(task => taskKind(task) === "unfinished"
    && courses.some(c => c.id === task.courseId) && (!platform || task.platform === platform)
    && matches(task, task.course.toLowerCase().includes(query)));
  byId("alerts").hidden = !!selectedCourse || !!platformPreferences && (platformPreferences.selected.length === 0);
  byId("alerts").classList.toggle("quiet", urgent.length === 0);
  byId("alerts").dataset.priority = pendingSummary({checked:true}, urgent, Date.now()).tone;
  byId("alert-note").textContent = (urgent.length ? "" : "当前范围内的已收录作业，没有符合筛选条件的未完成项。") +
    "同步状态与连接步骤请查看「设置」。" + " 已截止且未完成的作业只提醒一次，显示 8 秒后自动隐藏，可在课程的「已过期」中回看。截止满一个月的作业自动清理。";
  byId("alert-count").textContent = urgent.length + " 项";
  byId("more-alerts").hidden = urgent.length <= 3;
  byId("more-alerts").textContent = allAlerts ? "收起" : "展开全部 " + urgent.length + " 项";
  byId("urgent-tasks").replaceChildren(...(allAlerts ? urgent : urgent.slice(0, 3)).map(task => taskCard(task, "unfinished")));
  const dismissed = tasks.filter(t => t.reminderDismissed && (!platform || t.platform === platform)
    && (!query || t.course.toLowerCase().includes(query) || t.title.toLowerCase().includes(query)));
  byId("dismissed-reminders").hidden = !dismissed.length;
  byId("dismissed-reminders").querySelector("summary").textContent = "无需提醒 · " + dismissed.length + " 项（可恢复）";
  byId("dismissed-list").replaceChildren(...dismissed.map(task => {
    const line = node("div", "", "dismissed-line");
    const link = node("a", task.course + " · " + task.title);
    link.href = "#" + new URLSearchParams({course:task.courseId,task:task.id});
    const text = node("div", "");
    text.append(link,node("small",task.reminderReason + " · 平台：" + task.status));
    line.append(text,reminderButton(task));
    return line;
  }));

  const missed = tasks.filter(t => taskKind(t) === "missed" && (current ? t.courseId === current.id :
    courses.some(c => c.id === t.courseId) && (!platform || platform === t.platform)) && matches(t,t.course.toLowerCase().includes(query)));
  const fresh = missed.filter(t => !hasSeen(missedKey(t)));
  if (!status && !query && !detailOpen && fresh.length) {
    (current ? list : byId("alerts")).append(missedNotices(fresh));
  }

  if (current) {
    for (const [kind, label] of [["unfinished", "未完成"], ["upcoming", "未开放"], ["unknown", "待核实"], ["completed", "已完成"], ["dismissed", "无需提醒"]]) {
      const group = tasks.filter(task => task.courseId === current.id && taskKind(task) === kind && matches(task, current.name.toLowerCase().includes(query)));
      if (!group.length) continue;
      const heading = node("h3", label + " · " + group.length + " 项", "group-heading");
      heading.dataset.kind = kind;
      const grid = node("div", "", "task-grid");
      grid.append(...group.map(task => taskCard(task, kind)));
      list.append(heading, grid);
    }
    if (missed.length) {
      const history = node("details","","chapter missed-history");
      history.dataset.key = current.id + "/missed";
      history.open = !!query || status === "missed" || openChapters.has(history.dataset.key);
      history.append(node("summary","已过期 · "+missed.length+" 项"));
      for (const task of missed) {
        const link = node("a",task.title+" · 截止 "+task.deadline);
        link.href = "#" + new URLSearchParams({course:current.id,task:task.id});
        link.onclick = () => remember(missedKey(task));
        history.append(link);
      }
      list.append(history);
    }
    if (!list.childElementCount) list.append(node("p", status || query ? "没有匹配的作业。" : current.note));
    list.append(...courseFeeds(current, query, status, openChapters));
    if (current.outline?.length && !status && !query) {
      list.append(node("h3", "课程章节"));
      const entries = (items, parent) => items.map((item, i) => {
        const key = parent + "/" + i;
        if (item.children?.length) {
          const folder = node("details", "", "chapter");
          folder.dataset.key = key;
          folder.open = openChapters.has(key);
          folder.append(node("summary", item.title), ...entries(item.children, key));
          return folder;
        }
        const task = item.type === 6 && tasks.find(t => t.courseId === current.id && t.leaf === item.leaf);
        if (task) {
          const link = node("button", "作业 · " + item.title);
          link.onclick = () => navigate(current.id, task.id);
          return link;
        }
        const typeName = {0:"视频", 3:"图文", 4:"讨论", 6:"作业", 10:"资料"}[item.type] || "学习单元";
        return node("p", typeName + " · " + item.title);
      });
      list.append(...entries(current.outline, current.id));
    }
  } else {
    const rows = [];
    const now = Date.now();
    const term = preferredTerm(courses,now);
    for (const course of courses) {
      if (platform && course.platform !== platform) continue;
      const own = tasks.filter(task => task.courseId === course.id);
      const courseMatch = (course.name + (course.section || "")).toLowerCase().includes(query);
      const feedMatch = !status && !courseMatch && (board.feeds?.[course.id]?.items || []).concat(
        (board.feeds?.exams?.items || []).filter(item => item.course === course.id))
        .some(item => item.title.toLowerCase().includes(query));
      if ((status || !courseMatch) && !feedMatch && !own.some(task => matches(task, courseMatch))) continue;
      const summary = pendingSummary(course, own, now);
      summary.completed = completedSummary(course, own);
      const total = own.filter(t => taskKind(t) === "unfinished").length;
      const completed=own.filter(t=>taskKind(t) === "completed").length;
      rows.push({course, summary, term:courseTerm(course), total: total || (summary.count === "0 项" ? 0 : -1),
        completedTotal:completed || (summary.completed === "0 项" ? 0 : -1), latestWorkTime:latestCourseWorkTime(course,own)});
    }
    const visible = directoryExpanded ? rows.length : Math.min(PREVIEW_COURSES,rows.length);
    byId("directory-info").textContent = "有待办优先 · "+term+" 优先 · 显示 "+visible+" / "+rows.length+" 门" +
      (rows.length !== courses.length ? "（全部 "+courses.length+" 门）" : "");
    if (!rows.length) { list.append(node("p", platformPreferences && (!platformPreferences.selected.length) ? "尚未选择平台，请使用顶部「设置」入口选择并保存。" : "没有匹配的课程；尚未同步时，请按上方连接提示操作。")); return; }
    const directory = node("div", "", "directory-rows");
    const labels = node("div", "", "directory-columns");
    labels.append(node("span","课程名称"),node("span","待完成"),node("span","已完成"));
    directory.append(labels);
    rows.sort((a,b) => compareCourses(a,b,term,byId("course-sort").value));
    directory.append(...rows.slice(0,visible).map(({course,summary,term}) => courseRow(course,summary,term)));
    list.append(directory);
    const toggle = byId("toggle-directory");
    toggle.hidden = rows.length <= PREVIEW_COURSES;
    toggle.textContent = directoryExpanded ? "收起，只显示前 6 门 ▴" : "展开其余 "+(rows.length-visible)+" 门课程 ▾";
    toggle.setAttribute("aria-expanded",String(directoryExpanded));
  }
}

function taskTone(task, kind, now = Date.now()) {
  if (kind !== "unfinished") return kind;
  if (task.timeState === "未开放" || Date.parse(task.startAt) > now) return "upcoming";
  if (task.timeState === "待核实") return "unsure";
  const due = dueTime(task);
  if (task.deadlineState === "已截止" || Number.isFinite(due) && due <= now) return "overdue";
  if (!Number.isFinite(due)) return "unsure";
  return due - now <= 72 * HOUR ? "unfinished" : "later";
}

function taskCard(task, kind) {
    const card = node("div", "", "task-card");
    const button = node("button", "", "task-summary");
    button.dataset.kind = kind;
    const tone = taskTone(task, kind);
    button.dataset.priority = tone === "unfinished" || tone === "overdue" ? "urgent" : tone;
    const icon = tone === "completed" ? "✓ " : tone === "unknown" ? "? " : "! ";
    button.append(node("small", task.platform + " · " + task.course),
      node("b", task.title), node("span", icon + (kind === "upcoming" ? "未开放" : kind === "unknown" && (task.platform === "PTA（拼题 A）" || task.platform === "PTA") && (!task.timeState || task.timeState === "待核实") ? "开放状态待核实 · "+task.completion : task.status), "pill"),
      node("span", "截止 " + task.deadline, "card-deadline"));
    if (task.startAt) button.append(node("span","开放 "+new Date(task.startAt).toLocaleString("zh-CN"),"card-deadline"));
    button.title = "最近读取 " + task.verified;
    button.querySelector(".pill").dataset.tone = tone;
    button.onclick = () => navigate(task.courseId, task.id);
    card.append(button);
    if (kind === "unfinished" || kind === "unknown" || kind === "dismissed") card.append(reminderButton(task));
    return card;
}

function reminderButton(task) {
  const button = node("button",task.reminderDismissed ? "恢复提醒" : "无需提醒","reminder-action");
  button.type = "button";
  button.setAttribute("aria-label",button.textContent + "：" + task.title);
  button.onclick = () => saveReminder(task.id,!task.reminderDismissed);
  return button;
}

function saveReminder(taskId, dismissed) {
  return run(async () => {
    const response = await fetch("/api/reminder", {method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({task:taskId,dismissed})});
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "提醒设置保存失败");
    await read();
    byId("notice").textContent = dismissed ? "已设为无需提醒，可在「无需提醒」中恢复。" : "已恢复提醒，将按平台状态判断是否待完成。";
  });
}

function node(tag, text, className) {
  const item = document.createElement(tag);
  item.textContent = text;
  if (className) item.className = className;
  return item;
}
function size(bytes) {
  return bytes < 1024 ? bytes + " B" : (bytes / 1024).toFixed(2) + " KB";
}
function row(name, path, note) {
  const item = node("div", "", "file");
  const text = node("div", "");
  text.append(node("b", name), node("div", path, "path"), node("small", note));
  item.append(text);
  return item;
}
function action(label, role, path, operation) {
  const button = node("button", label);
  button.onclick = () => save(role, path, operation);
  return button;
}
function linkedRow(link) {
  const name = link.path.split(/[\\/]/).pop();
  const description = [link.available ? "本地文件可用" : "原路径已失效，请重新关联", link.basis].join(" · ");
  const item = row(name, link.path, description);
  item.append(action("解除关联", link.role, link.path, "unlink"));
  return item;
}
function renderInbox() {
  if (!board) return;
  const query = byId("find").value.trim().toLowerCase();
  const available = board.files.filter(f => !f.precleaned);
  const files = available.filter(f => f.relative.toLowerCase().includes(query));
  const materials = new Set(board.links.filter(l => l.role === "material").map(l => l.path.toLowerCase()));
  const list = byId("files");
  list.replaceChildren();
  byId("total").textContent = files.length + " / " + available.length;
  for (const file of files) {
    const notes = [size(file.size), new Date(file.modified * 1000).toLocaleDateString("zh-CN")];
    if (file.duplicates.length) notes.push("内容相同的其他文件：" + file.duplicates.join("、"));
    const item = row(file.relative, file.path, notes.join(" · "));
    if (materials.has(file.path.toLowerCase())) item.append(node("span", "已关联此作业", "tag"));
    else item.append(action("关联为作业资料", "material", file.path, "link"));
    list.append(item);
  }
  if (!files.length) list.append(node("p", query ? "没有匹配的下载文件。" : "本次未读到下载文件。"));
}
function renderCleanup() {
  const archived = board.files.filter(f => f.precleaned);
  const candidates = board.files.filter(f => f.cleanupCandidate);
  byId("cleanup-folder").textContent = board.cleanupFolder || ((board.inbox || "data/inbox") + "/预清理");
  byId("cleanup-count").textContent = "（待移入 " + candidates.length + "，已移入 " + archived.length + "）";
  byId("cleanup-move").disabled = !candidates.length;
  const list = byId("cleanup-files");
  list.replaceChildren();
  for (const file of [...candidates, ...archived]) {
    const item = row(file.relative, file.path, size(file.size) + " · " +
      (file.precleaned ? "已移入预清理" : "待移入 · 最近使用 " + new Date(file.lastUsed * 1000).toLocaleDateString("zh-CN")));
    if (file.precleaned) {
      const button = node("button", "恢复原位");
      button.onclick = () => cleanInbox("restore", file.path);
      item.append(button);
    }
    list.append(item);
  }
  if (!list.children.length) list.append(node("p", "当前没有符合条件或已移入的文件。"));
}
function render() {
  renderCleanup();
  const task = board.task;
  byId("assignment").hidden = byId("inbox").hidden = !(detailOpen && task.id === selectedTask);
  if (task.id && !platformEnabled(task.platform)) {
    byId("assignment").hidden = byId("inbox").hidden = true;
    if (detailOpen) byId("notice").textContent = "该平台未被选择，可在连接平台设置中启用。";
    renderTaskList();
    return;
  }
  if (!task.id) {
    if (detailOpen) byId("notice").textContent = "这项作业已清理或不在当前清单中。";
    renderTaskList();
    return;
  }
  byId("title").textContent = task.title;
  byId("course").textContent = board.course;
  byId("status").textContent = task.displayStatus || [task.deadlineState, task.platformStatus].filter(Boolean).join(" · ");
  const completed = task.completionState === "已完成";
  const unfinished = task.completionState === "未完成";
  const tone = taskTone({...task, deadline:task.deadlineDisplayed, verified:board.verified},
    completed ? "completed" : unfinished ? "unfinished" : "unknown");
  const icon = completed ? "✓ " : unfinished ? "! " : "? ";
  byId("status").dataset.tone = tone;
  byId("status").textContent = icon + byId("status").textContent;
  byId("completion").textContent = task.completionState || task.platformStatus;
  byId("completion").dataset.tone = tone;
  byId("completion").textContent = icon + byId("completion").textContent;
  byId("time-state").textContent = task.timeState || task.deadlineState || "以平台记录为准";
  byId("deadline-label").textContent = task.deadlineLabel || "平台截止时间";
  byId("due").textContent = task.deadlineDisplayed;
  byId("source").textContent = task.platform + " · " + task.platformFilter;
  byId("progress").textContent = task.progressDisplayed || "未记录";
  byId("verified").textContent = "平台核实记录 " + board.verified + " · 截止时间按平台原样显示。刷新按钮只更新本地文件。";
  byId("platform-note").textContent = (task.startAt ? "开放时间："+new Date(task.startAt).toLocaleString("zh-CN")+"。" : "")+(task.statusBasis || task.statusNote || "");
  byId("reminder-note").textContent = task.reminderDismissed
    ? "无需提醒 · " + task.reminderReason + "。平台状态保留，不计入待完成数。"
    : "如已通过其他形式完成，或无需完成，可设为无需提醒；以后同步仍保留此设置。";
  byId("reminder-toggle").textContent = task.reminderDismissed ? "恢复提醒" : "无需提醒";
  byId("reminder-toggle").onclick = () => saveReminder(task.id,!task.reminderDismissed);
  byId("local-report").hidden = !task.localReportSupported;
  const sourceLink = byId("platform-link");
  sourceLink.hidden = !task.url;
  if (task.url) sourceLink.href = task.url;
  else sourceLink.removeAttribute("href");
  byId("uploaded").textContent = task.platform + "答题区附件：" + (task.answerAttachmentObserved || "未记录");
  const report = board.links.find(l => l.role === "report");
  byId("report").replaceChildren(report ? linkedRow(report) : node("p", "待关联本地原件", "tag"));
  byId("expected").replaceChildren(...task.teacherAttachments.map(a => node("p", "老师发布：" + a.name + "（" + a.displayedSize + "）")));
  if (task.attachmentsNote) byId("expected").append(node("small", task.attachmentsNote));
  const materials = board.links.filter(l => l.role === "material");
  byId("materials").replaceChildren(...materials.map(linkedRow));
  if (!materials.length) byId("materials").append(node("small", "可在下载收件箱中选择本次作业的资料。"));
  byId("package").disabled = !board.links.length || board.links.some(link => !link.available);
  byId("package-note").textContent = board.links.some(link => !link.available) ? "有原件已失效，请先更新关联。" :
    board.links.length ? "将这 " + board.links.length + " 个已关联文件复制到 ZIP 中。" : "先关联本机报告或资料即可打包。";
  byId("scan").textContent = board.inbox + " · 本地读取于 " + new Date(board.scanned).toLocaleString("zh-CN");
  byId("warnings").textContent = board.warnings.join("；");
  renderInbox();
  renderTaskList();
}
function renderSync(sync) {
  renderPlatformSettings();
  byId("cx-status").hidden = !platformEnabled("学习通");
  byId("mooc-status").hidden = !platformEnabled("中国大学 MOOC");
  byId("feed-status").hidden = !platformEnabled("雨课堂");
  for (const id of ["sync-message","sync-scope","sync-time"]) byId(id).hidden = !!platformPreferences;

  const history = (board.courseScope || []).filter(c => platformEnabled(c.platform));
  const box = byId("course-history");
  box.hidden = history.length === 0;
  box.querySelector("summary").textContent = "历史班级 · 已跳过 "+history.filter(c => !c.pinned).length+" 个";
  byId("scope-list").replaceChildren(...history.map(course => {
    const line = node("div","","file");
    const label = node("div",course.platform+" · "+course.name);
    label.append(node("small",course.reason || "已手动保留"));
    const button = node("button",course.pinned ? "按默认规则同步" : "恢复同步");
    button.onclick = () => run(async () => {
      const response = await fetch("/api/sync/course-scope",{method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({id:course.id,keep:!course.pinned})});
      if (!response.ok) throw new Error("无法更新班级范围，请刷新工作台。");
      await read();
    });
    line.append(label,button);
    return line;
  }));
  const start = byId("sync-start");
  start.textContent = sync.running ? "已连接" : sync.enabled ? "查看连接步骤" : "恢复接收";
  start.disabled = sync.running || syncPending;
  byId("sync-stop").disabled = !sync.enabled || syncPending;
  const message = byId("sync-message");
  message.textContent = sync.message;
  message.dataset.state = sync.running ? "connected" : sync.enabled ? "waiting" : "paused";
  byId("sync-scope").textContent = "当前覆盖范围 · " + sync.scope;
  byId("sync-time").textContent = "最近目录检查 · " + (sync.lastSuccess ? new Date(sync.lastSuccess).toLocaleString("zh-CN") : "尚无成功同步");
  byId("cx-status").textContent = learningNote() + (board.cxSync?.checked ? " 最近目录检查 "+new Date(board.cxSync.checked).toLocaleString("zh-CN") : "");
  byId("mooc-status").textContent = moocNote();
  const examFeed = board.feeds?.exams;
  const rainCourses = board.courses.filter(c => c.listed && (c.platform || "雨课堂") === "雨课堂");
  const ids = new Set(rainCourses.map(c => c.id));
  const unassigned = (examFeed?.items || []).filter(item => !ids.has(item.course));
  const checked = rainCourses.filter(c => board.feeds?.[c.id]?.checked).length;
  const failed = rainCourses.filter(c => board.feeds?.[c.id]?.issue).length;
  byId("feed-status").textContent = "课堂动态已有记录的班级 " + checked + "/" + ids.size +
    (failed ? "（" + failed + " 门待重试）" : "") + "。近期考试清单 · " + feedSummary(examFeed, examFeed?.items.length || 0) +
    (unassigned.length ? "。待匹配班级的考试：" + unassigned.map(item => item.title).join("、") : "");
}
function moocNote() {
  const state = board.moocSync || {};
  const courses = courseDirectory().filter(c => c.platform === "中国大学 MOOC");
  const checked = courses.filter(c => c.checked).length;
  const coverage = "中国大学 MOOC · 已检查作业 " + checked + "/" + courses.length + " 门";
  if (state.issue) return coverage + " · " + (state.checked ? "本次未全部成功，保留上次记录" : "首次同步尚未全部成功") + " · " + state.issue;
  if (!state.checked) return coverage + " · 等待首次成功同步，以各课程检查时间为准。";
  return coverage + " · 最近全部成功 " + new Date(state.checked).toLocaleString("zh-CN") + "。";
}
function platformSyncNote(platform) {
  const notes=[];
  if (platformEnabled("雨课堂") && (!platform || platform === "雨课堂")) notes.push(board.sync.running ? "雨课堂按课程轮流更新。" : "雨课堂显示上次读取的记录。");
  if (platformEnabled("学习通") && (!platform || platform === "学习通")) notes.push(learningNote());
  if (platformEnabled("中国大学 MOOC") && (!platform || platform === "中国大学 MOOC")) notes.push(moocNote());
  if (platformEnabled("PTA（拼题 A）") && (!platform || platform === "PTA（拼题 A）" || platform === "PTA")) {const state=connectionGuidance("pta",connectionStatus);notes.push("PTA · "+state.label+" · "+state.next);}
  return " " + notes.join(" ");
}
function learningNote() {
  const courses=board.cxCourses || [];
  if (!board.cxSync?.checked) return " 学习通"+(board.cxSync?.issue ? " · "+board.cxSync.issue : "等待浏览器连接，目前显示已有记录。");
  const checked=courses.filter(c=>c.checked).length;
  const retry=courses.filter(c=>c.note.startsWith("待重试")).length;
  return " 学习通最近记录覆盖 "+checked+"/"+courses.length+" 个班级"+(retry ? "，"+retry+" 门待重试" : "")+
    (board.cxSync.issue ? " · "+board.cxSync.issue : "")+"。";
}
async function read() {
  const version = syncVersion;
  const requestId = ++readVersion;
  const response = await fetch("/api/workbench?task=" + encodeURIComponent(selectedTask));
  if (!response.ok) throw new Error("无法读取工作台，请确认新版服务已启动，核实记录仍在工具目录。");
  const result = await response.json();
  const [preferences, status] = await Promise.all(["/api/platform-preferences","/api/sync/status"].map(async path => {
    try {const reply=await fetch(path);return reply.ok ? await reply.json() : null;} catch {return null;}
  }));
  if (requestId !== readVersion) return;
  if (version !== syncVersion || syncPending) result.sync = board?.sync || result.sync;
  if (preferences && typeof preferences.configured === "boolean" && Array.isArray(preferences.selected)) platformPreferences = preferences;
  connectionStatus = status;
  board = result;
  renderPlatformSettings();
  // 平台延长截止或清走旧作业时，也释放对应的本地已读标记。
  const active = new Set(board.assignments.filter(t => taskKind(t) === "missed").map(missedKey));
  for (const key of seenInMemory) if (!active.has(key)) seenInMemory.delete(key);
  try {
    for (const key of Object.keys(localStorage)) if (key.startsWith(seenPrefix) && !active.has(key)) localStorage.removeItem(key);
  } catch {}
  render();
  if (!syncPending) renderSync(board.sync);
}
async function run(operation) {
  if (busy) return;
  busy = true;
  byId("refresh").disabled = true;

  try { byId("notice").textContent = ""; await operation(); }
  catch (error) { byId("notice").textContent = error.message; }
  finally {
    busy = false;
    byId("refresh").disabled = false;

  }
}
function save(role, path, operation) {
  return run(async () => {
    const response = await fetch("/api/association", {
      method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify({role, path, action: operation, task: selectedTask})
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "保存关联失败");
    if (role === "report") byId("report-path").value = "";
    await read();
    byId("notice").textContent = operation === "link" ? "已保存文件关联。" : "已解除关联，原文件保留在原处。";
  });
}
byId("bind").onsubmit = e => { e.preventDefault(); save("report", byId("report-path").value, "link"); };
byId("platform-preferences").onchange = () => {preferencesEditing = true;};
byId("platform-preferences").onsubmit = e => {
  e.preventDefault();
  const selected=[...document.querySelectorAll('#platform-preferences input[name="platform"]')].filter(input=>input.checked).map(input=>input.value);
  run(async()=>{
    const response=await fetch("/api/platform-preferences",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({selected})});
    if (!response.ok) throw new Error("平台选择保存失败，请确认新版服务已启动后重试。");
    preferencesEditing=false;
    platformPreferences={configured:true,selected};
    byId("platform-filter").value="";
    await read();
  });
};
byId("retry-platforms").onclick = () => run(read);
window.addEventListener("message",receiveConnectionResult);
window.addEventListener("message",receiveExtensionReady);
setInterval(probeCurrentExtension,10000);
probeCurrentExtension();
byId("find").oninput = renderInbox;
function cleanInbox(action, path) {
  return run(async () => {
    const response = await fetch("/api/inbox/cleanup", {method:"POST", headers:{"Content-Type":"application/json"},
      body:JSON.stringify({action, path})});
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "预清理操作失败");
    await read();
    byId("cleanup-result").textContent = action === "restore" ? "已恢复原位，并记录本次使用。" :
      "已移入 " + result.moved + " 个文件。" + result.warnings.join("；");
  });
}
byId("cleanup-move").onclick = () => cleanInbox("move");
byId("package").onclick = () => run(async () => {
  const response = await fetch("/api/package", {method:"POST", headers:{"Content-Type":"application/json"},
    body:JSON.stringify({task:selectedTask})});
  if (!response.ok) throw new Error((await response.json()).error || "打包失败");
  const link = node("a", "");
  const url = URL.createObjectURL(await response.blob());
  link.href = url;
  link.download = decodeURIComponent(response.headers.get("Content-Disposition").split("''")[1]);
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  byId("notice").textContent = "资料包已交给浏览器下载。";
});
byId("refresh").onclick = () => run(read);
async function openRoute() {
  const route = new URLSearchParams(location.hash.slice(1));
  settingsOpen = location.hash === "#settings" || route.get("page") === "settings";
  applyRouteVisibility();
  if (settingsOpen) byId("platform-settings").open = true;
  selectedCourse = settingsOpen ? "" : route.get("course") || "";
  detailOpen = !!selectedCourse && !!route.get("task");
  selectedTask = detailOpen ? route.get("task") : "";
  byId("report-path").value = "";
  byId("assignment").hidden = byId("inbox").hidden = true;
  byId("task-search").value = byId("list-status").value = "";
  byId("notice").textContent = "";
  try {
    await read();
    if (settingsOpen) {byId("settings-title").focus();window.scrollTo(0,0);}
    else if (detailOpen && !byId("assignment").hidden) {
      byId("assignment").focus();
      byId("assignment").scrollIntoView({block: "start"});
    } else window.scrollTo(0, 0);
  } catch (error) {
    byId("notice").textContent = error.message;
    byId("back-courses").hidden = false;
  }
}
window.addEventListener("hashchange", openRoute);
byId("back-courses").onclick = () => navigate();
byId("back-course").onclick = () => navigate(selectedCourse);
byId("more-alerts").onclick = () => { allAlerts = !allAlerts; renderTaskList(); };
function resetDirectory() { directoryExpanded = false; renderTaskList(); }
byId("platform-filter").onchange = resetDirectory;
byId("task-search").oninput = resetDirectory;
byId("list-status").onchange = resetDirectory;
byId("preferred-term").onchange = resetDirectory;
byId("course-sort").onchange = resetDirectory;
byId("toggle-directory").onclick = () => {
  directoryExpanded = !directoryExpanded;
  renderTaskList();
  if (!directoryExpanded) byId("directory-title").scrollIntoView({block:"nearest"});
};
async function controlSync(action) {
  if (syncPending) return;
  syncPending = true;
  syncVersion++;
  byId("sync-start").disabled = byId("sync-stop").disabled = true;
  byId("sync-error").textContent = "";
  byId("sync-message").textContent = action === "start" ? "正在恢复接收…" : "正在暂停接收…";
  try {
    const response = await fetch("/api/sync/" + action, {
      method:"POST", headers:{"Content-Type":"application/json"}, body:"{}"
    });
    if (!response.ok) throw new Error("同步操作失败，请刷新工作台后重试。");
    board.sync = await response.json();
    if (action === "start" && !board.sync.running) byId("connector-help").open = true;
  } catch (error) {
    byId("sync-error").textContent = "未能更改接收状态。" + error.message;
  } finally {
    syncPending = false;
    renderSync(board.sync);
  }
}
byId("sync-start").onclick = () => {
  if (!board.sync.enabled) return controlSync("start");
  const help = byId("connector-help");
  help.open = true;
  help.querySelector("summary").focus();
  help.scrollIntoView({block: "nearest"});
};
byId("sync-stop").onclick = () => controlSync("stop");
setInterval(() => { if (!busy && !document.hidden) run(read); }, 15000);
openRoute();
