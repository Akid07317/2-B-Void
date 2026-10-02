'use strict';
(() => {
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const app = $('#app'), timeline = $('#timeline'), scroll = $('#calendar-scroll');
const STORE = 'liubai-motion-study-v1', START = 480, END = 1200, PX = 84 / 60;
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icon = n => `<svg aria-hidden="true"><use href="#i-${n}"/></svg>`;
const hhmm = n => `${String(Math.floor(n / 60)).padStart(2,'0')}:${String(n % 60).padStart(2,'0')}`;
const hms = n => { n = Math.max(0,Math.floor(n)); return [Math.floor(n/3600),Math.floor(n/60)%60,n%60].map(x=>String(x).padStart(2,'0')).join(':'); };
const parse = s => /^\d{2}:\d{2}$/.test(s) ? Number(s.slice(0,2))*60+Number(s.slice(3)) : NaN;
const seeds = [
 {id:'c1',title:'高等数学',category:'固定课程',kind:'course',start:480,duration:90,description:'第三章 · 微分中值定理与导数的应用。教学楼 A203。'},
 {id:'t1',title:'整理数学课堂笔记',category:'高等数学',kind:'study',start:580,duration:40,description:'整理本周定理之间的联系，补上课堂例题的推导过程。'},
 {id:'c2',title:'大学英语',category:'固定课程',kind:'course',start:630,duration:50,description:'Unit 4 · Reading & discussion。外语楼 302。'},
 {id:'t2',title:'精读一篇前沿论文',category:'科研阅读',kind:'reading',start:787,duration:45,description:'先读研究问题与实验结论，再为关键图表写一张证据卡。'},
 {id:'c3',title:'程序设计',category:'固定课程',kind:'course',start:840,duration:90,description:'函数、递归与模块化。计算机实验室 2。'},
 {id:'t3',title:'完成本周编程练习',category:'程序设计',kind:'study',start:960,duration:45,description:'实现递归练习，验证边界条件，记录一个值得回顾的问题。'},
 {id:'t4',title:'复习英语词汇',category:'大学英语',kind:'reading',start:1035,duration:45,description:'用例句回忆本周词汇，并复习上周容易混淆的表达。'},
 {id:'q1',title:'高数习题 · 第三章',category:'高等数学',kind:'study',start:null,duration:45,description:'完成课后第 3、5、8 题。先独立尝试，再核对解题过程。'},
 {id:'q2',title:'为论文写一张证据卡',category:'科研阅读',kind:'reading',start:null,duration:30,description:'记录核心结论、实验设置和证据位置，区分作者解释与个人推断。'},
 {id:'q3',title:'梳理下周学习计划',category:'学业规划',kind:'study',start:null,duration:60,description:'先放入固定课程，再选择下周最重要的三个学习目标。'}
].map(t=>({...t,day:0,done:false}));
let state = {version:1,tasks:structuredClone(seeds),variant:'b',day:0,reduced:false,drafts:{},session:null,ledger:[{id:'seed',taskId:'t1',day:0,ms:2238000}],undo:[]};
try { const saved = JSON.parse(localStorage.getItem(STORE)); if(saved?.version===1 && Array.isArray(saved.tasks) && saved.tasks.every(t=>typeof t.id==='string'&&typeof t.title==='string'&&Number.isFinite(t.duration)&&Number.isInteger(t.day)) && Array.isArray(saved.ledger)) state={...state,...saved}; } catch {}
let selected = null, trigger = null, drag = null, peekTimer = 0, toastTimer = 0, menuTask = null, receipt = null;
let entrance = [], dayAnimations = [], suppressClick = false;
const media = matchMedia('(prefers-reduced-motion: reduce)');
const reduced = () => state.reduced || media.matches;
const task = id => state.tasks.find(t=>t.id===id);
const tasksToday = () => state.tasks.filter(t=>t.day===state.day);
const isEditable = t => t && t.kind!=='course' && !t.done;
function save() { try { localStorage.setItem(STORE,JSON.stringify(state)); } catch { $('#announcer').textContent='本机存储不可用，本次操作仍保留在当前页面。'; } }
function animate(el,frames,duration=220) { if(reduced()||!el)return null; return el.animate(frames,{duration,easing:'cubic-bezier(.18,.8,.22,1)'}); }
function say(text) { $('#announcer').textContent=text; }
function showToast(text,undo=false) {
 clearTimeout(toastTimer); $('#toast-text').textContent=text; $('#undo').hidden=!undo; $('#toast').hidden=false;
 animate($('#toast'),[{opacity:0,translate:'0 9px'},{opacity:1,translate:'0 0'}],180);
 toastTimer=setTimeout(()=>{if(!$('#toast').contains(document.activeElement))$('#toast').hidden=true;},undo?12000:6500);
}
function record(id,before,after,label) { state.undo.push({id,before,after,label}); if(state.undo.length>30)state.undo.shift(); }
function undo() {
 const op=state.undo.pop(); if(!op){showToast('没有可撤销的操作');return;}
 const t=task(op.id); if(!t)return;
 if('start' in op.before && op.before.start!==null) { const reason=conflict(t,op.before.start,op.before.duration??t.duration); if(reason){state.undo.push(op);showToast(`暂时无法撤销：${reason}`,true);return;} }
 Object.assign(t,op.before); render(); if(selected===t.id)fillDetail(t); save();
 showToast(`已撤销${op.label}；专注记录保持不变`,state.undo.length>0);
}
function durationText(n){return n>=60?`${Math.floor(n/60)} 小时${n%60?` ${n%60} 分钟`:''}`:`${n} 分钟`;}
function elapsed(s=state.session){return s ? s.accumulated+(s.startedAt===null?0:Math.max(0,Date.now()-s.startedAt)) : 0;}
function actualFor(id){return state.ledger.filter(x=>x.taskId===id).reduce((s,x)=>s+x.ms,0)+(state.session?.taskId===id?elapsed():0);}
function updateStats(){
 const ts=tasksToday(), editable=ts.filter(t=>t.kind!=='course'), done=editable.filter(t=>t.done).length;
 $('#completed').innerHTML=`${done} <small>/ ${editable.length}</small>`;
 const actual=state.ledger.filter(x=>x.day===state.day).reduce((s,x)=>s+x.ms,0)+(state.session?.day===state.day?elapsed():0);
 $('#actual').textContent=hms(actual/1000);
 // Completed scheduled work still occupies its original time; completion does not create free time.
 const intervals=ts.filter(t=>t.start!==null).map(t=>[t.start,t.start+t.duration]).sort((a,b)=>a[0]-b[0]);
 let occupied=0,last=START;for(const [a,b] of intervals){occupied+=Math.max(0,Math.min(END,b)-Math.max(last,a,START));last=Math.max(last,b);}
 const free=Math.max(0,END-START-occupied);$('#capacity').innerHTML=`${Math.floor(free/60)}<small>小时</small> ${String(free%60).padStart(2,'0')}<small>分钟</small>`;
 $('#task-total').textContent=`${done} / ${editable.length}`;$('#progress-fill').style.width=`${editable.length?done/editable.length*100:0}%`;
 const doneHTML=editable.filter(t=>t.done).map(t=>`<div class="completed-row">${icon('check')}<span>${esc(t.title)}</span></div>`).join('');
 if($('#completed-list').innerHTML!==doneHTML)$('#completed-list').innerHTML=doneHTML;
 if(selected&&task(selected))$('#detail-actual').textContent=`实际 ${hms(actualFor(selected)/1000)}`;
}
function eventNode(t){
 const el=document.createElement('article');el.className='event';el.dataset.id=t.id;
 el.innerHTML=`<button class="event-main" data-open="${t.id}" data-drag="${t.id}"><span class="event-title"></span><span class="event-time"></span></button><div class="event-actions"><button class="completion" data-complete="${t.id}" aria-label="完成任务">${icon('check')}</button><button class="event-grab" data-drag="${t.id}" aria-label="拖动${esc(t.title)}">${icon('grip')}</button><button class="icon-button more-task" data-more="${t.id}" aria-label="任务操作">${icon('more')}</button></div><button class="resize-handle" data-resize="${t.id}" aria-label="拖动调整时长"></button>`;
 return el;
}
function renderTimeline(){
 const ts=tasksToday().filter(t=>t.start!==null), ids=new Set(ts.map(t=>t.id));
 $$('.event').forEach(el=>{if(!ids.has(el.dataset.id))el.remove();});
 for(const t of ts){
  let el=$(`.event[data-id="${t.id}"]`);const fresh=!el;if(!el){el=eventNode(t);timeline.append(el);}
  const prev=el.getBoundingClientRect();const newTop=(t.start-START)*PX,newHeight=t.duration*PX;
  const oldTop=parseFloat(el.style.top);el.style.top=`${newTop}px`;el.style.height=`${newHeight}px`;el.dataset.kind=t.kind;
  el.classList.toggle('selected',selected===t.id);el.classList.toggle('done',t.done);el.classList.toggle('compact',t.duration<30);
  el.querySelector('.event-title').textContent=t.title;el.querySelector('.event-time').textContent=`${hhmm(t.start)} — ${hhmm(t.start+t.duration)}${t.kind==='course'?' · 固定课程':''}`;
  const main=el.querySelector('.event-main');main.setAttribute('aria-label',`${t.title}，${hhmm(t.start)} 至 ${hhmm(t.start+t.duration)}${t.done?'，已完成':''}`);
  const cb=el.querySelector('.completion');cb.hidden=t.kind==='course';cb.setAttribute('aria-label',`${t.done?'恢复':'完成'}${t.title}`);cb.setAttribute('aria-pressed',String(t.done));
  el.querySelector('.resize-handle').hidden=!isEditable(t);el.querySelector('.event-grab').hidden=!isEditable(t);el.querySelector('[data-more]').hidden=t.kind==='course';
  if(!fresh && Number.isFinite(oldTop) && oldTop!==newTop){el.getAnimations().forEach(a=>a.cancel());animate(el,[{transform:`translateY(${prev.top-el.getBoundingClientRect().top}px)`},{transform:'translateY(0)'}],state.variant==='b'?280:200);}
  if(fresh)animate(el,[{opacity:.2,translate:'0 5px'},{opacity:1,translate:'0 0'}],200);
 }
 $('#empty-day').hidden=ts.length>0;
}
function renderQueue(){
 const ts=tasksToday().filter(t=>t.start===null&&!t.done), ids=new Set(ts.map(t=>t.id));
 const before=new Map($$('.queue-task').map(n=>[n.dataset.id,n.getBoundingClientRect().top]));
 $$('.queue-task').forEach(n=>{if(!ids.has(n.dataset.id))n.remove();});$('#queue-count').textContent=String(ts.length).padStart(2,'0');
 for(const t of ts){let el=$(`.queue-task[data-id="${t.id}"]`);if(!el){el=document.createElement('article');el.className='queue-task';el.dataset.id=t.id;el.innerHTML=`<button class="queue-main" data-open="${t.id}" data-drag="${t.id}"><strong></strong><small></small></button><button class="drag-handle" data-drag="${t.id}" aria-label="拖动${esc(t.title)}">${icon('grip')}</button><button class="queue-schedule icon-button" data-open="${t.id}" aria-label="安排${esc(t.title)}">${icon('arrow')}</button>`;$('#queue').append(el);animate(el,[{opacity:0,translate:'0 -8px'},{opacity:1,translate:'0 0'}],200);}el.querySelector('strong').textContent=t.title;el.querySelector('small').textContent=`${t.category} · ${durationText(t.duration)}`;
  if(before.has(t.id)){const dy=before.get(t.id)-el.getBoundingClientRect().top;if(Math.abs(dy)>1)animate(el,[{translate:`0 ${dy}px`},{translate:'0 0'}],220);}
 }
 let empty=$('#queue .queue-empty');if(!ts.length&&!empty){empty=document.createElement('p');empty.className='queue-empty';empty.textContent='待安排的事情，都有了位置。';$('#queue').append(empty);}else if(ts.length&&empty)empty.remove();
}
function renderDay(){
 const d=new Date(2026,8,23+state.day);$('#date-label').textContent=`${d.getMonth()+1} 月 ${d.getDate()} 日 · 星期${'日一二三四五六'[d.getDay()]}`;
 $('#page-title').innerHTML=`${state.day===0?'今天':state.day===1?'明天':state.day===-1?'昨天':'日程'}<span class="title-dot">.</span>`;
 const i=[-1,0,1].indexOf(state.day);$('.day-plate').style.opacity=i<0?'0':'1';if(i>=0)$('.day-plate').style.transform=`translateX(${i*46}px)`;
 $$('[data-day]').forEach(b=>b.setAttribute('aria-pressed',String(Number(b.dataset.day)===state.day)));
}
function render(){renderDay();renderTimeline();renderQueue();updateStats();updateFocus();}
function conflict(t,start,duration){
 if(!Number.isInteger(start)||!Number.isInteger(duration)||duration<5||start<START||start+duration>END)return '请选择 08:00–20:00 内至少 5 分钟的时段';
 const overlap=state.tasks.find(o=>o.id!==t.id&&o.day===t.day&&o.start!==null&&start<o.start+o.duration&&start+duration>o.start);
 return overlap?`与「${overlap.title}」重叠`:'';
}
function freeSlot(t){for(let m=START;m+t.duration<=END;m++)if(!conflict(t,m,t.duration))return m;return null;}
function schedule(t,start,duration){
 if(!isEditable(t))return false;const error=conflict(t,start,duration);if(error){$('#time-error').textContent=error;showToast(error);return false;}
 if(t.start===start&&t.duration===duration){delete state.drafts[t.id];save();return true;}
 record(t.id,{start:t.start,duration:t.duration},{start,duration},'时间调整');Object.assign(t,{start,duration});delete state.drafts[t.id];render();save();
 showToast(`${t.title} · ${hhmm(start)}—${hhmm(start+duration)}`,true);const el=$(`.event[data-id="${t.id}"]`);if(el){el.classList.remove('saved-flash');void el.offsetWidth;el.classList.add('saved-flash');}return true;
}
function complete(t){
 if(!t||t.kind==='course')return;if(state.session?.taskId===t.id){showToast('先结束这段专注，再完成任务');return;}
 record(t.id,{done:t.done},{done:!t.done},t.done?'恢复任务':'完成');t.done=!t.done;render();if(selected===t.id)fillDetail(t);save();showToast(`${t.done?'已完成':'已恢复'}「${t.title}」`,true);
 const cb=$(`.event[data-id="${t.id}"] .completion`);if(cb)animate(cb,[{transform:'scale(.8)'},{transform:state.variant==='b'?'scale(1.12)':'scale(1)'},{transform:'scale(1)'}],220);
}

// A retargetable damped motion controller keeps current position and velocity when its goal changes.
const panel=$('#inspector');let panelOpen=false,frame=0,lastFrame=0;
const ps={x:0,y:0,o:1,vx:0,vy:0,vo:0}, goal={x:0,y:0,o:1};
function paintPanel(){panel.style.transform=`translate(${ps.x}px,${ps.y}px)`;panel.style.opacity=Math.max(0,Math.min(1,ps.o));}
function stepPanel(now){
 const dt=Math.min(.025,(now-(lastFrame||now-16))/1000);lastFrame=now;const w=state.variant==='b'?24:30,z=state.variant==='b'?.94:1;
 let moving=false;for(const k of ['x','y','o']){const vk='v'+k;ps[vk]+=(w*w*(goal[k]-ps[k])-2*z*w*ps[vk])*dt;ps[k]+=ps[vk]*dt;if(Math.abs(goal[k]-ps[k])>(k==='o'?.002:.15)||Math.abs(ps[vk])>(k==='o'?.02:1))moving=true;}
 paintPanel();if(moving)frame=requestAnimationFrame(stepPanel);else{frame=0;lastFrame=0;Object.assign(ps,goal,{vx:0,vy:0,vo:0});paintPanel();if(!panelOpen)panel.hidden=true;}
}
function runPanel(){if(reduced()){cancelAnimationFrame(frame);frame=0;Object.assign(ps,goal,{vx:0,vy:0,vo:0});paintPanel();panel.hidden=!panelOpen;}else if(!frame)frame=requestAnimationFrame(stepPanel);}
function sourceOffset(){const source=$(`.event[data-id="${selected}"]`)||$(`.queue-task[data-id="${selected}"]`);if(!source)return {x:0,y:15};const r=source.getBoundingClientRect(),p=panel.getBoundingClientRect();return{x:Math.max(-100,Math.min(100,r.left+r.width/2-(p.left+p.width/2))),y:Math.max(-40,Math.min(40,r.top-(p.top)))};}
function openDetail(id,source){
 const t=task(id);if(!t)return;hidePeek();closeMenu();const wasHidden=panel.hidden;selected=id;trigger=source||$(`[data-open="${id}"]`);panelOpen=true;panel.hidden=false;
 panel.style.top=`${Math.max(85,Math.min(180,innerHeight-520))}px`;fillDetail(t);renderTimeline();
 if(wasHidden){const v=sourceOffset();Object.assign(ps,{...v,o:0,vx:0,vy:0,vo:0});paintPanel();}
 Object.assign(goal,{x:0,y:0,o:1});runPanel();animate($('.inspector-content'),[{opacity:.4,translate:'0 4px'},{opacity:1,translate:'0 0'}],180);
 $('#close-detail').focus({preventScroll:true});
}
function fillDetail(t){
 $('#detail-title').textContent=t.title;$('#detail-description').textContent=t.description;$('#detail-category').textContent=t.category;$('#detail-state').textContent=t.done?'已完成':t.kind==='course'?'固定课程':t.start===null?'待安排':'已安排';$('#detail-actual').textContent=`实际 ${hms(actualFor(t.id)/1000)}`;
 const start=t.start??freeSlot(t),draft=state.drafts[t.id];$('#start-time').value=draft?.start??(start===null?'':hhmm(start));$('#end-time').value=draft?.end??(start===null?'':hhmm(start+t.duration));$('#time-error').textContent=draft?'保留了尚未保存的时间编辑':'';
 ['#start-time','#end-time','#save-time','#detail-focus'].forEach(s=>$(s).disabled=!isEditable(t));$('#detail-complete').disabled=t.kind==='course';$('#detail-complete span').textContent=t.done?'恢复任务':'完成';
 $('#unschedule').hidden=!isEditable(t)||t.start===null;$('#save-time').innerHTML=`${t.start===null?'安排到这个时段':'保存时间'}${icon('arrow')}`;
}
function closeDetail(restore=true){if(panel.hidden)return;const focused=panel.contains(document.activeElement);panelOpen=false;Object.assign(goal,{...sourceOffset(),o:0});runPanel();if(restore&&focused&&trigger?.isConnected)trigger.focus({preventScroll:true});selected=null;renderTimeline();}

function startFocus(id){
 const t=task(id);if(!isEditable(t)){showToast('请选择一项未完成的学习任务');return;}
 if(state.session){if(state.session.taskId===id){$('#focus-area').scrollIntoView({block:'nearest',behavior:reduced()?'instant':'smooth'});return;}showToast('请先结束当前专注，再开始另一项任务');return;}
 state.session={id:crypto.randomUUID(),taskId:id,day:t.day,startedAt:Date.now(),accumulated:0};receipt=null;save();updateFocus();updateStats();
 animate($('#focus-area'),[{transform:'translateY(4px)',filter:'brightness(1.05)'},{transform:'translateY(0)',filter:'brightness(1)'}],state.variant==='b'?360:220);showToast(`开始专注 · ${t.title}`);
}
function pauseFocus(){const s=state.session;if(!s)return;if(s.startedAt===null)s.startedAt=Date.now();else{s.accumulated=elapsed(s);s.startedAt=null;}save();updateFocus();}
function endFocus(){const s=state.session;if(!s)return;const ms=elapsed(s);if(!state.ledger.some(x=>x.id===s.id))state.ledger.push({id:s.id,taskId:s.taskId,day:s.day,ms});receipt={taskId:s.taskId,ms};state.session=null;save();updateFocus();updateStats();animate($('#session-receipt'),[{opacity:0,translate:'0 8px'},{opacity:1,translate:'0 0'}],260);showToast(`已记录 ${hms(ms/1000)}，这段投入已保留`);}
function updateFocus(){
 const s=state.session;$('#focus-idle').hidden=!!s;$('#focus-active').hidden=!s;$('#focus-area').classList.toggle('is-active',!!s);$('#focus-led').classList.toggle('running',!!s&&s.startedAt!==null);
 $('#focus-status').textContent=s?(s.startedAt===null?'稍作休息':'正在专注'):'留一段专注';
 if(s){const t=task(s.taskId);$('#focus-task').textContent=t?.title||'学习任务';$('#clock').textContent=hms(elapsed(s)/1000);$('#focus-plan').textContent=`计划 ${t?.duration||0} 分钟`;$('#pause-focus span').textContent=s.startedAt===null?'继续':'暂停';$('#pause-focus use').setAttribute('href',s.startedAt===null?'#i-play':'#i-pause');}
 else{const t=(selected&&isEditable(task(selected))?task(selected):tasksToday().find(t=>isEditable(t)&&t.start!==null))||tasksToday().find(isEditable);$('#focus-suggestion').textContent=t?`${t.title} · ${durationText(t.duration)}`:'新建一项任务，再开始一段专注。';$('#quick-focus').disabled=!t;$('#quick-focus').dataset.task=t?.id||'';}
 $('#session-receipt').hidden=!receipt||!!s;if(receipt){$('#receipt-time').textContent=hms(receipt.ms/1000);$('#receipt-task').textContent=task(receipt.taskId)?.title||'学习任务';}
}
setInterval(()=>{if(state.session){updateFocus();updateStats();}},250);

function hidePeek(){clearTimeout(peekTimer);$('#peek').hidden=true;}
function queuePeek(id,el){hidePeek();if(drag||panelOpen||matchMedia('(pointer:coarse)').matches)return;peekTimer=setTimeout(()=>{const t=task(id);if(!t)return;const p=$('#peek'),r=el.getBoundingClientRect();$('#peek-label').textContent=t.category;$('#peek-title').textContent=t.title;$('#peek-description').textContent=t.description;$('#peek-time').textContent=t.start===null?`计划 ${durationText(t.duration)}`:`${hhmm(t.start)}—${hhmm(t.start+t.duration)} · ${durationText(t.duration)}`;p.hidden=false;const pr=p.getBoundingClientRect();p.style.left=`${Math.max(12,Math.min(innerWidth-pr.width-12,r.right+12))}px`;p.style.top=`${Math.max(12,Math.min(innerHeight-pr.height-12,r.top))}px`;animate(p,[{opacity:0,translate:'-4px 0'},{opacity:1,translate:'0 0'}],150);},320);}
function closeMenu(){ $('#context-menu').hidden=true;menuTask=null; }
function showMenu(id,el){hidePeek();menuTask=id;const m=$('#context-menu'),r=el.getBoundingClientRect();m.hidden=false;m.style.left=`${Math.max(12,Math.min(innerWidth-190,r.right-175))}px`;m.style.top=`${Math.max(10,Math.min(innerHeight-155,r.bottom+7))}px`;m.querySelector('[data-menu=complete]').textContent=task(id).done?'恢复任务':'完成任务';m.querySelector('button').focus();animate(m,[{opacity:0,translate:'0 -5px'},{opacity:1,translate:'0 0'}],150);}

function setVariant(v){state.variant=v;document.body.dataset.variant=v;app.dataset.variant=v;$$('[data-variant]').filter(n=>n.tagName==='BUTTON').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.variant===v)));const width=$('[data-variant="a"]').getBoundingClientRect().width;$('.variant-plate').style.transform=`translateX(${v==='b'?width:0}px)`;save();}
function setReduced(){document.body.classList.toggle('reduced',reduced());$('#reduce').checked=reduced();if(reduced()){entrance.forEach(a=>a.cancel());runPanel();$$('*').forEach(el=>el.getAnimations().forEach(a=>a.finish()));}}
function enter(){entrance.forEach(a=>a.cancel());entrance=[];if(reduced())return;const elements=[$('.schedule'),$('.overview'),$('.planning')];elements.forEach((el,i)=>{const a=el.animate([{opacity:.55,transform:`translateY(${state.variant==='b'?9:5}px)`},{opacity:1,transform:'translateY(0)'}],{duration:state.variant==='b'?320:230,delay:i*30,easing:'cubic-bezier(.16,.8,.22,1)'});entrance.push(a);});}
function changeDay(n){if(drag)finishDrag(true);hidePeek();closeMenu();closeDetail(false);state.day=n;dayAnimations.forEach(a=>a.cancel());render();save();const a=animate(timeline,[{opacity:.35,translate:`${n>0?5:-5}px 0`},{opacity:1,translate:'0 0'}],180);if(a)dayAnimations=[a];}
function compose(){const f=$('#composer');f.hidden=false;$('#task-title').focus();animate(f,[{opacity:0,translate:'0 -6px'},{opacity:1,translate:'0 0'}],180);f.scrollIntoView({block:'nearest',behavior:reduced()?'instant':'smooth'});}

// Direct manipulation: the pointer owns the moving surface. Only the drop preview snaps.
function pointerStart(e){
 if(e.button!==0||e.target.closest('[data-complete],[data-more]'))return;const hit=e.target.closest('[data-resize],[data-drag]');if(!hit)return;
 const id=hit.dataset.resize||hit.dataset.drag,t=task(id);if(!isEditable(t))return;
 if(e.pointerType==='touch'&&!hit.matches('.drag-handle,.event-grab,.resize-handle'))return;
 const source=hit.closest('.event,.queue-task'),r=source.getBoundingClientRect();
 drag={id,t,source,hit,resize:!!hit.dataset.resize,startX:e.clientX,startY:e.clientY,x:e.clientX,y:e.clientY,offsetX:e.clientX-r.left,offsetY:e.clientY-r.top,rect:r,pointerId:e.pointerId,active:false,candidate:null,duration:t.duration,valid:false,raf:0};
 hit.setPointerCapture(e.pointerId);hidePeek();closeMenu();
}
function activateDrag(){const d=drag;if(!d)return;d.active=true;d.source.classList.add('drag-source');document.body.classList.add('dragging');const g=document.createElement('div');g.className='drag-ghost';g.innerHTML=`<span>${esc(d.t.title)}</span><small>${d.resize?'调整时长':'拖到课表安排时间'}</small>`;g.style.width=`${Math.min(320,d.rect.width)}px`;document.body.append(g);d.ghost=g;const tick=()=>{if(!drag?.active)return;const r=scroll.getBoundingClientRect();if(d.x>r.left&&d.x<r.right&&d.y>r.top-20&&d.y<r.bottom+20){const delta=d.y<r.top+45?-7:d.y>r.bottom-45?7:0;if(delta){scroll.scrollTop+=delta;updateDrag();}}d.raf=requestAnimationFrame(tick);};d.raf=requestAnimationFrame(tick);}
function updateDrag(){const d=drag;if(!d?.active)return;const r=timeline.getBoundingClientRect(),sc=scroll.getBoundingClientRect();d.ghost.style.left=`${Math.max(5,Math.min(innerWidth-150,d.x-Math.min(d.offsetX,200)))}px`;d.ghost.style.top=`${d.y-Math.min(d.offsetY,50)}px`;
 const inside=d.x>=r.left-20&&d.x<=r.right+20&&d.y>=sc.top&&d.y<=sc.bottom;
 const preview=$('#drop-preview');if(!inside){d.candidate=null;d.valid=false;preview.hidden=true;return;}
 let raw=START+(d.y-r.top-(d.resize?0:Math.min(d.offsetY,d.rect.height/2)))/PX;
 const step=d.precise?1:5;
 if(d.resize){d.candidate=d.t.start;d.duration=Math.max(5,Math.round((raw-d.t.start)/step)*step);}else{d.candidate=Math.round(raw/step)*step;d.duration=d.t.duration;}
 const reason=conflict(d.t,d.candidate,d.duration);d.valid=!reason;d.reason=reason;preview.hidden=false;preview.style.top=`${Math.max(0,(d.candidate-START)*PX)}px`;preview.style.height=`${Math.min(END-START,d.duration)*PX}px`;preview.classList.toggle('invalid',!!reason);preview.querySelector('span').textContent=reason||`${hhmm(d.candidate)}—${hhmm(d.candidate+d.duration)}${d.precise?' · 分钟精度':''}`;d.ghost.querySelector('small').textContent=reason||`${hhmm(d.candidate)}—${hhmm(d.candidate+d.duration)}`;
}
function pointerMove(e){if(!drag||e.pointerId!==drag.pointerId)return;drag.x=e.clientX;drag.y=e.clientY;drag.precise=e.altKey;if(!drag.active&&Math.hypot(e.clientX-drag.startX,e.clientY-drag.startY)>5)activateDrag();if(drag.active){e.preventDefault();updateDrag();}}
function finishDrag(cancel=false){
 const d=drag;if(!d)return;drag=null;cancelAnimationFrame(d.raf);if(d.hit.hasPointerCapture?.(d.pointerId))d.hit.releasePointerCapture(d.pointerId);d.source.classList.remove('drag-source');document.body.classList.remove('dragging');$('#drop-preview').hidden=true;
 if(!d.active)return;suppressClick=true;setTimeout(()=>suppressClick=false,80);
 let ok=false;if(!cancel&&d.valid)ok=schedule(d.t,d.candidate,d.duration);else if(!cancel)showToast(d.reason||'拖到课表内安排，原位置已保留');else say('已取消拖动');
 const target=ok?$(`.event[data-id="${d.id}"]`):d.source;
 if(d.ghost){if(target?.isConnected&&!reduced()){const from=d.ghost.getBoundingClientRect(),to=target.getBoundingClientRect();const a=animate(d.ghost,[{translate:'0 0',opacity:1},{translate:`${to.left-from.left}px ${to.top-from.top}px`,opacity:0}],state.variant==='b'?240:170);a.finished.catch(()=>{}).finally(()=>d.ghost.remove());}else d.ghost.remove();}
 if(selected===d.id)fillDetail(d.t);
}
document.addEventListener('pointerdown',e=>{if(app.contains(e.target)){entrance.forEach(a=>a.cancel());entrance=[];}if(!e.target.closest('#context-menu,[data-more]'))closeMenu();pointerStart(e);});
document.addEventListener('pointermove',pointerMove,{passive:false});document.addEventListener('pointerup',()=>finishDrag());document.addEventListener('pointercancel',()=>finishDrag(true));
window.addEventListener('blur',()=>{if(drag)finishDrag(true);hidePeek();});scroll.addEventListener('scroll',hidePeek);
document.addEventListener('pointerover',e=>{const el=e.target.closest('.event,.queue-task');if(el&&!el.contains(e.relatedTarget))queuePeek(el.dataset.id,el);});
document.addEventListener('pointerout',e=>{const el=e.target.closest('.event,.queue-task');if(el&&!el.contains(e.relatedTarget))hidePeek();});
document.addEventListener('click',e=>{
 if(suppressClick)return;const open=e.target.closest('[data-open]'),cb=e.target.closest('[data-complete]'),more=e.target.closest('[data-more]');
 if(cb)complete(task(cb.dataset.complete));else if(more)showMenu(more.dataset.more,more);else if(open)openDetail(open.dataset.open,open);
});
document.addEventListener('keydown',e=>{
 if(e.key==='Escape'){if(drag){finishDrag(true);return;}hidePeek();if(!$('#context-menu').hidden){closeMenu();return;}if(!$('#composer').hidden){$('#composer').hidden=true;$('#new-task').focus();return;}closeDetail();return;}
 if(e.target.matches('input,textarea,select')||e.isComposing)return;
 if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='z'){e.preventDefault();undo();return;}
 const hit=e.target.closest('[data-open]');if(hit&&['ArrowUp','ArrowDown'].includes(e.key)){const t=task(hit.dataset.open);if(isEditable(t)&&t.start!==null){e.preventDefault();schedule(t,t.start+(e.key==='ArrowUp'?-1:1)*(e.shiftKey?5:1),t.duration);return;}}
 if(!e.metaKey&&!e.ctrlKey&&e.key.toLowerCase()==='n'){e.preventDefault();compose();}
 if(!$('#context-menu').hidden&&['ArrowDown','ArrowUp'].includes(e.key)){e.preventDefault();const bs=[...$('#context-menu').querySelectorAll('button')],i=bs.indexOf(document.activeElement);bs[(i+(e.key==='ArrowDown'?1:-1)+bs.length)%bs.length].focus();}
});
$$('[data-menu]').forEach(b=>b.addEventListener('click',()=>{const id=menuTask,t=task(id);closeMenu();if(b.dataset.menu==='detail')openDetail(id);if(b.dataset.menu==='focus')startFocus(id);if(b.dataset.menu==='complete')complete(t);}));
$$('button[data-variant]').forEach(b=>b.addEventListener('click',()=>setVariant(b.dataset.variant)));
$$('[data-day]').forEach(b=>b.addEventListener('click',()=>changeDay(Number(b.dataset.day))));
$('.day-segments').addEventListener('keydown',e=>{if(['ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();const bs=$$('[data-day]'),i=bs.indexOf(document.activeElement),n=(i+(e.key==='ArrowRight'?1:-1)+3)%3;bs[n].focus();changeDay(Number(bs[n].dataset.day));}});
$('#prev').onclick=()=>changeDay(state.day-1);$('#next').onclick=()=>changeDay(state.day+1);$('#replay').onclick=enter;
$('#reduce').onchange=e=>{state.reduced=e.target.checked;setReduced();save();};media.addEventListener('change',setReduced);
$('#new-task').onclick=compose;$('#queue-add').onclick=compose;$('#cancel-compose').onclick=()=>{$('#composer').hidden=true;$('#new-task').focus();};
$('#composer').addEventListener('keydown',e=>{if(e.key==='Enter'&&e.isComposing)e.preventDefault();});
$('#composer').onsubmit=e=>{e.preventDefault();const title=$('#task-title').value.trim(),duration=Number($('#task-duration').value);if(!title||!Number.isInteger(duration)||duration<5||duration>180)return;const id='t'+crypto.randomUUID();state.tasks.push({id,title,duration,start:null,day:state.day,done:false,kind:'study',category:'学习任务',description:'留出时间，专心完成这一件事。'});$('#task-title').value='';$('#composer').hidden=true;render();save();showToast(`已加入待安排 · ${title}`);$(`.queue-task[data-id="${id}"] button`).focus({preventScroll:true});};
$('#time-form').onsubmit=e=>{e.preventDefault();const t=task(selected),s=parse($('#start-time').value),end=parse($('#end-time').value);if(schedule(t,s,end-s))fillDetail(t);};
['#start-time','#end-time'].forEach(s=>$(s).addEventListener('input',()=>{if(selected){state.drafts[selected]={start:$('#start-time').value,end:$('#end-time').value};save();}}));
$('#close-detail').onclick=()=>closeDetail();$('#detail-focus').onclick=()=>{startFocus(selected);closeDetail();};$('#detail-complete').onclick=()=>complete(task(selected));
$('#unschedule').onclick=()=>{const t=task(selected);if(!isEditable(t))return;record(t.id,{start:t.start},{start:null},'移出课表');t.start=null;render();fillDetail(t);save();showToast('已移回待安排',true);};
$('#quick-focus').onclick=e=>startFocus(e.currentTarget.dataset.task);$('#pause-focus').onclick=pauseFocus;$('#end-focus').onclick=endFocus;
$('#undo').onclick=undo;$('#dismiss-toast').onclick=()=>$('#toast').hidden=true;
$('#nav-day').onclick=()=>$('.schedule').scrollIntoView({behavior:reduced()?'instant':'smooth',block:'start'});$('#nav-tasks').onclick=()=>$('.planning').scrollIntoView({behavior:reduced()?'instant':'smooth',block:'start'});$('#nav-focus').onclick=()=>$('#focus-area').scrollIntoView({behavior:reduced()?'instant':'smooth',block:'center'});
window.addEventListener('resize',()=>{setVariant(state.variant);hidePeek();});
window.addEventListener('pagehide',save);document.addEventListener('visibilitychange',()=>{if(!document.hidden){updateFocus();updateStats();}});
$('#hour-labels').innerHTML=Array.from({length:13},(_,i)=>`<span style="top:${i*84}px">${hhmm(START+i*60)}</span>`).join('');
setVariant(state.variant);setReduced();render();requestAnimationFrame(enter);
})();
