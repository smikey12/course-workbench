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

function taskKind(task) {
  if (task.reminderDismissed) return "dismissed";
  // 平台明确允许补交、重做时，即使过了截止时间也仍是待办。
  if (task.completion === "未完成" && task.deadlineState !== "可继续提交"
      && (task.status === "过期未做" || task.deadlineState === "已截止" || dueTime(task) <= Date.now())) return "missed";
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
  const courses = new Map(board.courses.map(course => [course.id, {...course, platform: "雨课堂"}]));
  for (const course of board.cxCourses || []) courses.set(course.id,course);
  for (const task of board.assignments) {
    if (!courses.has(task.courseId)) courses.set(task.courseId, {id: task.courseId, name: task.course,
      platform: task.platform, listed: true, note: task.platform === "学习通" ? "本地核实记录" : "等待账号目录"});
  }
  return [...courses.values()].filter(course => course.listed);
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

function pendingSummary(course, tasks, now) {
  const pending = tasks.filter(t => taskKind(t) === "unfinished");
  const unknown = tasks.some(t => taskKind(t) === "unknown");
  if (!pending.length) {
    const label = unknown ? "待核实" : !course.checked ? "待同步" : "0 项";
    return {count:label, hint:"", tone:"quiet", order:4};
  }
  const count = (unknown ? "至少 " : "") + pending.length + " 项";
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

function termForDate(day) {
  const year = Number(day.slice(0,4)), month = Number(day.slice(5,7));
  if (!year || !month) return "";
  return month === 1 ? (year-1)+"秋" : month < 9 ? year+"春" : year+"秋";
}

function courseTerm(course) {
  const caption = course.section + " " + course.name;
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

function compareCourses(a,b,term,mode) {
  // 学期始终为第一排序条件，其他条件只影响同一优先组内的顺序。
  const priority = Number(b.term === term) - Number(a.term === term);
  if (priority) return priority;
  if (mode === "time") {
    // 有具体日期时精确比较；只有学期时，排在该学期有日期的课程之后。
    const timeKey = r => r.course.started || (r.term && r.term.slice(0,4)+(r.term.endsWith("秋") ? "-09-00" : "-02-00"));
    const diff = timeKey(b).localeCompare(timeKey(a));
    if (diff) return diff;
  } else if (mode === "work") {
    const diff = b.total - a.total || a.summary.order - b.summary.order;
    if (diff) return diff;
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
  const tasks = board.assignments;
  const list = byId("task-list");
  const openChapters = new Set([...list.querySelectorAll("details[open]")].map(item => item.dataset.key));
  list.replaceChildren();
  byId("directory-title").textContent = current ? current.name : "平台课程目录";
  if (selectedCourse && !current) byId("notice").textContent = "这门课程尚未同步或已不在当前目录中，可返回全部课程。";
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
  byId("alerts").hidden = !!selectedCourse || !courses.length;
  byId("alerts").classList.toggle("quiet", urgent.length === 0);
  byId("alert-note").textContent = (urgent.length ? "" : "当前范围内的已收录作业，没有符合筛选条件的未完成项。") +
    (platform === "学习通" ? learningNote() :
    (board.sync.running ? " 雨课堂按课程轮流更新。" : " 雨课堂显示上次读取的记录。") +
    (!platform ? learningNote() : "")) + " 已截止且未完成的作业只提醒一次，显示 8 秒后自动隐藏，可在课程的「已过期」中回看。截止满一个月的作业自动清理。";
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
    for (const [kind, label] of [["unfinished", "未完成"], ["unknown", "待核实"], ["completed", "已完成"], ["dismissed", "无需提醒"]]) {
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
    if (!list.childElementCount) list.append(node("p", status || query ? "没有匹配的作业。" : current.note || (current.checked ? "上次检查时没有收录作业。" : "课程目录已读取，正在等待首次作业检查。")));
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
      const completed = own.filter(t => taskKind(t) === "completed").length;
      summary.completed = completed || course.checked ? completed + " 项" : "待同步";
      const total = own.filter(t => taskKind(t) === "unfinished").length;
      rows.push({course, summary, term:courseTerm(course), total: total || (summary.count === "0 项" ? 0 : -1)});
    }
    const visible = directoryExpanded ? rows.length : Math.min(PREVIEW_COURSES,rows.length);
    byId("directory-info").textContent = term+" 优先 · 显示 "+visible+" / "+rows.length+" 门" +
      (rows.length !== courses.length ? "（全部 "+courses.length+" 门）" : "");
    if (!rows.length) {
      if (courses.length) list.append(node("p", "没有匹配的课程。试试清除搜索或筛选。"));
      else {
        byId("directory-info").textContent = "尚未同步平台课程";
        const empty = node("div", "", "empty-state");
        empty.append(node("h3", "从连接课程平台开始"),
          node("p", "安装浏览器扩展并登录课程平台后，课程会自动出现在这里。点开课程即可查看作业与详情。"));
        const help = node("button", "查看连接步骤");
        help.type = "button";
        help.onclick = () => {
          byId("connector-help").open = true;
          byId("connector-help").querySelector("summary").focus();
          byId("connector-help").scrollIntoView({block:"nearest"});
        };
        empty.append(help);
        list.append(empty);
      }
      return;
    }
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

function taskCard(task, kind) {
    const card = node("div", "", "task-card");
    const button = node("button", "", "task-summary");
    button.dataset.kind = kind;
    const tone = kind === "unfinished" && task.deadlineState === "已截止" ? "overdue" : kind;
    const icon = tone === "completed" ? "✓ " : tone === "unknown" ? "? " : "! ";
    button.append(node("small", task.platform + " · " + task.course),
      node("b", task.title), node("span", icon + task.status, "pill"),
      node("span", "截止 " + task.deadline, "card-deadline"));
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
  byId("cleanup-folder").textContent = board.cleanupFolder || "尚未配置下载收件箱";
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
  const task = board.task || {};
  byId("assignment").hidden = byId("inbox").hidden = !(detailOpen && task.id === selectedTask);
  if (!detailOpen || !task.id || task.id !== selectedTask) {
    if (detailOpen) byId("notice").textContent = "这项作业已清理或不在当前清单中。";
    renderTaskList();
    return;
  }
  byId("title").textContent = task.title;
  byId("course").textContent = board.course;
  byId("status").textContent = task.displayStatus || [task.deadlineState, task.platformStatus].filter(Boolean).join(" · ");
  const completed = task.completionState === "已完成";
  const unfinished = task.completionState === "未完成";
  const overdue = unfinished && task.deadlineState === "已截止";
  const tone = completed ? "completed" : overdue ? "overdue" : unfinished ? "unfinished" : "unknown";
  const icon = completed ? "✓ " : unfinished ? "! " : "? ";
  byId("status").dataset.tone = tone;
  byId("status").textContent = icon + byId("status").textContent;
  byId("completion").textContent = task.completionState || task.platformStatus;
  byId("completion").dataset.tone = tone;
  byId("completion").textContent = icon + byId("completion").textContent;
  byId("time-state").textContent = task.deadlineState || "以平台记录为准";
  byId("deadline-label").textContent = task.deadlineLabel || "平台截止时间";
  byId("due").textContent = task.deadlineDisplayed;
  byId("source").textContent = [task.platform, task.platformFilter].filter(Boolean).join(" · ");
  byId("progress").textContent = task.progressDisplayed || "未记录";
  byId("verified").textContent = "平台核实记录 " + (board.verified || "尚无检查时间") + " · 截止时间按平台原样显示。刷新按钮只更新本地文件。";
  byId("platform-note").textContent = task.statusBasis || task.statusNote || "";
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
  byId("expected").replaceChildren(...(task.teacherAttachments || []).map(a => node("p", "老师发布：" + a.name + (a.displayedSize ? "（" + a.displayedSize + "）" : ""))));
  if (task.attachmentsNote) byId("expected").append(node("small", task.attachmentsNote));
  const materials = board.links.filter(l => l.role === "material");
  byId("materials").replaceChildren(...materials.map(linkedRow));
  if (!materials.length) byId("materials").append(node("small", "可在下载收件箱中选择本次作业的资料。"));
  byId("package").disabled = !board.links.length || board.links.some(link => !link.available);
  byId("package-note").textContent = board.links.some(link => !link.available) ? "有原件已失效，请先更新关联。" :
    board.links.length ? "将这 " + board.links.length + " 个已关联文件复制到 ZIP 中。" : "先关联本机报告或资料即可打包。";
  byId("scan").textContent = (board.inbox || "尚未配置下载收件箱") + (board.scanned ? " · 本地读取于 " + new Date(board.scanned).toLocaleString("zh-CN") : "");
  byId("warnings").textContent = board.warnings.join("；");
  renderInbox();
  renderTaskList();
}
function renderSync(sync) {
  const history = board.courseScope || [];
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
  const examFeed = board.feeds?.exams;
  const ids = new Set(board.courses.filter(c => c.listed).map(c => c.id));
  const unassigned = (examFeed?.items || []).filter(item => !ids.has(item.course));
  const checked = board.courses.filter(c => c.listed && board.feeds?.[c.id]?.checked).length;
  const failed = board.courses.filter(c => c.listed && board.feeds?.[c.id]?.issue).length;
  byId("feed-status").textContent = "课堂动态已有记录的班级 " + checked + "/" + ids.size +
    (failed ? "（" + failed + " 门待重试）" : "") + "。近期考试清单 · " + feedSummary(examFeed, examFeed?.items.length || 0) +
    (unassigned.length ? "。待匹配班级的考试：" + unassigned.map(item => item.title).join("、") : "");
}
function learningNote() {
  const courses=board.cxCourses || [];
  if (!board.cxSync?.checked) return " 学习通"+(board.cxSync?.issue ? " · "+board.cxSync.issue : (courses.length ? "等待浏览器连接，目前显示已有记录。" : "等待首次同步。"));
  const checked=courses.filter(c=>c.checked).length;
  const retry=courses.filter(c=>(c.note || "").startsWith("待重试")).length;
  return " 学习通最近记录覆盖 "+checked+"/"+courses.length+" 个班级"+(retry ? "，"+retry+" 门待重试" : "")+
    (board.cxSync.issue ? " · "+board.cxSync.issue : "")+"。";
}
async function read() {
  const version = syncVersion;
  const requestId = ++readVersion;
  const response = await fetch("/api/workbench?task=" + encodeURIComponent(selectedTask));
  if (!response.ok) throw new Error("无法读取工作台，请确认本地服务正在运行，然后刷新重试。");
  const result = await response.json();
  if (requestId !== readVersion) return;
  if (version !== syncVersion || syncPending) result.sync = board?.sync || result.sync;
  // 空安装也使用同一接口；没有课程或选中作业时不创建示例记录。
  board = {...result, task:result.task || {}, courses:result.courses || [], cxCourses:result.cxCourses || [],
    assignments:result.assignments || [], links:result.links || [], files:result.files || [], warnings:result.warnings || [],
    feeds:result.feeds || {}, sync:{enabled:false,running:false,message:"等待连接浏览器扩展。",scope:"尚未同步课程",...result.sync}};
  // 平台延长截止或清走旧作业时，也释放对应的本地已读标记。
  const active = new Set(board.assignments.filter(t => taskKind(t) === "missed").map(missedKey));
  for (const key of seenInMemory) if (!active.has(key)) seenInMemory.delete(key);
  try {
    for (const key of Object.keys(localStorage)) if (key.startsWith(seenPrefix) && !active.has(key)) localStorage.removeItem(key);
  } catch {}
  render();
  if (!syncPending) renderSync(board.sync);
  if (!selectedCourse && !courseDirectory().length && !byId("connector-help").dataset.introduced) {
    byId("connector-help").open = true;
    byId("connector-help").dataset.introduced = "true";
  }
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
  selectedCourse = route.get("course") || "";
  detailOpen = !!selectedCourse && !!route.get("task");
  selectedTask = detailOpen ? route.get("task") : "";
  byId("report-path").value = "";
  byId("assignment").hidden = byId("inbox").hidden = true;
  byId("task-search").value = byId("list-status").value = "";
  byId("notice").textContent = "";
  try {
    await read();
    if (detailOpen && !byId("assignment").hidden) {
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
