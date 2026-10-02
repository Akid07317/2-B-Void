'use strict';
// Shared, deterministic time arithmetic; the UI clock only supplies `now`.
const PlannerTime = (() => {
  const ms = value => new Date(value).getTime();
  const seconds = (a, b) => Math.max(0, Math.floor((b - a) / 1000));
  const hms = value => {
    if (value === null || value === undefined || !Number.isFinite(value)) return '—';
    const n = Math.max(0, Math.floor(value));
    return [Math.floor(n / 3600), Math.floor(n / 60) % 60, n % 60].map(v => String(v).padStart(2, '0')).join(':');
  };
  const segments = (timer, now) => timer ? [...timer.segments, ...(timer.active_since ? [{start: timer.active_since, end: new Date(now).toISOString()}] : [])] : [];
  const clipped = (parts, a, b) => parts.reduce((n, s) => n + seconds(Math.max(a, ms(s.start)), Math.min(b, ms(s.end))), 0);
  function union(parts, a, b) {
    const sorted = parts.map(s => [Math.max(a, ms(s.start)), Math.min(b, ms(s.end))]).filter(([x,y]) => y>x).sort((x,y) => x[0]-y[0]);
    const merged = [];
    for (const [x,y] of sorted) {
      const last = merged.at(-1);
      if (last && x <= last[1]) last[1] = Math.max(y, last[1]); else merged.push([x,y]);
    }
    return merged.reduce((n,[x,y]) => n + seconds(x,y), 0);
  }
  function summary(state, day, now) {
    const a=ms(`${day}T00:00:00+08:00`), b=a+86400000;
    const onDay = s => ms(s.start)<b && ms(s.end)>a;
    const records = state.records.filter(r=>r.segments.some(onDay));
    const active = segments(state.timer, now);
    const blocks = state.blocks.filter(onDay);
    const planned = blocks.filter(x=>x.state==='PLANNED');
    const actual = records.reduce((n,r)=>n+clipped(r.segments,a,b),0)+clipped(active,a,b);
    const focus = records.filter(r=>r.source==='TIMER').reduce((n,r)=>n+clipped(r.segments,a,b),0)+clipped(active,a,b);
    const members = new Set([...blocks.filter(x=>x.state!=='CANCELLED').map(x=>x.task_id),...records.map(r=>r.task_id)]);
    state.tasks.filter(t=>t.completed_at && ms(t.completed_at)>=a && ms(t.completed_at)<b).forEach(t=>members.add(t.id));
    if (state.timer && active.some(onDay)) members.add(state.timer.task_id);
    const tasks=state.tasks.filter(t=>members.has(t.id)&&t.status!=='CANCELLED');
    // A future completion must not retroactively change a past day's result.
    const done=tasks.filter(t=>t.status==='DONE'&&t.completed_at&&ms(t.completed_at)<b).length;
    const unconfirmed=planned.filter(x=>ms(x.start)<now&&state.timer?.block_id!==x.id);
    const remaining=planned.filter(x=>x.coverage_state==='COUNTED').reduce((n,x)=>{
      const spent=state.timer?.block_id===x.id ? clipped(active,ms(x.start),ms(x.end)) : 0;
      return n+Math.max(0,x.planned_work_seconds-spent);
    },0);
    const cfg=state.settings, start=a+cfg.start_hour*3600000, end=a+cfg.end_hour*3600000;
    const fixedFree=seconds(start,end)-union(state.events,start,end);
    const buffer=900*Math.floor(Math.floor(fixedFree*cfg.buffer_percent/100)/900);
    const limit=Math.min(cfg.daily_minutes*60,fixedFree-buffer);
    const from=Math.max(now,start);
    const reserved=clipped(planned,from,end);
    const open=seconds(from,end)-union([...state.events,...planned],from,end);
    const runningToday=!!state.timer && now>=a && now<b;
    const available=from>=end?0:(runningToday||unconfirmed.length?null:Math.max(0,Math.min(open,limit-actual-reserved)));
    const timeline=[...state.events.filter(onDay).map(x=>({...x,event:true})),...planned].sort((x,y)=>ms(x.start)-ms(y.start));
    const next=timeline.find(x=>ms(x.end)>now) || null;
    return {actual,focus,done,total:tasks.length,remaining,available,buffer,unconfirmed:unconfirmed.length,next,planned,tasks};
  }
  return {hms, segments, clipped, summary};
})();
if (typeof module !== 'undefined') module.exports = PlannerTime;
