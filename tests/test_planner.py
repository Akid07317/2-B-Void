import json
import tempfile
import threading
import unittest
from copy import deepcopy
from datetime import datetime, timedelta
from pathlib import Path
from http.server import ThreadingHTTPServer
from urllib.request import Request,urlopen
from urllib.error import HTTPError

from planner.domain import initial_state, apply_action, DomainError, TZ, stamp, uid, check_graph
from planner.scheduler import plan, validate_plan, split_seconds, calendar
from planner.store import Store
from planner.server import make_handler

NOW=datetime(2026,9,21,17,0,tzinfo=TZ)


def add(s, minutes=60, **kwargs):
    data={'title':'任务','criteria':'保存结果并确认','remaining_seconds':minutes*60,**kwargs}
    return apply_action(s,'create_task',data,NOW)['task_id']


def request(state, action, data, key=None):
    return {'action':action,'data':data,'expected_revision':state['revision'],'idempotency_key':key or uid()}


class PlannerTests(unittest.TestCase):
    def setUp(self):
        self.s=initial_state()
        self.s['settings'].update(buffer_percent=0,horizon_days=1)

    def test_complete_two_tasks_not_empty(self):
        add(self.s);add(self.s)
        p=plan(self.s,NOW)
        self.assertEqual([a['coverage'] for a in p['assessments']],['FULL','FULL'])
        self.assertEqual(sum(b['planned_work_seconds'] for b in p['blocks']),7200)

    def test_overload_returns_partial(self):
        add(self.s,300)
        p=plan(self.s,NOW)
        self.assertEqual(p['assessments'][0]['unallocated_seconds'],3600)
        self.assertEqual(p['assessments'][0]['coverage'],'PARTIAL')

    def test_incomplete_cutoff_no_new_partial(self):
        add(self.s,300,cutoff_at='2026-09-21T22:00:00+08:00')
        p=plan(self.s,NOW)
        self.assertEqual(p['blocks'],[])
        self.assertEqual(p['assessments'][0]['evidence'],'NOT_PROVEN')

    def test_rescue_partial_explicit(self):
        add(self.s,300,cutoff_at='2026-09-21T22:00:00+08:00',rescue_partial=True)
        self.assertEqual(plan(self.s,NOW)['assessments'][0]['coverage'],'PARTIAL')

    def test_shared_dependency(self):
        a=add(self.s,30);add(self.s,30,dependencies=[a]);add(self.s,30,dependencies=[a])
        p=plan(self.s,NOW)
        self.assertEqual(sum(b['planned_work_seconds'] for b in p['blocks']),5400)
        self.assertEqual(len([b for b in p['blocks'] if b['task_id']==a]),1)
        with self.assertRaises(DomainError):
            apply_action(self.s,'start_timer',{'task_id':self.s['tasks'][1]['id']},NOW)

    def test_graph_cycle(self):
        a=add(self.s);b=add(self.s,dependencies=[a])
        self.s['tasks'][0]['dependencies']=[b]
        with self.assertRaises(DomainError):check_graph(self.s['tasks'])

    def test_rounding_and_short_tail(self):
        add(self.s,53)
        p=plan(self.s,NOW)
        self.assertEqual(p['blocks'][-1]['rounding_padding_seconds'],420)
        self.assertEqual(p['assessments'][0]['covered_seconds'],3180)
        self.assertEqual(p['assessments'][0]['unallocated_seconds'],0)

    def test_changed_estimate_recomputes_padding(self):
        add(self.s,53)
        self.s['blocks']=plan(self.s,NOW)['blocks']
        self.s['tasks'][0]['remaining_seconds']=90*60
        result=plan(self.s,NOW)
        self.assertEqual(result['assessments'][0]['covered_seconds'],90*60)
        self.assertEqual(result['assessments'][0]['unallocated_seconds'],0)

    def test_only_complete_short_tail(self):
        self.s['settings']['daily_minutes']=15
        add(self.s,60)
        self.assertEqual(plan(self.s,NOW)['blocks'],[])
        self.s['tasks'][0]['remaining_seconds']=15*60
        self.assertEqual(plan(self.s,NOW)['assessments'][0]['coverage'],'FULL')

    def test_non_split_cannot_use_fragments(self):
        add(self.s,180,splittable=False)
        self.s['events']=[{'id':uid(),'title':'课','start':'2026-09-21T19:00:00+08:00','end':'2026-09-21T20:00:00+08:00'}]
        self.assertEqual(plan(self.s,NOW)['blocks'],[])

    def test_fixed_event_union(self):
        self.s['events']=[{'start':'2026-09-21T18:00:00+08:00','end':'2026-09-21T19:00:00+08:00'},
                          {'start':'2026-09-21T18:30:00+08:00','end':'2026-09-21T19:30:00+08:00'}]
        d=calendar(self.s,NOW)['2026-09-21']
        self.assertEqual(d['limit'],150*60)

    def test_buffer_default(self):
        self.s['settings'].update(end_hour=20,buffer_percent=20)
        self.assertEqual(calendar(self.s,NOW)['2026-09-21']['capacity'],105*60)

    def test_protection_conflict_and_authorized_adjustment(self):
        add(self.s,120)
        p=plan(self.s,NOW)
        self.s['blocks']=p['blocks']
        self.s['blocks'][0]['manual_lock']=True
        self.s['tasks'][0]['remaining_seconds']=45*60
        with self.assertRaises(DomainError):plan(self.s,NOW)
        p2=plan(self.s,NOW,True,[self.s['blocks'][0]['id']])
        self.assertEqual(p2['assessments'][0]['covered_seconds'],45*60)
        self.assertTrue(any(c['protected'] for c in p2['changes']))

    def test_unknown_execution_holds_not_coverage(self):
        add(self.s,120)
        self.s['blocks']=plan(self.s,NOW)['blocks']
        p=plan(self.s,datetime(2026,9,21,19,0,tzinfo=TZ))
        self.assertEqual(p['assessments'][0]['coverage'],'UNKNOWN')
        self.assertTrue(all(b['coverage_state']=='HOLD' for b in p['blocks']))

    def test_direct_remaining_not_double_subtracted(self):
        key=add(self.s,180)
        apply_action(self.s,'record',{'task_id':key,'start':stamp(NOW-timedelta(hours=1)), 'end':stamp(NOW),
                                     'feedback':'remaining','remaining_seconds':75*60},NOW)
        self.assertEqual(self.s['tasks'][0]['remaining_seconds'],75*60)

    def test_timebox_zero_requires_checkpoint(self):
        key=add(self.s,kind='TIMEBOX',budget_seconds=3600)
        apply_action(self.s,'record',{'task_id':key,'start':stamp(NOW-timedelta(hours=1)),'end':stamp(NOW),'feedback':'on_track'},NOW)
        self.assertEqual(self.s['tasks'][0]['status'],'REVIEW')
        with self.assertRaises(DomainError):apply_action(self.s,'close_task',{'id':key,'note':'未得到结果'},NOW)
        apply_action(self.s,'close_task',{'id':key,'note':'排除一种方案','decision':'STOP'},NOW)
        self.assertEqual(self.s['tasks'][0]['status'],'DONE')

    def test_timer_pause_actual_only(self):
        key=add(self.s)
        apply_action(self.s,'start_timer',{'task_id':key},NOW)
        apply_action(self.s,'pause_timer',{},NOW+timedelta(minutes=10))
        apply_action(self.s,'resume_timer',{},NOW+timedelta(minutes=20))
        apply_action(self.s,'finish_timer',{'feedback':'on_track'},NOW+timedelta(minutes=30))
        self.assertEqual(self.s['records'][0]['active_seconds'],1200)
        self.assertIsNone(self.s['timer'])
        self.assertEqual(self.s['tasks'][0]['remaining_seconds'],2400)

    def test_cross_midnight(self):
        segments=[{'start':'2026-09-21T23:45:00+08:00','end':'2026-09-22T00:15:00+08:00'}]
        self.assertEqual(split_seconds(segments,NOW.date()),900)
        self.assertEqual(split_seconds(segments,(NOW+timedelta(days=1)).date()),900)

    def test_running_stops_same_day_promises(self):
        key=add(self.s);add(self.s)
        apply_action(self.s,'start_timer',{'task_id':key},NOW)
        self.assertEqual(plan(self.s,NOW)['blocks'],[])

    def test_independent_validator_rejects_overlap(self):
        add(self.s);add(self.s)
        p=plan(self.s,NOW)
        p['blocks'][1]['start']=p['blocks'][0]['start'];p['blocks'][1]['end']=p['blocks'][0]['end']
        with self.assertRaises(DomainError):validate_plan(self.s,p,NOW)

    def test_replan_retains_ids(self):
        add(self.s)
        p=plan(self.s,NOW);self.s['blocks']=p['blocks']
        p2=plan(self.s,NOW)
        self.assertEqual([b['id'] for b in p['blocks']],[b['id'] for b in p2['blocks']])
        self.assertEqual(p2['changes'],[])

    def test_due_late_cutoff_valid(self):
        add(self.s,due_at='2026-09-21T17:30:00+08:00',cutoff_at='2026-09-21T22:00:00+08:00')
        self.assertTrue(plan(self.s,NOW)['assessments'][0]['late'])


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.path=Path(self.tmp.name)/'planner.sqlite3';self.store=Store(self.path)
    def tearDown(self):self.tmp.cleanup()
    def create(self):
        return self.store.write(request(self.store.read(),'create_task',{'title':'作业','criteria':'题解','remaining_seconds':3600}),NOW)
    def test_idempotency_and_restart(self):
        r=request(self.store.read(),'create_task',{'title':'作业','criteria':'题解','remaining_seconds':3600})
        a=self.store.write(r,NOW);b=self.store.write(r,NOW)
        self.assertEqual(a,b);self.assertEqual(len(Store(self.path).read()['tasks']),1)
        r['data']['title']='不同内容'
        with self.assertRaises(DomainError):self.store.write(r,NOW)
    def test_failed_transaction_rolls_back(self):
        self.create();s=self.store.read();r=request(s,'create_task',{'title':'错序','criteria':'标准','remaining_seconds':3600,'due_at':'2026-09-20T18:00:00+08:00'})
        with self.assertRaises(DomainError):self.store.write(r,NOW)
        self.assertEqual(self.store.read(),s)
    def test_old_revision_rejected(self):
        self.create()
        with self.assertRaises(DomainError):self.store.write({'idempotency_key':uid(),'expected_revision':0,'action':'settings','data':{}},NOW)
    def test_plan_apply_and_expiry(self):
        self.create();s=self.store.read();p=plan(s,NOW)
        r=request(s,'apply_plan',{'proposal_id':p['id'],'manual_release_ids':[]})
        with self.assertRaises(DomainError):self.store.write(r,NOW+timedelta(minutes=6),p)
        self.store.write(r,NOW,p)
        self.assertTrue(self.store.read()['blocks'])
    def test_log_overlap_is_atomic(self):
        self.create();key=self.store.read()['tasks'][0]['id']
        data={'task_id':key,'start':stamp(NOW-timedelta(hours=1)),'end':stamp(NOW),'feedback':'on_track'}
        self.store.write(request(self.store.read(),'record',data),NOW)
        before=self.store.read()
        with self.assertRaises(DomainError):self.store.write(request(before,'record',data),NOW)
        self.assertEqual(self.store.read(),before)
    def test_three_domain_workflow_persists_after_reopen(self):
        keys=[]
        for category in ('COURSE','RESEARCH','COMPETITION'):
            r=self.store.write(request(self.store.read(),'create_task',{
                'title':category,'category':category,'criteria':'产生可检查结果','remaining_seconds':5400}),NOW)
            keys.append(r['result']['task_id'])
        self.store.write(request(self.store.read(),'create_event',{
            'title':'固定课程','start':'2026-09-21T19:00:00+08:00','end':'2026-09-21T20:00:00+08:00'}),NOW)
        def publish(adjust=False,release=None):
            p=plan(self.store.read(),NOW,adjust,release)
            self.store.write(request(self.store.read(),'apply_plan',{'proposal_id':p['id'],'manual_release_ids':release or []}),NOW,p)
            return p
        publish()
        block=next(b for b in self.store.read()['blocks'] if b['task_id']==keys[0])
        self.store.write(request(self.store.read(),'lock_block',{'id':block['id'],'locked':True}),NOW)
        self.store.write(request(self.store.read(),'record',{'task_id':keys[0],
            'start':stamp(NOW-timedelta(minutes=30)),'end':stamp(NOW),
            'feedback':'remaining','remaining_seconds':45*60}),NOW)
        publish(True,[block['id']])
        self.store.write(request(self.store.read(),'close_task',{'id':keys[0],'note':'检查题解并确认'}),NOW)
        loaded=Store(self.path).read()
        self.assertEqual(loaded['tasks'][0]['status'],'DONE')
        self.assertEqual(sum(r['active_seconds'] for r in loaded['records']),1800)
        self.assertFalse(any(b['task_id']==keys[0] and b['state']=='PLANNED' for b in loaded['blocks']))
        self.assertEqual(len(loaded['tasks']),3)

    def test_http_smoke_and_origin(self):
        server=ThreadingHTTPServer(('127.0.0.1',0),make_handler(self.store))
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        url=f'http://127.0.0.1:{server.server_port}'
        try:
            self.assertIn('留白',urlopen(url).read().decode())
            self.assertEqual(json.load(urlopen(url+'/api/state'))['state']['revision'],0)
            req=Request(url+'/api/preview',data=b'{}',headers={'Content-Type':'application/json','Origin':'https://example.org'})
            with self.assertRaises(HTTPError) as exc:urlopen(req)
            self.assertEqual(exc.exception.code,403)
            exc.exception.close()
        finally:server.shutdown();server.server_close();thread.join()

if __name__=='__main__':unittest.main()
