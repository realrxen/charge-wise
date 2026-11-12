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
test('默认公共费用按全部 24 小时等权均价估算',()=>{
  const r=calculate(DEFAULTS);assert.equal(r.pub.feasible,true);near(r.pub.avg,.89625);near(r.pub.cash,1568.4375);near(r.home.cash,2686.5);near(r.home.economic,1886.5);assert.equal(r.pub.count,44);near(r.pub.time,330);near(r.pub.economic,1898.4375);
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
  near(cash.energy,1899/(.89625-.45));near(cash.km,cash.energy*5);assert.ok(econ.km<cash.km);
  const cheap=fixture({homePrice:2});assert.equal(breakEven(cheap,r.pub),null);
  assert.equal(breakEven(fixture({salvage:1899}),r.pub).energy,0);
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
  near(cash.energy,(upfront+removal)/(.89625-.45));
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
test('租期变化重算自动残值；手动值不受租期或拆除选项影响',()=>{
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


test('电费与服务费分别等权平均，单一小时价格变化按 1/24 计入',()=>{
  const s=fixture();s.tariffs=Array.from({length:24},()=>({electricity:.5,service:.2}));
  near(tariffAverage(s).total,.7);const before=publicCharging(240,s);near(before.electricity,120);near(before.service,48);
  s.tariffs[15].electricity=2.9;const after=publicCharging(240,s);near(after.electricity-before.electricity,24);near(after.service,before.service);near(after.avg,.8);
});
test('旧时间窗口、智能模式、小时开关及权重不再影响费用',()=>{
  const a=fixture(),b=fixture({mode:'custom',windows:[]});b.tariffs.forEach(t=>{t.enabled=false;t.weight=0;});
  assert.deepEqual(publicCharging(100,a),publicCharging(100,b));
});
test('按单次电量估算次数，最后一次停车只按剩余电量计算',()=>{
  const s=fixture({power:20,batch:40,distance:0,extraMinutes:0,freeMinutes:60,parkingRate:6});
  const partial=publicCharging(45,s);assert.equal(partial.count,2);near(partial.parking,6);near(partial.charged,45);
  const exact=publicCharging(80,s);assert.equal(exact.count,2);near(exact.parking,12);
  const empty=publicCharging(0,s);assert.equal(empty.count,0);near(empty.cash,0);near(empty.time,0);near(empty.avg,.89625);
});
test('零需求仍显示参考电价，零电价不影响次数、停车和时间成本',()=>{
  const s=fixture({power:20,batch:40,freeMinutes:0});s.tariffs.forEach(t=>{t.electricity=0;t.service=0;});
  const r=publicCharging(40,s);near(r.electricity,0);near(r.service,0);assert.equal(r.count,1);assert.ok(r.parking>0);near(r.time,7.5);
  const zero=calculate(fixture({completion:0}));near(zero.pub.cash,0);near(zero.home.cash,1899);
});
