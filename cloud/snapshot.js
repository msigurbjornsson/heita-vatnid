import catalog from '../veitur_tariffs.json' with {type:'json'};
import { priceElectricity } from './electricity-cost.js';
const windows=[1,5,15,30,60,180,360,720,1440,2880,10080];
const ranges={'1h':[1,60],'3h':[5,36],'6h':[15,24],'12h':[30,24],'24h':[60,24],'7d':[360,28]};
const stamp=t=>new Date(t*1000).toISOString();
function lower(a,v){let l=0,h=a.length;while(l<h){const m=(l+h)>>1;if(a[m]<v)l=m+1;else h=m;}return l;}
function upper(a,v){let l=0,h=a.length;while(l<h){const m=(l+h)>>1;if(a[m]<=v)l=m+1;else h=m;}return l;}
export class CounterHistory {
 constructor(rows,poll=60){this.points=new Map(rows.filter(r=>r.water_observed&&r.hot_water_m3!=null).map(r=>[Date.parse(r.timestamp)/1000,r.hot_water_m3]));this.times=[...this.points.keys()].sort((a,b)=>a-b);this.cadence=new Map(rows.map(r=>[Date.parse(r.timestamp)/1000,r.poll_interval_seconds||poll]));this.gap=2.5*poll;this.tolerance=1.5*poll;this.resets=[0];for(let i=1;i<this.times.length;i++)this.resets.push(this.resets[i-1]+Number(this.points.get(this.times[i])<this.points.get(this.times[i-1])));}
 boundary(t,gapOnly=false){const i=upper(this.times,t)-1;if(i<0)return null;const left=this.times[i],value=this.points.get(left);if(left===t)return {time:left,value,index:i,estimated:false};const right=this.times[i+1];if(right!=null&&right-left>2.5*this.cadence.get(left)){const next=this.points.get(right);if(next<value)return {reset:true};return {time:t,value:value+(t-left)/(right-left)*(next-value),index:i,estimated:true};}if(!gapOnly&&t-left<=1.5*this.cadence.get(left))return {time:left,value,index:i,estimated:false};return null;}
 difference(a,b){const r={volume_m3:null,average_m3h:null,from:null,to:null,duration_seconds:null,status:'insufficient',samples:0,estimated:false};if(a?.reset||b?.reset)return {...r,status:'reset'};if(!a||!b||b.time<=a.time)return r;Object.assign(r,{from:stamp(a.time),to:stamp(b.time),duration_seconds:b.time-a.time,samples:upper(this.times,b.time)-lower(this.times,a.time)});if(this.resets[a.index]!==this.resets[b.index])return {...r,status:'reset'};const volume=b.value-a.value,estimated=a.estimated||b.estimated;return {...r,volume_m3:Math.round(volume*1e6)/1e6,average_m3h:volume*3600/r.duration_seconds,estimated,status:estimated?'estimated':'measured'};}
 window(minutes,end){return {minutes,...(end==null?{}:{end:stamp(end)}),...this.difference(end==null?null:this.boundary(end-minutes*60),end==null?null:this.boundary(end))};}
 day(date){const start=Date.parse(date+'T00:00:00Z')/1000,end=start+86400,a=lower(this.times,start),b=lower(this.times,end);const first=this.boundary(start,true)||(a<b?this.boundary(this.times[a]):null),last=this.boundary(end,true)||(a<b?this.boundary(this.times[b-1]):null);const r=this.difference(first,last);return {...r,date,samples:b-a,reset:r.status==='reset'};}
 gaps(){return this.times.slice(1).flatMap((t,i)=>t-this.times[i]>2.5*this.cadence.get(this.times[i])?[this.difference(this.boundary(this.times[i]),this.boundary(t))]:[]);}
}
export function buildSnapshot(rows,count,now=Date.now()) {
 const history=new CounterHistory(rows),anchor=history.times.at(-1),gaps=history.gaps(),price=catalog.tariffs.H1.price_per_m3_isk;
 const cost=r=>({...r,usage_cost_isk:r.volume_m3==null?null:Math.round(r.volume_m3*price*100)/100});
 const daily=Array.from({length:14},(_,i)=>cost(history.day(new Date(now-i*86400000).toISOString().slice(0,10))));
 const usage={as_of:anchor==null?null:stamp(anchor),intervals:windows.map(m=>cost(history.window(m,anchor))),series:{},trends:{},gaps:gaps.slice(-20),gap_count:gaps.length,gap_threshold_seconds:history.gap};
 for(const m of windows.slice(0,9))usage.series[m]=Array.from({length:24},(_,i)=>cost(history.window(m,anchor==null?null:anchor-(23-i)*m*60)));
 for(const [k,[m,n]] of Object.entries(ranges))usage.trends[k]={interval_minutes:m,total:cost(history.window(m*n,anchor)),points:Array.from({length:n},(_,i)=>cost(history.window(m,anchor==null?null:anchor-(n-1-i)*m*60)))};
 const latest=rows.length?{...rows.at(-1)}:null;
 // Preserve last known fields while explicitly marking a missing water observation.
 if(latest)for(const key of ['hot_water_m3','flow_m3h','temp_supply_c','temp_return_c','energy_wh','mbus_timestamp'])if(latest[key]==null){for(let i=rows.length-2;i>=0;i--)if(rows[i][key]!=null){latest[key]=rows[i][key];break;}}
 let seven=history.difference(null,null);if(daily.slice(0,7).every(d=>d.volume_m3!=null))seven=history.difference(history.boundary(Date.parse(daily[6].from)/1000),history.boundary(Date.parse(daily[0].to)/1000));
 const heating=latest&&['flow_m3h','temp_supply_c','temp_return_c'].every(k=>latest[k]!=null)?latest.flow_m3h*1000*4.186*(latest.temp_supply_c-latest.temp_return_c)/3600:null;
 const detail=buildDetails(rows,now);
 const fresh=latest&&now-Date.parse(latest.timestamp)<180000;
 return {mode:'live',...detail,latest,daily,water_usage:usage,pricing:{...catalog,tariff_code:'H1',tariff_label:catalog.tariffs.H1.label,price_per_m3_isk:price,basis:'veitur',meter_class:null,fixed_per_day_isk:null,fixed_rates:Object.entries(catalog.meter_classes).map(([cls,size])=>({class:cls,size,per_day_isk:catalog.tariffs.H1.fixed_per_day_isk[cls]}))},usage_quality:{today_estimated:daily[0].estimated,yesterday_estimated:daily[1].estimated,seven_days_estimated:seven.estimated},summary:{today_m3:daily[0].volume_m3,yesterday_m3:daily[1].volume_m3,seven_days_m3:seven.volume_m3,heating_kw:heating,current_cost_per_hour_isk:latest?.flow_m3h==null?null:latest.flow_m3h*price,today_cost_isk:daily[0].usage_cost_isk,yesterday_cost_isk:daily[1].usage_cost_isk,seven_days_cost_isk:seven.volume_m3==null?null:seven.volume_m3*price},health:{connected:!!fresh,last_success:latest?.timestamp??null,error:fresh?null:'Bíður eftir nýjum lestri frá UCG-Fiber.'},reading_count:count,poll_interval_seconds:latest?.poll_interval_seconds||60,upload_interval_seconds:latest?.upload_interval_seconds||60};
}

function buildDetails(rows,now) {
 const electricityRows=rows.filter(r=>r.elec_import_kwh!=null).map(r=>({...r,water_observed:true,hot_water_m3:r.elec_import_kwh}));
 const h=new CounterHistory(electricityRows),anchor=h.times.at(-1);
 const convert=r=>{const {volume_m3,average_m3h,...rest}=r;return {...rest,energy_kwh:volume_m3,average_kw:average_m3h};};
 const daily=Array.from({length:14},(_,i)=>convert(h.day(new Date(now-i*86400000).toISOString().slice(0,10))));
 const intervals=windows.map(m=>convert(h.window(m,anchor)));
 const trends={};
 for(const [k,[m,n]] of Object.entries(ranges))trends[k]={interval_minutes:m,total:convert(h.window(m*n,anchor)),points:Array.from({length:n},(_,i)=>convert(h.window(m,anchor==null?null:anchor-(n-1-i)*m*60)))};
 const end=rows.length?Date.parse(rows.at(-1).timestamp):now;
 const samples={};
 for(const [key,hours] of Object.entries({'1h':1,'6h':6,'24h':24,'7d':168})) {
  const candidates=rows.filter(r=>Date.parse(r.timestamp)>=end-hours*3600000);
  // Retain a real observed sample per display bucket; never invent sensor values.
  const bins=new Map(),width=hours*3600000/300;let segment=0,previous=null;
  for(const r of candidates){if(previous&&(Date.parse(r.timestamp)-Date.parse(previous.timestamp))/1000>2.5*(previous.poll_interval_seconds||60))segment++;bins.set(segment+':'+Math.floor(Date.parse(r.timestamp)/width),{...r,segment_id:segment});previous=r;}
  samples[key]=[...bins.values()].map(r=>({timestamp:r.timestamp,segment_id:r.segment_id,power_kw:r.power_w==null?null:r.power_w/1000,flow_lh:r.water_observed&&r.flow_m3h!=null?r.flow_m3h*1000:null,supply_c:r.water_observed?r.temp_supply_c:null,return_c:r.water_observed?r.temp_return_c:null,heating_kw:r.water_observed&&[r.flow_m3h,r.temp_supply_c,r.temp_return_c].every(v=>v!=null)?r.flow_m3h*1000*4.186*(r.temp_supply_c-r.temp_return_c)/3600:null,poll_interval_seconds:r.poll_interval_seconds||60}));
 }
 const today=new Date(now).toISOString().slice(0,10),todayRows=rows.filter(r=>r.timestamp.slice(0,10)===today&&r.power_w!=null);
 const peak=todayRows.reduce((best,r)=>!best||r.power_w>best.power_w?r:best,null);
 const first=rows[0]?.timestamp??null;
 return {electricity:priceElectricity({daily,intervals,trends,peak_today_w:peak?.power_w??null,peak_today_timestamp:peak?.timestamp??null,as_of:anchor==null?null:stamp(anchor)},rows,now),sensor_history:samples,data_quality:{first_reading:first,last_upload:rows.at(-1)?.received_at??null,samples_today:rows.filter(r=>r.timestamp.slice(0,10)===today).length,water_samples_today:rows.filter(r=>r.timestamp.slice(0,10)===today&&r.water_observed).length}};
}
