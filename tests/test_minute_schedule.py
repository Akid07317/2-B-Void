import unittest
from datetime import timedelta
import test_manual as manual
from test_planner import NOW, add
from planner.domain import initial_state, apply_action
from planner.scheduler import plan


class MinuteTests(unittest.TestCase):
    setUp = manual.ManualTests.setUp
    act = manual.ManualTests.act
    task = manual.ManualTests.task
    place = manual.ManualTests.place
    undo = manual.ManualTests.undo
    rejects = manual.ManualTests.rejects

    def test_exact_minutes_survive_reload_move_resize_and_undo(self):
        task=self.task(remaining_seconds=45*60)
        bid=self.place(task,'18:37','19:22')['result']['block_id']
        self.place(task,'19:07','19:24',id=bid)
        self.assertEqual(self.store.read()['blocks'][0]['planned_work_seconds'],17*60)
        self.undo()
        from planner.store import Store
        b=Store(self.path).read()['blocks'][0]
        self.assertEqual(b['start'],'2026-09-21T18:37:00+08:00')
        self.assertEqual(b['end'],'2026-09-21T19:22:00+08:00')

    def test_one_minute_partial_is_allowed_but_seconds_are_rejected(self):
        task=self.task()
        self.place(task,'18:37','18:38')
        self.assertEqual(self.store.read()['blocks'][0]['planned_work_seconds'],60)
        for second in ('01','00.5'):
            self.rejects(lambda:self.act('manual_schedule',{'task_id':task,
                'start':f'2026-09-21T19:00:{second}+08:00','end':'2026-09-21T19:01:00+08:00'}))

    def test_subminute_work_keeps_exact_seconds_and_padding(self):
        task=self.task(remaining_seconds=59)
        self.place(task,'18:37','18:38')
        b=self.store.read()['blocks'][0]
        self.assertEqual((b['planned_work_seconds'],b['rounding_padding_seconds']),(59,1))
        p=plan(self.store.read(),NOW)
        self.assertEqual(len(p['blocks']),1)
        self.assertEqual(p['assessments'][0]['covered_seconds'],59)

    def test_second_boundary_event_conflict_rolls_back(self):
        task=self.task()
        self.act('create_event',{'title':'课','start':'2026-09-21T18:37:30+08:00','end':'2026-09-21T18:38:15+08:00'})
        self.rejects(lambda:self.place(task,'18:37','18:38'))
        self.place(task,'18:39','18:40')

    def test_auto_plan_respects_minute_lock_without_tiny_fragments(self):
        task=self.task(remaining_seconds=45*60)
        bid=self.place(task,'18:37','19:22')['result']['block_id']
        self.act('lock_block',{'id':bid,'locked':True})
        other=self.task(remaining_seconds=120*60)
        p=plan(self.store.read(),NOW)
        locked=next(b for b in p['blocks'] if b['id']==bid)
        self.assertEqual(locked['start'],'2026-09-21T18:37:00+08:00')
        auto=[b for b in p['blocks'] if b['task_id']==other]
        self.assertTrue(auto)
        self.assertTrue(all(1800<=b['planned_work_seconds']<=3600 for b in auto[:-1]))

    def test_seconds_timer_and_sources(self):
        task=self.task()
        self.act('start_timer',{'task_id':task})
        self.act('pause_timer',{},NOW+timedelta(seconds=59))
        self.act('resume_timer',{},NOW+timedelta(seconds=119))
        self.act('finish_timer',{'feedback':'on_track'},NOW+timedelta(seconds=120))
        r=self.store.read()['records'][0]
        self.assertEqual((r['active_seconds'],r['source']),(60,'TIMER'))
        self.assertEqual(self.store.read()['tasks'][0]['remaining_seconds'],3540)

    def test_legacy_auto_padding_survives_replanning(self):
        s=initial_state();add(s,53)
        s['blocks']=plan(s,NOW)['blocks']
        for b in s['blocks']:b.pop('source',None)
        p=plan(s,NOW)
        self.assertEqual(p['blocks'][0]['id'],s['blocks'][0]['id'])
        self.assertEqual(p['blocks'][0]['rounding_padding_seconds'],420)

    def test_smaller_estimate_cannot_turn_short_tail_into_negative_work(self):
        from planner.domain import DomainError
        task=self.task()
        self.place(task,'18:00','18:52')
        self.place(task,'19:00','19:08')
        self.act('update_task',{'id':task,'remaining_seconds':51*60})
        with self.assertRaises(DomainError) as exc:
            plan(self.store.read(),NOW)
        self.assertEqual(exc.exception.code,'EXCESS_PROTECTED')
