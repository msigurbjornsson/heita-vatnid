import {PLANS,PLAN_SOURCE,VERIFIED_ON,planCost,summarizePlan} from './electricity-plans.js';
const $=id=>document.getElementById(id);
let chosen='hs-night',snapshot,number;
try{const saved=localStorage.getItem('electric-plan');if(PLANS.some(p=>p.id===saved))chosen=saved;}catch{}
export const selectedPlan=()=>PLANS.find(p=>p.id===chosen);
export const selectedDayCost=day=>planCost(selectedPlan(),day)?.total??null;
export function initializePlanComparison(refresh){
 const select=$('electric-plan-select');
 for(const supplier of [...new Set(PLANS.map(p=>p.supplier))]){
  const group=document.createElement('optgroup');group.label=supplier;
  for(const p of PLANS.filter(p=>p.supplier===supplier)){const option=document.createElement('option');option.value=p.id;option.textContent=p.label+(p.rate!=null?' · '+p.rate.toFixed(2).replace('.',',')+' kr./kWh':'');group.append(option);}select.append(group);
 }
 select.value=chosen;
 select.onchange=()=>{chosen=select.value;try{localStorage.setItem('electric-plan',chosen);}catch{}refresh();};
 $('electric-plan-period').onchange=()=>snapshot&&renderPlanComparison(snapshot,number);
}
export function renderPlanComparison(data,nf){
 snapshot=data;number=nf;
 const plan=selectedPlan(),daily=data?.electricity?.daily||[],period=$('electric-plan-period').value;
 const candidates=period==='yesterday'?daily.slice(1,2):daily.slice(0,Number(period));
 const days=candidates.filter(d=>Number.isFinite(d.energy_kwh));
 const cost=summarizePlan(plan,days),money=v=>v==null?'—':'≈ '+nf(v,2)+' kr.';
 $('electric-selected-heading').textContent=plan.supplier+' · '+plan.label+' (kr.)';
 $('electric-plan-total').textContent=money(cost?.total);
 $('electric-plan-supplier').textContent=money(cost?.supplier);
 $('electric-plan-distribution').textContent=money(cost?.distribution);
 $('electric-plan-difference').textContent=cost?.saving==null?'Samanburður bíður gagna':money(Math.abs(cost.saving))+(cost.saving>=0?' ódýrara':' dýrara')+' en núverandi næturleið Straumlindar';
 $('electric-plan-note').textContent=(plan.rate!=null?nf(plan.rate,2)+' kr./kWh. ':'')+plan.note;
 $('electric-plan-scope').textContent=`${days.length} af ${candidates.length} dögum með mæligögnum · ${nf(days.reduce((s,d)=>s+d.energy_kwh,0),3)} kWh. Dagurinn í dag er ólokinn. Tölur ná aðeins yfir skráð tímabil; engin uppreikningur í heilan mánuð.`;
 const rows=PLANS.map(p=>({plan:p,cost:summarizePlan(p,days)})).sort((a,b)=>(a.cost?.total??Infinity)-(b.cost?.total??Infinity));
 $('electric-plan-ranking').replaceChildren(...rows.map(({plan:p,cost:c})=>{
  const tr=document.createElement('tr');if(p.id===chosen)tr.className='selected-plan';
  const cell=document.createElement('td'),button=document.createElement('button');button.className='plan-choice';button.textContent=p.supplier+' · '+p.label;button.setAttribute('aria-pressed',String(p.id===chosen));button.onclick=()=>{const select=$('electric-plan-select');select.value=p.id;select.dispatchEvent(new Event('change'));};cell.append(button);tr.append(cell);
  for(const text of [money(c?.supplier),money(c?.distribution),money(c?.total),c?.saving==null?'—':(c.saving<0?'−':'+')+nf(Math.abs(c.saving),2)+' kr.',p.note||'Fast einingaverð']){const td=document.createElement('td');td.textContent=text;tr.append(td);}return tr;
 }));
 $('electric-plan-source').href=PLAN_SOURCE;
 $('electric-plan-source').textContent='Verð frá Aurbjörgu · skoðað '+VERIFIED_ON;
}
