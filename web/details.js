import {initializePlanComparison,renderPlanComparison,selectedPlan,selectedDayCost} from './plan-comparison.js';
const $=id=>document.getElementById(id);
const pages={overview:['/','Yfirsýn','Notkun, kostnaður og staðan núna.'],water:['/vatn','Heitt vatn','Rennsli, hitastig og notkun í samhengi.'],electricity:['/rafmagn','Rafmagn','Orkunotkun, aflþróun og álag eftir fösum.'],history:['/saga','Notkunarsaga','Dagleg notkun og varðveitt mælisaga.']};
let active='overview',latest=null,format=null,resizeFrame;
const numeric=v=>typeof v==='number'&&Number.isFinite(v);
const measured=(p,value,digits=2)=>`${p?.estimated&&value!=null?'≈ ':''}${format(value,digits)}`;
const months=['janúar','febrúar','mars','apríl','maí','júní','júlí','ágúst','september','október','nóvember','desember'];
const date=s=>{const d=new Date(s);return `${d.getUTCDate()}. ${months[d.getUTCMonth()]}`;};
const time=s=>s?new Date(s).toLocaleTimeString('is-IS',{timeZone:'Atlantic/Reykjavik',hour:'2-digit',minute:'2-digit',second:'2-digit'}):'—';
function routeFromLocation(){return Object.keys(pages).find(k=>pages[k][0]===location.pathname.replace(/\/$/,'')||k==='overview'&&location.pathname==='/')||({water:'water',electricity:'electricity',history:'history',overview:'overview'}[location.hash.slice(1)]??'overview');}
function showPage(key,scroll=true){
 active=pages[key]?key:'overview';
 document.querySelectorAll('[data-page]').forEach(panel=>panel.hidden=panel.dataset.page!==active);
 document.querySelectorAll('nav [data-route]').forEach(link=>{const selected=link.dataset.route===active;link.classList.toggle('active',selected);if(selected)link.setAttribute('aria-current','page');else link.removeAttribute('aria-current');});
 $('page-title').textContent=pages[active][1];$('breadcrumb-page').textContent=pages[active][1];$('page-description').textContent=pages[active][2];
 document.title=`Heita vatnið — ${pages[active][1]}`;
 if(scroll)window.scrollTo({top:0,behavior:'instant'});
 if(latest)renderDetails(latest,format);
 // Reveal charts after the panel has measurable geometry.
 window.dispatchEvent(new Event('resize'));
 window.dispatchEvent(new CustomEvent('dashboard:pagechange',{detail:active}));
}
export function initializePages(){
 initializePlanComparison(()=>latest&&renderDetails(latest,format));
 document.addEventListener('click',event=>{const link=event.target.closest('a[data-route]');if(!link||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey||event.button!==0)return;event.preventDefault();const key=link.dataset.route;history.pushState({},'',link.getAttribute('href'));showPage(key);if(location.hash)document.getElementById(location.hash.slice(1))?.scrollIntoView();});
 window.addEventListener('popstate',()=>showPage(routeFromLocation(),false));
 window.addEventListener('resize',()=>{cancelAnimationFrame(resizeFrame);resizeFrame=requestAnimationFrame(()=>latest&&renderDetails(latest,format));});
 for(const id of ['water-sensor-range','electric-sensor-range'])$(id).addEventListener('change',()=>latest&&renderDetails(latest,format));
 showPage(routeFromLocation(),false);
}
function tableRow(values){const tr=document.createElement('tr');for(const value of values){const td=document.createElement('td');td.textContent=value;tr.append(td);}return tr;}
export function makeChart(element,points,series,{unit='',height=190,intervals=false}={}){
 element.replaceChildren();
 if(!points.length||!points.some(p=>series.some(s=>numeric(p[s.key])))){const p=document.createElement('p');p.className='empty-chart';p.textContent='Mælisaga birtist þegar næg gögn hafa safnast.';element.append(p);return;}
 const width=Math.max(280,element.clientWidth||700);
 const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg');svg.setAttribute('viewBox',`0 0 ${width} ${height}`);svg.setAttribute('role','img');svg.setAttribute('aria-label',series.map(s=>s.label).join(', ')+` (${unit})`);
 const add=(tag,attributes,text,parent=svg)=>{const el=document.createElementNS(ns,tag);for(const [k,v]of Object.entries(attributes))el.setAttribute(k,v);if(text!=null)el.textContent=text;parent.append(el);return el;};
 const title=add('title',{},series.map(s=>s.label).join(' / ')+` · ${unit}`);
 const stamps=points.map(p=>Date.parse(p.timestamp||p.to||p.end));const lo=Math.min(...stamps),hi=Math.max(...stamps);const vals=points.flatMap(p=>series.map(s=>p[s.key])).filter(numeric);const max=Math.max(...vals,0.1)*1.12;const left=42,right=width-16,top=14,bottom=height-30;
 const x=t=>left+(t-lo)/Math.max(1,hi-lo)*(right-left),y=v=>bottom-v/max*(bottom-top);
 for(let i=0;i<4;i++){const v=max*i/3;add('line',{x1:left,x2:right,y1:y(v),y2:y(v),stroke:'#e5ebe7','stroke-dasharray':'3 5'});add('text',{x:left-8,y:y(v)+4,'text-anchor':'end',fill:'#7c8985','font-size':10},format(v,max>20?0:1));}
 for(const [i,t]of [lo,lo+(hi-lo)/2,hi].entries())add('text',{x:x(t),y:height-8,'text-anchor':i===0?'start':i===2?'end':'middle',fill:'#7c8985','font-size':10},`${hi-lo>86400000?date(t)+' · ':''}${new Date(t).toLocaleTimeString('is-IS',{timeZone:'Atlantic/Reykjavik',hour:'2-digit',minute:'2-digit'})}`);
 series.forEach(s=>{
  for(let i=0;i<points.length;i++){
   const p=points[i],v=p[s.key];if(!numeric(v))continue;const estimated=!!p.estimated,c=estimated?'#b38543':s.color;
   if(i>0){const prev=points[i-1],gap=(stamps[i]-stamps[i-1])/1000;if(numeric(prev[s.key])&&(intervals||(p.segment_id!=null&&p.segment_id===prev.segment_id)||(p.segment_id==null&&gap<=Math.max(150,(p.poll_interval_seconds||60)*2.5))))add('line',{x1:x(stamps[i-1]),y1:y(prev[s.key]),x2:x(stamps[i]),y2:y(v),stroke:c,'stroke-width':2,'stroke-dasharray':estimated?'5 4':'none'});}
   const dot=add('circle',{cx:x(stamps[i]),cy:y(v),r:points.length>100?1.6:2.5,fill:c});add('title',{},`${time(p.timestamp||p.to||p.end)} · ${s.label}: ${format(v,2)} ${unit}${estimated?' · ≈ Áætlað':''}`,dot);
  }
 });element.append(svg);
 const legend=document.createElement('div');legend.className='sensor-legend';series.forEach(s=>{const label=document.createElement('span');const dot=document.createElement('i');dot.style.backgroundColor=s.color;label.append(dot,document.createTextNode(s.label));legend.append(label);});element.append(legend);
}
export function renderDetails(data,nf){
 latest=data;format=nf;
 const r=data?.latest||{},s=data?.summary||{},e=data?.electricity||{},today=e.daily?.[0],yesterday=e.daily?.[1],q=data?.data_quality||{},p=data?.pricing||{};
 $('home-water-today').textContent=measured({estimated:data?.usage_quality?.today_estimated},s.today_m3,3);
 $('home-electric-today').textContent=measured(today,today?.energy_kwh);
 $('home-electric-cost').textContent=today?.usage_cost_isk==null?'—':'≈ '+nf(today.usage_cost_isk,2);
 const hs=today?.hs_orka;
 $('home-hs-cost').textContent=hs?.usage_cost_isk==null?'—':'≈ '+nf(hs.usage_cost_isk,2);
 const hsDifference=hs?.saving_isk==null?'Bíður eftir mælisögu':`≈ ${nf(Math.abs(hs.saving_isk),2)} kr. ${hs.saving_isk>=0?'ódýrara':'dýrara'} með HS orku`;
 $('home-hs-saving').textContent=hsDifference+' · með dreifingu';
 $('electric-hs-today').textContent=hs?.usage_cost_isk==null?'—':'≈ '+nf(hs.usage_cost_isk,2);
 $('electric-hs-saving').textContent=hsDifference;
 $('home-electric-cost-context').textContent=e.pricing?'Næturleið · Veitur A1D óstaðfest':'Bíður eftir verðviðmiði';
 $('home-cost-today').textContent=measured({estimated:data?.usage_quality?.today_estimated},s.today_cost_isk);
 $('home-water-context').textContent=s.yesterday_m3==null?'Samanburður við gærdag bíður gagna':`Í gær: ${nf(s.yesterday_m3,3)} m³ · skráð tímabil`;
 $('home-electric-context').textContent=yesterday?.energy_kwh==null?'Samanburður við gærdag bíður gagna':`Í gær: ${measured(yesterday,yesterday.energy_kwh)} kWh · skráð tímabil`;
 $('home-cost-context').textContent=p.price_per_m3_isk==null?'Einingaverð vantar':`${nf(p.price_per_m3_isk,2)} kr./m³ · án fastra gjalda`;
 $('cadence-read').textContent=`${data?.poll_interval_seconds||60} sek.`;$('cadence-upload').textContent=`${data?.upload_interval_seconds||60} sek.`;
 $('samples-today').textContent=nf(q.samples_today??null,0);$('last-upload').textContent=time(q.last_upload);
 $('home-quality').textContent=r.water_observed===false||r.water_observed===0?'Vatnsgögn vantar í síðasta lestri; síðustu þekktu gildi eru sýnd.':q.first_reading?`Mælisaga frá ${date(q.first_reading)}. Tímabil utan sögunnar eru óþekkt.`:'Bíður eftir mælisögu.';
 if(active==='overview'){
  makeChart($('home-water-chart'),data?.water_usage?.trends?.['6h']?.points||[],[{key:'average_m3h',label:'Meðalrennsli',color:'#286556'}],{unit:'m³/klst.',intervals:true});
  makeChart($('home-electric-chart'),e.trends?.['6h']?.points||[],[{key:'average_kw',label:'Meðalafl',color:'#bd7e40'}],{unit:'kW',intervals:true});
 }
 $('water-detail-flow').textContent=nf(r.flow_m3h==null?null:r.flow_m3h*1000,0);$('water-detail-temperatures').textContent=`${nf(r.temp_supply_c,1)} / ${nf(r.temp_return_c,1)}`;
 $('water-detail-delta').textContent=nf(r.temp_supply_c==null||r.temp_return_c==null?null:r.temp_supply_c-r.temp_return_c,1);$('water-detail-heating').textContent=nf(s.heating_kw,2);
 $('water-detail-capture').textContent=r.mbus_timestamp?`Vatnsmæling kl. ${r.mbus_timestamp.slice(11,19)}`:'Tímastimpil vatnsmælis vantar';
 if(active==='water'){
  const points=data?.sensor_history?.[$('water-sensor-range').value]||[];
  makeChart($('water-temperature-chart'),points,[{key:'supply_c',label:'Framrás',color:'#bd7e40'},{key:'return_c',label:'Bakrás',color:'#3d8194'}],{unit:'°C'});
  makeChart($('water-flow-chart'),points,[{key:'flow_lh',label:'Rennsli',color:'#286556'}],{unit:'L/klst.'});
  $('water-sensor-rows').replaceChildren(...points.slice().reverse().map(p=>tableRow([`${date(p.timestamp)} · ${time(p.timestamp)}`,nf(p.flow_lh,0),nf(p.supply_c,1),nf(p.return_c,1),nf(p.heating_kw,2)])));
 }
 $('electric-detail-power').textContent=nf(r.power_w==null?null:r.power_w/1000,2);$('electric-detail-today').textContent=measured(today,today?.energy_kwh);$('electric-detail-yesterday').textContent=measured(yesterday,yesterday?.energy_kwh);
 $('electric-detail-quality').textContent=today?.estimated?'≈ Skipting yfir lestrarrof':'Frá fyrsta lestri dagsins';$('electric-yesterday-quality').textContent=yesterday?.energy_kwh==null?'Næg mælisaga vantar':yesterday.estimated?'≈ Skipting yfir lestrarrof':'Frá fyrsta til síðasta lesturs';
 $('electric-detail-peak').textContent=nf(e.peak_today_w==null?null:e.peak_today_w/1000,2);$('electric-peak-time').textContent=e.peak_today_timestamp?`Kl. ${time(e.peak_today_timestamp)} · hæsti varðveitti lestur`:'Bíður eftir rafmagnsmælingu';
 renderElectricPricing(e,r,nf);
 renderPlanComparison(data,nf);
 $('electric-export-total').textContent=nf(r.elec_export_kwh,3);$('phase-capture').textContent=`Rafmagnslestur kl. ${time(r.timestamp)}`;
 if(active==='electricity'){
  const points=data?.sensor_history?.[$('electric-sensor-range').value]||[];
  $('electric-sensor-rows').replaceChildren(...points.slice().reverse().map(p=>tableRow([`${date(p.timestamp)} · ${time(p.timestamp)}`,nf(p.power_kw,3)])));
  makeChart($('electric-power-chart'),data?.sensor_history?.[$('electric-sensor-range').value]||[],[{key:'power_kw',label:'Augnabliksafl',color:'#bd7e40'}],{unit:'kW',height:240});
  $('phase-detail-cards').replaceChildren(...[0,1,2].map(i=>{const card=document.createElement('article');card.className='phase-detail';const title=document.createElement('h3');title.textContent=`Fasi ${i+1}`;const power=document.createElement('strong');power.textContent=`${nf(r.phase_power_w?.[i]==null?null:r.phase_power_w[i]/1000,2)} kW`;const dl=document.createElement('dl');for(const [label,value]of [['Spenna',`${nf(r.voltages?.[i],1)} V`],['Straumur',`${nf(r.currents?.[i],1)} A`]]){const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=label;dd.textContent=value;dl.append(dt,dd);}const track=document.createElement('div');track.className='phase-track';const bar=document.createElement('i');const total=r.phase_power_w?.reduce((a,v)=>a+(v||0),0);bar.style.width=`${total?Math.min(100,(r.phase_power_w[i]||0)/total*100):0}%`;track.append(bar);card.append(title,power,dl,track);return card;}));
  $('electric-windows').replaceChildren(...(e.intervals||[]).map(p=>{const card=document.createElement('article');card.className='usage-window'+(p.estimated?' estimated':'');const title=document.createElement('h3');title.textContent=p.minutes<60?`${p.minutes} mín.`:p.minutes<1440?`${p.minutes/60} klst.`:p.minutes===1440?'24 klst.':`${p.minutes/1440} dagar`;const value=document.createElement('strong');value.textContent=measured(p,p.energy_kwh,3);const unit=document.createElement('small');unit.textContent='kWh';const caption=document.createElement('p');caption.textContent=p.energy_kwh==null?p.status==='reset'?'Mælir bakfærður':'Næg mælisaga vantar':`${nf(p.average_kw,2)} kW að meðaltali${p.estimated?' · ≈ Áætlað':''}`;const cost=document.createElement('p');cost.className='interval-cost';cost.textContent=p.usage_cost_isk==null?'— kr.':`≈ ${nf(p.usage_cost_isk,2)} kr. · m.v. A1D`;card.append(title,value,unit,caption,cost);return card;}));
  $('electric-daily-rows').replaceChildren(...(e.daily||[]).map(p=>tableRow([date(p.date+'T12:00:00Z'),measured(p,p.energy_kwh,3),nf(p.day_kwh,3),nf(p.night_kwh,3),p.usage_cost_isk==null?'—':'≈ '+nf(p.usage_cost_isk,2),p.hs_orka?.usage_cost_isk==null?'—':'≈ '+nf(p.hs_orka.usage_cost_isk,2),selectedDayCost(p)==null?'—':'≈ '+nf(selectedDayCost(p),2),nf(p.average_kw,2),nf(p.samples,0),p.energy_kwh==null?p.status==='reset'?'Mælir bakfærður':'Næg mælisaga vantar':p.estimated?'≈ Áætlað yfir rof':'Mismunur mælisstaða'])));
 }
}

function renderElectricPricing(e,r,nf){
 const p=e.pricing,day=e.daily?.[0];
 $('electric-pricing').hidden=!p;
 if(!p){$('electric-now-cost').textContent='';return;}
 const money=v=>v==null?'—':'≈ '+nf(v,2),s=p.supplier,d=p.distribution;
 $('electric-current-rate').textContent=`${nf(p.current_total_price_per_kwh_isk,2)} kr./kWh núna`;
 $('electric-current-band').textContent=p.current_band==='night'?'Næturverð · kl. 23–07':'Dagverð · kl. 07–23';
 $('electric-day-rate').textContent=`${nf(s.day_price_per_kwh_isk+d.price_per_kwh_isk,2)} kr./kWh`;
 $('electric-night-rate').textContent=`${nf(s.night_price_per_kwh_isk+d.price_per_kwh_isk,2)} kr./kWh`;
 $('electric-day-breakdown').textContent=`Straumlind ${nf(s.day_price_per_kwh_isk,2)} + Veitur ${nf(d.price_per_kwh_isk,2)}`;
 $('electric-night-breakdown').textContent=`Straumlind ${nf(s.night_price_per_kwh_isk,2)} + Veitur ${nf(d.price_per_kwh_isk,2)}`;
 $('electric-cost-today').textContent=money(day?.usage_cost_isk);
 $('electric-supplier-today').textContent=day?.supplier_cost_isk==null?'—':`${day.cost_estimated?'≈ ':''}${nf(day.supplier_cost_isk,2)}`;
 $('electric-distribution-today').textContent=money(day?.distribution_cost_isk);
 $('electric-night-saving').textContent=day?.night_saving_isk==null?'—':`${day.cost_estimated?'≈ ':''}${nf(day.night_saving_isk,2)}`;
 $('electric-day-kwh').textContent=`${day?.cost_estimated?'≈ ':''}${nf(day?.day_kwh,3)} kWh`;
 $('electric-night-kwh').textContent=`${day?.cost_estimated?'≈ ':''}${nf(day?.night_kwh,3)} kWh`;
 $('electric-night-share').textContent=day?.energy_kwh>0?`${nf(day.night_kwh/day.energy_kwh*100,1)}%`:'—';
 $('electric-fixed-note').textContent=`Fast gjald Veitna samkvæmt A1D: ${nf(d.fixed_per_day_isk,2)} kr./dag. Sýnt sér og ekki lagt við tölurnar hér að ofan.`;
 $('electric-price-verified').textContent=`Verð staðfest ${p.verified_on}`;
 $('electric-now-cost').textContent=r.power_w==null?'':`≈ ${nf(r.power_w/1000*p.current_total_price_per_kwh_isk,2)} kr./klst. · m.v. A1D`;
}
