from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timedelta, timezone
from math import ceil
from uuid import uuid4
from zoneinfo import ZoneInfo

TZ = ZoneInfo('Asia/Shanghai')
GRID = 60
AUTO_QUANTUM = 900
AUTO_MIN_SECONDS = 1800
AUTO_MAX_SECONDS = 3600


class DomainError(ValueError):
    def __init__(self, message, code='INVALID_INPUT'):
        super().__init__(message)
        self.code = code


def uid():
    return str(uuid4())


def instant(value):
    try:
        dt = datetime.fromisoformat(value.replace('Z', '+00:00'))
        if dt.tzinfo is None:
            raise ValueError()
        return dt
    except (ValueError, AttributeError, TypeError):
        raise DomainError('时间必须包含时区。')


def stamp(dt):
    return dt.astimezone(TZ).isoformat(timespec='seconds')


def integer(value, low=0, high=10_000_000):
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise DomainError(f'需要 {low}–{high} 范围内的整数。')
    return value


def text(value, limit=2000):
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        raise DomainError('请填写有效文字，且不要超过长度限制。')
    return value.strip()


def initial_state():
    return {'revision': 0, 'tasks': [], 'events': [], 'blocks': [], 'records': [],
            'timer': None, 'audit': [], 'settings': {'start_hour': 18, 'end_hour': 22,
            'daily_minutes': 240, 'buffer_percent': 20, 'horizon_days': 14}}


def task_by_id(state, task_id):
    task = next((t for t in state['tasks'] if t['id'] == task_id), None)
    if task is None:
        raise DomainError('任务不存在。')
    return task


def overlap(a, b, c, d):
    return a < d and c < b


def check_graph(tasks):
    mapping = {t['id']: t for t in tasks}
    visiting, done = set(), set()

    def visit(key):
        if key not in mapping:
            raise DomainError('前置任务不存在。', 'DEPENDENCY_MISSING')
        if key in visiting:
            raise DomainError('前置关系形成了循环。', 'DEPENDENCY_CYCLE')
        if key in done:
            return
        visiting.add(key)
        for parent in mapping[key]['dependencies']:
            visit(parent)
        visiting.remove(key)
        done.add(key)
    for key in mapping:
        visit(key)


def validate_task(task):
    text(task['title'], 160)
    if task['kind'] not in ('DELIVERABLE', 'TIMEBOX'):
        raise DomainError('未知任务类型。')
    if task['category'] not in ('COURSE', 'RESEARCH', 'COMPETITION'):
        raise DomainError('未知项目类型。')
    if task['importance'] not in ('COMMITTED', 'PREFERRED', 'OPTIONAL'):
        raise DomainError('未知重要性。')
    if task['remaining_seconds'] is not None:
        integer(task['remaining_seconds'])
    if task['kind'] == 'TIMEBOX':
        integer(task['budget_seconds'], 1)
    if not isinstance(task['splittable'], bool) or not isinstance(task['rescue_partial'], bool):
        raise DomainError('可拆性和抢救安排需要布尔值。')
    if not isinstance(task['dependencies'], list) or len(set(task['dependencies'])) != len(task['dependencies']):
        raise DomainError('前置任务列表无效。')
    release = instant(task['release_at'])
    due = instant(task['due_at']) if task['due_at'] else None
    cutoff = instant(task['cutoff_at']) if task['cutoff_at'] else None
    if due and due < release or cutoff and cutoff < release or due and cutoff and due > cutoff:
        raise DomainError('时间顺序应为：可开始时间 ≤ 目标日期 ≤ 最晚截止。')


def protected(block, now):
    return block.get('manual_lock', False) or instant(block['start']) < now + timedelta(hours=24)


def active_segments(timer, now):
    if not timer:
        return []
    segments = list(timer['segments'])
    if timer['active_since']:
        segments.append({'start': timer['active_since'], 'end': stamp(now)})
    return segments


def duration(segments):
    return sum(max(0, int((instant(s['end']) - instant(s['start'])).total_seconds())) for s in segments)


def stale_tasks(state, now):
    return {b['task_id'] for b in state['blocks'] if b['state'] == 'PLANNED'
            and instant(b['start']) < now}


def input_issue(state, task, now):
    if task['id'] in stale_tasks(state, now):
        return 'EXECUTION_UNCONFIRMED'
    if state['timer'] and state['timer']['task_id'] == task['id']:
        return 'EXECUTION_UNCONFIRMED'
    if task['remaining_seconds'] is None or task.get('needs_feedback'):
        return 'ESTIMATE_REQUIRED'
    if task['status'] == 'REVIEW':
        return 'CHECKPOINT_REQUIRED'
    if task['remaining_seconds'] == 0 and task['status'] not in ('DONE', 'CANCELLED'):
        return 'ESTIMATE_REQUIRED'
    return None


def apply_action(state, action, data, now):
    """Mutate an isolated state copy; the store commits only after successful validation."""
    result = {}
    if action in ('create_task', 'update_task'):
        if action == 'create_task':
            task = {'id': uid(), 'title': '', 'category': 'COURSE', 'project': '',
                    'kind': 'DELIVERABLE', 'importance': 'PREFERRED', 'status': 'OPEN',
                    'remaining_seconds': None, 'budget_seconds': 5400, 'splittable': True,
                    'rescue_partial': False, 'dependencies': [], 'release_at': stamp(now),
                    'due_at': None, 'cutoff_at': None, 'criteria': '', 'needs_feedback': False,
                    'created_at': stamp(now)}
            state['tasks'].append(task)
            if data.get('quick_entry') is True:
                task['quick_entry'] = True
        else:
            task = task_by_id(state, data['id'])
            if task['status'] in ('DONE', 'CANCELLED'):
                raise DomainError('已关闭任务不能直接编辑。')
            if state['timer'] and state['timer']['task_id'] == task['id']:
                raise DomainError('请先结束当前计时再修改任务。')
        allowed = ('title', 'category', 'project', 'kind', 'importance', 'remaining_seconds',
                   'budget_seconds', 'splittable', 'rescue_partial', 'dependencies',
                   'release_at', 'due_at', 'cutoff_at', 'criteria')
        if action == 'update_task' and 'kind' in data and data['kind'] != task['kind']:
            raise DomainError('已有任务不能切换类型，请新建任务。')
        if action == 'update_task' and task['kind'] == 'TIMEBOX' and 'budget_seconds' in data and data['budget_seconds'] != task['budget_seconds']:
            raise DomainError('探索的新预算请新建下一轮任务，保留本轮记录。')
        for key in allowed:
            if key in data:
                task[key] = data[key]
        if task['kind'] == 'TIMEBOX':
            spent = sum(r['active_seconds'] for r in state['records'] if r['task_id'] == task['id'])
            task['remaining_seconds'] = max(0, task['budget_seconds'] - spent)
        task['title'] = text(task['title'], 160)
        if not isinstance(task['project'], str) or not isinstance(task['criteria'], str):
            raise DomainError('项目和完成标准需要文字。')
        validate_task(task)
        check_graph(state['tasks'])
        if 'remaining_seconds' in data:
            task['needs_feedback'] = False
        task['status'] = 'OPEN' if task['remaining_seconds'] is not None and (task['criteria'].strip() or (task.get('quick_entry') and task['kind'] == 'DELIVERABLE')) else 'DRAFT'
        if any(r['task_id'] == task['id'] for r in state['records']) and task['status'] == 'OPEN':
            task['status'] = 'IN_PROGRESS'
        task['estimate_as_of'] = stamp(now)
        result['task_id'] = task['id']
    elif action == 'settings':
        s = state['settings']
        start = integer(data['start_hour'], 0, 23)
        end = integer(data['end_hour'], 1, 24)
        if start >= end:
            raise DomainError('每天结束时间必须晚于开始时间。')
        s.update(start_hour=start, end_hour=end,
                 daily_minutes=integer(data['daily_minutes'], 0, 1440),
                 buffer_percent=integer(data['buffer_percent'], 0, 80))
    elif action == 'create_event':
        start, end = instant(data['start']), instant(data['end'])
        if end <= start or (end-start).days > 14:
            raise DomainError('固定日程结束时间必须晚于开始，且不超过14天。')
        state['events'].append({'id': uid(), 'title': text(data['title'], 160), 'start': stamp(start), 'end': stamp(end)})
    elif action == 'delete_event':
        state['events'] = [e for e in state['events'] if e['id'] != data['id']]
    elif action == 'lock_block':
        block = next((b for b in state['blocks'] if b['id'] == data['id']), None)
        if not block or block['state'] != 'PLANNED' or instant(block['start']) < now:
            raise DomainError('只能修改尚未开始的预约。')
        if not isinstance(data['locked'], bool):
            raise DomainError('锁定状态无效。')
        block['manual_lock'] = data['locked']
    elif action == 'skip_block':
        block = next((b for b in state['blocks'] if b['id'] == data['id']), None)
        if not block or block['state'] != 'PLANNED':
            raise DomainError('该预约已处理。')
        block['state'] = 'SKIPPED'
    elif action in ('start_timer', 'pause_timer', 'resume_timer'):
        if action == 'start_timer':
            task = task_by_id(state, data['task_id'])
            if state['timer']:
                raise DomainError('请先结束当前计时。')
            if task['status'] not in ('OPEN', 'IN_PROGRESS'):
                raise DomainError('当前任务不能开始，请补齐信息或检查点。')
            if instant(task['release_at']) > now:
                raise DomainError('任务尚未到可开始时间。')
            if any(task_by_id(state, x)['status'] != 'DONE' for x in task['dependencies']):
                raise DomainError('前置任务尚未实际完成。')
            if task['cutoff_at'] and instant(task['cutoff_at']) <= now:
                raise DomainError('任务已过最晚截止，请先处理截止规则。')
            block_id = data.get('block_id')
            if block_id:
                block = next((b for b in state['blocks'] if b['id'] == block_id), None)
                if not block or block['task_id'] != task['id'] or block['state'] != 'PLANNED':
                    raise DomainError('预约与任务不匹配。')
            state['timer'] = {'id': uid(), 'task_id': task['id'], 'block_id': block_id,
                              'started_at': stamp(now), 'active_since': stamp(now), 'segments': []}
            task['status'] = 'IN_PROGRESS'
        else:
            timer = state['timer']
            if not timer:
                raise DomainError('没有进行中的计时。')
            if action == 'pause_timer' and timer['active_since']:
                timer['segments'].append({'start': timer['active_since'], 'end': stamp(now)})
                timer['active_since'] = None
            elif action == 'resume_timer' and not timer['active_since']:
                timer['active_since'] = stamp(now)
    elif action in ('record', 'finish_timer'):
        if action == 'finish_timer':
            timer = state['timer']
            if not timer:
                raise DomainError('没有进行中的计时。')
            task = task_by_id(state, timer['task_id'])
            segments = active_segments(timer, now)
            block_id = timer['block_id']
        else:
            task = task_by_id(state, data['task_id'])
            if state['timer']:
                raise DomainError('请先结束计时，再补录历史。')
            segments = [{'start': data['start'], 'end': data['end']}]
            block_id = data.get('block_id')
        if task['status'] in ('DONE', 'CANCELLED'):
            raise DomainError('已关闭任务不能直接新增记录。')
        for segment in segments:
            start, end = instant(segment['start']), instant(segment['end'])
            if end < start or end > now:
                raise DomainError('实际记录不能结束于未来，且结束不能早于开始。')
            for record in state['records']:
                if any(overlap(start, end, instant(s['start']), instant(s['end'])) for s in record['segments']):
                    raise DomainError('与已有专注记录重叠，请核对后再保存。', 'LOG_OVERLAP')
        seconds = duration(segments)
        if seconds <= 0:
            raise DomainError('请至少记录一秒的实际投入。')
        feedback = data.get('feedback', 'unknown')
        if feedback not in ('remaining', 'on_track', 'blocked', 'unknown', 'done'):
            raise DomainError('未知反馈。')
        note = data.get('note', '').strip()
        if feedback == 'done':
            text(note)
            if task['kind'] == 'TIMEBOX' and data.get('decision') not in ('CONTINUE', 'STOP', 'PIVOT'):
                raise DomainError('请记录探索检查点决策。')
        record = {'id': uid(), 'task_id': task['id'], 'block_id': block_id, 'segments': segments,
                  'source': 'TIMER' if action == 'finish_timer' else 'MANUAL',
                  'active_seconds': seconds, 'feedback': feedback, 'note': note, 'recorded_at': stamp(now)}
        state['records'].append(record)
        if task['kind'] == 'TIMEBOX':
            spent = sum(r['active_seconds'] for r in state['records'] if r['task_id'] == task['id'])
            task['remaining_seconds'] = max(0, task['budget_seconds'] - spent)
            task['needs_feedback'] = False
            task['status'] = 'REVIEW' if task['remaining_seconds'] == 0 else 'IN_PROGRESS'
        else:
            task['status'] = 'IN_PROGRESS'
            if feedback == 'remaining':
                task['remaining_seconds'] = integer(data['remaining_seconds'])
                task['needs_feedback'] = False
            elif feedback == 'on_track' and task['remaining_seconds'] is not None:
                task['remaining_seconds'] = max(0, task['remaining_seconds'] - seconds)
                task['needs_feedback'] = task['remaining_seconds'] == 0
            elif feedback == 'unknown':
                task['needs_feedback'] = True
        if block_id:
            block = next((b for b in state['blocks'] if b['id'] == block_id), None)
            if not block or block['task_id'] != task['id'] or block['state'] != 'PLANNED':
                raise DomainError('执行预约已处理或不匹配。')
            block['state'] = 'RECORDED'
        if action == 'finish_timer':
            state['timer'] = None
        if feedback == 'done':
            close_task(state, task, data, now)
        task['estimate_as_of'] = stamp(now)
    elif action in ('close_task', 'cancel_task'):
        task = task_by_id(state, data['id'])
        if state['timer'] and state['timer']['task_id'] == task['id']:
            raise DomainError('请先结束计时并记录反馈。')
        if action == 'close_task':
            close_task(state, task, data, now)
        else:
            text(data.get('note', ''))
            task['status'] = 'CANCELLED'
            task['closure_note'] = data['note']
            for b in state['blocks']:
                if b['task_id'] == task['id'] and b['state'] == 'PLANNED' and instant(b['start']) >= now:
                    b['state'] = 'CANCELLED'
    else:
        raise DomainError('未知操作。')
    state['audit'].append({'at': stamp(now), 'action': action, 'task_id': data.get('task_id', data.get('id')), 'revision': state['revision'] + 1})
    return result


def close_task(state, task, data, now):
    note = text(data.get('note', ''))
    if task['kind'] == 'TIMEBOX' and data.get('decision') not in ('CONTINUE', 'STOP', 'PIVOT'):
        raise DomainError('探索结束需要检查点及继续／停止／转向决策。')
    task.update(status='DONE', remaining_seconds=0, needs_feedback=False, closure_note=note,
                decision=data.get('decision'), completed_at=stamp(now))
    for block in state['blocks']:
        if block['task_id'] == task['id'] and block['state'] == 'PLANNED' and instant(block['start']) >= now:
            block['state'] = 'CANCELLED'
