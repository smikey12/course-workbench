"use strict";

const remote = "https://www.yuketang.cn";
const receiver = "http://127.0.0.1:8765/api/sync/browser";
let syncing = false;

async function local(payload) {
  const response = await fetch(receiver, {
    method: "POST", headers: {"Content-Type": "application/json", "X-Course-Connector": "1"},
    body: JSON.stringify(payload), signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error("工作台未能接收本次数据");
  return response.json();
}

async function readApi(path, params, step) {
  const url = new URL(path, remote);
  url.search = new URLSearchParams(params);
  const response = await fetch(url, {
    credentials: "include", headers: {xtbz: "ykt"}, cache: "no-store", signal: AbortSignal.timeout(10000)
  });
  if (response.status === 401 || /^\/web\/?$/.test(new URL(response.url).pathname)) throw new Error("login");
  if (!response.ok) throw new Error(step + "读取失败（HTTP " + response.status + "）");
  const body = await response.json();
  if (body.error_code === 20009 || /user is not login|未登录/.test(body.msg || "")) throw new Error("login");
  if (!(body.success === true || body.errcode === 0) || !body.data) throw new Error(step + "读取失败（" + Number(body.error_code || body.errcode || 0) + "）" + String(body.msg || "").slice(0, 80));
  return body.data;
}

function assignments(chapters) {
  if (!Array.isArray(chapters)) throw new Error("课程目录格式发生变化");
  const tasks = new Map();
  function visit(item, parent) {
    if (Number(item.leaf_type) === 6 && item.leaf_type != null) {
      const id = String(item.id || item.leafinfo_id || "");
      if (!/^\d+$/.test(id) || !item.name) throw new Error("作业目录缺少编号或名称");
      const task = {leaf: id, title: item.name, node: String(item.node_id || parent || "")};
      if (item.score_deadline) task.deadline = deadlineIso(item.score_deadline);
      tasks.set(id,task);
      return;
    }
    for (const children of [item.section_leaf_list, item.leaf_list, item.children]) {
      if (Array.isArray(children)) children.forEach(child => visit(child, item.id || item.section_id || item.chapter_id || parent));
    }
  }
  chapters.forEach(item => visit(item, ""));
  return [...tasks.values()];
}

function outline(chapters) {
  function entry(item) {
    const type = item.leaf_type;
    const children = [...(item.section_leaf_list || []), ...(item.leaf_list || []), ...(item.children || [])];
    const title = String(item.name || item.chapter_name || item.section_name || "").trim();
    const row = {title: title || "课程单元"};
    if (type != null) {
      row.type = Number(type);
      row.leaf = String(item.id || item.leafinfo_id || "");
    }
    if (children.length) row.children = children.map(entry);
    return row;
  }
  return chapters.map(entry);
}

function deadlineIso(value) {
  if (!value) return null;
  if (typeof value === "number") value *= value < 1e11 ? 1000 : 1;
  if (typeof value === "string" && /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d(?::\d\d)?$/.test(value)) value = value.replace(" ", "T") + "+08:00";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("无法识别平台截止时间");
  return date.toISOString();
}

function expiredDeadline(stamp) {
  if (!stamp) return false;
  const offset = 8 * 3600000;
  const end = new Date(Date.parse(stamp) + offset);
  const lastDay = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth()+2, 0)).getUTCDate();
  end.setUTCMonth(end.getUTCMonth()+1,Math.min(end.getUTCDate(),lastDay));
  return Date.now() >= end.getTime()-offset;
}

async function readCourse(course, oldLeaves = []) {
  const query = {classroom_id: course, cid: course};
  const menu = await readApi("/mooc-api/v1/lms/learn/course/chapter", {...query, show_unpublished: 0}, "课程目录");
  const old = new Set(oldLeaves);
  const tasks = assignments(menu.course_chapter).filter(task =>
    !old.has(task.leaf) || (task.deadline && !expiredDeadline(task.deadline)));
  const recent = tasks.filter(task => !expiredDeadline(task.deadline));
  let schedules = {};
  const completions = new Map();
  let scheduleIssue = "";
  if (recent.length) {
    try {
      const info = await readApi("/mooc-api/v1/lms/learn/classroom_info/", {classroom_id: course}, "班级信息");
      const data = await readApi("/mooc-api/v1/lms/learn/course/schedule", {...query, sign: info.course_sign || "", is_h5: true}, "作业进度");
      schedules = data.leaf_schedules || {};
    } catch (error) {
      if (error.message === "login") throw error;
      scheduleIssue = error.message;
    }
    try {
      const data = await readApi("/c27/online_courseware/schedule/course/progress/", {classroom_id: course}, "课程完成度");
      function visitProgress(item) {
        if (Number(item.leaf_type) === 6 && typeof item.progress === "number" && item.progress >= 0 && item.progress <= 1)
          completions.set(String(item.id), item.progress === 1);
        for (const child of item.course_progress || item.section_leaf_list || item.leaf_list || []) visitProgress(child);
      }
      visitProgress(data);
    } catch (error) {
      if (error.message === "login") throw error;
    }
  }
  let missingDetails = 0;
  for (const task of recent) {
    const progress = schedules[task.leaf];
    if (completions.has(task.leaf)) task.completed = completions.get(task.leaf);
    if (progress && Number.isInteger(progress.status) && progress.status >= 0) {
      task.completed = progress.status > 2;
      if (Number.isInteger(progress.done) && Number.isInteger(progress.total)) task.progress = [progress.done, progress.total];
    }
    try {
      const detail = await readApi("/mooc-api/v1/lms/learn/leaf_info/" + course + "/" + task.leaf + "/", {classroom_id: course}, "作业详情");
      if (String(detail.id || detail.leafinfo_id || "") !== task.leaf) throw new Error("详情编号不符");
      task.deadline = deadlineIso(detail.score_deadline || detail.class_end_time);
    } catch (error) {
      if (error.message === "login") throw error;
      missingDetails++;
    }
  }
  if (recent.every(task => typeof task.completed === "boolean")) scheduleIssue = "";
  return {action: "course", course, tasks, missingDetails, scheduleIssue, outline: outline(menu.course_chapter)};
}

async function readIndex() {
  const active = await readApi("/v2/api/web/courses/list", {identity: 2}, "在学课程");
  if (!Array.isArray(active.list)) throw new Error("在学课程目录格式发生变化");
  const courses = new Map();
  function add(row, archived) {
    const id = String(row.classroom_id || row.id || "");
    const name = row.course?.name || row.course_name || row.name;
    if (!/^\d+$/.test(id) || !name) throw new Error("课程缺少班级编号或名称");
    if (!courses.has(id)) courses.set(id, {id, name, section: row.name || "", archived,
      started:row.course_start_time || row.classroom_start_time || null,
      ended:row.classroom_end_time ?? row.course_end_time});
  }
  active.list.forEach(row => add(row, false));
  let archiveOk = false;
  try {
    const archived = await readApi("/v2/api/web/classroom_archive", {}, "归档课程");
    if (Array.isArray(archived.classrooms)) {
      archived.classrooms.forEach(row => add(row, true));
      archiveOk = true;
    }
  } catch (error) {
    if (error.message === "login") throw error;
  }
  return {action: "index", courses: [...courses.values()], archiveOk};
}

const activityKinds = {2:"课件", 3:"课堂", 4:"测验", 5:"考试", 6:"通知", 8:"链接", 9:"通知",
  13:"讨论", 14:"课堂", 15:"学习单元", 16:"图文", 17:"视频", 18:"讨论", 19:"章节作业", 20:"章节考试", 30:"音频", 100:"实验"};

function eventId(value) {
  const id = String(value ?? "");
  if (!/^[1-9]\d{0,19}$/.test(id)) throw new Error("平台记录缺少可识别的编号");
  return id;
}

function eventTime(value) {
  if (!value || value === "0") return null;
  return deadlineIso(typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value);
}

async function classroomFeed(course) {
  const items = new Map();
  for (let page = 0; page < 100; page++) {
    const data = await readApi("/v2/api/web/logs/learn/" + course, {actype:-1, page, offset:20, sort:-1}, "课堂动态");
    if (!Array.isArray(data.activities) || ![true,false,0,1].includes(data.has_more)) throw new Error("课堂动态分页格式有变");
    const before = items.size;
    for (const entry of data.activities) {
      const id = eventId(entry.id);
      const kind = activityKinds[entry.type] || "课堂动态";
      const row = {id, course, kind, title:entry.title || entry.content?.title || entry.content?.name || kind,
        published:eventTime(entry.create_time)};
      if ([4,5].includes(entry.type)) {
        row.due = eventTime(entry.deadline);
        if (!data.IS_SIMPLE && [0,1,2,3].includes(entry.status)) row.completed = entry.status >= 2;
      }
      items.set(id,row);
    }
    if (!data.has_more) return [...items.values()];
    if (items.size === before) throw new Error("课堂动态分页重复，稍后重试");
  }
  throw new Error("动态超过单次读取上限，保留上次完整记录");
}

async function upcomingExams() {
  const rows = await readApi("/v/rain_exam/get_upcoming_exam/", {}, "近期考试");
  if (!Array.isArray(rows)) throw new Error("近期考试列表格式有变");
  return rows.map(row => ({id:eventId(row.id), course:row.classroom_id ? eventId(row.classroom_id) : "",
    kind:row.type === "exam" ? "考试" : "测验", title:row.title, due:eventTime(row.deadline)}));
}

async function syncFeed(scope, collect) {
  let payload;
  try {
    payload = {scope, items:await collect()};
  } catch (error) {
    if (error.message === "login") throw error;
    payload = {scope, issue:error.message};
  }
  await local({action:"feed", ...payload});
}

async function synchronize() {
  if (syncing) return;
  syncing = true;
  let badge = "!";
  let title = "工作台未启动，稍后自动重试";
  try {
    const config = await local({action: "check"});
    if (!config.enabled) {
      badge = "";
      title = "工作台已暂停接收";
    } else {
      try {
        const index = await local(await readIndex());
        await syncFeed("exams", upcomingExams);
        for (const id of index.feedCourses || []) {
          if (!(await local({action:"check"})).enabled) break;
          await syncFeed(id, () => classroomFeed(id));
        }
        for (const id of index.next) {
          if (!(await local({action: "check"})).enabled) break;
          try {
            await local(await readCourse(id,index.oldLeaves?.[id]));
          } catch (error) {
            if (error.message === "login") throw error;
            await local({action: "courseIssue", course: id, message: error.message});
          }
        }
        badge = String(index.count);
        title = "账号目录共 " + index.count + " 门课程";
      } catch (error) {
        const login = error.message === "login";
        title = login ? "雨课堂登录已过期，请在安装此扩展的浏览器中登录一次" : "暂未更新 · " + error.message;
        await local({action: "issue", login, message: title});
      }
    }
  } catch {
    // 本机服务关闭时，在下一个周期重试。
  } finally {
    syncing = false;
    await chrome.action.setBadgeText({text: badge});
    await chrome.action.setBadgeBackgroundColor({color: badge === "!" ? "#aa3043" : "#4e5fc5"});
    await chrome.action.setTitle({title});
  }
}

function startTimer() {
  chrome.alarms.create("course-sync", {periodInMinutes: 1});
  synchronize();
  wakeCX();
}
let creatingCX;
async function wakeCX() {
  const hosts=["mooc1-api","mooc1","mooc2-ans"].map(s=>"https://"+s+".chaoxing.com/*");
  const allowed = await chrome.permissions.contains({origins:hosts});
  if (!(await local({action:"check",cxAccess:allowed}).catch(()=>({enabled:false}))).enabled || !allowed) return;
  try {
    if (!await chrome.offscreen.hasDocument()) {
      creatingCX ||= chrome.offscreen.createDocument({url:"cx-reader.html",reasons:["DOM_PARSER"],
        justification:"在浏览器本地读取学习通课程和作业列表中的标题、状态、截止时间"}).finally(()=>creatingCX=null);
      await creatingCX;
    }
    await chrome.runtime.sendMessage({type:"cx-run"});
  } catch {
    await local({action:"chaoxing",issue:"后台读取器未能启动，请重新加载连接扩展"}).catch(()=>{});
  }
}
chrome.runtime.onMessage.addListener(msg=>{if(msg.type==="cx-wake") wakeCX();});
chrome.runtime.onInstalled.addListener(startTimer);
chrome.runtime.onStartup.addListener(startTimer);
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === "course-sync") {synchronize(); wakeCX();}
});
chrome.action.onClicked.addListener(synchronize);
