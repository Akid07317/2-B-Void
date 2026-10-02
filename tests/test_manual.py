"""Manual UI operations must obey scheduling rules and survive real DB reloads."""
import tempfile
import unittest
from pathlib import Path
from datetime import timedelta
from planner.domain import DomainError
from planner.store import Store
from test_planner import NOW, request

class ManualTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path=Path(self.tmp.name)/'manual.sqlite3'
        self.store=Store(self.path)
    def act(self, action, data, now=NOW):
        if action=='settings':data={**self.store.read()['settings'],**data}
        return self.store.write(request(self.store.read(),action,data),now)
    def task(self, **extra):
        return self.act('create_task',{'title':'阅读论文','remaining_seconds':3600,'quick_entry':True,**extra})['result']['task_id']
    def place(self, task, start='18:00', end='19:00', **extra):
        return self.act('manual_schedule',dict(task_id=task,start=f'2026-09-21T{start}:00+08:00',end=f'2026-09-21T{end}:00+08:00',**extra))
    def undo(self, now=NOW):
        return self.act('undo_last',{'token':self.store.read()['undo']['token']},now)
    def rejects(self, callback):
        before=self.store.read()
        with self.assertRaises(DomainError):callback()
        self.assertEqual(before,self.store.read())
    def test_quick_entry_keeps_explicit_estimate_without_fake_criterion(self):
        self.task();t=self.store.read()['tasks'][0]
        self.assertEqual(t['status'],'OPEN');self.assertEqual(t['criteria'],'')
        self.assertEqual(t['remaining_seconds'],3600)
        self.task(quick_entry=False)
        self.assertEqual(self.store.read()['tasks'][1]['status'],'DRAFT')
    def test_move_resize_and_undo_survive_restart(self):
        task=self.task();bid=self.place(task)['result']['block_id']
        self.place(task,'19:00','19:30',id=bid)
        self.store=Store(self.path)
        self.assertEqual(self.store.read()['blocks'][0]['id'],bid)
        self.assertEqual(self.store.read()['blocks'][0]['planned_work_seconds'],1800)
        revision=self.store.read()['revision'];self.undo()
        self.assertEqual(self.store.read()['blocks'][0]['start'],'2026-09-21T18:00:00+08:00')
        self.assertEqual(self.store.read()['revision'],revision+1)
        self.undo();self.assertEqual(self.store.read()['blocks'],[])
        self.undo();self.assertEqual(self.store.read()['tasks'],[])
    def test_event_and_block_conflicts_roll_back(self):
        task=self.task();other=self.task()
        self.act('create_event',{'title':'课程','start':'2026-09-21T19:00:00+08:00','end':'2026-09-21T20:00:00+08:00'})
        self.place(task)
        self.rejects(lambda:self.place(other,'18:30','19:30'))
        self.rejects(lambda:self.place(other,'19:00','20:00'))
    def test_grid_window_capacity_cutoff_and_overallocation(self):
        task=self.task(cutoff_at='2026-09-21T21:00:00+08:00')
        for start,end in [('17:00','18:00'),('21:00','22:00'),('18:00','19:30')]:
            self.rejects(lambda:self.place(task,start,end))
        self.act('settings',{'daily_minutes':30,'buffer_percent':0})
        self.rejects(lambda:self.place(task))
    def test_lock_and_explicit_unschedule(self):
        task=self.task();bid=self.place(task)['result']['block_id']
        self.act('lock_block',{'id':bid,'locked':True})
        self.rejects(lambda:self.place(task,'19:00','20:00',id=bid))
        self.rejects(lambda:self.act('unschedule_block',{'id':bid}))
        self.act('lock_block',{'id':bid,'locked':False})
        self.act('unschedule_block',{'id':bid});self.assertEqual(self.store.read()['blocks'],[])
        self.undo();self.assertEqual(self.store.read()['blocks'][0]['id'],bid)
    def test_completion_releases_reservations_without_inventing_time(self):
        task=self.task();self.place(task)
        self.act('complete_task',{'id':task});s=self.store.read()
        self.assertEqual(s['tasks'][0]['status'],'DONE');self.assertEqual(s['records'],[])
        self.assertFalse(any(b['state']=='PLANNED' for b in s['blocks']))
        self.undo();s=self.store.read()
        self.assertEqual(s['tasks'][0]['status'],'OPEN');self.assertEqual(s['blocks'][0]['state'],'PLANNED')
    def test_timebox_still_requires_checkpoint(self):
        task=self.task(kind='TIMEBOX',budget_seconds=3600,criteria='记录实验结果')
        self.rejects(lambda:self.act('complete_task',{'id':task}))
    def test_quick_entry_does_not_bypass_timebox_checkpoint(self):
        self.task(kind='TIMEBOX',budget_seconds=3600)
        self.assertEqual(self.store.read()['tasks'][0]['status'],'DRAFT')
    def test_dependency_must_be_fully_reserved_before_child(self):
        parent=self.task();child=self.task(dependencies=[parent])
        self.rejects(lambda:self.place(child,'19:00','20:00'))
        parent_block=self.place(parent)['result']['block_id'];self.place(child,'19:00','20:00')
        self.rejects(lambda:self.act('unschedule_block',{'id':parent_block}))
    def test_undo_token_revision_and_time_are_guarded(self):
        task=self.task();stale=self.store.read()['undo']['token'];self.place(task)
        self.rejects(lambda:self.act('undo_last',{'token':stale}))
        self.rejects(lambda:self.undo(NOW+timedelta(hours=2)))
    def test_unrelated_action_invalidates_undo(self):
        self.task();self.act('settings',{'daily_minutes':300})
        self.assertNotIn('undo',self.store.read())
    def test_midnight_is_valid_end_boundary(self):
        self.act('settings',{'end_hour':24})
        task=self.task();self.act('manual_schedule',{
            'task_id':task,'start':'2026-09-21T23:00:00+08:00','end':'2026-09-22T00:00:00+08:00'})
        self.assertEqual(len(self.store.read()['blocks']),1)
