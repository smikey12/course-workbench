/* Package-local DOM-only reader: no fetch, answer fields or submission endpoints. */
async function collectPta() {
 const u=new URL(location.href),root=document.querySelector("main,[role=main]")||document.body;
 const fail=issue=>({issue});
 if(u.origin!=="https://pintia.cn")return fail("PTA 页面离开授权域名");
 const visible=n=>n.getClientRects().length>0 && getComputedStyle(n).visibility!=="hidden" && getComputedStyle(n).display!=="none";
 let rows=[];
 const match=/^\/problem-sets\/([1-9][0-9]{0,24})\/(?:exam\/)?overview\/?$/.exec(u.pathname);
 if(match) {
  const text=root.innerText||"";
  if(!document.querySelector("#exam-app") || !/答题信息/.test(text) || !/答题开始时间/.test(text) || !/答题中|已开放/.test(text))return fail("只读取已开放且有个人答题信息的题集概览；请本人打开后重试");
  const link=[...root.querySelectorAll("a[href]")].find(n=>visible(n)&&new URL(n.getAttribute("href"),u).origin===u.origin&&new URL(n.getAttribute("href"),u).pathname===u.pathname&&n.innerText.trim()!=="概览");
  if(!link?.innerText.trim())return fail("概览未提供可核验的题集名称");
  const m=/答题结束时间\s*(20\d\d)[/-](\d{1,2})[/-](\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(text);
  const due=m?`${m[1]}-${m[2].padStart(2,"0")}-${m[3].padStart(2,"0")}T${m[4].padStart(2,"0")}:${m[5]}:${m[6]||"00"}+08:00`:null;
  rows=[{id:match[1],name:link.innerText.trim().slice(0,300),due}];
 } else if(["/problem-sets/active","/problem-sets/all"].includes(u.pathname)) {
  if(!document.querySelector("#problem-set-join-type"))return fail("本人目录尚未就绪或需登录；本轮不翻页、不重载");
  const busy=[...root.querySelectorAll('[aria-busy="true"],[role="progressbar"],.ant-spin-spinning')].some(visible);
  if(busy)return fail("本人目录仍在加载，尚未取得结果");
  const ids=new Set();
  for(const a of root.querySelectorAll("a[href]")) {
   if(!visible(a))continue;
   const target=new URL(a.getAttribute("href"),u),id=/^\/problem-sets\/([1-9][0-9]{0,24})\/overview$/.exec(target.pathname),text=a.innerText.trim();
   if(target.origin!==u.origin||!id||ids.has(id[1])||!/来源用户组[:：]/.test(text))continue;
   ids.add(id[1]);rows.push({id:id[1],name:text.split(/关闭时间[:：]/)[0].trim().slice(0,300),due:null});
  }
  if(!rows.length) {
   const empty=[...root.querySelectorAll('[data-empty],.ant-empty-description,[role="status"]')].some(n=>visible(n)&&/^(暂无题目集|没有题目集|暂无数据|No problem sets|No data)$/i.test(n.innerText.trim()));
   const total=/共\s*(\d+)\s*条数据/.exec(root.innerText||"");
   if(document.readyState!=="complete"||!empty||(total&&Number(total[1])!==0))return fail("本人目录尚未就绪：等待题集卡片或明确空目录，当前未取得结果");
  }
 } else return fail("仅支持本人当前目录或已开放题集概览；不访问作答、提交及题目列表");
 const issue="仅当前单页元数据，未翻页、未核验逐题提交；完成状态待核实";
 return {emptyConfirmed:rows.length===0,courses:rows.filter(r=>r.name).map(r=>({id:r.id,name:r.name,section:"PTA 只读概览",checked:false,partial:true,issue,tasks:[{id:"set-"+r.id,title:r.name,status:"个人提交状态待核实",completion:"待核实",deadlineAt:r.due}]})),issue};
}
if(typeof module!=="undefined")module.exports={collectPta};
