"""使用临时 SQLite 与临时服务副本验收 PTA，不连接真实平台。"""
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from contextlib import closing
from datetime import datetime
from pathlib import Path

import course_scope
import pta_sync
import rain_catalog
import retention

T1 = "2026-11-03T10:00:00+08:00"
T2 = "2026-11-03T11:00:00+08:00"


def course(cid="101", checked=True, tasks=None, **extra):
    return dict(id=cid,name="测试课程",section="一班",term="2026秋",checked=checked,
                tasks=tasks if tasks is not None else [dict(id="201",title="测试作业",status="未提交",completion="未完成",deadlineAt="2026-11-10T23:59:00+08:00")],**extra)


class PtaTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.root = Path(self.folder.name)
        self.database = self.root / "platform.sqlite3"
        self.conn = rain_catalog.open_db(self.database)
        self.addCleanup(self.conn.close)

    def receive(self, courses=None, now=T1, **extra):
        with self.conn:
            return pta_sync.receive(self.conn,dict(action="pta",**({"courses":courses} if courses is not None else {}),**extra),now)

    def read(self):
        return pta_sync.read(self.database)

    def test_persist_normalized_board_fields_and_id_isolation(self):
        self.conn.execute("INSERT INTO courses(id,name,section,archived) VALUES('101','雨课堂同编号','',0)")
        self.conn.execute("INSERT INTO cx_groups(id,clazz,name) VALUES('cx-101-201','201','学习通')")
        self.conn.commit()
        result = self.receive([course(),course("102")])
        data = self.read()
        self.assertEqual(result["count"],2)
        self.assertEqual(data["checked"],T1)
        self.assertEqual(data["issue"],"")
        self.assertEqual({c["id"] for c in data["courses"]},{"pta-101","pta-102"})
        self.assertEqual(len({t["id"] for t in data["tasks"]}),2)
        self.assertTrue(all(t["platform"]=="PTA（拼题 A）" for t in data["tasks"]))
        self.assertEqual(data["tasks"][0]["deadlineDisplayed"],"2026-11-10 23:59")
        self.assertEqual(self.conn.execute("SELECT name FROM courses WHERE id='101'").fetchone()[0],"雨课堂同编号")
        self.assertEqual(self.conn.execute("SELECT count(*) FROM cx_groups").fetchone()[0],1)

    def test_partial_failure_preserves_cache_and_success_time(self):
        self.receive([course(),course("102")])
        result=self.receive([course(checked=False,issue="登录失效"),course("102",tasks=[])],now=T2)
        data=self.read()
        self.assertEqual((result["count"],result["failed"]),(1,1))
        self.assertEqual(data["checked"],T1)
        self.assertIn("登录失效",data["issue"])
        by_id={c["id"]:c for c in data["courses"]}
        self.assertEqual(by_id["pta-101"]["checked"],T1)
        self.assertEqual(by_id["pta-101"]["attempted"],T2)
        self.assertEqual(by_id["pta-102"]["checked"],T2)
        self.assertEqual([t["courseId"] for t in data["tasks"]],["pta-101"])

    def test_global_issue_or_partial_directory_does_not_unlist(self):
        self.receive([course(),course("102")])
        self.receive(now=T2,issue="网页读取失败")
        self.assertEqual(len(self.read()["courses"]),2)
        self.assertEqual(self.read()["checked"],T1)
        self.receive([course(tasks=[])],now=T2,issue="目录未读全")
        self.assertEqual(len(self.read()["courses"]),2)
        self.assertEqual(len(self.read()["tasks"]),1)

    def test_full_success_removes_absent_courses_and_empty_directory_is_confirmed(self):
        self.receive([course(),course("102")])
        self.receive([course()],now=T2)
        self.assertEqual([c["id"] for c in self.read()["courses"]],["pta-101"])
        self.receive([],now=T2)
        data=self.read()
        self.assertEqual(data["courses"],[])
        self.assertEqual(data["tasks"],[])
        self.assertEqual(data["checked"],T2)

    def test_invalid_course_is_atomic_while_other_course_succeeds(self):
        self.receive([course(),course("102")])
        bad=course(tasks=[dict(id="201",title="不应覆盖",status="已提交"),dict(id="202",title="无时区",deadlineAt="2026-11-10T12:00:00")])
        result=self.receive([bad,course("102",tasks=[])],now=T2)
        self.assertEqual(result["failed"],1)
        data=self.read()
        self.assertEqual(len(data["tasks"]),1)
        self.assertEqual(data["tasks"][0]["title"],"测试作业")
        self.assertEqual(data["tasks"][0]["observedAt"],T1)
        self.assertIn("缺少时区",data["issue"])

    def test_duplicate_courses_or_tasks_cannot_replace_cache(self):
        self.receive([course()])
        self.receive([course(tasks=[]),course(tasks=[])],now=T2)
        self.assertEqual(len(self.read()["tasks"]),1)
        task=course()["tasks"][0]
        self.receive([course(tasks=[task,task])],now=T2)
        self.assertEqual(len(self.read()["tasks"]),1)
        self.assertEqual(self.read()["checked"],T1)

    def test_natural_month_boundary_and_unknown_deadline(self):
        tasks=[dict(id="1",title="月底",status="未提交",deadlineAt="2026-10-31T12:00:00+08:00"),
               dict(id="2",title="无截止时间",status="待核实",deadlineAt=None)]
        self.receive([course(tasks=tasks)])
        with self.conn:
            retention.clean(self.conn,datetime.fromisoformat("2026-11-30T11:59:59+08:00"))
        self.assertEqual(len(self.read()["tasks"]),2)
        with self.conn:
            retention.clean(self.conn,datetime.fromisoformat("2026-11-30T12:00:00+08:00"))
        self.assertEqual([t["title"] for t in self.read()["tasks"]],["无截止时间"])

    def test_expired_task_not_reintroduced_but_extended_deadline_restores(self):
        old=dict(id="1",title="旧作业",status="未提交",deadlineAt="2026-09-30T12:00:00+08:00")
        self.receive([course(tasks=[old])])
        self.assertEqual(self.read()["tasks"],[])
        self.receive([course(tasks=[dict(old,deadlineAt="2026-11-10T12:00:00+08:00")])],now=T2)
        self.assertEqual(len(self.read()["tasks"]),1)

    def test_partial_directory_missing_date_preserves_known_deadline_and_allows_update(self):
        self.receive([course()])
        initial = self.read()["tasks"][0]
        for value in (None, "", "omitted"):
            task = dict(id="201", title="测试作业", status="个人状态待核实", completion="待核实")
            if value != "omitted":
                task["deadlineAt"] = value
            self.receive([course(checked=False, tasks=[task], partial=True)], now=T2)
            saved = self.read()["tasks"][0]
            self.assertEqual(saved["deadlineAt"], initial["deadlineAt"])
            self.assertEqual(saved["deadlineDisplayed"], initial["deadlineDisplayed"])
            self.assertEqual(self.conn.execute("SELECT due FROM pta_work WHERE id=?", (saved["id"],)).fetchone()[0], initial["deadlineAt"])
        revised = "2042-05-06T18:42:51+08:00"
        self.receive([course(checked=False, tasks=[dict(task, deadlineAt=revised)], partial=True)], now=T2)
        self.assertEqual(self.read()["tasks"][0]["deadlineAt"], revised)
        self.assertEqual(self.read()["tasks"][0]["deadlineDisplayed"], "2042-05-06 18:42")

    def test_history_filter_and_pin_restore(self):
        old=course(tasks=[])
        old["term"]="2024春"
        self.receive([old])
        self.assertEqual(self.read()["courses"],[])
        history=course_scope.history(self.conn)
        self.assertEqual(history[0]["platform"],"PTA（拼题 A）")
        with self.conn:
            self.conn.execute("UPDATE course_scope SET pinned=1 WHERE id='pta-101'")
        self.assertEqual(len(self.read()["courses"]),1)
        self.receive([course()],now=T2)
        self.assertEqual(len(self.read()["tasks"]),1)

    def test_unknown_submission_does_not_drop_complete_task_list(self):
        task=dict(id="201",title="个人状态未提供",status="个人提交状态待核实",completion="待核实",deadlineAt=None)
        self.receive([course(tasks=[task],issue="部分个人提交状态待核实")])
        data=self.read()
        self.assertEqual(len(data["tasks"]),1)
        self.assertEqual(data["tasks"][0]["completionState"],"待核实")
        self.assertEqual(data["courses"][0]["checked"],T1)
        self.assertIn("待核实",data["courses"][0]["note"])

    def test_partial_tasks_merge_without_deleting_previous_or_advancing_success(self):
        self.receive([course()])
        task=dict(id="202",title="部分范围新增",status="未提交",completion="未完成",deadlineAt=None)
        self.receive([course(checked=False,tasks=[task],partial=True,issue="源课程未完整读取")],now=T2)
        data=self.read()
        self.assertEqual(len(data["tasks"]),2)
        self.assertEqual(data["courses"][0]["checked"],T1)
        self.assertEqual(data["checked"],T1)
        self.assertIn("部分读取",data["courses"][0]["note"])

    def test_complete_directory_shrinks_to_empty_and_records_success_with_warning(self):
        self.receive([course(),course("102")],warning="部分个人状态未核实")
        self.receive([course()],now=T2,warning="个人状态待核实")
        self.assertEqual(len(self.read()["courses"]),1)
        self.assertEqual(self.read()["checked"],T2)
        self.receive([],now=T2,warning="目录完整")
        self.assertEqual(self.read()["courses"],[])
        self.assertEqual(self.read()["checked"],T2)

    def test_directory_unknown_preserves_old_correct_submission_evidence_and_time(self):
        done=dict(id="201",title="虚构题集",status="本人全部 2 题均有答案正确的提交记录",completion="已完成",deadlineAt=None)
        self.receive([course(tasks=[done])])
        # 兼容旧服务尚未写statusEvidence的既有正解记录。
        with self.conn:
            self.conn.execute("UPDATE pta_work SET body=json_remove(body,'$.statusEvidence')")
        unknown=dict(done,status="待核实",completion="待核实")
        self.receive([course(tasks=[unknown])],now=T2)
        row=self.read()["tasks"][0]
        self.assertEqual(row["completionState"],"已完成")
        self.assertEqual(row["observedAt"],T1)
        self.assertEqual(row["directoryObservedAt"],T2)
        self.assertIn("未重新核实",row["statusBasis"])

    def test_platform_and_board_http_in_isolated_copy(self):
        source=Path(__file__).resolve().parent
        isolated=self.root/"app"
        isolated.mkdir()
        for path in source.glob("*.py"):
            shutil.copyfile(path,isolated/path.name)
        for name in ("学习通接入验证.json","雨课堂接入验证.json"):
            (isolated/name).write_text(json.dumps({"assignments":[]}),encoding="utf-8")
        program=r'''
import json, threading
from contextlib import closing
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.request import Request,urlopen
import platform_sync, server, workbench
platform_sync.platform_settings(['pta'])
root=Path.cwd()
inbox=root/'inbox'
inbox.mkdir()
httpd=ThreadingHTTPServer(('127.0.0.1',0),server.make_handler(root,0,root/'links.sqlite3',inbox))
httpd.RequestHandlerClass=server.make_handler(root,httpd.server_port,root/'links.sqlite3',inbox)
thread=threading.Thread(target=httpd.serve_forever,daemon=True)
thread.start()
base='http://127.0.0.1:'+str(httpd.server_port)
def get(path):
    with urlopen(base+path,timeout=5) as response:
        return json.load(response)
try:
    assert get('/api/platform-preferences')=={'configured':True,'selected':['pta']}
    assert get('/api/sync/status')['connections']['pta']['connected'] is False
    def select(keys):
        req=Request(base+'/api/platform-preferences',data=json.dumps({'selected':keys}).encode(),headers={'Content-Type':'application/json','Origin':base})
        with urlopen(req,timeout=5) as response:return json.load(response)
    assert select([])['selected']==[]
    assert platform_sync.receive({'action':'check','platform':'pta'})['enabled'] is False
    assert platform_sync.receive({'action':'pta','courses':[]})['skipped'] is True
    assert select(['pta'])['selected']==['pta']
    payload={'action':'pta','courses':[{'id':'101','name':'模拟PTA','section':'一班','term':'2026秋','checked':True,'tasks':[{'id':'201','title':'模拟作业','status':'未提交','completion':'未完成','deadlineAt':None}]}]}
    request=Request(base+'/api/sync/browser',data=json.dumps(payload).encode(),headers={'Content-Type':'application/json','Origin':'chrome-extension://'+'a'*32,'X-Course-Connector':'1'})
    with urlopen(request,timeout=5) as response:
        assert json.load(response)['count']==1
    board=get('/api/workbench?task=')
    course=next(c for c in board['courses'] if c.get('platform')=='PTA（拼题 A）')
    task=next(t for t in board['assignments'] if t['platform']=='PTA（拼题 A）')
    assert task['courseId']==course['id']=='pta-101'
    assert board['ptaSync']['checked'] and not board['ptaSync']['issue']
    detail=get('/api/workbench?task='+task['id'])
    assert detail['task']['id']==task['id']
    state=get('/api/sync/status')['pta']
    assert state['courses'][0]['checked']==board['ptaSync']['checked']
    assert select([])['selected']==[]
    assert len(get('/api/workbench?task=')['assignments'])==1
    select(['pta'])
    platform_sync.stop()
    try:
        platform_sync.receive(payload)
        raise AssertionError('paused receiver accepted payload')
    except ValueError:
        pass
    print('PTA HTTP/board/detail/status/paused verified')
finally:
    httpd.shutdown()
    httpd.server_close()
    thread.join(timeout=5)
'''
        env=os.environ.copy()
        env.pop("KECANG_COURSES_ROOT",None)
        env.pop("KECANG_INBOX",None)
        result=subprocess.run([sys.executable,"-B","-X","utf8","-c",program],cwd=isolated,env=env,capture_output=True,text=True,encoding="utf-8",timeout=30)
        self.assertEqual(result.returncode,0,result.stdout+result.stderr)
        self.assertIn("verified",result.stdout)

    def test_active_scope_exact_ids_and_directory_preserves_evidence_time_and_old_courses(self):
        self.receive([course(),course("102")])
        proof=dict(kind="problem_id_states",course="101",requiredProblemIds=["301","302"],
                   problemStates=[dict(id="301",status="PROBLEM_ACCEPTED"),dict(id="302",status="PROBLEM_ACCEPTED")])
        done=dict(id="201",title="合成题集",status="本人全部 2 题均有答案正确的提交记录",completion="已完成",evidence=proof)
        self.receive([course(tasks=[done])],now=T2,scope="active")
        tasks={t["courseId"]:t for t in self.read()["tasks"]}
        self.assertEqual(tasks["pta-101"]["statusVerifiedAt"],T2)
        self.assertEqual(len(self.read()["courses"]),2)
        later="2026-11-03T12:00:00+08:00"
        self.receive([course(tasks=[dict(id="201",title="合成题集",status="待核实",completion="待核实")])],now=later,scope="active")
        row=next(t for t in self.read()["tasks"] if t["courseId"]=="pta-101")
        self.assertEqual(row["completionState"],"已完成")
        self.assertEqual(row["observedAt"],T2)
        self.assertEqual(row["statusVerifiedAt"],T2)
        self.assertEqual(row["submissionEvidence"],proof)
        self.assertEqual(len(self.read()["courses"]),2)
        bad=dict(proof,problemStates=[dict(id="301",status="PROBLEM_ACCEPTED"),dict(id="303",status="PROBLEM_ACCEPTED")])
        result=self.receive([course(tasks=[dict(done,evidence=bad)])],now=later,scope="active")
        self.assertEqual(result["failed"],1)
        self.assertEqual(next(t for t in self.read()["tasks"] if t["courseId"]=="pta-101")["observedAt"],T2)


if __name__=="__main__":
    unittest.main()
