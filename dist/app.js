import {DEFAULTS,clone,calculate,calendar,availability,breakEven,homeSetupFees,homeSalvage,money,minuteToTime} from './engine.js?v=home-cost-v3';

const $=id=>document.getElementById(id), STORAGE='chargewise:v1';
const FOLD_STORAGE='chargewise:folded-hours:v1';
let foldedHours=new Set();
let state=clone(DEFAULTS),basis='economic',lastResult=null,renderTimer,toastTimer;
function loadFoldedHours(){try{const hours=JSON.parse(localStorage.getItem(FOLD_STORAGE));if(Array.isArray(hours))foldedHours=new Set(hours.filter(h=>Number.isInteger(h)&&h>=0&&h<24));}catch{}}
function saveFoldedHours(){try{localStorage.setItem(FOLD_STORAGE,JSON.stringify([...foldedHours]));}catch{}}
function load(){
  try{
    const saved=JSON.parse(localStorage.getItem(STORAGE));
    if([1,2,3].includes(saved?.version)){
      const next={...clone(DEFAULTS),...saved.state};
      if(saved.version===1){if(next.cableRate==null)next.cableRate=DEFAULTS.cableRate;if(next.removeCharger&&next.salvage===0)next.salvage=DEFAULTS.salvage;}
      if(saved.version<3)next.salvageMode=next.salvage===(next.removeCharger?800:0)?'auto':'manual';
      if(!next.removeCharger)next.salvage=0;
      if(validState(next))state=next;
    }
  }catch{}
}
function validState(s){
  if(!s||!Array.isArray(s.tariffs)||s.tariffs.length!==24||!Array.isArray(s.windows)||s.windows.length>12)return false;
  const numeric=['weekdayKm','weekendKm','completion','consumption','homePrice','equipment','installation','cableLength','salvage','distance','freeMinutes','parkingRate','extraMinutes','timeValue','batch','power'];
  if(numeric.some(k=>!Number.isFinite(s[k])||s[k]<0)||s.power<=0||s.batch<=0||s.consumption<=0||s.completion>150)return false;
  if(typeof s.removeCharger!=='boolean'||s.cableRate!==null&&(!Number.isFinite(s.cableRate)||s.cableRate<0))return false;
  if(!['auto','manual'].includes(s.salvageMode))return false;
  if(!['smart','custom'].includes(s.mode))return false;
  if(s.tariffs.some(t=>!['electricity','service','weight'].every(k=>Number.isFinite(t[k])&&t[k]>=0)))return false;
  if(s.windows.some(w=>!/^([01]\d|2[0-3]):[0-5]\d$/.test(w.start)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(w.end)))return false;
  return calendar(s).valid;
}
const fmt=(n,d=0)=>new Intl.NumberFormat('zh-CN',{maximumFractionDigits:d}).format(n);
const yen=n=>'¥ '+money(n);
const txt=(id,value)=>$(id).textContent=value;
function toast(message){txt('toast',message);$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,2600);}
function save(){try{localStorage.setItem(STORAGE,JSON.stringify({version:3,state}));}catch{document.body.classList.add('save-failed');const el=document.querySelector('.local-status');if(el)el.textContent='当前浏览器无法保存，仍可正常计算';}}
function syncInputs(){document.querySelectorAll('[data-key]').forEach(el=>{if(el.type==='checkbox')el.checked=state[el.dataset.key];else el.value=state[el.dataset.key]??'';});buildTariffRows();buildWindows();buildPeriodSettings();}
function syncHomeFees(){
  const salvage=homeSalvage(state);
  if(Number.isFinite(salvage)&&(state.salvageMode==='auto'||!state.removeCharger)){state.salvage=salvage;$('salvage').value=salvage;}
  $('salvage').disabled=!state.removeCharger;
  $('restore-salvage').hidden=state.salvageMode==='auto'||!state.removeCharger;
  txt('salvage-mode-note',!state.removeCharger?'不拆除：残值为 0 元。':state.salvageMode==='manual'?'已手动填写，修改租期时保留此金额。':Number.isFinite(salvage)?`按租期自动估算：${salvage===800?'不超过一年':'超过一年'}，残值 ${yen(salvage)}。`:'完成有效租期后自动估算残值。');
  const fees=homeSetupFees(state);
  txt('cable-installation',yen(fees.cableInstallation));txt('removal-cost',yen(fees.removal));
  txt('cable-note',fees.excessLength>0?`超出 ${fmt(fees.excessLength,1)} 米 × ${state.cableRate===null?'待填写单价':`${money(state.cableRate)} 元 / 米`}；前 40 米免费。`:'40 米内免费；超出部分才按安装单价计费。');
  txt('removal-note',state.removeCharger?`拆除费 = 200 元 + 5 元 / 米 × 总线路 ${fmt(state.cableLength,1)} 米；计入退租现金支出。`:'退租不拆除，拆除费为 0 元。');
}
function buildWindows(){
  $('windows-list').innerHTML=state.windows.map((w,i)=>`<div class="window-row"><span class="window-number">窗口 ${String(i+1).padStart(2,'0')}</span><input type="time" value="${w.start}" data-window="${i}" data-edge="start" aria-label="窗口 ${i+1} 开始时间"><span>—</span><input type="time" value="${w.end}" data-window="${i}" data-edge="end" aria-label="窗口 ${i+1} 结束时间"><button type="button" class="remove-window" data-remove="${i}" aria-label="删除窗口 ${i+1}">×</button></div>`).join('');
  $('add-window').disabled=state.windows.length>=12;
}
function buildPeriodSettings(){
  const option=h=>`<option value="${h}">${String(h).padStart(2,'0')}:00</option>`;
  $('period-start').innerHTML=Array.from({length:24},(_,h)=>option(h)).join('');
  $('period-end').innerHTML=Array.from({length:24},(_,h)=>option(h+1)).join('');
  $('period-start').value='15';$('period-end').value='16';syncPeriodQuote();
  $('fold-start').innerHTML=Array.from({length:24},(_,h)=>option(h)).join('');
  $('fold-end').innerHTML=Array.from({length:24},(_,h)=>option(h+1)).join('');
  $('fold-start').value='0';$('fold-end').value='9';
}
function syncPeriodQuote(){
  const start=+$('period-start').value,end=+$('period-end').value;
  const setEmpty=message=>{for(const id of ['period-electricity','period-service','period-total'])$(id).value='—';txt('period-feedback',message);};
  if(end<=start){setEmpty('结束时间应晚于开始时间；跨午夜请分成两段查看。');return;}
  const tariffs=state.tariffs.slice(start,end);
  if(tariffs.some(t=>!Number.isFinite(t.electricity+t.service)||t.electricity<0||t.service<0)){
    setEmpty('所选时段的电价尚未填写完整，请在下方电价表中完成输入。');return;
  }
  const display=values=>{
    const low=Math.min(...values),high=Math.max(...values);
    return Math.abs(high-low)<1e-8?money(low):`${money(low)}–${money(high)}`;
  };
  $('period-electricity').value=display(tariffs.map(t=>t.electricity));
  $('period-service').value=display(tariffs.map(t=>t.service));
  $('period-total').value=display(tariffs.map(t=>t.electricity+t.service));
  const varied=tariffs.some(t=>Math.abs(t.electricity-tariffs[0].electricity)>1e-8||Math.abs(t.service-tariffs[0].service)>1e-8);
  txt('period-feedback',varied?'所选区间含不同单价，显示最低–最高价格；实际费用仍按各小时实际充入电量计费，不使用区间均值。':'单价实时引用下方电价表；修改后自动更新全部计算，无需再次应用。');
}
function buildTariffRows(){
  $('tariff-rows').innerHTML=state.tariffs.map((t,h)=>`<tr id="tariff-hour-${h}" data-hour-row="${h}"><td>${String(h).padStart(2,'0')}:00–${String(h+1).padStart(2,'0')}:00</td><td><input type="number" value="${t.electricity}" min="0" max="20" step="0.01" data-hour="${h}" data-tariff="electricity" aria-label="${h}点电费单价"></td><td><input type="number" value="${t.service}" min="0" max="20" step="0.01" data-hour="${h}" data-tariff="service" aria-label="${h}点服务费单价"></td><td id="total-${h}"></td><td><input type="checkbox" ${t.enabled?'checked':''} data-hour="${h}" data-tariff="enabled" aria-label="允许${h}点充电"></td><td><input type="number" value="${t.weight}" min="0" max="100" step="1" data-hour="${h}" data-tariff="weight" aria-label="${h}点电量权重"></td><td id="share-${h}">—</td><td id="status-${h}"></td><td><button type="button" class="text-button fold-hour" data-fold-hour="${h}" aria-label="收起${h}点时段，仅隐藏显示">收起</button></td></tr>`).join('');
  renderTariffVisibility();
}
function renderTariffVisibility(){
  $('tariff-rows').querySelectorAll('.collapsed-hours-row').forEach(row=>row.remove());
  for(let h=0;h<24;h++)$(`tariff-hour-${h}`).hidden=foldedHours.has(h);
  let h=0;
  while(h<24){
    if(!foldedHours.has(h)){h++;continue;}
    const start=h;while(h<24&&foldedHours.has(h))h++;
    const row=document.createElement('tr');row.className='collapsed-hours-row';
    row.innerHTML=`<td colspan="9"><div><span>${String(start).padStart(2,'0')}:00–${String(h).padStart(2,'0')}:00 <small>已收起 ${h-start} 个时段 · 计算设置保持不变</small></span><button type="button" class="text-button" data-unfold-start="${start}" data-unfold-end="${h}" aria-label="展开${start}点到${h}点时段">展开 ↓</button></div></td>`;
    $('tariff-rows').insertBefore(row,$(`tariff-hour-${start}`));
  }
  txt('fold-summary',`显示 ${24-foldedHours.size} / 24 个时段；收起只影响显示，是否参与充电由“允许充电”和时间窗口决定。`);
}
function foldRange(start,end){
  if(end<=start){toast('请选择结束时间晚于开始时间的时段');return;}
  for(let h=start;h<end;h++){
    const row=$(`tariff-hour-${h}`);
    if([...row.querySelectorAll('input')].some(el=>!el.checkValidity()||el.type!=='checkbox'&&el.value==='')){toast('请先完整填写所选时段的价格与电量占比');return;}
  }
  for(let h=start;h<end;h++)foldedHours.add(h);
  renderTariffVisibility();saveFoldedHours();
}
function render(){
  clearTimeout(renderTimer);
  syncPeriodQuote();
  syncHomeFees();
  const invalid=[...document.querySelectorAll('input')].find(el=>!el.checkValidity()||el.type!=='checkbox'&&el.id!=='cableRate'&&el.value==='');
  let error=invalid?'请完成参数输入，并保持在输入框允许的范围内。':'';
  if(!error&&!validState(state))error='请检查日期与数值：结束日期不早于开始日期，计算区间不超过 10 年。';
  if(!error&&homeSetupFees(state).needsCableRate)error='线路超过 40 米，请填写超出部分的安装单价。';
  if(error){
    txt('error-banner',error);$('error-banner').hidden=false;lastResult=null;$('export').disabled=true;
    for(const id of ['stat-km','stat-energy','stat-days','stat-count','home-cost','home-fixed','home-unit','home-salvage','public-cost','public-unit','public-time','weighted-avg','travel-total','weekday-share','weekend-share','breakeven-km'])txt(id,'—');
    for(const id of ['home-bottom','public-bottom','cost-chart-note','breakeven-explainer','sensitivity-note'])txt(id,'');
    document.querySelectorAll('.plan-card').forEach(el=>el.classList.remove('is-winner'));
    txt('home-badge','便利之选');txt('public-badge','无需设备投入');
    for(const id of ['cost-chart','price-chart','breakeven-chart','sensitivity-chart'])$(id).innerHTML='<div class="chart-empty">完善参数后重新计算</div>';
    $('travel-donut').style.background='#edf1f7';$('detail-rows').innerHTML='';$('conclusions').innerHTML='';
    $('recommendation').textContent='参数尚未完成，暂不比较费用或推荐方案。';
    txt('schedule-error',error);$('schedule-error').hidden=false;return;
  }
  $('error-banner').hidden=true;$('export').disabled=false;
  const r=calculate(state);lastResult=r;save();
  const {driving:d,home:h,pub:p}=r;
  txt('period-label',`${state.start.replaceAll('-','.')} — ${state.end.replaceAll('-','.')}`);
  txt('stat-km',fmt(d.km));txt('stat-energy',fmt(d.energy,1));txt('stat-days',fmt(d.days));txt('stat-count',p.feasible?fmt(p.count):'—');
  txt('stat-km-note',`${state.completion}% 里程完成比例`);txt('stat-energy-note',`每百公里 ${fmt(state.consumption,1)} 度 · 已含损耗`);
  txt('stat-days-note',`${d.weekdays} 个工作日 · ${d.weekends} 个周末日`);txt('stat-count-note',p.feasible?`单次上限 ${state.batch} 度 · ${state.power} kW`:'当前公共充电安排不可行');
  txt('completion-value',`${state.completion}%`);
  document.querySelectorAll('[data-completion]').forEach(el=>el.classList.toggle('active',+el.dataset.completion===state.completion));
  document.querySelectorAll('[data-basis]').forEach(el=>el.classList.toggle('active',el.dataset.basis===basis));
  document.querySelectorAll('[data-mode]').forEach(el=>el.classList.toggle('active',el.dataset.mode===state.mode));
  document.querySelectorAll('[data-tariff="weight"]').forEach(el=>{el.disabled=state.mode!=='custom';});
  txt('walking-note',`往返步行约 ${fmt(state.distance/40,1)} 分钟（80 米 / 分钟）；每次总额外耗时 ${fmt(state.extraMinutes+state.distance/40,1)} 分钟。充电等待默认可与办公重叠。`);
  const diff=p[basis]-h[basis],winner=p.feasible?(Math.abs(diff)<.005?'tie':diff>0?'home':'public'):'home';
  txt('home-cost',money(h[basis]));txt('public-cost',p.feasible?money(p[basis]):'不可行');
  document.querySelector('.home-card').classList.toggle('is-winner',winner==='home');document.querySelector('.public-card').classList.toggle('is-winner',winner==='public');
  txt('home-badge',winner==='home'?'当前成本更低 · 便利之选':'便利之选');txt('public-badge',winner==='public'?'当前成本更低':'无需设备投入');
  txt('home-fixed',yen(h.fixed));txt('home-unit',`${money(state.homePrice)} 元`);txt('home-salvage',yen(h.salvage));
  txt('public-unit',p.feasible?`${p.avg.toFixed(3)} 元`:'—');txt('public-time',p.feasible?`${fmt(p.totalMinutes/60,1)} 小时`:'—');
  txt('home-bottom',`含退租拆除费 ${yen(h.removal)} · ${basis==='economic'?`残值抵扣 ${yen(h.salvage)}`:'残值不计入现金'}`);
  txt('public-bottom',p.feasible?(basis==='economic'?`含时间成本 ${yen(p.time)} · 现金支付 ${yen(p.cash)}`:'仅统计实际付款 · 不含时间价值'):'可用充电时段无法满足当前出行需求');
  const rec=!p.feasible?`<strong>当前公共充电安排不可行，家充可满足需求。</strong><p>${p.error||'请调整充电窗口、功率或电量占比。'} 未充足电量 ${fmt(p.remaining,1)} 度；部分充电的费用不参与推荐。</p>`:
    winner==='tie'?'<strong>当前口径下，两种方案成本基本相同。</strong><p>家充减少往返，公共快充无需一次性设备投入，可按便利性选择。</p>':`<strong>当前计划下，${winner==='home'?'家庭充电桩':'公共快充'}更经济，预计节省 ${yen(Math.abs(diff))}。</strong><p>${basis==='economic'?'已纳入停车、额外时间价值和家充期末残值。':'基于租期内实际付款，不扣除残值，不加入时间价值。'} ${state.tariffs.some((t,h)=>p.hours[h]>0&&!t.verified&&!t.edited)?'部分电量使用默认参考价，可在下方按实际价格修改。':''}</p>`;
  $('recommendation').innerHTML=`<span class="rec-icon">ϟ</span><div>${rec}</div>`;
  drawCost(r);drawTravel(d);drawPrices(p);drawBreakEven(r);drawSensitivity();renderDetails(r);renderConclusions(r);
  const windowInvalid=state.windows.some(w=>w.end<=w.start);
  const weightUnavailable=state.mode==='custom'&&state.tariffs.some((t,h)=>t.weight>0&&!p.available.mask.slice(h*60,(h+1)*60).some(Boolean));
  const notices=[];
  if(windowInvalid)notices.push('结束时间须晚于开始时间；无效窗口已忽略，跨午夜请拆成两段。');
  if(weightUnavailable)notices.push('窗口外或被禁用小时的自定义权重已忽略，其余权重自动归一化。');
  if(!p.feasible)notices.push(`${p.error} 尚缺 ${fmt(p.remaining,1)} 度，费用对比已暂停。`);
  $('schedule-error').hidden=notices.length===0;txt('schedule-error',notices.join(' '));
}
function drawCost({home:h,pub:p}){
  txt('cost-basis-label',`${basis==='cash'?'现金支出':'经济成本'} · 元`);
  const cats=[['fixed','#275de5','设备 / 安装'],['removal','#b895ce','拆除费'],['electricity','#7aa2f8','电费'],['service','#bed1fc','服务费'],['parking','#8a9aad','停车费'],...(basis==='economic'?[['time','#dce4ef','时间成本']]:[])];
  const gross=x=>cats.reduce((a,[key])=>a+(x[key]||0),0),max=Math.max(1,gross(h),p.feasible?gross(p):0);
  $('cost-chart').innerHTML=[['家庭充电',h],['公共快充',p]].map(([label,v])=>`<div class="cost-row"><span>${label}</span><div class="stacked-track">${v===p&&!p.feasible?'':cats.map(([k,c,n])=>`<span style="width:${(v[k]||0)/max*100}%;background:${c}" title="${n}：${yen(v[k]||0)}"></span>`).join('')}</div><strong>${v===p&&!p.feasible?'不可行':yen(gross(v))}</strong></div>`).join('');
  txt('cost-chart-note',basis==='economic'?`柱形展示抵扣前成本；家充另扣期末残值 ${yen(h.salvage)}，经济成本为 ${yen(h.economic)}。`:'现金只计实际付款，时间价值与预估残值不进入柱形。');
}
function drawTravel(d){
  const share=d.km?d.weekdayKm/d.km:0;
  $('travel-donut').style.background=d.km?`conic-gradient(#275de5 0 ${share*100}%,#bed1fc ${share*100}% 100%)`:'#edf1f7';
  txt('travel-total',fmt(d.km));txt('weekday-share',`${fmt(share*100,1)}%`);txt('weekend-share',`${fmt((d.km?1-share:0)*100,1)}%`);
  txt('weekday-distance',`${fmt(d.weekdayKm)} 公里 · ${d.weekdays} 天`);txt('weekend-distance',`${fmt(d.weekendKm)} 公里 · ${d.weekends} 天`);
}
function drawPrices(p){
  txt('weighted-avg',p.feasible?p.avg.toFixed(3):'—');
  const W=800,H=175,L=30,R=7,T=17,B=27,plotW=W-L-R,plotH=H-T-B,step=plotW/24,max=Math.max(1.5,...state.tariffs.map(t=>t.electricity+t.service))*1.12;
  let svg=`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="24 小时电价柱形图，蓝色表示实际分配到充电电量的小时">`;
  for(let i=0;i<4;i++){const price=max/3*i,y=T+plotH*(1-price/max);svg+=`<line x1="${L}" x2="${W-R}" y1="${y}" y2="${y}" stroke="#edf1f7" ${i?'stroke-dasharray="3 4"':''}/><text x="${L-8}" y="${y+3}" text-anchor="end" font-size="8" fill="#a0aec2">${price.toFixed(1)}</text>`;}
  state.tariffs.forEach((t,h)=>{
    const price=t.electricity+t.service,used=p.hours?.[h]||0,allowed=p.available.mask.slice(h*60,(h+1)*60).some(Boolean),height=price/max*plotH,x=L+h*step+4,y=T+plotH-height;
    const color=used>1e-8?'#2a65eb':allowed?'#c9d8f2':'#e9edf4';
    svg+=`<rect x="${x}" y="${y}" width="${step-9}" height="${Math.max(.5,height)}" rx="3" fill="${color}"><title>${h}:00–${h+1}:00 · 综合 ${price.toFixed(2)} 元/度 · ${used.toFixed(2)} 度 · ${p.charged?((used/p.charged)*100).toFixed(1):0}% · ${t.edited?'你设置的价格':t.verified?'你提供的综合价，拆分暂估':'默认参考价'}</title></rect>`;
    if(used>1e-8)svg+=`<text x="${x+(step-9)/2}" y="${y-5}" text-anchor="middle" fill="#2a65eb" font-size="7.5">${(used/p.charged*100).toFixed(0)}%</text>`;
    if(h%2===0)svg+=`<text x="${L+h*step+step/2}" y="${H-9}" text-anchor="middle" fill="#9cacc3" font-size="8">${String(h).padStart(2,'0')}:00</text>`;
    txt(`total-${h}`,money(price));txt(`share-${h}`,p.charged?`${fmt(used/p.charged*100,1)}%`:'—');
    const status=$(`status-${h}`);status.className=t.edited?'status-edited':t.verified?'status-known':'status-unconfirmed';status.textContent=t.edited?'你设置的价格':t.verified?'你提供的综合价':'默认参考价';
  });
  $('price-chart').innerHTML=svg+'</svg>';
  const used=(p.hours||[]).filter(v=>v>1e-7).length;
  txt('share-summary',`实际使用 ${used} 个小时区间`);
  let summary=state.mode==='smart'?'优先选取每次充电电费与服务费更低的连续窗口。':'按可用小时权重归一化分配，实际占比见表格。';
  if(p.sessions.length){const first=p.sessions[0],date=new Date(Date.parse(state.start+'T00:00:00Z')+first.day*86400000).toISOString().slice(0,10);summary+=` 首次安排：${date} ${minuteToTime(first.start)}–${minuteToTime(first.end)}，${fmt(first.energy,2)} 度。`;}
  if(p.charged>0)summary+=` 加权均价 = ${money(p.electricity+p.service)} 元 ÷ ${fmt(p.charged,2)} 度；不含停车和时间。`;
  txt('schedule-summary',summary);
}
function svgLines(points,{xLabel='',markIndex=-1,breakPoint=null,unit='公里'}={}){
  const W=800,H=218,L=57,R=20,T=22,B=36,pw=W-L-R,ph=H-T-B;
  if(!points.length)return '<div class="chart-empty">调整参数后查看趋势</div>';
  const xs=points.map(p=>p.x),ys=points.flatMap(p=>[p.home,p.pub]).filter(Number.isFinite),xmin=Math.min(...xs),xmax=Math.max(xmin+1,...xs),ymin=Math.min(0,...ys),ymax=Math.max(1,...ys)*1.1;
  const X=x=>L+(x-xmin)/(xmax-xmin)*pw,Y=y=>T+ph-(y-ymin)/(ymax-ymin)*ph;
  let out=`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${xLabel}变化下，家庭充电和公共快充成本趋势">`;
  for(let i=0;i<=4;i++){const v=ymin+(ymax-ymin)*i/4,y=Y(v);out+=`<line x1="${L}" x2="${W-R}" y1="${y}" y2="${y}" stroke="#edf1f7" stroke-dasharray="3 4"/><text x="${L-10}" y="${y+3}" text-anchor="end" fill="#9aabc2" font-size="8.5">${fmt(v)}</text>`;}
  out+=`<text x="${L-10}" y="10" text-anchor="end" fill="#9aabc2" font-size="8">元</text>`;
  if(markIndex>=0&&points[markIndex]){const p=points[markIndex];out+=`<line x1="${X(p.x)}" x2="${X(p.x)}" y1="${T}" y2="${T+ph}" stroke="#b6c9ec" stroke-dasharray="4 4"/><text x="${X(p.x)}" y="${T-9}" fill="#7f98bd" text-anchor="middle" font-size="8">当前计划</text>`;}
  for(const [k,color] of [['home','#275de5'],['pub','#93a4be']]){
    let drawing=false,path='';for(const p of points){if(Number.isFinite(p[k])){path+=`${drawing?'L':'M'}${X(p.x)},${Y(p[k])} `;drawing=true;}else drawing=false;}
    out+=`<path d="${path}" stroke="${color}" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
    for(const p of points)if(Number.isFinite(p[k]))out+=`<circle cx="${X(p.x)}" cy="${Y(p[k])}" r="${points.length<9?3.4:1.8}" fill="white" stroke="${color}" stroke-width="1.6"><title>${p.label||fmt(p.x)}${unit} · ${k==='home'?'家庭充电':'公共快充'} ${yen(p[k])}</title></circle>`;
  }
  const labels=points.length>9?points.filter((_,i)=>i%Math.ceil(points.length/5)===0||i===points.length-1):points;
  for(const p of labels)out+=`<text x="${X(p.x)}" y="${H-13}" text-anchor="middle" fill="#9aabc2" font-size="8.5">${p.label||fmt(p.x)}</text>`;
  if(breakPoint&&breakPoint.x<=xmax){out+=`<circle cx="${X(breakPoint.x)}" cy="${Y(breakPoint.y)}" r="5" fill="#275de5" stroke="white" stroke-width="2"/><title>回本点 ${fmt(breakPoint.x)} 公里</title>`;}
  if(xLabel)out+=`<text x="${W-R}" y="${H-1}" text-anchor="end" fill="#a0aec2" font-size="7.5">${xLabel}</text>`;
  return out+'</svg>';
}
function drawBreakEven({driving:d,home:h,pub:p}){
  const be=breakEven(state,p,basis),fixed=h.fixed+h.removal-(basis==='economic'?h.salvage:0),variable=p.feasible&&p.charged?p[basis]/p.charged:0;
  txt('breakeven-km',be?fmt(be.km):'暂不回本');txt('breakeven-unit',be?'公里':'');
  txt('breakeven-explainer',!p.feasible?'公共充电安排不可行，无法计算可比的回本点。':!d.energy?'当前没有用电需求，暂不外推回本点。':be?(be.energy===0?'设定残值已覆盖设备投入；该结论依赖残值能实现。':`约 ${fmt(be.energy,1)} 度电。${d.km>=be.km?'当前计划已超过回本点。':`距离回本还差约 ${fmt(be.km-d.km)} 公里。`}`):'当前公共单位综合成本不高于家庭电价，家充无法用后续节省覆盖净投入。');
  if(!p.feasible||!d.energy){$('breakeven-chart').innerHTML='<div class="chart-empty">需要有效的公共充电安排与用电需求</div>';return;}
  const maxKm=Math.max(1000,d.km*1.5,be?Math.min(be.km*1.3,200000):d.km*2);
  const xs=[...Array.from({length:9},(_,i)=>maxKm*i/8),d.km];if(be&&be.km<=maxKm)xs.push(be.km);xs.sort((a,b)=>a-b);
  const points=xs.map(x=>({x,home:fixed+x*state.consumption/100*state.homePrice,pub:x*state.consumption/100*variable}));
  $('breakeven-chart').innerHTML=svgLines(points,{xLabel:'累计里程 / 公里',markIndex:xs.indexOf(d.km),breakPoint:be?{x:be.km,y:fixed+be.energy*state.homePrice}:null});
}
function drawSensitivity(){
  const kind=$('sensitivity-variable').value,base=lastResult;
  if(!base?.valid)return;
  let points=[],note='',unit='';
  if(kind==='mileage'){
    points=[.4,.6,1,1.4,1.8].map(f=>{const s=clone(state);s.weekdayKm*=f;s.weekendKm*=f;const r=calculate(s);return {x:Math.round(base.driving.km*f),home:r.home[basis],pub:r.pub.feasible?r.pub[basis]:NaN,label:fmt(base.driving.km*f)};});
    note='固定租期与其他参数，模拟当前里程的 40%、60%、100%、140%、180%；公共充电次数和停车费随实际安排重算。';unit='公里';
  }else if(kind==='price'){
    points=[.6,.8,1,1.2,1.4].map(f=>{const s=clone(state);s.tariffs.forEach(t=>{t.electricity*=f;t.service*=f;});const r=calculate(s);return {x:f,home:r.home[basis],pub:r.pub.feasible?r.pub[basis]:NaN,label:Math.round(f*100)+'%'};});
    note='全部公共时段的电费与服务费同比变化，家庭电价保持当前设置；横轴为当前公共综合电价的比例。';unit='倍电价';
  }else if(kind==='duration'){
    const ds=[.5,.75,1,1.5,2].map(f=>Math.max(1,Math.min(3660,Math.round(base.driving.days*f))));
    points=[...new Set(ds)].map(days=>{const s=clone(state);s.end=new Date(Date.parse(s.start+'T00:00:00Z')+(days-1)*86400000).toISOString().slice(0,10);const r=calculate(s);return {x:days,home:r.home[basis],pub:r.pub.feasible?r.pub[basis]:NaN,label:days+' 天'};});
    note=`保持起租日期与每周出行规律，改变租期并重新统计工作日、周末和充电安排；${state.salvageMode==='auto'?'残值随租期重算：一年内 800 元，超过一年 400 元，不拆除为 0 元。':'保留手动设置的期末残值。'}`;unit='天';
  }else{
    if(!state.removeCharger){$('sensitivity-chart').innerHTML='<div class="chart-empty">勾选退租拆除后可比较不同残值</div>';txt('sensitivity-note','不拆除时，残值固定为 0 元，不计算保留充电桩的价值抵扣。');return;}
    const max=Math.max(2000,base.home.salvage*1.5,base.home.fixed*1.25),values=[0,max*.25,max*.5,max*.75,max,base.home.salvage].sort((a,b)=>a-b);
    points=[...new Set(values)].map(v=>({x:v,home:basis==='cash'?base.home.cash:base.home.cash-v,pub:base.pub.feasible?base.pub[basis]:NaN,label:fmt(v)}));
    note=basis==='cash'?'现金口径下，预估残值不会改变已支付金额，两条曲线保持不变。':'残值仅冲减家庭充电的经济成本；高残值情景需实际能够转让或保留利用才能实现。';unit='元残值';
  }
  let current=kind==='mileage'?points.findIndex(p=>Math.abs(p.x-base.driving.km)<1):kind==='price'?2:kind==='duration'?points.findIndex(p=>p.x===base.driving.days):points.findIndex(p=>p.x===state.salvage);
  $('sensitivity-chart').innerHTML=svgLines(points,{xLabel:kind==='mileage'?'行驶里程 / 公里':kind==='price'?'公共电价 / 当前比例':kind==='duration'?'使用时长 / 天':'退租残值 / 元',markIndex:current,unit});
  txt('sensitivity-note',note+' 蓝线为家充，灰线为公共快充；不可行的情景不绘制公共成本。');
}
function detailRows({home:h,pub:p}){
  const v=(k)=>p.feasible?p[k]:null;
  return [
    ['设备与基础安装',state.equipment,0,''],['超长线路安装费',h.cableInstallation,0,''],['其他额外安装费',state.installation,0,''],['退租拆除费',h.removal,0,''],
    ['充电电费',h.electricity,v('electricity'),''],['充电服务费',0,v('service'),''],['停车费',0,v('parking'),''],
    ['实际现金支出',h.cash,v('cash'),'cash-row'],['额外时间成本',0,v('time'),''],['期末残值抵扣',-h.salvage,0,''],['经济总成本',h.economic,v('economic'),'total-row']
  ];
}
function renderDetails(r){$('detail-rows').innerHTML=detailRows(r).map(([label,h,p,cls])=>`<tr class="${cls}"><td>${label}</td><td>${yen(h)}</td><td>${p===null?'不可行':yen(p)}</td></tr>`).join('');}
function renderConclusions({driving:d,home:h,pub:p}){
  const be=breakEven(state,p,basis),cheaper=!p.feasible?'公共排期需调整':Math.abs(h[basis]-p[basis])<.005?'两者成本相同':h[basis]<p[basis]?'家庭充电桩':'第三方公共快充';
  const longTerm=be&&be.variable>state.homePrice?'家庭充电桩':'取决于电价与使用规模';
  const unknownEnergy=(p.hours||[]).reduce((sum,e,hour)=>sum+(!state.tariffs[hour].verified&&!state.tariffs[hour].edited?e:0),0);
  $('conclusions').innerHTML=[
    ['01 / 当前成本最低',cheaper,!p.feasible?'请扩展允许窗口、提高功率，或调整自定义电量分配。':`${basis==='economic'?'经济成本':'现金支出'}口径下差额 ${yen(Math.abs(h[basis]-p[basis]))}。${unknownEnergy>0?`${fmt(unknownEnergy/p.charged*100,1)}% 电量使用默认参考价。`:'使用当前设置的单价计算。'}`],
    ['02 / 日常便利性最好','家庭充电桩',`按无额外往返的假设，家充更方便。公共方案${p.feasible?`需 ${p.count} 次到站，累计额外 ${fmt(p.totalMinutes/60,1)} 小时`:'尚未形成可行排期'}。`],
    ['03 / 长期节省潜力',longTerm,be?`${basis==='cash'?'现金':'经济'}口径约 ${fmt(be.km)} 公里达到交点；${basis==='economic'?'沿用当前租期残值假设。':'不计残值与时间价值。'}${d.km>=be.km?'当前用量已覆盖净投入。':'更长使用周期有利于摊薄设备投入。'}`:'当前结构下不能确认家充长期成本更低，需重新比较电价与净投入。']
  ].map(([tag,title,body])=>`<article class="conclusion-card"><span>${tag}</span><h3>${title}</h3><p>${body}</p></article>`).join('');
}
document.addEventListener('input',e=>{
  const el=e.target;
  if(el.dataset.key){state[el.dataset.key]=el.type==='checkbox'?el.checked:el.type==='date'?el.value:el.value===''?(el.id==='cableRate'?null:NaN):+el.value;if(el.dataset.key==='removeCharger')state.salvageMode='auto';if(el.dataset.key==='salvage')state.salvageMode='manual';}
  else if(el.dataset.tariff){const t=state.tariffs[+el.dataset.hour],key=el.dataset.tariff;t[key]=el.type==='checkbox'?el.checked:el.value===''?NaN:+el.value;if(key==='electricity'||key==='service')t.edited=true;}
  else if(el.dataset.window!==undefined){state.windows[+el.dataset.window][el.dataset.edge]=el.value;}
  else return;
  clearTimeout(renderTimer);renderTimer=setTimeout(render,65);
});
document.addEventListener('click',e=>{
  const fold=e.target.closest('[data-fold-hour]'),unfold=e.target.closest('[data-unfold-start]');
  if(fold){foldRange(+fold.dataset.foldHour,+fold.dataset.foldHour+1);return;}
  if(unfold){for(let h=+unfold.dataset.unfoldStart;h<+unfold.dataset.unfoldEnd;h++)foldedHours.delete(h);renderTariffVisibility();saveFoldedHours();return;}
  const basisButton=e.target.closest('[data-basis]'),modeButton=e.target.closest('[data-mode]'),preset=e.target.closest('[data-completion]'),remove=e.target.closest('[data-remove]');
  if(basisButton){basis=basisButton.dataset.basis;render();}
  if(modeButton){state.mode=modeButton.dataset.mode;render();}
  if(preset){state.completion=+preset.dataset.completion;$('completion').value=state.completion;render();}
  if(remove){state.windows.splice(+remove.dataset.remove,1);buildWindows();render();}
});
$('add-window').addEventListener('click',()=>{if(state.windows.length>=12)return;state.windows.push({start:'19:00',end:'20:00'});buildWindows();render();});
$('period-start').addEventListener('change',()=>{if(+$('period-end').value<=+$('period-start').value)$('period-end').value=String(+$('period-start').value+1);syncPeriodQuote();});
$('period-end').addEventListener('change',syncPeriodQuote);
$('edit-tariffs').addEventListener('click',()=>{$('tariff-price-table').open=true;});
$('fold-start').addEventListener('change',()=>{if(+$('fold-end').value<=+$('fold-start').value)$('fold-end').value=String(+$('fold-start').value+1);});
$('fold-selected-hours').addEventListener('click',()=>foldRange(+$('fold-start').value,+$('fold-end').value));
$('unfold-all-hours').addEventListener('click',()=>{foldedHours.clear();renderTariffVisibility();saveFoldedHours();});
$('reset').addEventListener('click',()=>{state=clone(DEFAULTS);basis='economic';foldedHours.clear();saveFoldedHours();syncInputs();render();toast('已恢复默认参数');});
$('sensitivity-variable').addEventListener('change',drawSensitivity);
$('restore-salvage').addEventListener('click',()=>{state.salvageMode='auto';render();});
$('export').addEventListener('click',()=>{
  if(!lastResult?.valid)return;
  const r=lastResult,rows=[['充电方案费用对比'],['开始日期',state.start],['结束日期',state.end],['总里程（公里）',r.driving.km],['总需求（度）',r.driving.energy],['公共方案是否可行',r.pub.feasible?'是':'否'],[],['费用项目','家庭充电桩（元）','公共快充（元）'],...detailRows(r).map(([l,h,p])=>[l,h,p===null?'不可行':p]),[],['公共安排日期','开始时间','结束时间','充电量（度）','电费（元）','服务费（元）'],...r.pub.sessions.map(s=>[new Date(Date.parse(state.start+'T00:00:00Z')+s.day*86400000).toISOString().slice(0,10),minuteToTime(s.start),minuteToTime(s.end),s.energy.toFixed(4),s.electricity.toFixed(4),s.service.toFixed(4)]),[],['说明','残值仅为预估经济价值，不代表现金退款。默认参考电价及电费/服务费拆分为情景假设。']];
  const csv='\uFEFF'+rows.map(row=>row.map(c=>'"'+String(c).replaceAll('"','""')+'"').join(',')).join('\r\n');
  const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8;'})),a=document.createElement('a');a.href=url;a.download=`充电成本对比_${state.start}_${state.end}.csv`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('费用明细及充电安排已导出');
});
load();loadFoldedHours();syncInputs();render();
