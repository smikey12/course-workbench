"use strict";
// 在扩展自己的隐藏文档中解析页面。模板内的课程脚本不会执行。
const mooc = "https://mooc1.chaoxing.com";
const api = "https://mooc1-api.chaoxing.com";
const localURL = "http://127.0.0.1:8765/api/sync/browser";
const digits = value => /^[1-9]\d{0,19}$/.test(String(value ?? ""));
async function send(payload) {
  const response = await fetch(localURL,{method:"POST",headers:{"Content-Type":"application/json","X-Course-Connector":"1"},
    body:JSON.stringify(payload),signal:AbortSignal.timeout(10000)});
  if (!response.ok) throw new Error("工作台接收失败");
  return response.json();
}
async function read(url) {
  const response=await fetch(url,{credentials:"include",cache:"no-store",signal:AbortSignal.timeout(14000)});
  if (!response.ok) throw new Error("平台读取失败 HTTP "+response.status);
  const host=new URL(response.url).hostname;
  if (!["mooc1-api.chaoxing.com","mooc1.chaoxing.com","mooc2-ans.chaoxing.com"].includes(host)) throw new Error("登录失效，请在联想浏览器登录学习通");
  return response.text();
}
function parse(markup) {
  const t=document.createElement("template");
  t.innerHTML=markup;
  return t.content;
}
async function index() {
  const raw=await read(api+"/mycourse/backclazzdata?view=json&mcode=");
  let body;
  try {body=JSON.parse(raw);} catch {throw new Error("课程目录未返回，请检查联想浏览器的学习通登录");}
  if (!Array.isArray(body.channelList)) throw new Error("课程目录格式有变或登录已过期");
  const courses=new Map();
  for (const channel of body.channelList) {
    const row=channel.content;
    if (!row?.course) continue;
    const info=row.course.data?.[0];
    const clazz=row.clazz?.data?.[0]?.id ?? row.id ?? channel.key;
    if (!digits(info?.id)||!digits(clazz)||!info.name) throw new Error("课程清单含未识别的班级");
    courses.set("cx-"+info.id+"-"+clazz,{cid:String(info.id),clazz:String(clazz),name:info.name,cpi:String(row.cpi ?? ""),
      started:row.begindate || row.startTime || info.begindate || null,
      ended:row.clazz?.data?.[0]?.enddate ?? row.enddate ?? row.endTime});
  }
  if (!courses.size) throw new Error("账号目录尚未返回课程，保留上次记录");
  return courses;
}
function listURL(group, html) {
  const doc=parse(html);
  const val=id=>doc.querySelector("input#"+id)?.value;
  if (!val("workEnc") || !val("enc")) throw new Error("未读到本班作业入口");
  const params=new URLSearchParams({courseId:group.cid,classId:group.clazz,cpi:group.cpi,ut:"s",
      enc:val("workEnc"),stuenc:val("enc"),t:String(Date.now())});
  if (val("openc")) params.set("openc",val("openc"));
  return mooc+"/mooc2/work/list?"+params;
}
function dateFrom(text) {
  const m=text.match(/(?:截止(?:时间)?[：:\s]*)?(20\d\d)[年./-](\d{1,2})[月./-](\d{1,2})日?\s+(\d\d?):(\d\d)/);
  return m ? m[1]+"-"+m[2].padStart(2,"0")+"-"+m[3].padStart(2,"0")+"T"+m[4].padStart(2,"0")+":"+m[5]+":00+08:00" : null;
}
function pageOf(html,group) {
  const doc=parse(html);
  if (!doc.querySelector("#workFocus") || doc.querySelector("#classId")?.value !== group.clazz) throw new Error("未能核实班级作业页");
  const rows=[];
  for (const entry of doc.querySelectorAll("li[data][onclick*='goTask']")) {
    const params=new URL(entry.getAttribute("data"),mooc).searchParams;
    const wid=params.get("workId")||params.get("activeId")||params.get("taskrefId");
    const title=entry.querySelector(".overHidden2")?.textContent.trim();
    const status=entry.querySelector(".status")?.textContent.trim() || "";
    const time=entry.querySelector(".time");
    const when=(time?.textContent || "").trim();
    if (!digits(wid)||!title) throw new Error("作业列表中有无法识别的记录");
    const due=dateFrom(time?.getAttribute("title") || when);
    rows.push({wid,title,status,when,due,kind:params.has("activeId")?"activity":"work"});
  }
  if (!rows.length && !/暂无作业|没有作业|暂无数据|暂无相关作业|还没有作业/.test(doc.textContent)) throw new Error("尚未核实空作业列表");
  return {rows,doc};
}
function paginationOf(html, doc) {
  // paging 的 pageNum 是总页数；真正翻页的查询参数由 callback 指定。
  // 只读取数字和参数名，不执行平台页面中的脚本。
  const paging=html.match(/\.paging\s*\(\s*\{([\s\S]*?)callback\s*:\s*function\s*\(\s*(\w+)\s*\)\s*\{([\s\S]*?)\}/i);
  if (paging) {
    const current=paging[1].match(/\bnowPage\s*:\s*['"]?(\d+)/);
    const total=paging[1].match(/\bpageNum\s*:\s*['"]?(\d+)/);
    const parameter=paging[3].match(new RegExp('[&?](\\w+)=["\\\']\\s*\\+\\s*'+paging[2]+'\\b'));
    if (!current || !total || !parameter || +current[1]<1 || +total[1]<+current[1] || +total[1]>100) {
      throw new Error("平台分页格式待核实");
    }
    return {current:+current[1],total:+total[1],parameter:parameter[1]};
  }
  const next=doc.querySelector("a[rel=next]") || [...doc.querySelectorAll("#page a")].find(a=>/下一页/.test(a.textContent)&&!a.classList.contains("disabled"));
  const total=html.match(/(?:totalPage[s]?|pageCount|allPage)\s*[:=]\s*['"]?(\d+)/i);
  if (!total && !next && /\.(?:xlPaging|paging)\s*\(/i.test(html)) throw new Error("平台分页格式待核实");
  return {total:total?+total[1]:null,next:!!next,parameter:"pageNum"};
}
async function homework(group) {
  const params=new URLSearchParams({courseid:group.cid,clazzid:group.clazz,cpi:group.cpi,ismooc2:"1",v:"2",pageHeader:"8"});
  const url=listURL(group,await read(mooc+"/visit/stucoursemiddle?"+params));
  const seen=new Set();
  const tasks=[];
  const counts=[];
  let expectedTotal, parameter="pageNum";
  for (let page=1;page<=100;page++) {
    const addr=new URL(url);
    if (page>1) addr.searchParams.set(parameter,String(page));
    const html=await read(addr);
    const {rows,doc}=pageOf(html,group);
    const paging=paginationOf(html,doc);
    if (paging.current != null && paging.current!==page) throw new Error("平台返回的作业页码不符，保留上次清单");
    if (page===1) {expectedTotal=paging.total; parameter=paging.parameter;}
    if (paging.total!==expectedTotal || paging.parameter!==parameter) throw new Error("作业分页在读取中变化，请重试");
    if (!rows.length && (page>1 || expectedTotal>1)) throw new Error("作业分页意外为空，保留上次清单");
    counts.push(rows.length);
    for (const row of rows) {
      const key=row.kind+row.wid;
      if (seen.has(key)) throw new Error("作业分页重复，保留上次清单");
      seen.add(key); tasks.push(row);
    }
    if (expectedTotal!=null ? page===expectedTotal : !paging.next) {
      return {tasks,scan:{pages:counts,totalPages:page}};
    }
  }
  throw new Error("作业超过单轮分页上限");
}
let busy=false;
async function cycle() {
  if (busy) return;
  busy=true;
  try {
    if (!(await send({action:"check",platform:"cx"})).enabled) return;
    const courses=await index();
    const {next}=await send({action:"chaoxing",courses:[...courses.values()].map(({cid,clazz,name,started,ended})=>({cid,clazz,name,started,ended}))});
    for (const key of next) {
      if (!(await send({action:"check",platform:"cx"})).enabled) break;
      try {
        const result=await homework(courses.get(key));
        await send({action:"chaoxing",course:key,...result});
      } catch(e) {
        await send({action:"chaoxing",course:key,issue:e.message});
      }
    }
  } catch(e) {
    await send({action:"chaoxing",issue:e.message}).catch(()=>{});
  } finally {busy=false;}
}
chrome.runtime.onMessage.addListener(msg=>{
  if (msg.type==="cx-run") cycle();
});
