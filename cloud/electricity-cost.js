import tariff from '../electricity_tariffs.json' with {type:'json'};
const HOUR=3600000,DAY=24*HOUR;
export function bandAt(epoch){const hour=new Date(epoch).getUTCHours();return hour>=tariff.supplier.night_start_hour||hour<tariff.supplier.day_start_hour?'night':'day';}
export function splitDuration(start,end){
 let day=0,night=0,t=start;
 while(t<end){const midnight=Math.floor(t/DAY)*DAY,hour=new Date(t).getUTCHours();const next=hour<7?midnight+7*HOUR:hour<23?midnight+23*HOUR:midnight+DAY+7*HOUR;const stop=Math.min(next,end);if(bandAt(t)==='night')night+=stop-t;else day+=stop-t;t=stop;}
 return {day,night};
}
export class ElectricityCostHistory {
 constructor(rows){
  const map=new Map(rows.filter(r=>Number.isFinite(r.elec_import_kwh)).map(r=>[Date.parse(r.timestamp),r.elec_import_kwh]));
  this.times=[...map.keys()].sort((a,b)=>a-b);this.values=this.times.map(t=>map.get(t));this.prefix=[{day:0,night:0,crossings:0}];
  for(let i=1;i<this.times.length;i++){const start=this.times[i-1],end=this.times[i],delta=this.values[i]-this.values[i-1],parts=splitDuration(start,end),previous=this.prefix[i-1];this.prefix.push({day:previous.day+Math.max(0,delta)*parts.day/(end-start),night:previous.night+Math.max(0,delta)*parts.night/(end-start),crossings:previous.crossings+Number(parts.day>0&&parts.night>0&&delta>0)});}
 }
 at(t){
  let lo=0,hi=this.times.length;while(lo<hi){const m=(lo+hi)>>1;if(this.times[m]<=t)lo=m+1;else hi=m;}const i=lo-1;
  if(i<0||t>this.times.at(-1))return null;
  if(t===this.times[i])return {...this.prefix[i],index:i,interpolated:false};
  const end=this.times[i+1],delta=this.values[i+1]-this.values[i];if(end==null||delta<0)return null;
  const parts=splitDuration(this.times[i],t),all=splitDuration(this.times[i],end),base=this.prefix[i];
  return {day:base.day+delta*parts.day/(end-this.times[i]),night:base.night+delta*parts.night/(end-this.times[i]),crossings:base.crossings+Number(all.day>0&&all.night>0&&delta>0),index:i,interpolated:true};
 }
 price(period){
  const none={day_kwh:null,night_kwh:null,supplier_cost_isk:null,distribution_cost_isk:null,usage_cost_isk:null,night_saving_isk:null,cost_estimated:false};
  if(period.energy_kwh==null||!period.from||!period.to||period.status==='reset')return {...period,...none};
  const a=this.at(Date.parse(period.from)),b=this.at(Date.parse(period.to));if(!a||!b)return {...period,...none};
  let day=Math.max(0,b.day-a.day),night=Math.max(0,b.night-a.night);
  // Reconcile floating-point allocation with the same counter total used by the dashboard.
  const total=day+night;if(total>0){day*=period.energy_kwh/total;night*=period.energy_kwh/total;}
  const supplier=day*tariff.supplier.day_price_per_kwh_isk+night*tariff.supplier.night_price_per_kwh_isk;
  const distribution=period.energy_kwh*tariff.distribution.price_per_kwh_isk;
  return {...period,day_kwh:day,night_kwh:night,supplier_cost_isk:supplier,distribution_cost_isk:distribution,usage_cost_isk:supplier+distribution,night_saving_isk:night*(tariff.supplier.day_price_per_kwh_isk-tariff.supplier.night_price_per_kwh_isk),cost_estimated:!!period.estimated||a.interpolated||b.interpolated||b.crossings>a.crossings};
 }
}
// User-supplied comparison, not a verified supplier tariff. Distribution stays payable.
export function hsOrkaScenario(period,history){
 const none={supplier_cost_isk:null,distribution_cost_isk:null,usage_cost_isk:null,saving_isk:null,night_kwh:null};
 if(period.energy_kwh==null||!period.from||!period.to||period.status==='reset')return none;
 const midnight=Date.parse(period.from.slice(0,10)+'T00:00:00Z');
 const start=Math.max(Date.parse(period.from),midnight+HOUR),end=Math.min(Date.parse(period.to),midnight+6*HOUR);
 const valueAt=t=>{
  let lo=0,hi=history.times.length;while(lo<hi){const m=(lo+hi)>>1;if(history.times[m]<=t)lo=m+1;else hi=m;}
  const i=lo-1;if(i<0)return null;if(history.times[i]===t)return history.values[i];
  if(i+1>=history.times.length||history.values[i+1]<history.values[i])return null;
  return history.values[i]+(history.values[i+1]-history.values[i])*(t-history.times[i])/(history.times[i+1]-history.times[i]);
 };
 let night=0;
 if(end>start){const a=valueAt(start),b=valueAt(end);if(a==null||b==null||b<a)return none;night=b-a;}
 night=Math.min(period.energy_kwh,Math.max(0,night));
 const supplier=(period.energy_kwh-night)*12.18,distribution=period.distribution_cost_isk;
 if(distribution==null)return none;
 return {supplier_cost_isk:supplier,distribution_cost_isk:distribution,usage_cost_isk:supplier+distribution,saving_isk:period.usage_cost_isk-(supplier+distribution),night_kwh:night,estimated:true};
}
export function priceElectricity(electricity,rows,now=Date.now()){
 const history=new ElectricityCostHistory(rows),band=bandAt(now),supplierRate=band==='night'?tariff.supplier.night_price_per_kwh_isk:tariff.supplier.day_price_per_kwh_isk;
 return {...electricity,daily:electricity.daily.map(p=>{const priced=history.price(p);return {...priced,hs_orka:hsOrkaScenario(priced,history)};}),intervals:electricity.intervals.map(p=>history.price(p)),trends:Object.fromEntries(Object.entries(electricity.trends).map(([k,v])=>[k,{...v,total:history.price(v.total),points:v.points.map(p=>history.price(p))}])),pricing:{...tariff,current_band:band,current_supplier_price_per_kwh_isk:supplierRate,current_total_price_per_kwh_isk:supplierRate+tariff.distribution.price_per_kwh_isk}};
}
