export const DEFAULTS = {
  start: '2026-11-10', end: '2027-02-28', weekdayKm: 50, weekendKm: 300,
  completion: 100, consumption: 20, homePrice: 0.45, equipment: 1499,
  installation: 0, cableLength: 40, cableRate: 25, removeCharger: true,
  salvage: 800, salvageMode: 'auto', distance: 200, freeMinutes: 120,
  parkingRate: 6, extraMinutes: 10, timeValue: 30, batch: 40, power: 60,
  tariffs: Array.from({length:24}, (_, h) => {
    const total = h < 7 ? 0.65 : h < 9 ? 0.85 : h < 12 ? 0.85 : h < 15 ? 0.75 : h === 15 ? 0.93 : h === 16 ? 1.29 : h < 20 ? 1.43 : h < 23 ? 1.1 : 0.65;
    return {electricity: +(total - 0.3).toFixed(2), service: 0.3, verified: h >= 15 && h <= 19};
  })
};
export const clone = x => JSON.parse(JSON.stringify(x));
const DAY = 86400000;
export const money = n => Number.isFinite(n) ? new Intl.NumberFormat('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2}).format(n) : '—';
function rentalDates(s){
  const parse=value=>{if(!/^\d{4}-\d{2}-\d{2}$/.test(value))return NaN;const time=Date.parse(value+'T00:00:00Z');return Number.isFinite(time)&&new Date(time).toISOString().slice(0,10)===value?time:NaN;};
  return [parse(s.start),parse(s.end)];
}
export function automaticSalvage(s){
  if(!(s.removeCharger??DEFAULTS.removeCharger))return 0;
  const [start,end]=rentalDates(s);
  if(!Number.isFinite(start+end)||end<start)return NaN;
  const date=new Date(start),year=date.getUTCFullYear()+1,month=date.getUTCMonth();
  const day=Math.min(date.getUTCDate(),new Date(Date.UTC(year,month+1,0)).getUTCDate());
  // Inclusive rental: the day before the anniversary completes one calendar year.
  return end<Date.UTC(year,month,day)?800:400;
}
export function homeSalvage(s){return !(s.removeCharger??DEFAULTS.removeCharger)?0:s.salvageMode==='auto'?automaticSalvage(s):s.salvage;}
export function calendar(s) {
  const [a,b]=rentalDates(s);
  if (!Number.isFinite(a+b) || b<a) return {valid:false,error:'请填写有效的起止日期，结束日期应不早于开始日期。'};
  const days = Math.round((b-a)/DAY)+1;
  if(days>3660) return {valid:false,error:'请将计算区间控制在 10 年内。'};
  let weekdays=0, weekends=0;
  for(let t=a;t<=b;t+=DAY){ const d=new Date(t).getUTCDay(); d===0||d===6?weekends++:weekdays++; }
  const weekdayKm=weekdays*s.weekdayKm*s.completion/100;
  const weekendKm=weekends*s.weekendKm/2*s.completion/100;
  const km=weekdayKm+weekendKm;
  return {valid:true,days,weekdays,weekends,weekdayKm,weekendKm,km,energy:km*s.consumption/100};
}
export function tariffAverage(s){
  const electricity=s.tariffs.reduce((sum,t)=>sum+t.electricity,0)/s.tariffs.length;
  const service=s.tariffs.reduce((sum,t)=>sum+t.service,0)/s.tariffs.length;
  return {electricity,service,total:electricity+service};
}
export function publicCharging(energy,s){
  const rates=tariffAverage(s);
  const empty={feasible:true,count:0,electricity:0,service:0,parking:0,time:0,cash:0,economic:0,avg:rates.total,energy,charged:0,totalMinutes:0};
  if(energy<=1e-8)return empty;
  if(s.power<=0||s.batch<=0)return {...empty,feasible:false,error:'充电功率和每次充电量必须大于 0。'};
  const fullCount=Math.floor(energy/s.batch),remainder=energy-fullCount*s.batch;
  const count=fullCount+(remainder>1e-8?1:0),visitMinutes=s.extraMinutes+s.distance/40;
  const parkingFor=qty=>Math.max(0,qty/s.power*60+visitMinutes-s.freeMinutes)/60*s.parkingRate;
  const parking=fullCount*parkingFor(s.batch)+(remainder>1e-8?parkingFor(remainder):0);
  const electricity=energy*rates.electricity,service=energy*rates.service,totalMinutes=count*visitMinutes;
  const time=totalMinutes/60*s.timeValue,cash=electricity+service+parking;
  return {feasible:true,count,electricity,service,parking,time,cash,economic:cash+time,avg:rates.total,energy,charged:energy,totalMinutes};
}
export function homeSetupFees(s){
  const length=s.cableLength??DEFAULTS.cableLength,excessLength=Math.max(0,length-40);
  const needsCableRate=excessLength>0&&(!Number.isFinite(s.cableRate)||s.cableRate<0);
  const cableInstallation=needsCableRate?NaN:excessLength*(s.cableRate??0);
  const removal=(s.removeCharger??DEFAULTS.removeCharger)?200+5*length:0;
  const fixed=s.equipment+s.installation+cableInstallation;
  return {excessLength,needsCableRate,cableInstallation,removal,fixed};
}
export function homeCharging(energy,s){const fees=homeSetupFees(s),electricity=energy*s.homePrice,cash=fees.fixed+fees.removal+electricity,salvage=homeSalvage(s);return {...fees,electricity,service:0,parking:0,time:0,salvage,cash,economic:cash-salvage};}
export function calculate(s){const driving=calendar(s);if(!driving.valid)return {valid:false,error:driving.error};if(homeSetupFees(s).needsCableRate)return {valid:false,error:'线路超过 40 米，请填写超出部分的安装单价。'};const home=homeCharging(driving.energy,s),pub=publicCharging(driving.energy,s);return {valid:true,driving,home,pub};}
export function breakEven(s,pub,basis='economic') {
  if(!pub.feasible||pub.charged<=0) return null;
  // Extrapolate estimated unit costs, including per-visit parking and time.
  const variable=(basis==='cash'?pub.cash:pub.economic)/pub.charged;
  const fees=homeSetupFees(s);
  if(fees.needsCableRate)return null;
  const fixed=fees.fixed+fees.removal-(basis==='economic'?homeSalvage(s):0);
  if(fixed<=0)return {energy:0,km:0,variable};
  if(variable<=s.homePrice+1e-8)return null;
  const energy=fixed/(variable-s.homePrice);
  return {energy,km:energy/s.consumption*100,variable};
}
