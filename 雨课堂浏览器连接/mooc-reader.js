"use strict";

// 在用户已单独授权的 icourse163.org 标签页 MAIN world 中运行。
// 仅请求官网当前脚本使用的四个读取接口；不读取答题纸、不开始答题、不提交答案。
// 2026-11-03 核对的官方来源（公开脚本，不含账号记录）：
// https://mc.stu.126.net/pub/s/tp_home_desktop_modules_course_index_462d3d8dc4cfc4e8cb972eec239a47d3.js
// https://mc.stu.126.net/pub/s/tp_home_desktop_modules_spocCourse_index_91c740797e5757774e2f7d596896a869.js
// https://mc.stu.126.net/pub/s/core_ed1c7a49308cc510ed45630ef37d7901.js
// https://mc.stu.126.net/pub/s/tp_learn_index_desktop_modules_learn_90891aae5c86fb27141e153dc2cae324.js
async function collectMooc() {
  if (location.origin !== "https://www.icourse163.org") return {issue:"MOOC 读取页域名不符"};
  const id = value => typeof value === "string" && /^[1-9]\d{0,19}$/.test(value) ? value
    : typeof value === "number" && Number.isSafeInteger(value) && value>0 ? String(value) : null;
  const text = value => typeof value === "string" ? value.trim().slice(0,250) : "";
  const issueText = error => text(error?.message) || "MOOC 读取失败";
  const delay = ms => new Promise(resolve=>setTimeout(resolve,ms));
  const started=Date.now();
  // 新建的后台页可能仍在装载官网脚本，不触发登录或隐私提示。
  for (let n=0;n<20 && !window.NEJ;n++) await delay(500);
  if (!id(window.webUser?.id)) return {issue:"中国大学 MOOC 尚未登录，请在当前浏览器手动登录后重试"};
  const csrf = document.cookie.split(";").map(v=>v.trim()).find(v=>v.startsWith("NTESSTUDYSI="))?.slice(12);
  if (!csrf) return {issue:"MOOC 当前会话缺少网站读取凭据，请在官网重新登录"};
  const endpoints = {
    directory:"/web/j/learnerCourseRpcBean.getMyLearnedCoursePanelList.rpc",
    content:"/web/j/courseBean.getLastLearnedMocTermDto.rpc",
    quiz:"/web/j/mocQuizRpcBean.getOpenQuizInfo.rpc",
    homework:"/web/j/mocQuizRpcBean.getOpenHomeworkInfo.rpc"
  };
  async function rpc(kind, data) {
    if (Date.now()-started>90000) throw new Error("MOOC 本批读取超过 90 秒，稍后重试；未覆盖班期保留原记录");
    const path=endpoints[kind];
    if (!path) throw new Error("未允许的 MOOC 读取接口");
    let body, headers;
    if (kind==="quiz" || kind==="homework") {
      body=JSON.stringify(data);
      const site=window.NEJ?.P("nej.j");
      if (typeof site?.geneAuthHeaders!=="function") throw new Error("官网测验签名组件尚未就绪，个人提交状态待核实");
      // 复用官网请求签名方法，凭据只留在该网站上下文，不传回扩展或本机后端。
      headers=site.geneAuthHeaders({data:body});
      if (!/^[A-Fa-f0-9]{32}$/.test(headers?.["Auth-Signature"] || "")) {
        throw new Error("官网测验签名组件未就绪，请在官网刷新后重试");
      }
    } else {
      body=new URLSearchParams(data).toString();
      headers={"Content-Type":"application/x-www-form-urlencoded;charset=UTF-8"};
    }
    const response=await fetch(path+"?csrfKey="+encodeURIComponent(csrf),{
      method:"POST",credentials:"same-origin",cache:"no-store",headers,body,signal:AbortSignal.timeout(15000)
    });
    if (!response.ok || new URL(response.url).origin!==location.origin) throw new Error("MOOC 读取接口未返回有效会话，HTTP "+response.status);
    let value;
    try {value=await response.json();} catch {throw new Error("MOOC 接口格式有变或登录失效");}
    if (value?.code!==0 && value?.code!=="0") throw new Error(value?.code===1 || value?.code==="1" ? "MOOC 登录已过期，请手动登录" : "MOOC 接口拒绝读取，状态待核实");
    const result=value.result ?? value.data;
    if (result==null) throw new Error("MOOC 接口未返回清单，保留上次记录");
    return result;
  }
  function deadline(value) {
    // 官方 test.deadline 为毫秒时间戳。0、负数、缺失值均不当作已截止。
    if (value==null || value===0 || value==="0" || value===-1 || value==="-1") return null;
    const ms=typeof value==="number" ? value : /^\d{13}$/.test(String(value)) ? Number(value) : NaN;
    if (!Number.isFinite(ms) || ms<946684800000 || ms>4102444800000) throw new Error("MOOC 截止时间格式待核实");
    return new Date(ms).toISOString();
  }
  function completion(kind, info, test) {
    // 不根据“去测验/去作业”、课程进度或截止时间猜测个人完成情况。
    if (kind==="quiz" && Number.isInteger(info?.usedTryCount) && info.usedTryCount>=0) {
      return info.usedTryCount>0 ? {status:"已提交",completion:"已完成"} : {status:"未提交",completion:"未完成"};
    }
    if (kind==="homework" && info?.submitStatus===2) return {status:"已提交",completion:"已完成"};
    if (kind==="homework" && info?.submitStatus===1) return {status:"草稿未提交",completion:"未完成"};
    // 实测同一只读接口会为已有草稿返回 aid + submitStatus=1；没有个人记录时两者明确为 null。
    // 必须核对作业编号且字段确实存在，不能把缺失字段、空响应或请求失败当成未提交。
    if (kind==="homework" && id(info?.tid)===id(test.id) && id(test.id)
        && Object.prototype.hasOwnProperty.call(info,"aid") && info.aid===null
        && Object.prototype.hasOwnProperty.call(info,"submitStatus") && info.submitStatus===null) {
      return {status:"尚无个人提交记录",completion:"未完成"};
    }
    if (typeof test.userScore==="number" && Number.isFinite(test.userScore)) return {status:"已评分",completion:"已完成"};
    return {status:"个人提交状态待核实",completion:"待核实"};
  }
  const courses=new Map(), problems=[];
  try {
    // 官网“我的课程”和“学校专有课程”分别使用 courseType=1/2；type=30 为全部学期。
    // 智慧课/付费专栏等其他独立入口尚未覆盖，不能声称读取整个网站所有产品。
    for (const courseType of [1,2]) {
      let totalPages, totalCount, count=0;
      const seen=new Set();
      for (let page=1;page<=100;page++) {
        const result=await rpc("directory",{type:30,p:page,psize:8,courseType});
        const rows=result.list ?? result.result, query=result.query ?? result.pagination;
        if (!Array.isArray(rows) || !query || !Number.isInteger(query.pageIndex)
            || !Number.isInteger(query.totlePageCount) || !Number.isInteger(query.totleCount)
            || query.pageIndex!==page || query.totlePageCount<0 || query.totlePageCount>100 || query.totleCount<0) {
          throw new Error("MOOC 账号课程分页格式待核实");
        }
        if (page===1) {totalPages=query.totlePageCount;totalCount=query.totleCount;}
        if (query.totlePageCount!==totalPages || query.totleCount!==totalCount) throw new Error("MOOC 目录在读取中变化，请重试");
        if ((!rows.length && (totalCount!==0 || page!==1)) || (rows.length && totalPages<page)) throw new Error("MOOC 目录分页意外为空或页数不符");
        for (const row of rows) {
          const cid=id(row.id), tid=id(row.termPanel?.id), name=text(row.name);
          if (!cid || !tid || !name) throw new Error("MOOC 目录包含未识别的课程班期");
          const key=cid+"-"+tid;
          if (seen.has(key)) throw new Error("MOOC 目录分页重复，保留上次记录");
          seen.add(key); count++;
          courses.set(key,{id:key,name,section:(courseType===2 ? "学校专有课程" : "MOOC")+" · 班期 "+tid,
            term:text(row.termPanel.name),tasks:[],checked:false,_tid:tid,_panel:row.termPanel});
        }
        if (page>=totalPages) {
          if (count!==totalCount) throw new Error("MOOC 目录条数与平台总数不符");
          break;
        }
        if (page===100) throw new Error("MOOC 目录超过分页上限");
      }
    }
  } catch (error) {
    // 目录分页不完整时不发送残缺目录，避免后端撤下尚未读到的班级。
    return {issue:issueText(error)};
  }
  const catalog=[...courses.values()];
  for (const course of catalog) {
    const tasks=[], seen=new Set(), issues=[];
    try {
      const result=await rpc("content",{termId:course._tid});
      const term=result.mocTermDto;
      if (!term || id(term.id)!==course._tid || !Array.isArray(term.chapters)) throw new Error("MOOC 班期章节清单未核实");
      for (const chapter of term.chapters) {
        for (const [field,kind] of [["quizs","quiz"],["homeworks","homework"]]) {
          if (chapter[field]!=null && !Array.isArray(chapter[field])) throw new Error("MOOC 作业或测验清单格式待核实");
          for (const lesson of chapter[field] || []) {
            if (tasks.length>=500) throw new Error("MOOC 单班期超过本批 500 项上限，保留原记录");
            const test=lesson.test, tid=id(test?.id), title=text(test?.name || lesson.name);
            if (!tid || !title) throw new Error("MOOC 清单含未发布或未识别的测验/作业");
            const key=kind+"-"+tid;
            if (seen.has(key)) throw new Error("MOOC 班期作业编号重复");
            seen.add(key);
            let info=null;
            const expectedType=kind==="quiz" ? 2 : 3;
            if (lesson.contentType!==expectedType) throw new Error("MOOC 作业类型待核实");
            try {
              const params=kind==="quiz" ? {tid,targetAid:null,isDraft:false} : {tid,aid:null,isDraft:false};
              if (typeof window.appId==="string" && window.appId) params.appId=window.appId;
              info=await rpc(kind,params);
              if (!info || typeof info!=="object" || Array.isArray(info)) throw new Error("MOOC 个人作业详情格式待核实");
            } catch (error) {issues.push(issueText(error));}
            const state=completion(kind,info,test);
            if (state.completion==="待核实") issues.push("部分作业/测验个人提交状态待核实（未读取答题纸）");
            tasks.push({id:key,title,...state,deadlineAt:deadline(info?.deadline ?? test.deadline)});
          }
        }
      }
      // 同步 SPOC 的源班期、课内随堂练习、OJ 与期末考试不混入普通作业的已核实清单。
      if (course._panel.mode===10 || course._panel.mode===15) issues.push("同步 SPOC 的源课程作业尚未覆盖");
      course.tasks=tasks;
      const incompleteSource=course._panel.mode===10 || course._panel.mode===15;
      // 提交状态不明不等于清单读取失败。完整清单可以保存，并保留逐项待核实。
      course.checked=!incompleteSource;
      if (incompleteSource) course.partial=true;
      if (issues.length) {
        course.issue=[...new Set(issues)].join("；").slice(0,300);
        problems.push(course.name+"："+course.issue);
      }
    } catch (error) {course.issue=issueText(error);problems.push(course.name+"："+course.issue);}
    delete course._tid;
    delete course._panel;
  }
  const issue=[...new Set(problems)].join("；");
  return {courses:catalog,
    ...(issue ? {issue:(issue.slice(0,240)+"；仅覆盖普通 MOOC/学校专有课程的章节作业与测验").slice(0,300)} : {})};
}

if (typeof module!=="undefined") module.exports={collectMooc};
