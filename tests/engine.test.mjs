import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DEFAULTS,clone,calendar,tariffAverage,publicCharging,calculate,homeCharging,homeSetupFees,automaticSalvage,homeSalvage,breakEven} from '../dist/engine.js';
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
test('默认费用使用家庭 0.4 元与手填公共 0.7 元，固定每次 50 度',()=>{
  const r=calculate(DEFAULTS);assert.equal(r.pub.feasible,true);near(r.pub.avg,.7);near(r.pub.charging,1225);near(r.pub.cash,1225);near(r.home.cash,2599);near(r.home.economic,1799);assert.equal(r.pub.count,35);near(r.pub.time,262.5);near(r.pub.economic,1487.5);
});

test('超时停车按分钟收费；距离、额外耗时与时间价值独立计入',()=>{
  const s=fixture({power:20,batch:40,windows:[{start:'14:00',end:'17:20'}],freeMinutes:120,parkingRate:6,distance:200,extraMinutes:10,timeValue:30});
  const r=publicCharging(40,s,1);near(r.parking,1.5);near(r.time,7.5);near(r.economic-r.cash,7.5);
  const far=publicCharging(40,{...s,distance:600},1);near(far.time,12.5);near(far.parking,2.5);
});
test('残值只冲减经济成本，不改变实际现金支付',()=>{
  const a=homeCharging(100,fixture({installation:200,salvage:500}));near(a.cash,2139);near(a.economic,1639);
});
test('回本分别使用现金与经济口径，较高公共单位成本才产生交点',()=>{
  const r=calculate(DEFAULTS),cash=breakEven(DEFAULTS,r.pub,'cash'),econ=breakEven(DEFAULTS,r.pub,'economic');
  near(cash.energy,1899/(.7-.4));near(cash.km,cash.energy*5);assert.ok(econ.km<cash.km);
  const cheap=fixture({homePrice:2});assert.equal(breakEven(cheap,r.pub),null);
  assert.equal(breakEven(fixture({salvage:1899}),r.pub).energy,0);
});

test('线路安装只对超过 40 米的部分收费，支持小数长度',()=>{
  for(const [cableLength,expected] of [[0,0],[39.9,0],[40,0],[40.1,8],[55,1200]]){
    const h=homeCharging(100,fixture({cableLength,cableRate:80,removeCharger:false}));
    near(h.cableInstallation,expected);near(h.fixed,1499+expected);near(h.cash,1539+expected);
  }
});
test('拆除按总线路长度计费，两种成本口径均包含，前期投入不包含',()=>{
  const s=fixture({cableLength:55,cableRate:80,installation:100,salvage:600});
  const h=homeCharging(100,s);near(h.removal,475);near(h.fixed,2799);near(h.cash,3314);near(h.economic,2714);
  const kept=homeCharging(100,{...s,removeCharger:false});near(kept.removal,0);near(h.cash-kept.cash,475);near(kept.salvage,600);near(h.economic-kept.economic,475);
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
  near(cash.energy,(upfront+removal)/(.7-.4));
  near(economic.energy,(upfront+removal-600)/(r.pub.economic/r.pub.charged-.4));
});

test('自动残值按首尾计天和自然周年分档，包括闰年与闰日车位起租',()=>{
  for(const [start,end,expected] of [
    ['2026-11-10','2026-11-10',800],['2026-11-10','2027-11-09',800],['2026-11-10','2027-11-10',400],
    ['2023-03-01','2024-02-29',800],['2023-03-01','2024-03-01',400],
    ['2024-02-29','2025-02-27',800],['2024-02-29','2025-02-28',400],['2026-11-10','2028-11-09',400]
  ])near(automaticSalvage(fixture({start,end})),expected);
  assert.equal(calendar(fixture({start:'2027-02-29'})).valid,false);
  assert.equal(calendar(fixture({end:'2026-02-30'})).valid,false);
  assert.ok(Number.isNaN(automaticSalvage(fixture({end:''}))));
});
test('车位租赁期变化重算自动残值；手动值不受车位租赁期或拆除选项影响',()=>{
  const short=fixture(),long={...short,end:'2027-11-10'};
  near(homeCharging(100,short).salvage,800);near(homeCharging(100,long).salvage,400);
  near(homeCharging(100,short).cash,homeCharging(100,long).cash);
  near(homeCharging(100,long).economic-homeCharging(100,short).economic,400);
  const manual=fixture({salvage:650,end:long.end});near(homeSalvage(manual),650);
  const kept={...manual,removeCharger:false};near(homeCharging(100,kept).removal,0);near(homeCharging(100,kept).salvage,650);near(homeCharging(100,kept).cash-homeCharging(100,kept).economic,650);
  near(homeSalvage({...kept,salvageMode:'auto'}),0);
});
test('回本使用与费用明细相同的残值，现金口径不受年限分档影响',()=>{
  const pub=calculate(DEFAULTS).pub,short=fixture(),long={...short,end:'2027-11-10'};
  near(breakEven(short,pub,'cash').energy,breakEven(long,pub,'cash').energy);
  near(breakEven(long,pub).energy-breakEven(short,pub).energy,400/(pub.economic/pub.charged-short.homePrice));
  const kept={...long,removeCharger:false,salvage:500,salvageMode:'manual'};
  near(breakEven(kept,pub).energy,999/(pub.economic/pub.charged-short.homePrice));
  near(breakEven(kept,pub,'cash').energy,1499/(pub.cash/pub.charged-short.homePrice));
});

test('分时参考价变化不影响费用；仅手填公共单价参与综合费用计算',()=>{
  const s=fixture();s.tariffs=Array.from({length:24},()=>({electricity:.5,service:.2}));
  near(tariffAverage(s).total,.7);const before=publicCharging(240,s);near(before.charging,168);
  s.tariffs[15].electricity=2.9;const after=publicCharging(240,s);near(tariffAverage(s).total,.8);assert.deepEqual(after,before);
  const edited=publicCharging(240,{...s,publicPrice:.9});near(edited.charging,216);near(edited.avg,.9);
  assert.equal(edited.service,undefined);assert.equal(edited.electricity,undefined);
});
test('旧时间窗口、智能模式、小时开关及权重不再影响费用',()=>{
  const a=fixture(),b=fixture({mode:'custom',windows:[]});b.tariffs.forEach(t=>{t.enabled=false;t.weight=0;});
  assert.deepEqual(publicCharging(100,a),publicCharging(100,b));
});
test('固定每次 50 度估算次数，最后一次停车按剩余电量计算',()=>{
  const s=fixture({power:20,batch:40,distance:0,extraMinutes:0,freeMinutes:60,parkingRate:6});
  const partial=publicCharging(55,s);assert.equal(partial.count,2);near(partial.parking,9);near(partial.charged,55);
  const exact=publicCharging(100,s);assert.equal(exact.count,2);near(exact.parking,18);
  assert.deepEqual(exact,publicCharging(100,{...s,batch:10}));
  const empty=publicCharging(0,s);assert.equal(empty.count,0);near(empty.cash,0);near(empty.time,0);near(empty.avg,.7);
});
test('零需求仍显示参考电价，零电价不影响次数、停车和时间成本',()=>{
  const s=fixture({publicPrice:0,power:20,freeMinutes:0});
  const r=publicCharging(40,s);near(r.charging,0);assert.equal(r.count,1);assert.ok(r.parking>0);near(r.time,7.5);
  const zero=calculate(fixture({completion:0}));near(zero.pub.cash,0);near(zero.home.cash,1899);
});

test('截图九个分时段的电费、服务费和综合价逐小时一致',()=>{
  const bands=[[0,9,.67,.26,.93],[9,11,.34,.21,.55],[11,14,.25,.30,.55],[14,15,.34,.21,.55],[15,16,.67,.26,.93],[16,17,1.01,.28,1.29],[17,20,1.15,.28,1.43],[20,22,1.01,.28,1.29],[22,24,.67,.26,.93]];
  for(const [start,end,electricity,service,total] of bands)for(let h=start;h<end;h++){
    const t=DEFAULTS.tariffs[h];near(t.electricity,electricity);near(t.service,service);near(t.electricity+t.service,total);assert.equal(t.verified,true);
  }
  near(tariffAverage(DEFAULTS).total,.9425);
});
test('手填公共单价不能为空或为负，填 0 则免费充电且不叠加参考服务费',()=>{
  for(const publicPrice of [null,undefined,NaN,-.1])assert.equal(calculate(fixture({publicPrice})).valid,false);
  const free=calculate(fixture({publicPrice:0}));assert.equal(free.valid,true);near(free.pub.charging,0);near(free.pub.cash,0);near(free.pub.economic,262.5);
});
