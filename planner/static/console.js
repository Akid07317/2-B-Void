'use strict';
const HOUR_PX=120;
let calendarMode='day', peekDelay, peekHideDelay, peekAnchor=null, peekDismissed=null;
const symbolPaths={
 course:'M4 5c3-1 5 0 8 2 3-2 5-3 8-2v14c-3-1-5 0-8 2-3-2-5-3-8-2V5Zm8 2v14',
 research:'M6 3h9l4 4v14H6V3Zm9 0v5h4M9 12h7m-7 4h5',
 competition:'M8 3h8v7a4 4 0 0 1-8 0V3Zm0 2H4v3a4 4 0 0 0 4 4m8-7h4v3a4 4 0 0 1-4 4m-4 2v6m-4 1h8',
 calendar:'M4 5h16v16H4V5Zm0 5h16M8 3v4m8-4v4M8 14h2m4 0h2m-8 3h2',
 timer:'M9 2h6m-3 0v3m6 1 2-2M12 10v4l3 2M21 14a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
 chart:'M4 20V10h4v10m2 0V4h4v16m2 0v-7h4v7M3 21h18',
 check:'M5 12l5 5L20 6',
};
function symbol(name){return `<svg class="symbol" viewBox="0 0 24 24" aria-hidden="true"><path class="symbol-wash" d="M4 5h16v16H4z"/><path d="${symbolPaths[name]||symbolPaths.calendar}"/></svg>`;}
function consoleShell(){return `<section id="day-workspace">
 <div class="day-toolbar"><div class="day-date-controls"><button data-dayop="previous" aria-label="前一天">‹</button><label><span class="sr-only">查看日期</span><input type="date" id="daily-date" aria-label="查看日期"></label><button data-dayop="next" aria-label="后一天">›</button><button data-dayop="today">今天</button></div><div class="day-tools"><button id="undo-action" data-dayop="undo" disabled>撤销</button><button data-command="plan">${icon('calendar')}自动安排</button></div></div>
 <section class="console-stats" aria-label="当日概况">
 <div class="console-stat"><span>${symbol('check')}当日任务</span><strong id="stat-completion">0 / 0</strong><small>已完成 / 有安排或投入</small></div>
 <div class="console-stat"><span>${symbol('timer')}已记录投入</span><strong id="stat-actual">00:00:00</strong><small id="stat-focus">计时与补记</small></div>
 <div class="console-stat"><span>${symbol('calendar')}待执行安排</span><strong id="stat-remaining">00:00:00</strong><small id="stat-remaining-note">安排中的预计投入</small></div>
 <div class="console-stat"><span>${symbol('chart')}可再安排</span><strong id="stat-available">00:00:00</strong><small id="stat-available-note">已扣除安排与容量限制</small></div></section>
 <div class="console-body"><section class="daily-calendar-panel" aria-label="课表"><div class="day-panel-title"><div><h2 id="daily-heading">课表</h2><p id="day-capacity"></p></div><div class="calendar-view-switch" aria-label="课表视图"><button data-calendar-mode="day" aria-pressed="true">日</button><button data-calendar-mode="week" aria-pressed="false">周</button></div></div>
 <div class="day-week-strip"><div class="day-indicator" aria-hidden="true"></div>${Array.from({length:7},()=>'<button data-dayop="select-date"><span></span><strong></strong></button>').join('')}</div>
 <div class="calendar-viewport" tabindex="0" aria-label="可滚动课表"><div id="day-timeline"></div></div><div id="compact-events" class="compact-events"></div></section>
 <aside class="console-rail"><section class="console-next"><div class="rail-caption">当前 / 下一项<span class="live-dot"></span></div><div id="console-next"></div></section>
 <section class="console-analysis" aria-label="当日分析"><h2>当日分析</h2><p id="console-analysis"></p><div class="workload-track"><span id="workload-fill"></span></div><small id="workload-caption"></small></section>
 <section class="daily-list-panel" aria-label="待排任务"><div class="day-panel-title"><h2>待排任务 <span id="daily-count"></span></h2><label class="day-show-done"><input id="day-show-done" type="checkbox">完成</label></div>
 <div class="day-filters" aria-label="清单筛选">${[['ALL','全部'],['COURSE','课程'],['RESEARCH','科研'],['COMPETITION','竞赛']].map(([v,label])=>`<button data-dayop="filter" data-value="${v}" aria-pressed="false">${label}</button>`).join('')}</div>
 <form id="quick-task-form" class="quick-entry"><label class="sr-only" for="quick-title">添加任务</label><input id="quick-title" name="title" placeholder="写下下一件事" maxlength="160" required autocomplete="off"><div><label>预计 <select name="minutes" aria-label="新任务预计时长"><option value="30">30 分钟</option><option value="45" selected>45 分钟</option><option value="60">60 分钟</option><option value="90">90 分钟</option></select></label><button type="submit" aria-label="添加任务">${icon('plus')}</button></div></form>
 <div id="daily-tasks"></div><p id="daily-empty" class="day-empty" hidden>暂时没有待排任务。</p><div id="day-attention"></div></section></aside></div>
 <details class="day-auto-options"><summary>自动安排与统计口径</summary><p>“待执行安排”只计入所选日期的预约，不代表全部任务剩余量；过去未记录的时段需先核实。投入包含计时与补记，旧记录来源未知时不算入纯计时。缓冲沿用 15 分钟档位，手动安排精确到分钟。</p><label class="check"><input id="adjust-near" type="checkbox">允许调整近 24 小时的预约</label><div id="day-lock-options"></div></details></section>`;}
function updateConsoleClock(){
 if(!document.querySelector('#day-workspace'))return;
 const now=Date.now(),s=PlannerTime.summary(state,selectedDay,now);
 $('#stat-completion').textContent=`${s.done} / ${s.total}`;
 $('#stat-actual').textContent=duration(s.actual);
 $('#stat-focus').textContent=`其中计时 ${duration(s.focus)}`;
 $('#stat-remaining').textContent=duration(s.remaining);
 $('#stat-remaining-note').textContent=s.unconfirmed?`${s.unconfirmed} 个过去时段待核实`:'安排中的预计投入';
 $('#stat-available').textContent=s.available===null?'待核实':duration(s.available);
 $('#stat-available-note').textContent=s.available===null?(state.timer?'计时结束后重新核算':'先确认过去的安排'):'扣除日程、缓冲与每日上限';
 const next=state.timer?{task_id:state.timer.task_id,timer:true,id:state.timer.id}:s.next;
 const key=next?(next.id+(next.timer?'timer':'')):'empty',el=$('#console-next');
 if(el.dataset.key!==key){el.dataset.key=key;const t=next&&!next.event?task(next.task_id):null;
 el.innerHTML=next?`<span class="category-symbol ${t?.category.toLowerCase()||'fixed'}">${symbol(t?.category.toLowerCase()||'calendar')}</span><h3>${esc(t?.title||next.title)}</h3><p data-next-time></p><b data-next-countdown></b>${next.timer?'<button data-op="finish-timer">结束并反馈</button>':next.event?`<button data-event-detail="${next.id}">查看课程</button>`:`<button class="primary" data-op="start" data-id="${t.id}">开始专注 ${icon('play')}</button>`}`:'<h3>把时间留给重要的事。</h3><p>从待排任务中，选一件放进课表。</p><button data-command="new">添加任务</button>';}
 if(next){const t=el.querySelector('[data-next-time]'),c=el.querySelector('[data-next-countdown]');
 if(next.timer){t.textContent=state.timer.active_since?'本次专注':'已暂停';c.textContent=duration(PlannerTime.clipped(PlannerTime.segments(state.timer,now),0,now));}
 else {t.textContent=`${clock(next.start)}–${clock(next.end)}`;c.textContent=new Date(next.start)>now?`还有 ${duration((new Date(next.start)-now)/1000)}`:`时段内 · 还剩 ${duration((new Date(next.end)-now)/1000)}`;}}
 const pending=s.tasks.filter(t=>!['DONE','CANCELLED'].includes(t.status)).length;
 $('#console-analysis').textContent=s.unconfirmed?`有 ${s.unconfirmed} 个过去时段尚未核实。补记或确认未做后，再判断今天的余量。`:!s.total?'所选日期还没有任务安排。把待排任务拖进课表，开始规划。':pending?`已完成 ${s.done} 项，还有 ${pending} 项任务。${s.available===null?'当前计时结束后再核算空闲。':s.available===0?'可用容量已用满。':'仍有空间安排下一步。'}`:'当日任务已完成。可以收尾，也可以留一点空白。';
 const ratio=s.total?s.done/s.total:0;$('#workload-fill').style.width=`${ratio*100}%`;$('#workload-caption').textContent=`任务完成 ${Math.round(ratio*100)}%`;
 for(const line of document.querySelectorAll('.now-line')){const base=Number(line.dataset.base),end=Number(line.dataset.end);line.hidden=now<base||now>end;line.style.top=(now-base)/3600000*HOUR_PX+'px';line.querySelector('span').textContent=clock(now);}
}
function renderConsoleCalendar(){
 hideTaskPeek();const selected=new Date(`${selectedDay}T12:00:00+08:00`),offset=(selected.getDay()+6)%7;
 const dates=calendarMode==='week'?Array.from({length:7},(_,i)=>dayDate(i-offset)):[selectedDay];
 const source=[...state.events.map(e=>({...e,event:true})),...state.blocks.filter(b=>b.state==='PLANNED')];
 let start=Math.min(8,state.settings.start_hour),end=Math.max(20,state.settings.end_hour);
 for(const date of dates){const midnight=+new Date(`${date}T00:00:00+08:00`);for(const x of source.filter(b=>new Date(b.start)<midnight+86400000&&new Date(b.end)>midnight)){start=Math.min(start,Math.floor((Math.max(midnight,new Date(x.start))-midnight)/3600000));end=Math.max(end,Math.ceil((Math.min(midnight+86400000,new Date(x.end))-midnight)/3600000));}}
 const host=$('#day-timeline');host.className=`day-timeline ${calendarMode==='week'?'week-timeline':''}`;host.style.setProperty('--days',dates.length);
 host.innerHTML=`<div class="calendar-grid-head"><span>GMT+8</span>${dates.map(d=>`<button data-dayop="select-date" data-value="${d}" class="${d===selectedDay?'selected':''}">${calendarMode==='week'?`${Number(d.slice(5,7))}/${Number(d.slice(8))}`:'时间安排'}</button>`).join('')}</div><div class="calendar-columns"><div class="day-time-labels">${Array.from({length:end-start},(_,i)=>`<span>${String(start+i).padStart(2,'0')}:00</span>`).join('')}</div></div>`;
 const compact=[];
 for(const date of dates){const midnight=+new Date(`${date}T00:00:00+08:00`),base=midnight+start*3600000,finish=midnight+end*3600000;
 const items=source.filter(b=>new Date(b.start)<finish&&new Date(b.end)>base).map(b=>({...b})).sort((a,b)=>new Date(a.start)-new Date(b.start));
 let group=[],groupEnd=0;const groups=[];for(const x of items){if(group.length&&+new Date(x.start)>=groupEnd){groups.push(group);group=[];groupEnd=0;}group.push(x);groupEnd=Math.max(groupEnd,+new Date(x.end));}if(group.length)groups.push(group);
 for(const g of groups){const ends=[];for(const x of g){let lane=ends.findIndex(e=>e<=+new Date(x.start));if(lane<0)lane=ends.length;ends[lane]=+new Date(x.end);x.lane=lane;}g.forEach(x=>x.lanes=ends.length);}
 const surface=document.createElement('div');surface.className='day-surface';surface.dataset.base=base;surface.dataset.end=finish;surface.dataset.date=date;surface.style.height=(end-start)*HOUR_PX+'px';
 surface.innerHTML=`<div class="day-blocks"></div><div class="day-drop" hidden></div><div class="now-line" data-base="${base}" data-end="${finish}" hidden><span></span></div>`;
 for(const b of items){const t=b.event?null:task(b.task_id),movable=t&&dayCanMove(b),a=Math.max(base,+new Date(b.start)),z=Math.min(finish,+new Date(b.end)),h=(z-a)/3600000*HOUR_PX;
 const el=document.createElement('article');el.className=`day-block ${b.event?'fixed':t.category.toLowerCase()} ${h<66?'short-block':''} ${h<28?'tiny-block':''}`;el.dataset.key=`${date}-${b.id}`;el.dataset.peekId=b.id;el.dataset.peekEvent=String(!!b.event);
 el.innerHTML=`<button class="day-block-main" data-${b.event?'event':'block'}-detail="${b.id}" aria-label="${esc(t?.title||b.title)} ${clock(b.start)} 至 ${clock(b.end)}">${symbol(t?.category.toLowerCase()||'calendar')}<span class="block-copy"><strong>${esc(t?.title||b.title)}</strong><small>${clock(b.start)}–${clock(b.end)}${b.event?' · 固定':b.manual_lock?' · 锁定':''}</small></span></button>${movable&&h>=28?`<button class="day-block-handle" data-drag-block="${b.id}" aria-label="移动${esc(t.title)}">⠿</button><button class="day-resize" data-resize-block="${b.id}" aria-label="调整${esc(t.title)}时长"></button>`:''}`;
 el.style.top=(a-base)/3600000*HOUR_PX+'px';el.style.height=h+'px';el.style.left=`calc(${b.lane/b.lanes*100}% + 4px)`;el.style.width=`calc(${100/b.lanes}% - 8px)`;surface.querySelector('.day-blocks').append(el);
 if(h<28)compact.push(`<div class="compact-event">${movable?`<button class="compact-drag" data-drag-block="${b.id}" aria-label="移动短任务${esc(t.title)}">⠿</button>`:''}<button data-${b.event?'event':'block'}-detail="${b.id}">${symbol(t?.category.toLowerCase()||'calendar')}<span>${esc(t?.title||b.title)}</span><small>${calendarMode==='week'?date.slice(5)+' ':''}${clock(b.start)}–${clock(b.end)}</small></button></div>`);
 }
 host.querySelector('.calendar-columns').append(surface);
 }
 $('#compact-events').innerHTML=compact.length?`<p>短时段 · 点击查看或调整</p>${compact.join('')}`:'';
 const dayBlocks=source.filter(b=>!b.event&&dateKey(b.start)===selectedDay);$('#day-capacity').textContent=`${dayBlocks.length} 个任务时段 · 可拖动到分钟`;
 document.querySelectorAll('[data-calendar-mode]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.calendarMode===calendarMode)));
 updateConsoleClock();
}
function hideTaskPeek(){clearTimeout(peekDelay);clearTimeout(peekHideDelay);document.querySelector('#task-peek')?.remove();peekAnchor?.classList.remove('is-peeking');peekAnchor=null;}
function showTaskPeek(anchor){
 if(dayDrag||document.querySelector('dialog[open]')||peekDismissed===anchor)return;
 hideTaskPeek();if(!anchor.isConnected)return;peekAnchor=anchor;anchor.classList.add('is-peeking');
 const event=anchor.dataset.peekEvent==='true',b=(event?state.events:state.blocks).find(x=>x.id===anchor.dataset.peekId);if(!b)return;
 const t=event?null:task(b.task_id),p=document.createElement('aside');p.id='task-peek';p.setAttribute('role','region');p.setAttribute('aria-label','任务预览');
 p.innerHTML=`<span class="peek-category">${symbol(t?.category.toLowerCase()||'calendar')}${t?labels[t.category]:'固定日程'}</span><h3>${esc(t?.title||b.title)}</h3><p class="peek-time">${clock(b.start)}–${clock(b.end)}</p><p>${esc(t?.criteria||'点击查看详情与时间安排。')}</p>${t?`<dl><div><dt>任务预计剩余</dt><dd>${duration(t.remaining_seconds)}</dd></div><div><dt>累计已投入</dt><dd>${duration(state.records.filter(r=>r.task_id===t.id).reduce((n,r)=>n+r.active_seconds,0))}</dd></div></dl>`:''}<small>点击任务编辑 · Esc 收起</small>`;
 document.body.append(p);const r=anchor.getBoundingClientRect(),width=p.offsetWidth;let left=r.right+12;if(left+width>innerWidth-16)left=r.left-width-12;left=Math.max(12,Math.min(left,innerWidth-width-12));p.style.left=left+'px';p.style.top=Math.max(12,Math.min(r.top,innerHeight-p.offsetHeight-16))+'px';
}
document.addEventListener('pointerover',e=>{if(e.pointerType==='touch')return;const a=e.target.closest('.day-block');if(e.target.closest('#task-peek')){clearTimeout(peekHideDelay);return;}if(a&&!a.contains(e.relatedTarget)){peekDismissed=null;clearTimeout(peekHideDelay);clearTimeout(peekDelay);peekDelay=setTimeout(()=>showTaskPeek(a),250);}});
document.addEventListener('pointerout',e=>{const a=e.target.closest('.day-block,#task-peek');if(a&&!a.contains(e.relatedTarget)){clearTimeout(peekDelay);peekHideDelay=setTimeout(hideTaskPeek,160);}});
document.addEventListener('focusin',e=>{const a=e.target.closest('.day-block');if(a){peekDismissed=null;showTaskPeek(a);}else hideTaskPeek();});
document.addEventListener('keydown',async e=>{
 if(e.key==='Escape'){peekDismissed=peekAnchor;hideTaskPeek();return;}
 const anchor=e.target.closest('.day-block'),id=anchor?.dataset.peekId;
 if(!id||!e.altKey||!['ArrowUp','ArrowDown'].includes(e.key)||document.querySelector('dialog[open]'))return;
 const b=state.blocks.find(x=>x.id===id);if(!b||!dayCanMove(b))return;e.preventDefault();const delta=(e.key==='ArrowUp'?-1:1)*60000;
 try{await action('manual_schedule',{id,task_id:b.task_id,start:new Date(+new Date(b.start)+delta).toISOString(),end:new Date(+new Date(b.end)+delta).toISOString()});document.querySelector(`[data-block-detail="${id}"]`)?.focus();notify('已移动 1 分钟，可撤销。');}catch(err){showError(err);}
});
document.addEventListener('click',e=>{if(e.target.closest('button'))hideTaskPeek();const b=e.target.closest('[data-calendar-mode]');if(b){calendarMode=b.dataset.calendarMode;renderConsoleCalendar();const viewport=document.querySelector('.calendar-viewport');const selected=document.querySelector(`.day-surface[data-date="${selectedDay}"]`);if(viewport&&selected)viewport.scrollLeft=calendarMode==='week'?selected.offsetLeft-62:0;}});
document.addEventListener('scroll',()=>hideTaskPeek(),true);
window.addEventListener('resize',hideTaskPeek);
