export const DEFAULTS = {
  start: '2026-11-10', end: '2027-02-28', weekdayKm: 50, weekendKm: 300,
  completion: 100, consumption: 20, homePrice: 0.45, equipment: 1499,
  installation: 0, salvage: 0, distance: 200, freeMinutes: 120,
  parkingRate: 6, extraMinutes: 10, timeValue: 30, batch: 40, power: 60,
  mode: 'smart', windows: [{start:'09:20',end:'11:20'}, {start:'14:00',end:'17:20'}],
  tariffs: Array.from({length:24}, (_, h) => {
    const total = h < 7 ? 0.65 : h < 9 ? 0.85 : h < 12 ? 0.85 : h < 15 ? 0.75 : h === 15 ? 0.93 : h === 16 ? 1.29 : h < 20 ? 1.43 : h < 23 ? 1.1 : 0.65;
    return {electricity: +(total - 0.3).toFixed(2), service: 0.3, enabled: true, weight: h === 10 ? 50 : h === 14 ? 50 : 0, verified: h >= 15 && h <= 19};
  })
};
export const clone = x => JSON.parse(JSON.stringify(x));
const DAY = 86400000;
export const timeToMinute = s => { const [h,m] = String(s).split(':').map(Number); return h*60+m; };
export const minuteToTime = m => {const n=Math.round(m);return `${String(Math.floor(n/60)).padStart(2,'0')}:${String(n%60).padStart(2,'0')}`;};
export const money = n => Number.isFinite(n) ? new Intl.NumberFormat('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2}).format(n) : '—';
export function calendar(s) {
  const a = Date.parse(s.start+'T00:00:00Z'), b = Date.parse(s.end+'T00:00:00Z');
  if (!Number.isFinite(a+b) || b<a) return {valid:false,error:'结束日期应不早于开始日期。'};
  const days = Math.round((b-a)/DAY)+1;
  if(days>3660) return {valid:false,error:'请将计算区间控制在 10 年内。'};
  let weekdays=0, weekends=0;
  for(let t=a;t<=b;t+=DAY){ const d=new Date(t).getUTCDay(); d===0||d===6?weekends++:weekdays++; }
  const weekdayKm=weekdays*s.weekdayKm*s.completion/100;
  const weekendKm=weekends*s.weekendKm/2*s.completion/100;
  const km=weekdayKm+weekendKm;
  return {valid:true,days,weekdays,weekends,weekdayKm,weekendKm,km,energy:km*s.consumption/100};
}
export function availability(s) {
  const mask=new Uint8Array(1440);
  for(const w of s.windows){
    const start=timeToMinute(w.start), end=timeToMinute(w.end);
    if(!Number.isFinite(start+end)||end<=start) continue;
    for(let m=Math.max(0,start);m<Math.min(1440,end);m++) if(s.tariffs[Math.floor(m/60)].enabled) mask[m]=1;
  }
  const intervals=[]; let start=-1;
  for(let m=0;m<=1440;m++) { if(mask[m]&&start<0) start=m; if(!mask[m]&&start>=0){intervals.push([start,m]);start=-1;} }
  return {mask,intervals,minutes:mask.reduce((a,b)=>a+b,0)};
}
function segmentsFor(start,end,s) {
  const slots=[];
  while(start<end-1e-8){const hour=Math.floor(start/60), stop=Math.min(end,(hour+1)*60);slots.push({hour,energy:(stop-start)*s.power/60});start=stop;}
  return slots;
}
function costOf(segments,s){
  return segments.reduce((a,v)=>{a.electricity+=v.energy*s.tariffs[v.hour].electricity;a.service+=v.energy*s.tariffs[v.hour].service;return a;},{electricity:0,service:0});
}
function bestSession(intervals,energy,s) {
  const duration=energy/s.power*60;
  let best=null;
  for(const [a,b] of intervals) {
    if(b-a+1e-8<duration)continue;
    // Minute-level starts, with exact fractional final-minute metering.
    const starts=new Set([a,b-duration]);
    for(let t=Math.ceil(a);t<=b-duration+1e-8;t++) starts.add(t);
    for(const start of starts){
      const end=start+duration, slots=segmentsFor(start,end,s), cost=costOf(slots,s), total=cost.electricity+cost.service;
      if(!best||total<best.total-1e-8||Math.abs(total-best.total)<1e-8&&start<best.start) best={start,end,slots,...cost,total,energy};
    }
  }
  return best;
}
function removeInterval(intervals,start,end){
  return intervals.flatMap(([a,b])=>end<=a+1e-8||start>=b-1e-8?[[a,b]]:[...(start>a+1e-8?[[a,start]]:[]),...(end<b-1e-8?[[end,b]]:[])]);
}
function smartSchedule(energy,s,days,available) {
  const daily=Array.from({length:days},()=>available.intervals.map(x=>[...x]));
  const sessions=[],cache=new Map();let remaining=energy;
  while(remaining>1e-7) {
    // Prefer the requested charge size; split only when no remaining window fits.
    const maxMinutes=Math.max(0,...daily.flatMap(v=>v.map(([a,b])=>b-a)));
    if(maxMinutes<1e-8)break;
    const target=Math.min(s.batch,remaining,maxMinutes*s.power/60);
    let best=null;
    for(let d=0;d<daily.length;d++){
      const key=JSON.stringify([daily[d],target]);
      if(!cache.has(key))cache.set(key,bestSession(daily[d],target,s));
      const candidate=cache.get(key);
      if(candidate&&(!best||candidate.total<best.total-1e-8))best={...candidate,day:d};
    }
    if(!best)break;
    sessions.push(best);daily[best.day]=removeInterval(daily[best.day],best.start,best.end);remaining-=best.energy;
    if(sessions.length>20000)break;
  }
  return {sessions,remaining:Math.max(0,remaining)};
}
function customSchedule(energy,s,days,available) {
  const weights=s.tariffs.map((t,h)=>t.enabled&&available.intervals.some(([a,b])=>Math.min(b,(h+1)*60)>Math.max(a,h*60))?t.weight:0);
  const sum=weights.reduce((a,b)=>a+b,0);
  if(sum<=0) return {sessions:[],remaining:energy,error:'请为允许充电的小时设置大于 0 的电量占比。'};
  const pieces=[];let remaining=0;
  for(let h=0;h<24;h++) {
    let need=energy*weights[h]/sum;
    const windows=available.intervals.map(([a,b])=>[Math.max(a,h*60),Math.min(b,(h+1)*60)]).filter(([a,b])=>b>a);
    for(let d=0;d<days&&need>1e-7;d++)for(const [a,b] of windows){
      const qty=Math.min(need,(b-a)*s.power/60); if(qty<=1e-8)continue;
      pieces.push({day:d,start:a,end:a+qty/s.power*60});need-=qty;
    }
    remaining+=Math.max(0,need);
  }
  pieces.sort((a,b)=>a.day-b.day||a.start-b.start);
  const merged=[];
  for(const p of pieces){const prev=merged.at(-1);if(prev&&prev.day===p.day&&Math.abs(prev.end-p.start)<1e-7)prev.end=p.end;else merged.push({...p});}
  const sessions=[];
  for(const p of merged){let start=p.start;while(start<p.end-1e-7){const end=Math.min(p.end,start+s.batch/s.power*60);const slots=segmentsFor(start,end,s),cost=costOf(slots,s);sessions.push({day:p.day,start,end,slots,...cost,total:cost.electricity+cost.service,energy:(end-start)*s.power/60});start=end;}}
  return {sessions,remaining};
}
export function publicCharging(energy,s,days=3660) {
  const available=availability(s);
  if(energy<=1e-8)return {feasible:true,sessions:[],count:0,electricity:0,service:0,parking:0,time:0,cash:0,economic:0,avg:0,hours:Array(24).fill(0),energy:0,charged:0,remaining:0,totalMinutes:0,available};
  if(s.power<=0||s.batch<=0) return {feasible:false,error:'充电功率和每次充电量必须大于 0。',sessions:[],remaining:energy,available};
  const plan=s.mode==='custom'?customSchedule(energy,s,days,available):smartSchedule(energy,s,days,available);
  const hours=Array(24).fill(0);let electricity=0,service=0,parking=0,totalMinutes=0;
  for(const session of plan.sessions){
    electricity+=session.electricity;service+=session.service;
    // Parking covers charging plus the independently entered additional visit time.
    const visitMinutes=s.extraMinutes+s.distance/40;
    parking+=Math.max(0,session.end-session.start+visitMinutes-s.freeMinutes)/60*s.parkingRate;
    totalMinutes+=visitMinutes;
    for(const slot of session.slots)hours[slot.hour]+=slot.energy;
  }
  const charged=hours.reduce((a,b)=>a+b,0),time=totalMinutes/60*s.timeValue,cash=electricity+service+parking;
  const feasible=plan.remaining<1e-6&&!plan.error;
  return {...plan,feasible,count:plan.sessions.length,electricity,service,parking,time,cash,economic:cash+time,avg:charged>0?(electricity+service)/charged:0,hours,energy,charged,totalMinutes,available,
    error:plan.error||(!feasible?'可用窗口或所选小时容量不足，无法在租期内完成全部充电。':null)};
}
export function homeCharging(energy,s){const fixed=s.equipment+s.installation,electricity=energy*s.homePrice,cash=fixed+electricity;return {fixed,electricity,service:0,parking:0,time:0,salvage:s.salvage,cash,economic:cash-s.salvage};}
export function calculate(s){const driving=calendar(s);if(!driving.valid)return {valid:false,error:driving.error};const home=homeCharging(driving.energy,s),pub=publicCharging(driving.energy,s,driving.days);return {valid:true,driving,home,pub};}
export function breakEven(s,pub,basis='economic') {
  if(!pub.feasible||pub.charged<=0) return null;
  // Extrapolate the observed session mix including per-visit parking and time.
  const variable=(basis==='cash'?pub.cash:pub.economic)/pub.charged;
  const fixed=s.equipment+s.installation-(basis==='economic'?s.salvage:0);
  if(fixed<=0)return {energy:0,km:0,variable};
  if(variable<=s.homePrice+1e-8)return null;
  const energy=fixed/(variable-s.homePrice);
  return {energy,km:energy/s.consumption*100,variable};
}
