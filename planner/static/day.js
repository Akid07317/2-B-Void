'use strict';
let dayFilter='ALL', dayShowDone=false, dayDrag=null, daySuppressClick=false, dayOrigin=null;
const dayMotion=matchMedia('(prefers-reduced-motion: reduce)');
const daySprings=new WeakMap();
function daySpring(element,target){
 if(dayMotion.matches){element.style.transform=`translateX(${target}px)`;return;}
 let s=daySprings.get(element);
 if(!s){s={x:target,v:0,target,frame:0};daySprings.set(element,s);element.style.transform=`translateX(${target}px)`;return;}
 s.target=target;if(s.frame)return;let last=performance.now();
 const tick=now=>{const dt=Math.min((now-last)/1000,.025);last=now;s.v+=(390*(s.target-s.x)-38*s.v)*dt;s.x+=s.v*dt;element.style.transform=`translateX(${s.x}px)`;
 if(Math.abs(s.target-s.x)<.1&&Math.abs(s.v)<.1){s.x=s.target;s.v=0;s.frame=0;element.style.transform=`translateX(${s.x}px)`;}else s.frame=requestAnimationFrame(tick);};s.frame=requestAnimationFrame(tick);
}
function dayAnimate(el,frames,ms=190){if(!dayMotion.matches)return el.animate(frames,{duration:ms,easing:'cubic-bezier(.2,.8,.2,1)'});}
function dayDate(offset){return dateKey(new Date(new Date(`${selectedDay}T12:00:00+08:00`).getTime()+offset*86400000));}
function dayFuture(t){return state.blocks.filter(b=>b.task_id===t.id&&b.state==='PLANNED'&&new Date(b.start)>=new Date());}
function dayUnallocated(t){return Math.max(0,(t.remaining_seconds||0)-dayFuture(t).filter(b=>b.coverage_state==='COUNTED').reduce((n,b)=>n+b.planned_work_seconds,0));}
function dayDefaultMinutes(t){const n=Math.ceil(dayUnallocated(t)/60);return Math.max(1,t.splittable?Math.min(60,n||45):n||45);}
function dayCanMove(b){return !b.manual_lock&&new Date(b.start)>new Date()&&b.state==='PLANNED';}
function dayRow(t){
 const done=t.status==='DONE',closed=done||t.status==='CANCELLED',scheduled=dayFuture(t),unallocated=dayUnallocated(t);
 return `<article class="daily-task ${t.category.toLowerCase()} ${done?'is-complete':''}" data-key="${t.id}">
 <button class="day-drag" data-drag-task="${t.id}" aria-label="拖动${esc(t.title)}到日历" ${closed||!unallocated||t.status==='DRAFT'?'disabled':''}>${symbol(t.category.toLowerCase())}</button>
 <button class="day-complete" data-dayop="complete" data-id="${t.id}" aria-label="${done?'已完成：':'完成：'}${esc(t.title)}" ${closed?'disabled':''}>${done?icon('check'):''}</button>
 <button class="day-task-title" data-op="edit" data-id="${t.id}" ${closed?'disabled':''}><strong>${esc(t.title)}</strong><small>${esc(t.project||labels[t.category])}<span>·</span>${duration(t.remaining_seconds)}${t.status==='DRAFT'?' · 待补信息':''}${t.needs_feedback?' · 待核实':''}</small></button>
 ${!closed?`<button class="day-arrange" data-dayop="arrange" data-id="${t.id}" aria-label="安排：${esc(t.title)}">${scheduled.length&&!unallocated?'已安排':scheduled.length?'继续安排':'安排'}</button>`:''}
 ${scheduled.length?`<div class="day-reservations">${scheduled.map(b=>`<button data-block-detail="${b.id}">${dateKey(b.start)===selectedDay?'当天':local(b.start).slice(5,10)} ${clock(b.start)}${b.manual_lock?' · 锁定':''}</button>`).join('')}</div>`:''}</article>`;
}
function dayReconcile(container,items,html){
 const old=new Map(Array.from(container.children).filter(e=>e.dataset.key).map(e=>[e.dataset.key,{el:e,rect:e.getBoundingClientRect()}]));
 const active=document.activeElement;const focusKey=active?.closest('[data-key]')?.dataset.key,focusOp=active?.dataset.dayop||active?.dataset.op;
 const keys=new Set(items.map(i=>i.id));for(const [key,{el}] of old)if(!keys.has(key))el.remove();
 items.forEach(item=>{const markup=html(item),entry=old.get(item.id);let el=entry?.el;
 if(!el){const template=document.createElement('template');template.innerHTML=markup;el=template.content.firstElementChild;el.dataset.signature=markup;container.append(el);dayAnimate(el,[{opacity:0,transform:'translateY(5px)'},{opacity:1,transform:'none'}]);}
 else {if(el.dataset.signature!==markup){const template=document.createElement('template');template.innerHTML=markup;const fresh=template.content.firstElementChild;el.className=fresh.className;el.innerHTML=fresh.innerHTML;el.dataset.signature=markup;}container.append(el);const rect=el.getBoundingClientRect(),dy=entry.rect.top-rect.top;if(Math.abs(dy)>1)dayAnimate(el,[{transform:`translateY(${dy}px)`},{transform:'none'}],220);}});
 if(focusKey&&!active.isConnected){const row=Array.from(container.children).find(e=>e.dataset.key===focusKey);const next=row?.querySelector(`[data-dayop="${focusOp}"],[data-op="${focusOp}"]`);(next&&!next.disabled?next:document.querySelector('#quick-title'))?.focus({preventScroll:true});}
}
function renderDaily(content){
 if(!selectedDay)selectedDay=dateKey(new Date());
 hideTaskPeek();
 if(!document.querySelector('#day-workspace'))content.innerHTML=consoleShell();
 $('#daily-date').value=selectedDay;$('#day-show-done').checked=dayShowDone;
 const all=state.tasks.filter(t=>t.status!=='CANCELLED'&&(dayShowDone||t.status!=='DONE')&&(dayFilter==='ALL'||t.category===dayFilter)&&(t.status==='DONE'||dayUnallocated(t)>0||t.remaining_seconds===null));
 $('#daily-count').textContent=all.length;
 document.querySelectorAll('[data-dayop="filter"]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.value===dayFilter)));
 dayReconcile($('#daily-tasks'),all,dayRow);$('#daily-empty').hidden=!!all.length;
 $('#daily-empty').textContent=dayFilter==='ALL'?'写下第一件要做的事。':'这个清单暂时没有任务。';
 const d=new Date(`${selectedDay}T12:00:00+08:00`),weekday=(d.getDay()+6)%7;
 $('#daily-heading').textContent=d.toLocaleDateString('zh-CN',{month:'long',day:'numeric',weekday:'long'});
 document.querySelectorAll('.day-week-strip [data-dayop="select-date"]').forEach((button,i)=>{button.dataset.value=dayDate(i-weekday);button.querySelector('span').textContent=['一','二','三','四','五','六','日'][i];button.querySelector('strong').textContent=Number(button.dataset.value.slice(-2));button.setAttribute('aria-label',button.dataset.value);button.setAttribute('aria-pressed',String(i===weekday));});
 positionDayIndicator();renderDayCalendar();
 const missed=state.blocks.filter(b=>b.state==='PLANNED'&&new Date(b.start)<new Date()&&state.timer?.block_id!==b.id);
 $('#day-attention').innerHTML=missed.length?`<details><summary>${missed.length} 个过去时段待核实</summary>${missed.map(b=>`<div><span>${esc(task(b.task_id)?.title)}<small>${fmt(b.start)}</small></span><button data-op="record-block" data-id="${b.id}">补记</button><button data-op="skip" data-id="${b.id}">未做</button></div>`).join('')}</details>`:'';
 const locked=state.blocks.filter(b=>b.state==='PLANNED'&&b.manual_lock&&new Date(b.start)>=new Date());
 $('#day-lock-options').innerHTML=locked.map(b=>`<label class="check"><input type="checkbox" name="release-lock" value="${b.id}">允许自动计划调整：${esc(task(b.task_id)?.title)} · ${fmt(b.start)}</label>`).join('');
 updateUndoControl();
}
function positionDayIndicator(){const strip=document.querySelector('.day-week-strip');if(!strip)return;const i=Array.from(strip.querySelectorAll('button')).findIndex(b=>b.getAttribute('aria-pressed')==='true');const width=(strip.clientWidth-8)/7;const indicator=strip.querySelector('.day-indicator');indicator.style.width=width+'px';daySpring(indicator,width*Math.max(0,i));}
function renderDayCalendar(){renderConsoleCalendar();}
function updateUndoControl(){const b=document.querySelector('#undo-action');if(b){b.disabled=!state?.undo||busy;b.textContent=state?.undo?'撤销'+state.undo.label:'撤销';b.setAttribute('aria-label',state?.undo?'撤销'+state.undo.label:'暂无可撤销操作');}}
function animateDayDialog(dialog){const r=dayOrigin,box=dialog.getBoundingClientRect();const x=r?Math.max(-24,Math.min(24,r.left+r.width/2-box.left-box.width/2)):0;const y=r?Math.max(-24,Math.min(24,r.top-box.top)):10;dayAnimate(dialog,[{opacity:.1,transform:`translate(${x}px,${y}px) scale(.975)`},{opacity:1,transform:'none'}],210);dayOrigin=null;}
function dayScheduleForm(t,b=null){
 const defaultStart=new Date(`${selectedDay}T${String(state.settings.start_hour).padStart(2,'0')}:00:00+08:00`);const next=new Date(Math.ceil(Math.max(+defaultStart,Date.now()+60000)/60000)*60000);
 return `<form id="day-schedule-form"><input name="task_id" type="hidden" value="${t.id}"><input name="id" type="hidden" value="${b?.id||''}"><div class="form-row"><label>开始时间<input name="start" type="datetime-local" step="60" value="${local(b?.start||next)}" required></label><label>时长（分钟）<input name="minutes" type="number" min="1" max="1440" step="1" value="${b?(new Date(b.end)-new Date(b.start))/60000:dayDefaultMinutes(t)}" required></label></div><p class="muted">精确到分钟 · 任务预计剩余 ${duration(t.remaining_seconds)}${b?'':' · 尚未安排 '+duration(dayUnallocated(t))}</p><div class="day-form-actions"><button type="submit" class="primary">${b?'保存时段':'安排到日历'}</button>${b?`<button type="button" data-dayop="unschedule" data-id="${b.id}">取消这次安排</button>`:''}</div></form>`;
}
function enhanceBlockDetail(b,t){if(t&&dayCanMove(b))$('#block-detail').insertAdjacentHTML('beforeend',dayScheduleForm(t,b));}
function openDayArrange(id){const t=task(id);const blocks=dayFuture(t);if(!dayUnallocated(t)&&blocks.length){showBlock(blocks[0].id);return;}$('#block-detail').innerHTML=`<span class="badge">${labels[t.category]}</span><h3>${esc(t.title)}</h3>${dayScheduleForm(t)}${t.status==='DRAFT'?'<p class="warning">请先编辑任务，补全估计和完成标准。</p>':''}`;$('#block-dialog').showModal();animateDayDialog($('#block-dialog'));}
async function dayUndo(){if(!state.undo)return;await action('undo_last',{token:state.undo.token});notify('已撤销，数据已保存。');updateUndoControl();}
document.addEventListener('click',async e=>{
 const button=e.target.closest('button');if(!button)return;if(daySuppressClick&&(button.closest('.day-block')||button.classList.contains('day-drag'))){e.stopImmediatePropagation();e.preventDefault();return;}
 dayOrigin=button.getBoundingClientRect();const op=button.dataset.dayop;if(!op)return;e.stopImmediatePropagation();
 try{if(busy)return;
 if(op==='filter'){dayFilter=button.dataset.value;renderDaily($('#content'));return;}
 if(['previous','next','today','select-date'].includes(op)){selectedDay=op==='today'?dateKey(new Date()):op==='select-date'?button.dataset.value:dayDate(op==='next'?1:-1);renderDaily($('#content'));return;}
 if(op==='arrange'){openDayArrange(button.dataset.id);return;}
 if(op==='complete'){const t=task(button.dataset.id);if(t.kind==='TIMEBOX'){$('#close-form').reset();$('#close-form').elements.id.value=t.id;$('#close-dialog').showModal();return;}await action('complete_task',{id:t.id});notify('已完成，可撤销。没有新增实际工时。');}
 if(op==='undo')await dayUndo();
 if(op==='unschedule'){await action('unschedule_block',{id:button.dataset.id});$('#block-dialog').close();notify('已取消这次安排，任务仍在清单中。');}
 }catch(err){showError(err);}finally{updateUndoControl();}
});
let dayComposing=false;
document.addEventListener('compositionstart',()=>dayComposing=true);
document.addEventListener('compositionend',()=>dayComposing=false);
document.addEventListener('keydown',e=>{if(e.key==='Enter'&&(e.isComposing||dayComposing)&&e.target.closest('form')){e.preventDefault();return;}if(e.key==='Escape'&&dayDrag){e.preventDefault();finishDayDrag(false);return;}if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='z'&&!e.shiftKey&&!e.isComposing&&!e.target.closest('input,textarea,select,[contenteditable]')&&!document.querySelector('dialog[open]')){e.preventDefault();dayUndo().catch(showError);}});
document.addEventListener('change',e=>{if(e.target.id==='daily-date'&&e.target.value){selectedDay=e.target.value;renderDaily($('#content'));}if(e.target.id==='day-show-done'){dayShowDone=e.target.checked;renderDaily($('#content'));}});
document.addEventListener('submit',async e=>{
 const f=e.target;if(!['quick-task-form','day-schedule-form'].includes(f.getAttribute('id')))return;e.preventDefault();e.stopImmediatePropagation();if(dayComposing||busy)return;const b=f.querySelector('[type=submit]');b.disabled=true;
 try{const d=Object.fromEntries(new FormData(f));if(f.getAttribute('id')==='quick-task-form'){await action('create_task',{title:d.title,remaining_seconds:Number(d.minutes)*60,quick_entry:true,category:dayFilter==='ALL'?'COURSE':dayFilter});f.elements.title.value='';f.elements.title.focus();notify('任务已保存，可以拖入日历。');}
 else {const start=iso(d.start);await action('manual_schedule',{task_id:d.task_id,id:d.id||undefined,start,end:new Date(+new Date(start)+Number(d.minutes)*60000).toISOString()});$('#block-dialog').close();notify('时段已保存，可撤销。');}}
 catch(err){showError(err);}finally{b.disabled=false;updateUndoControl();}
});
window.addEventListener('resize',positionDayIndicator);

function dayDropInfo(clientX,clientY){
 const viewport=document.querySelector('.calendar-viewport')?.getBoundingClientRect();if(!viewport||clientY<Math.max(0,viewport.top)||clientY>Math.min(innerHeight,viewport.bottom)||clientX<viewport.left||clientX>viewport.right)return null;
 const surface=Array.from(document.querySelectorAll('.day-surface')).find(el=>{const r=el.getBoundingClientRect();return clientX>=r.left&&clientX<=r.right&&clientY>=r.top&&clientY<=r.bottom;});if(!surface)return null;const rect=surface.getBoundingClientRect();if(clientX<rect.left||clientX>rect.right||clientY<rect.top||clientY>rect.bottom)return null;
 const base=Number(surface.dataset.base),end=Number(surface.dataset.end),d=dayDrag;let start,finish;
 if(d.resize){start=+new Date(d.block.start);finish=base+Math.round((clientY-rect.top-d.grabY)/HOUR_PX*60)*60000;finish=Math.max(start+60000,Math.min(end,finish));}
 else {start=base+Math.round((clientY-rect.top-d.grabY)/HOUR_PX*60)*60000;start=Math.max(base,Math.min(end-d.minutes*60000,start));finish=start+d.minutes*60000;}
 let error='';if(d.resize&&dateKey(d.block.start)!==surface.dataset.date)error='请在原日期内调整时长';if(start<Date.now())error='不能安排到已经过去的时间';
 const cfg=state.settings,min=+new Date(`${surface.dataset.date}T00:00:00+08:00`)+cfg.start_hour*3600000,max=+new Date(`${surface.dataset.date}T00:00:00+08:00`)+cfg.end_hour*3600000;
 if(start<min||finish>max)error='超出每天可用时间';
 const clash=[...state.events,...state.blocks.filter(b=>b.state==='PLANNED'&&b.id!==d.block?.id)].find(b=>start<+new Date(b.end)&&+new Date(b.start)<finish);if(clash)error='与'+(clash.title||task(clash.task_id)?.title||'已有安排')+'冲突';
 return {start,finish,error,surface,y:(start-base)/3600000*HOUR_PX,height:(finish-start)/3600000*HOUR_PX};
}
document.addEventListener('pointerdown',e=>{
 const handle=e.target.closest('[data-drag-task],[data-drag-block],[data-resize-block]');if(!handle||handle.disabled||busy||e.button!==0)return;
 const block=state.blocks.find(b=>b.id===(handle.dataset.dragBlock||handle.dataset.resizeBlock));if(block&&!dayCanMove(block))return;
 hideTaskPeek();const t=task(block?.task_id||handle.dataset.dragTask),rect=handle.closest('.day-block,.daily-task,.compact-event').getBoundingClientRect();
 dayDrag={pointerId:e.pointerId,handle,task:t,block,resize:!!handle.dataset.resizeBlock,startX:e.clientX,startY:e.clientY,grabY:handle.dataset.resizeBlock?e.clientY-rect.bottom:block&&!handle.closest('.compact-event')?e.clientY-rect.top:0,minutes:block?(new Date(block.end)-new Date(block.start))/60000:dayDefaultMinutes(t),started:false,origin:rect};
 handle.setPointerCapture(e.pointerId);e.preventDefault();
});
document.addEventListener('pointermove',e=>{
 const d=dayDrag;if(!d||e.pointerId!==d.pointerId)return;if(!d.started&&Math.hypot(e.clientX-d.startX,e.clientY-d.startY)<5)return;
 if(!d.started){d.started=true;d.ghost=document.createElement('div');d.ghost.className='day-drag-ghost';d.ghost.textContent=d.task.title;document.body.append(d.ghost);document.body.classList.add('day-dragging');}
 d.ghost.style.transform=`translate(${e.clientX+15}px,${e.clientY+12}px)`;document.querySelectorAll('.day-drop').forEach(el=>el.hidden=true);d.drop=dayDropInfo(e.clientX,e.clientY);const preview=d.drop?.surface.querySelector('.day-drop');if(preview){preview.hidden=!d.drop;if(d.drop){preview.style.top=d.drop.y+'px';preview.style.height=d.drop.height+'px';preview.classList.toggle('invalid',!!d.drop.error);preview.textContent=clock(d.drop.start)+'–'+clock(d.drop.finish)+(d.drop.error?' · '+d.drop.error:'');}}
 const viewport=document.querySelector('.calendar-viewport');if(viewport){const r=viewport.getBoundingClientRect(),top=Math.max(0,r.top),bottom=Math.min(innerHeight,r.bottom),now=performance.now();if(e.clientX>=r.left&&e.clientX<=r.right&&e.clientY>=top&&e.clientY<=bottom&&now-(d.lastScroll||0)>32){if(e.clientY>bottom-24)viewport.scrollBy(0,12);else if(e.clientY<top+24)viewport.scrollBy(0,-12);if(e.clientX>r.right-24)viewport.scrollBy(12,0);else if(e.clientX<r.left+24)viewport.scrollBy(-12,0);d.lastScroll=now;}}e.preventDefault();
},{passive:false});
async function finishDayDrag(commit){
 const d=dayDrag;if(!d)return;dayDrag=null;document.querySelectorAll('.day-drop').forEach(el=>el.hidden=true);if(d.handle.hasPointerCapture(d.pointerId))d.handle.releasePointerCapture(d.pointerId);document.body.classList.remove('day-dragging');d.ghost?.remove();const preview=d.drop?.surface.querySelector('.day-drop');if(preview)preview.hidden=true;
 if(!d.started)return;daySuppressClick=true;setTimeout(()=>daySuppressClick=false,100);
 if(!commit||!d.drop)return;if(d.drop.error){notify(d.drop.error,true);return;}
 try{await action('manual_schedule',{task_id:d.task.id,id:d.block?.id,start:new Date(d.drop.start).toISOString(),end:new Date(d.drop.finish).toISOString()});notify('时段已保存，可撤销。');}catch(err){showError(err);}finally{updateUndoControl();}
}
document.addEventListener('pointerup',e=>{if(dayDrag?.pointerId===e.pointerId){dayDrag.drop=dayDropInfo(e.clientX,e.clientY);finishDayDrag(true);}});
document.addEventListener('pointercancel',()=>finishDayDrag(false));
