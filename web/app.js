"use strict";
// 清单只保存在内存；所有筛选、目录跳转都只改变网页显示。
let catalog = null;
let selectedSemester = "";
let selectedCourse = ""; // 用“学期/课程”标识，同名课程也不会混在一起。
let folder = "";
let loading = false;
const $ = (id) => document.getElementById(id);
const collator = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });
const formatDate = (value) => new Date(value).toLocaleString("zh-CN", { hour12: false });
function sizeLabel(size) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 ** 3) return `${(size / 1024 ** 2).toFixed(1)} MB`;
  return `${(size / 1024 ** 3).toFixed(2)} GB`;
}
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function inSemester(file) {
  return !selectedSemester || (selectedSemester === "?" ? !file.semester : file.semester === selectedSemester);
}
function semesterButtons() {
  const nav = $("semesters");
  nav.replaceChildren();
  const choices = [["", "全部学期", catalog.files.length], ...catalog.semesters.map((semester) =>
    [semester, semester, catalog.files.filter((f) => f.semester === semester).length]),
    ["?", "其他资料", catalog.files.filter((f) => !f.semester).length]];
  for (const [value, label, count] of choices) {
    const button = element("button", undefined, value === selectedSemester ? "course active" : "course");
    button.setAttribute("aria-pressed", String(value === selectedSemester));
    button.append(element("span", label), element("span", count, "count"));
    button.onclick = () => {
      selectedSemester = value; selectedCourse = "";
      folder = value && value !== "?" ? value : "";
      semesterButtons(); courseOptions(); render();
    };
    nav.append(button);
  }
}
function courseOptions() {
  const select = $("course-filter");
  select.replaceChildren(new Option("所有课程", ""));
  for (const course of catalog.courses.filter((c) => !selectedSemester || c.semester === selectedSemester)) {
    const label = selectedSemester ? course.name : `${course.semester} · ${course.name}`;
    select.add(new Option(label, course.id));
  }
  if (![...select.options].some((o) => o.value === selectedCourse)) selectedCourse = "";
  select.value = selectedCourse;
  select.disabled = selectedSemester === "?";
}
function navigate(path) {
  folder = path;
  const parts = path.split("/");
  selectedSemester = !path ? "" : catalog.semesters.includes(parts[0]) ? parts[0] : "?";
  selectedCourse = catalog.courses.find((c) => c.id === parts.slice(0, 2).join("/"))?.id || "";
  semesterButtons(); courseOptions(); render();
}
function showDetail(file) {
  const fields = $("detail-fields");
  fields.replaceChildren();
  for (const [key, value] of [["文件名", file.name], ["原始路径", file.originalPath],
    ["学期", file.semester || "其他资料"], ["课程", file.course || "未归入课程"],
    ["识别依据", file.reason], ["类型", file.extension], ["大小", `${sizeLabel(file.size)}（${file.size.toLocaleString()} 字节）`], ["修改时间", formatDate(file.modified)]]) {
    fields.append(element("dt", key), element("dd", value));
  }
  $("detail").showModal();
}
function render() {
  if (!catalog) return;
  const query = $("search").value.trim().toLocaleLowerCase();
  const type = $("type").value;
  const filtering = Boolean(query || type);
  const files = catalog.files.filter((f) => inSemester(f) && (!selectedCourse || f.courseId === selectedCourse)
    && (!type || f.extension === type) && (!query || f.name.toLocaleLowerCase().includes(query))
    && (filtering || f.parent === folder));
  const sort = $("sort").value;
  files.sort((a, b) => sort === "size" ? b.size - a.size : sort === "modified" ? Date.parse(b.modified) - Date.parse(a.modified) : collator.compare(a.path, b.path));
  const directories = filtering ? [] : catalog.folders.filter((f) => f.parent === folder
    && !(selectedSemester === "?" && !folder && catalog.semesters.includes(f.path)));
  const crumb = $("breadcrumb");
  crumb.replaceChildren();
  if (filtering) {
    const courseName = catalog.courses.find((c) => c.id === selectedCourse)?.name;
    crumb.append(element("span", `${selectedSemester === "?" ? "其他资料" : selectedSemester || "全部学期"}${courseName ? ` / ${courseName}` : ""} / 筛选结果`));
  } else {
    const home = element("button", "课程内容");
    home.onclick = () => navigate("");
    crumb.append(home);
    (folder ? folder.split("/") : []).forEach((part, i, parts) => {
      crumb.append(element("span", "/"));
      const button = element("button", part);
      button.onclick = () => navigate(parts.slice(0, i + 1).join("/"));
      crumb.append(button);
    });
    if (selectedSemester === "?" && !folder) crumb.append(element("span", "/ 其他资料"));
  }
  $("result-count").textContent = `${directories.length} 个文件夹 · ${files.length} 个文件`;
  const rows = $("rows");
  rows.replaceChildren();
  for (const dir of directories) {
    const tr = element("tr");
    const td = element("td");
    const button = element("button", `▱  ${dir.name}`, "file-button folder-button");
    button.onclick = () => navigate(dir.path);
    td.append(button, element("div", dir.excluded ? "依赖／内部目录 · 已跳过内部文件" : `${catalog.root}\\${dir.path.replaceAll("/", "\\")}`, "file-path"));
    tr.append(td, element("td", "—"), element("td", "文件夹"), element("td", "—"), element("td", "—")); rows.append(tr);
  }
  for (const file of files) {
    const tr = element("tr");
    const name = element("td");
    const line = element("div", undefined, "file-line");
    line.append(element("span", file.extension === "无扩展名" ? "FILE" : file.extension.slice(1).toUpperCase(), "file-icon"));
    const button = element("button", file.name, "file-button");
    button.onclick = () => showDetail(file);
    line.append(button); name.append(line, element("div", file.originalPath, "file-path"));
    const course = element("td");
    course.append(element("span", file.course || "未归入课程", file.course ? "badge" : "badge pending"));
    course.append(element("small", file.semester || "其他资料", "recognition"));
    tr.append(name, course, element("td", file.extension), element("td", sizeLabel(file.size)), element("td", formatDate(file.modified)));
    rows.append(tr);
  }
  const excludedFolder = catalog.folders.find((f) => f.path === folder)?.excluded;
  $("empty").textContent = !catalog.files.length && !catalog.folders.length ? "尚未收录本地资料。请在启动配置中指定课程资料目录，放入资料后点击「重新扫描」。" : excludedFolder ? "此目录入口已保留，内部文件按扫描规则跳过。可通过上方路径返回项目目录。" : "这里没有匹配的文件。当前目录可能为空，或可尝试清除搜索与筛选。";
  $("empty").hidden = Boolean(files.length || directories.length);
}
async function load(refresh = false) {
  if (loading) return;
  loading = true;
  $("refresh").disabled = true;
  $("refresh").textContent = "扫描中…";
  $("message").textContent = "正在读取本地目录，请稍候…";
  try {
    const response = await fetch(`/api/catalog${refresh ? "?refresh=1" : ""}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "目录读取失败");
    catalog = {...data, semesters:data.semesters || [], courses:data.courses || [], files:data.files || [],
      folders:data.folders || [], warnings:data.warnings || [], skipped:data.skipped || {directories:0,temporaryFiles:0,links:0}};
    if (selectedSemester && selectedSemester !== "?" && !catalog.semesters.includes(selectedSemester)) { selectedSemester = ""; selectedCourse = ""; folder = ""; }
    courseOptions();
    if (folder && !catalog.folders.some((f) => f.path === folder)) folder = selectedCourse || (selectedSemester !== "?" ? selectedSemester : "");
    $("semester-count").textContent = catalog.semesters.length;
    $("course-count").textContent = catalog.courses.length;
    $("file-count").textContent = catalog.files.length;
    $("scan-time").textContent = (catalog.scannedAt ? new Date(catalog.scannedAt).toLocaleTimeString("zh-CN", { hour12: false }) : "尚未扫描");
    $("root-path").textContent = (catalog.root ? `资料位置：${catalog.root}` : "尚未配置课程资料目录");
    const previousType = $("type").value;
    $("type").replaceChildren(new Option("所有文件类型", ""));
    for (const ext of [...new Set(catalog.files.map((f) => f.extension))].sort()) $("type").add(new Option(ext, ext));
    if ([...$("type").options].some((o) => o.value === previousType)) $("type").value = previousType;
    $("scan-summary").textContent = `扫描说明 · 跳过 ${catalog.skipped.directories} 个目录的内部文件、${catalog.skipped.temporaryFiles} 个临时文件、${catalog.skipped.links} 个链接 · ${catalog.warnings.length} 项读取提示`;
    $("warnings").replaceChildren(...catalog.warnings.map((w) => element("p", `${w.path}：${w.message}`)));
    $("message").textContent = "";
    semesterButtons(); render();
  } catch (error) {
    $("message").textContent = `读取失败：${error.message}。请确认本地服务正在运行，再点击重新扫描。${catalog ? " 下方保留的是上次扫描结果。" : ""}`;
  } finally {
    loading = false;
    $("refresh").disabled = false;
    $("refresh").textContent = "↻ 重新扫描";
  }
}
$("search").addEventListener("input", render);
$("type").addEventListener("change", render);
$("sort").addEventListener("change", render);
$("course-filter").addEventListener("change", () => {
  selectedCourse = $("course-filter").value;
  folder = selectedCourse || (selectedSemester && selectedSemester !== "?" ? selectedSemester : "");
  if (selectedCourse) selectedSemester = catalog.courses.find((c) => c.id === selectedCourse).semester;
  semesterButtons(); courseOptions(); render();
});
$("refresh").addEventListener("click", () => load(true));
$("close-detail").onclick = () => $("detail").close();
load();
