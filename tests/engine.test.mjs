import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DEFAULTS,clone,calendar,availability,publicCharging,calculate,homeCharging,homeSetupFees,automaticSalvage,homeSalvage,breakEven,minuteToTime} from '../dist/engine.js';
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-6,`${a} != ${b}`);
function fixture(extra={}){return {...clone(DEFAULTS),...(Object.hasOwn(extra,'salvage')?{salvageMode:'manual'}:{}),...extra};}

test('页面原生数字输入的范围和步长接受全部默认值',()=>{
  const html=readFileSync(new URL('../dist/index.html',import.meta.url),'utf8');
  for(const match of html.matchAll(/<input\b[^>]*data-key="([^"]+)"[^>]*>/g)){
    const tag=match[0],key=match[1],value=DEFAULTS[key];if(typeof value!=='number')continue;
    const get=k=>{const m=tag.match(new RegExp(`${k}="([^"]+)"`));return m?+m[1]:null;};
    const min=get('min'),max=get('max'),step=get('step');
    if(min!==null)assert.ok(value>=min,`${key} below min`);if(max!==null)assert.ok(value<=max,`${key} above max`);
    if(step!==null){const units=(value-(min??0))/step;near(units,Math.round(units));}
  }
});

test('默认日期首尾包含在内，自然周按周末每日一半计算',()=>{
  const r=calendar(DEFAULTS);assert.equal(r.days,111);assert.equal(r.weekdays+r.weekends,111);
  assert.equal(r.weekdays,79);assert.equal(r.weekends,32);near(r.weekdayKm,3950);near(r.weekendKm,4800);near(r.km,8750);near(r.energy,1750);
});
test('跨月与单个周末日不重复或漏算里程',()=>{
  const r=calendar(fixture({start:'2027-02-28',end:'2027-02-28',completion:40}));assert.equal(r.weekends,1);near(r.km,60);near(r.energy,12);
  assert.equal(calendar(fixture({start:'2027-03-01',end:'2027-02-28'})).valid,false);
});
test('默认智能充电选择允许窗口内 0.75 元时段而非算术平均价',()=>{
  const r=calculate(DEFAULTS);assert.equal(r.pub.feasible,true);near(r.pub.avg,.75);near(r.pub.cash,1312.5);near(r.home.cash,2686.5);near(r.home.economic,1886.5);assert.equal(r.pub.count,44);near(r.pub.time,330);near(r.pub.economic,1642.5);
});
test('跨小时按实际度数计费，结束分钟的部分电量精确处理',()=>{
  const s=fixture({windows:[{start:'15:40',end:'16:10'}],batch:30});
  const r=publicCharging(30,s,1);assert.equal(r.feasible,true);near(r.hours[15],20);near(r.hours[16],10);near(r.electricity+r.service,31.5);near(r.avg,1.05);
  const short=publicCharging(30.5,fixture({windows:[{start:'15:40',end:'16:11'}],batch:30.5}),1);near(short.charged,30.5);near(short.hours[15]+short.hours[16],30.5);
});
test('重叠窗口合并，禁止小时移除，容量不会重复使用',()=>{
  const s=fixture({windows:[{start:'09:20',end:'11:20'},{start:'10:00',end:'12:00'}]});s.tariffs[10].enabled=false;
  const a=availability(s);assert.deepEqual(a.intervals,[[560,600],[660,720]]);assert.equal(a.minutes,100);
  const r=publicCharging(110,s,1);assert.equal(r.feasible,false);near(r.charged,100);near(r.remaining,10);
});
test('每次充电不超过上限，且同一天安排不存在重叠',()=>{
  const s=fixture({windows:[{start:'10:00',end:'11:00'}],batch:40});
  const r=publicCharging(115,s,2);assert.equal(r.feasible,true);near(r.charged,115);
  for(const session of r.sessions){assert.ok(session.energy<=40+1e-6);assert.ok(session.start>=600);assert.ok(session.end<=660);}
  for(let i=0;i<r.sessions.length;i++)for(let j=i+1;j<r.sessions.length;j++){const a=r.sessions[i],b=r.sessions[j];if(a.day===b.day)assert.ok(a.end<=b.start+1e-6||b.end<=a.start+1e-6);}
});
test('自定义按可用小时归一化权重，忽略窗口外权重',()=>{
  const s=fixture({mode:'custom',windows:[{start:'15:00',end:'17:00'}]});s.tariffs.forEach(t=>t.weight=0);s.tariffs[15].weight=20;s.tariffs[16].weight=60;s.tariffs[3].weight=100;
  const r=publicCharging(40,s,1);assert.equal(r.feasible,true);near(r.hours[15],10);near(r.hours[16],30);near(r.avg,(10*.93+30*1.29)/40);
});
test('自定义小时容量不足不会自动转移占比或作为完整方案推荐',()=>{
  const s=fixture({mode:'custom',windows:[{start:'09:20',end:'11:20'}]});s.tariffs.forEach(t=>t.weight=0);s.tariffs[9].weight=50;s.tariffs[10].weight=50;
  const r=publicCharging(120,s,1);assert.equal(r.feasible,false);near(r.hours[9],40);near(r.hours[10],60);near(r.remaining,20);
});
test('零权重或没有窗口明确不可行，零需求保持零用电与零到站',()=>{
  const s=fixture({mode:'custom'});s.tariffs.forEach(t=>t.weight=0);assert.equal(publicCharging(10,s,1).feasible,false);
  assert.equal(publicCharging(10,fixture({windows:[]}),1).feasible,false);
  const r=calculate(fixture({completion:0}));near(r.pub.cash,0);assert.equal(r.pub.count,0);near(r.home.cash,1899);
});
test('超时停车按分钟收费；距离、额外耗时与时间价值独立计入',()=>{
  const s=fixture({power:20,batch:40,windows:[{start:'14:00',end:'17:20'}],freeMinutes:120,parkingRate:6,distance:200,extraMinutes:10,timeValue:30});
  const r=publicCharging(40,s,1);near(r.parking,1.5);near(r.time,7.5);near(r.economic-r.cash,7.5);
  const far=publicCharging(40,{...s,distance:600},1);near(far.time,12.5);near(far.parking,2.5);
});
test('残值只冲减经济成本，不改变实际现金支付',()=>{
  const a=homeCharging(100,fixture({installation:200,salvage:500}));near(a.cash,2144);near(a.economic,1644);
});
test('回本分别使用现金与经济口径，较高公共单位成本才产生交点',()=>{
  const r=calculate(DEFAULTS),cash=breakEven(DEFAULTS,r.pub,'cash'),econ=breakEven(DEFAULTS,r.pub,'economic');
  near(cash.energy,1899/(.75-.45));near(cash.km,cash.energy*5);assert.ok(econ.km<cash.km);
  const cheap=fixture({homePrice:2});assert.equal(breakEven(cheap,r.pub),null);
  assert.equal(breakEven(fixture({salvage:1899}),r.pub).energy,0);
});
test('格式化不产生 01:60 这样的非法分钟',()=>{assert.equal(minuteToTime(119.9),'02:00');assert.equal(minuteToTime(1440),'24:00');});
test('价格全为零时仍能正确分配电量和保留时间成本',()=>{
  const s=fixture();s.tariffs.forEach(t=>{t.electricity=0;t.service=0;});const r=publicCharging(40,s,1);assert.equal(r.feasible,true);near(r.cash,0);near(r.avg,0);near(r.time,7.5);
});


test('线路安装只对超过 40 米的部分收费，支持小数长度',()=>{
  for(const [cableLength,expected] of [[0,0],[39.9,0],[40,0],[40.1,8],[55,1200]]){
    const h=homeCharging(100,fixture({cableLength,cableRate:80,removeCharger:false}));
    near(h.cableInstallation,expected);near(h.fixed,1499+expected);near(h.cash,1544+expected);
  }
});
test('拆除按总线路长度计费，两种成本口径均包含，前期投入不包含',()=>{
  const s=fixture({cableLength:55,cableRate:80,installation:100,salvage:600});
  const h=homeCharging(100,s);near(h.removal,475);near(h.fixed,2799);near(h.cash,3319);near(h.economic,2719);
  const kept=homeCharging(100,{...s,removeCharger:false});near(kept.removal,0);near(h.cash-kept.cash,475);near(kept.salvage,0);near(h.economic-kept.economic,-125);
  near(homeCharging(0,{...s,cableLength:0}).removal,200);
});
test('超过免费长度但缺少单价时，暂停计算；免费范围内不需要单价',()=>{
  assert.equal(calculate(fixture({cableLength:40,cableRate:null})).valid,true);
  for(const cableRate of [null,undefined,NaN,-1]){
    const s=fixture({cableLength:41,cableRate});assert.equal(calculate(s).valid,false);
    assert.equal(homeSetupFees(s).needsCableRate,true);
    assert.equal(breakEven(s,calculate(DEFAULTS).pub),null);
  }
  const zero=calculate(fixture({cableLength:41,cableRate:0}));assert.equal(zero.valid,true);near(zero.home.cableInstallation,0);
});
test('超长安装及拆除共同计入回本成本，残值仅影响经济口径',()=>{
  const s=fixture({cableLength:60,cableRate:50,installation:100,salvage:600});
  const r=calculate(s),cash=breakEven(s,r.pub,'cash'),economic=breakEven(s,r.pub,'economic');
  const upfront=1499+1000+100,removal=500;
  near(cash.energy,(upfront+removal)/(.75-.45));
  near(economic.energy,(upfront+removal-600)/(r.pub.economic/r.pub.charged-.45));
});


test('自动残值按首尾计天和自然周年分档，包括闰年与闰日起租',()=>{
  for(const [start,end,expected] of [
    ['2026-11-10','2026-11-10',800],['2026-11-10','2027-11-09',800],['2026-11-10','2027-11-10',400],
    ['2023-03-01','2024-02-29',800],['2023-03-01','2024-03-01',400],
    ['2024-02-29','2025-02-27',800],['2024-02-29','2025-02-28',400],['2026-11-10','2028-11-09',400]
  ])near(automaticSalvage(fixture({start,end})),expected);
  assert.equal(calendar(fixture({start:'2027-02-29'})).valid,false);
  assert.equal(calendar(fixture({end:'2026-02-30'})).valid,false);
  assert.ok(Number.isNaN(automaticSalvage(fixture({end:''}))));
});
test('租期变化重算自动残值；手动值保留；不拆除时不允许产生残值抵扣',()=>{
  const short=fixture(),long={...short,end:'2027-11-10'};
  near(homeCharging(100,short).salvage,800);near(homeCharging(100,long).salvage,400);
  near(homeCharging(100,short).cash,homeCharging(100,long).cash);
  near(homeCharging(100,long).economic-homeCharging(100,short).economic,400);
  const manual=fixture({salvage:650,end:long.end});near(homeSalvage(manual),650);
  const kept={...manual,removeCharger:false};near(homeCharging(100,kept).removal,0);near(homeCharging(100,kept).salvage,0);near(homeCharging(100,kept).cash,homeCharging(100,kept).economic);
});
test('回本使用与费用明细相同的残值，现金口径不受年限分档影响',()=>{
  const pub=calculate(DEFAULTS).pub,short=fixture(),long={...short,end:'2027-11-10'};
  near(breakEven(short,pub,'cash').energy,breakEven(long,pub,'cash').energy);
  near(breakEven(long,pub).energy-breakEven(short,pub).energy,400/(pub.economic/pub.charged-short.homePrice));
  const kept={...long,removeCharger:false,salvage:9999,salvageMode:'manual'};
  near(breakEven(kept,pub).energy,1499/(pub.economic/pub.charged-short.homePrice));
});
