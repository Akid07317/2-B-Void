"""Explicit daily planning operations, checked by the same scheduling validator."""
from copy import deepcopy
from math import ceil
from datetime import timedelta

from .domain import (DomainError, GRID, instant, stamp, task_by_id, uid,
                     close_task, input_issue)
from .scheduler import validate_plan, block_slots


def future_blocks(state, now):
    return [deepcopy(b) for b in state['blocks']
            if b['state'] == 'PLANNED' and instant(b['start']) >= now]


def validate_explicit(state, blocks, now):
    # Every unrelated reservation is retained. The user explicitly changes only
    # the selected block, so near-term protection is not an automatic-replan veto.
    validate_plan(state, {'blocks': blocks, 'adjust_near': True,
                         'release_manual': [b['id'] for b in state['blocks']
                                            if b.get('manual_lock')]}, now)


def apply_manual(state, action, data, now):
    if action == 'complete_task':
        task = task_by_id(state, data['id'])
        if task['status'] in ('DONE', 'CANCELLED'):
            raise DomainError('任务已经关闭。')
        if state['timer'] and state['timer']['task_id'] == task['id']:
            raise DomainError('请先结束专注计时，再确认完成。')
        if task['kind'] == 'TIMEBOX':
            raise DomainError('探索任务请填写检查点和结束决策。')
        close_task(state, task, {'note': '用户勾选完成；没有据此生成实际工时记录。'}, now)
        state['last_plan'] = None
        return {'task_id': task['id']}

    existing = next((b for b in state['blocks'] if b['id'] == data.get('id')), None)
    if data.get('id') and (not existing or existing['state'] != 'PLANNED'):
        raise DomainError('该预约不存在或已经处理。')
    if existing and (instant(existing['start']) < now or existing.get('manual_lock')):
        raise DomainError('已开始的预约需记录执行；锁定预约请先解锁。')
    if action == 'unschedule_block':
        if not existing:
            raise DomainError('请选择要取消安排的时段。')
        blocks = [b for b in future_blocks(state, now) if b['id'] != existing['id']]
        target = task_by_id(state, existing['task_id'])
    else:
        target = task_by_id(state, existing['task_id'] if existing else data['task_id'])
        if target['status'] not in ('OPEN', 'IN_PROGRESS') or input_issue(state, target, now):
            raise DomainError('请先补充任务估计、处理检查点或核实之前的执行。')
        start, end = instant(data['start']), instant(data['end'])
        if start.timestamp() % GRID or end.timestamp() % GRID:
            raise DomainError('预约起止时间必须精确到整分钟。', 'OFF_GRID_LOCK')
        if end <= start or start.astimezone(now.tzinfo).date() != (end-timedelta(microseconds=1)).astimezone(now.tzinfo).date():
            raise DomainError('请安排在同一天内，并让结束晚于开始。')
        candidate = {'id': existing['id'] if existing else uid(), 'task_id': target['id'],
                     'start': stamp(start), 'end': stamp(end), 'state': 'PLANNED',
                     'manual_lock': False, 'coverage_state': 'COUNTED',
                     'planned_work_seconds': 0, 'rounding_padding_seconds': 0,
                     'conditional_on': list(target['dependencies']), 'source': 'MANUAL'}
        block_slots(candidate)
        blocks = [b for b in future_blocks(state, now) if b['id'] != candidate['id']]
        blocks.append(candidate)

    # Recompute the target's final rounding padding after a move/resize/removal.
    own = sorted([b for b in blocks if b['task_id'] == target['id']
                  and b['coverage_state'] == 'COUNTED'], key=lambda b: b['start'])
    total = sum(len(block_slots(b))*GRID for b in own)
    remaining = target['remaining_seconds'] or 0
    if total > ceil(remaining/GRID)*GRID:
        raise DomainError('安排超过任务剩余时间。请先修改估计或取消其他预约。')
    for b in own:
        b['planned_work_seconds'] = len(block_slots(b))*GRID
        b['rounding_padding_seconds'] = 0
    if own and total >= remaining:
        own[-1]['rounding_padding_seconds'] = total - remaining
        own[-1]['planned_work_seconds'] -= total - remaining
    try:
        validate_explicit(state, blocks, now)
    except DomainError as exc:
        if str(exc) == '受保护时段与日程、可用时间或正在执行的任务冲突。':
            raise DomainError('所选时段与已有日程、可用窗口或正在执行的任务冲突。', exc.code) from exc
        raise
    keep = [b for b in state['blocks'] if b['state'] != 'PLANNED' or instant(b['start']) < now]
    state['blocks'] = keep + sorted(blocks, key=lambda b: b['start'])
    state['last_plan'] = None
    return {'task_id': target['id'], 'block_id': candidate['id'] if action != 'unschedule_block' else existing['id']}


def validate_undo(before, current, now):
    old = {b['id']: b for b in before['blocks']}
    new = {b['id']: b for b in current['blocks']}
    for key in old.keys() | new.keys():
        if old.get(key) == new.get(key):
            continue
        for block in (old.get(key), new.get(key)):
            if block and instant(block['start']) < now:
                raise DomainError('相关时段已开始，不能再撤销；请核实执行记录。', 'STALE_TIME')
    validate_explicit(before, future_blocks(before, now), now)
