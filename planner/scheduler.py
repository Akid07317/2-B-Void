from copy import deepcopy
from datetime import datetime, timedelta
from math import ceil

from .domain import TZ, GRID, AUTO_QUANTUM, AUTO_MIN_SECONDS, AUTO_MAX_SECONDS, DomainError, instant, stamp, uid, overlap, protected, input_issue, active_segments


def split_seconds(segments, day):
    a = datetime.combine(day, datetime.min.time(), TZ)
    b = a + timedelta(days=1)
    return sum(max(0, int((min(instant(s['end']), b) - max(instant(s['start']), a)).total_seconds())) for s in segments)


def calendar(state, now):
    cfg = state['settings']
    days = {}
    history = [s for r in state['records'] for s in r['segments']]
    history += active_segments(state['timer'], now)
    for offset in range(cfg['horizon_days']):
        day = now.astimezone(TZ).date() + timedelta(days=offset)
        midnight = datetime.combine(day, datetime.min.time(), TZ)
        start = midnight + timedelta(hours=cfg['start_hour'])
        end = midnight + timedelta(hours=cfg['end_hour'])
        events = [(instant(e['start']), instant(e['end'])) for e in state['events']]
        # Union of busy intersections, preserving non-grid event boundaries.
        clipped = sorted((max(start, a), min(end, b)) for a, b in events if overlap(start, end, a, b))
        merged = []
        for a, b in clipped:
            if merged and a <= merged[-1][1]:
                merged[-1] = (merged[-1][0], max(b, merged[-1][1]))
            else:
                merged.append((a, b))
        free_seconds = int((end-start).total_seconds()) - sum(int((b-a).total_seconds()) for a,b in merged)
        buffer = AUTO_QUANTUM * ((free_seconds * cfg['buffer_percent'] // 100) // AUTO_QUANTUM)
        limit = min(cfg['daily_minutes'] * 60, free_seconds-buffer)
        remaining = max(0, limit-split_seconds(history, day))
        slots = []
        cursor = start
        while cursor + timedelta(seconds=GRID) <= end:
            finish = cursor + timedelta(seconds=GRID)
            if cursor >= now and not any(overlap(cursor, finish, a, b) for a,b in events):
                slots.append(int(cursor.timestamp()))
            cursor = finish
        # Without an explicit running end, no same-day new work is promised.
        if state['timer'] and offset == 0:
            slots = []
        days[str(day)] = {'slots': set(slots), 'capacity': remaining, 'limit': limit, 'buffer': buffer}
    return days


def block_slots(block):
    start, end = instant(block['start']), instant(block['end'])
    if start.timestamp() % GRID or end.timestamp() % GRID or end <= start:
        raise DomainError('预约起止时间必须精确到整分钟。', 'OFF_GRID_LOCK')
    return list(range(int(start.timestamp()), int(end.timestamp()), GRID))


def day_for(slot):
    return str(datetime.fromtimestamp(slot, TZ).date())


def reserve(days, block):
    slots = block_slots(block)
    counts = {}
    for slot in slots:
        day = day_for(slot)
        if day not in days or slot not in days[day]['slots']:
            raise DomainError('受保护时段与日程、可用时间或正在执行的任务冲突。', 'PROTECTED_CONFLICT')
        counts[day] = counts.get(day, 0) + GRID
    if any(days[d]['capacity'] < seconds for d, seconds in counts.items()):
        raise DomainError('受保护时段超过当天剩余容量。', 'PROTECTED_CONFLICT')
    for slot in slots:
        days[day_for(slot)]['slots'].remove(slot)
    for d, seconds in counts.items():
        days[d]['capacity'] -= seconds


def runs(days, earliest, latest):
    result = []
    for key in sorted(days):
        current = []
        for slot in sorted(days[key]['slots']):
            if slot < earliest or slot+GRID > latest:
                continue
            if current and slot != current[-1]+GRID:
                result.append(current)
                current = []
            current.append(slot)
        if current:
            result.append(current)
    return result


def make_block(task, start, slots):
    return {'id': uid(), 'task_id': task['id'], 'start': stamp(datetime.fromtimestamp(start,TZ)),
            'end': stamp(datetime.fromtimestamp(start+slots*GRID,TZ)), 'manual_lock': False,
            'state': 'PLANNED', 'coverage_state': 'COUNTED', 'planned_work_seconds': slots*GRID,
            'rounding_padding_seconds': 0, 'conditional_on': list(task['dependencies']), 'source': 'AUTO'}


def plan(state, now, adjust_near=False, release_manual=None):
    release_manual = set(release_manual or [])
    known_manual = {b['id'] for b in state['blocks'] if b.get('manual_lock')}
    if not release_manual <= known_manual:
        raise DomainError('人工锁释放清单包含不存在的锁。')
    tasks = {t['id']: t for t in state['tasks']}
    days = calendar(state, now)
    horizon_end = datetime.combine(now.astimezone(TZ).date()+timedelta(days=state['settings']['horizon_days']),datetime.min.time(),TZ)
    issues = {t['id']: input_issue(state,t,now) for t in tasks.values()}
    for _ in range(len(tasks)):
        for task in tasks.values():
            if any(tasks[x]['status'] in ('CANCELLED','PAUSED','DRAFT','REVIEW') or issues[x]
                   for x in task['dependencies'] if tasks[x]['status'] != 'DONE'):
                issues[task['id']] = issues[task['id']] or 'DEPENDENCY_UNSATISFIED'
    blocks = []
    old_future = [b for b in state['blocks'] if b['state']=='PLANNED' and instant(b['start'])>=now and instant(b['start'])<horizon_end]
    for old in old_future:
        keep = old['id'] not in release_manual and (old.get('manual_lock') or (protected(old,now) and not adjust_near))
        if not keep:
            continue
        task = tasks[old['task_id']]
        block = deepcopy(old)
        if task['status'] in ('DONE','CANCELLED'):
            continue
        if instant(block['start']) < instant(task['release_at']) or task['cutoff_at'] and instant(block['end'])>instant(task['cutoff_at']):
            raise DomainError('旧保护块不符合新的开始或截止时间，请明确释放后重排。','PROTECTED_CONFLICT')
        if issues[task['id']] or task['status'] not in ('OPEN','IN_PROGRESS'):
            block.update(coverage_state='HOLD', planned_work_seconds=0, rounding_padding_seconds=0)
        if block['coverage_state']=='COUNTED':
            block['planned_work_seconds']=len(block_slots(block))*GRID
            block['rounding_padding_seconds']=0
        reserve(days,block)
        blocks.append(block)
    def allocated(key):
        return sum(len(block_slots(b))*GRID for b in blocks if b['task_id']==key and b['coverage_state']=='COUNTED')
    for task in tasks.values():
        required = ceil((task['remaining_seconds'] or 0)/AUTO_QUANTUM)*AUTO_QUANTUM
        if not issues[task['id']] and allocated(task['id'])>required:
            raise DomainError('剩余工作量已减少，旧保护块预留过多。请选择要调整的保护时段后重排。','EXCESS_PROTECTED')
    processed, visiting = set(), set()

    def allocate(key, require_full=False):
        nonlocal days, blocks
        task = tasks[key]
        if task['status']=='DONE':
            return True
        target = ceil((task['remaining_seconds'] or 0)/AUTO_QUANTUM)*AUTO_QUANTUM
        if allocated(key) >= (task['remaining_seconds'] or 0):
            target = allocated(key)
        if issues[key] or task['status'] not in ('OPEN','IN_PROGRESS') or target<=0:
            return False
        if key in visiting:
            return False
        if key in processed:
            return allocated(key)==target
        saved_days, saved_blocks = deepcopy(days), deepcopy(blocks)
        saved_processed = set(processed)
        visiting.add(key)
        earliest = max(now.timestamp(),instant(task['release_at']).timestamp())
        for parent in task['dependencies']:
            if not allocate(parent,True):
                days, blocks = saved_days, saved_blocks
                processed.clear(); processed.update(saved_processed)
                visiting.remove(key)
                return False
            if tasks[parent]['status']!='DONE':
                end = max((instant(b['end']).timestamp() for b in blocks if b['task_id']==parent and b['coverage_state']=='COUNTED'),default=earliest)
                earliest=max(earliest,end)
        latest=min(horizon_end.timestamp(),instant(task['cutoff_at']).timestamp() if task['cutoff_at'] else horizon_end.timestamp())
        need=target-allocated(key)
        if need and not task['splittable'] and allocated(key):
            visiting.remove(key)
            return False
        for run in runs(days,earliest,latest):
            if need<=0:
                break
            room=min(len(run),days[day_for(run[0])]['capacity']//GRID)
            wanted=need//GRID
            if not task['splittable'] and room<wanted:
                continue
            take=min(room,wanted,AUTO_MAX_SECONDS//GRID) if task['splittable'] else wanted
            # Repeated blocks in a long free run are allocated below.
            offset=0
            while room>0 and need>0:
                take=min(room,need//GRID,AUTO_MAX_SECONDS//GRID) if task['splittable'] else need//GRID
                if (take*GRID < AUTO_MIN_SECONDS and take*GRID < need) or take<=0:
                    break
                block=make_block(task,run[offset],take)
                reserve(days,block); blocks.append(block)
                need-=take*GRID; room-=take; offset+=take
                if not task['splittable']:
                    break
        full=allocated(key)==target
        strict=require_full or (task['cutoff_at'] and instant(task['cutoff_at'])<=horizon_end and not task['rescue_partial'])
        if strict and not full:
            days,blocks=saved_days,saved_blocks
            processed.clear();processed.update(saved_processed)
        else:
            processed.add(key)
        visiting.remove(key)
        return full

    rank={'COMMITTED':0,'PREFERRED':1,'OPTIONAL':2}
    ordered=sorted(tasks.values(),key=lambda t:(rank[t['importance']], t['due_at'] or t['cutoff_at'] or '9999', t['created_at'],t['id']))
    for task in ordered:
        allocate(task['id'])
    # Keep identity for unchanged reservations even when recomputed.
    old_by_position={(b['task_id'],b['start'],b['end']):b for b in old_future}
    for b in blocks:
        old=old_by_position.get((b['task_id'],b['start'],b['end']))
        if old:
            b['id']=old['id']
            if old['id'] not in release_manual:
                b['manual_lock']=old.get('manual_lock',False)
    assessments=[]
    reasons={'EXECUTION_UNCONFIRMED':'有未核实的执行或正在计时，请先确认。', 'ESTIMATE_REQUIRED':'请补充剩余工时。',
             'CHECKPOINT_REQUIRED':'请记录检查点并关闭本轮探索。','DEPENDENCY_UNSATISFIED':'前置任务需要先处理。'}
    for task in tasks.values():
        if task['status'] in ('DONE','CANCELLED'):
            continue
        key=task['id']; issue=issues[key]
        raw=task['remaining_seconds']
        taskblocks=sorted([b for b in blocks if b['task_id']==key and b['coverage_state']=='COUNTED'],key=lambda b:b['start'])
        covered_slots=sum(len(block_slots(b))*GRID for b in taskblocks)
        coverage='UNKNOWN' if issue else 'FULL' if raw and raw<=covered_slots<=ceil(raw/AUTO_QUANTUM)*AUTO_QUANTUM else 'PARTIAL' if covered_slots else 'NONE'
        if coverage=='FULL':
            padding=covered_slots-raw
            if padding >= len(block_slots(taskblocks[-1]))*GRID:
                raise DomainError('剩余工作量已减少，请释放末尾多余预约后重排。', 'EXCESS_PROTECTED')
            taskblocks[-1]['rounding_padding_seconds']=padding
            taskblocks[-1]['planned_work_seconds']=len(block_slots(taskblocks[-1]))*GRID-padding
        covered=sum(b['planned_work_seconds'] for b in taskblocks)
        if issue:
            reason=issue
        elif task['status']=='DRAFT':
            reason='ESTIMATE_REQUIRED'
        elif task['cutoff_at'] and instant(task['cutoff_at'])<=now:
            reason='OVERDUE_CUTOFF'
        else:
            reason='NOT_SELECTED_IN_RETURNED_PLAN' if coverage!='FULL' else None
        end=taskblocks[-1]['end'] if coverage=='FULL' else None
        target=task['due_at'] or task['cutoff_at']
        assessments.append({'task_id':key,'coverage':coverage,'input_state':issue or 'READY',
              'remaining_seconds':None if issue else raw,'covered_seconds':covered,
              'unallocated_seconds':None if issue or raw is None else raw-covered,
              'forecast_end':end,'late': bool(end and target and instant(end)>instant(target)),
              'conditional':any(tasks[x]['status']!='DONE' for x in task['dependencies']),
              'reason':reason,'message':reasons.get(reason,'已过最晚截止，不能新增安排。' if reason=='OVERDUE_CUTOFF' else '当前规则下未排足；不代表已经证明无解。' if reason else '已完整预留；仍需实际执行和确认完成。'),
              'evidence':'NOT_PROVEN' if reason=='NOT_SELECTED_IN_RETURNED_PLAN' else 'POLICY'})
    before={b['id']:b for b in old_future};after={b['id']:b for b in blocks}
    changes=[]
    for key,b in before.items():
        if key not in after:
            changes.append({'kind':'REMOVE','block':b,'protected':protected(b,now)})
        elif any(b.get(f)!=after[key].get(f) for f in ('start','end','coverage_state','manual_lock')):
            changes.append({'kind':'CHANGE','block':b,'after':after[key],'protected':protected(b,now)})
    for key,b in after.items():
        if key not in before:
            changes.append({'kind':'ADD','block':b,'protected':False})
    future_events=[now+timedelta(minutes=5)]
    for b in blocks+old_future:
        for field in ('start','end'):
            if instant(b[field])>now:
                future_events.append(instant(b[field]))
        boundary=instant(b['start'])-timedelta(hours=24)
        if boundary>now: future_events.append(boundary)
    for t in tasks.values():
        for field in ('release_at','due_at','cutoff_at'):
            if t[field] and instant(t[field])>now:future_events.append(instant(t[field]))
    proposal={'id':uid(),'base_revision':state['revision'],'generated_at':stamp(now),'valid_until':stamp(min(future_events)),
              'backend':'GREEDY','quality':'HEURISTIC','blocks':sorted(blocks,key=lambda b:b['start']),
              'assessments':assessments,'changes':changes,'release_manual':sorted(release_manual),'adjust_near':adjust_near}
    validate_plan(state,proposal,now)
    return proposal


def validate_plan(state, proposal, now):
    days=calendar(state,now)
    tasks={t['id']:t for t in state['tasks']}
    totals={}
    ids=[b['id'] for b in proposal['blocks']]
    if len(ids)!=len(set(ids)):
        raise DomainError('工作块ID重复。','PLAN_INVALID')
    for b in proposal['blocks']:
        t=tasks[b['task_id']]
        if instant(b['start'])<now or instant(b['start'])<instant(t['release_at']):
            raise DomainError('计划包含已经过去或尚未释放的工作块。','PLAN_INVALID')
        if t['cutoff_at'] and instant(b['end'])>instant(t['cutoff_at']):
            raise DomainError('计划越过最晚截止。','PLAN_INVALID')
        reserve(days,b)
        if b['coverage_state']=='HOLD' and (b['planned_work_seconds'] or b['rounding_padding_seconds']):
            raise DomainError('占位不能计入任务工作量。','PLAN_INVALID')
        if b['coverage_state']=='COUNTED':
            if b['planned_work_seconds'] <= 0 or b['rounding_padding_seconds'] < 0:
                raise DomainError('任务预约必须包含正数投入，缓冲不能为负。', 'PLAN_INVALID')
            if input_issue(state,t,now) or t['status'] not in ('OPEN','IN_PROGRESS'):
                raise DomainError('任务状态不允许计算需求覆盖。','PLAN_INVALID')
            total=len(block_slots(b))*GRID
            if b['planned_work_seconds']+b['rounding_padding_seconds']!=total:
                raise DomainError('工作量与预约长度不守恒。','PLAN_INVALID')
            totals[t['id']]=totals.get(t['id'],0)+b['planned_work_seconds']
    for key,total in totals.items():
        t=tasks[key]
        if total>t['remaining_seconds']:
            raise DomainError('预留超过剩余工作量。','PLAN_INVALID')
        bs=sorted([b for b in proposal['blocks'] if b['task_id']==key and b['coverage_state']=='COUNTED'],key=lambda b:b['start'])
        if not t['splittable'] and (len(bs)!=1 or total!=t['remaining_seconds']):
            raise DomainError('不可拆任务未完整连续安排。','PLAN_INVALID')
        for index,b in enumerate(bs):
            if b.get('source') != 'MANUAL' and len(block_slots(b))*GRID < AUTO_MIN_SECONDS and not(index==len(bs)-1 and total==t['remaining_seconds']):
                raise DomainError('短块不是完整收尾。','PLAN_INVALID')
            for parent in t['dependencies']:
                if tasks[parent]['status']=='DONE':continue
                parents=[x for x in proposal['blocks'] if x['task_id']==parent and x['coverage_state']=='COUNTED']
                if totals.get(parent)!=tasks[parent]['remaining_seconds'] or not parents or max(instant(x['end']) for x in parents)>instant(b['start']):
                    raise DomainError('条件预约缺少完整前置安排。','PLAN_INVALID')
    before={b['id']:b for b in state['blocks'] if b['state']=='PLANNED' and instant(b['start'])>=now}
    after={b['id']:b for b in proposal['blocks']}
    for key,b in before.items():
        must=b.get('manual_lock') and key not in proposal['release_manual'] or protected(b,now) and not proposal['adjust_near'] and key not in proposal['release_manual']
        if must and (key not in after or any(b[f]!=after[key][f] for f in ('task_id','start','end'))):
            raise DomainError('计划未经授权修改了保护时段。','PROTECTED_CONFLICT')
