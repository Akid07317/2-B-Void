import hashlib
import json
import sqlite3
from copy import deepcopy
from contextlib import contextmanager
from pathlib import Path

from .domain import DomainError, initial_state, apply_action, instant
from .scheduler import validate_plan
from .manual import apply_manual, validate_undo


class Store:
    def __init__(self, path):
        self.path=str(path)
        Path(path).parent.mkdir(parents=True,exist_ok=True)
        with self.connect() as conn:
            conn.execute('CREATE TABLE IF NOT EXISTS state(id INTEGER PRIMARY KEY, body TEXT NOT NULL)')
            conn.execute('CREATE TABLE IF NOT EXISTS requests(key TEXT PRIMARY KEY, digest TEXT NOT NULL, response TEXT NOT NULL)')
            conn.execute('CREATE TABLE IF NOT EXISTS undo_entries(token TEXT PRIMARY KEY, body TEXT NOT NULL)')
            conn.execute('INSERT OR IGNORE INTO state VALUES(1,?)',(json.dumps(initial_state()),))

    @contextmanager
    def connect(self):
        conn=sqlite3.connect(self.path,timeout=10)
        conn.execute('PRAGMA journal_mode=WAL')
        try:
            with conn:
                yield conn
        finally:
            conn.close()

    def read(self):
        with self.connect() as conn:
            return json.loads(conn.execute('SELECT body FROM state WHERE id=1').fetchone()[0])

    def write(self, request, now, proposal=None):
        key=request.get('idempotency_key')
        if not isinstance(key,str) or not 8<=len(key)<=200:
            raise DomainError('缺少幂等键。')
        digest=hashlib.sha256(json.dumps(request,sort_keys=True,ensure_ascii=False).encode()).hexdigest()
        with self.connect() as conn:
            conn.execute('BEGIN IMMEDIATE')
            old=conn.execute('SELECT digest,response FROM requests WHERE key=?',(key,)).fetchone()
            if old:
                if old[0]!=digest:raise DomainError('同一请求标识对应不同内容。','IDEMPOTENCY_CONFLICT')
                return json.loads(old[1])
            state=json.loads(conn.execute('SELECT body FROM state WHERE id=1').fetchone()[0])
            if request.get('expected_revision')!=state['revision']:
                raise DomainError('数据已变化，请刷新后再操作。','STALE_REVISION')
            action=request['action']
            previous=deepcopy(state)
            revision=state['revision']
            reversible={'create_task':'新增任务','update_task':'编辑任务','manual_schedule':'安排时段',
                        'unschedule_block':'取消安排','complete_task':'完成任务','close_task':'完成任务',
                        'lock_block':'修改锁定'}
            if action=='undo_last':
                token=request.get('data',{}).get('token')
                if not token or state.get('undo',{}).get('token')!=token:
                    raise DomainError('这一步已不能撤销，请刷新查看最新状态。','STALE_REVISION')
                row=conn.execute('SELECT body FROM undo_entries WHERE token=?',(token,)).fetchone()
                if not row:raise DomainError('撤销记录已不可用。')
                restored=json.loads(row[0])
                validate_undo(restored,state,now)
                restored['audit']=state['audit']+[{'action':'undo_last','at':now.isoformat(),'revision':revision+1}]
                state=restored
                conn.execute('DELETE FROM undo_entries WHERE token=?',(token,))
                result={}
            elif action in ('manual_schedule','unschedule_block','complete_task'):
                result=apply_manual(state,action,request.get('data',{}),now)
                state['audit'].append({'action':action,'at':now.isoformat(),'revision':revision+1,**result})
            elif action=='apply_plan':
                if not proposal or proposal['id']!=request['data'].get('proposal_id'):
                    raise DomainError('预览已失效，请重新生成。')
                if proposal['base_revision']!=state['revision']:
                    raise DomainError('预览基于旧版本。','STALE_REVISION')
                if now>=instant(proposal['valid_until']):
                    raise DomainError('时间已推进，请重新生成预览。','STALE_TIME')
                authorized=set(request['data'].get('manual_release_ids',[]))
                if authorized!=set(proposal['release_manual']):
                    raise DomainError('人工锁修改未得到逐项确认。','PROTECTED_CONFLICT')
                validate_plan(state,proposal,now)
                historical=[b for b in state['blocks'] if b['state']!='PLANNED' or instant(b['start'])<now]
                state['blocks']=historical+deepcopy(proposal['blocks'])
                state['last_plan']={'id':proposal['id'],'assessments':proposal['assessments'],'generated_at':proposal['generated_at']}
                state['audit'].append({'action':'apply_plan','at':now.isoformat(),'changes':proposal['changes']})
                result={}
            else:
                result=apply_action(state,action,request.get('data',{}),now)
            if action in reversible:
                from .domain import uid
                token=uid()
                conn.execute('INSERT INTO undo_entries VALUES(?,?)',(token,json.dumps(previous,ensure_ascii=False)))
                state['undo']={'token':token,'label':reversible[action]}
            elif action!='undo_last':
                state.pop('undo',None)
            state['revision']=revision+1
            response={'state':state,'result':result}
            conn.execute('UPDATE state SET body=? WHERE id=1',(json.dumps(state,ensure_ascii=False),))
            conn.execute('INSERT INTO requests VALUES(?,?,?)',(key,digest,json.dumps(response,ensure_ascii=False)))
            return response
