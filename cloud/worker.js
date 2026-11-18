import {refreshDashboard,readMaterialized,readMaterializedWire,decorateSnapshot} from './materialized.js';
const json=(body,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const numeric=['hot_water_m3','flow_m3h','temp_supply_c','temp_return_c','energy_wh','elec_import_kwh','elec_export_kwh','power_w'];
export function validateItem(item) {
  if(!item || typeof item.source_id!=='string' || typeof item.collector_id!=='string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(item.source_id) || !/^[a-zA-Z0-9_-]{1,50}$/.test(item.collector_id))throw Error('Invalid identifier');
  const r=item.reading;
  if(!r || typeof r.timestamp!=='string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(r.timestamp) || !Number.isFinite(Date.parse(r.timestamp)))throw Error('Invalid timestamp');
  if(Date.parse(r.timestamp)>Date.now()+300000)throw Error('Future timestamp');
  const result={timestamp:new Date(r.timestamp).toISOString(),water_observed:!!r.water_observed};
  for(const key of numeric){const v=r[key]??null;if(v!==null && (typeof v!=='number'||!Number.isFinite(v)||v<0||v>1e12))throw Error('Invalid value');result[key]=v;}
  for(const key of ['voltages','currents']){const a=r[key];if(!Array.isArray(a)||a.length!==3||a.some(v=>v!==null&&(typeof v!=='number'||!Number.isFinite(v)||v<0||v>1e6)))throw Error('Invalid phases');result[key]=a;}
  if(r.phase_power_w!=null){if(!Array.isArray(r.phase_power_w)||r.phase_power_w.length!==3||r.phase_power_w.some(v=>v!==null&&(typeof v!=='number'||!Number.isFinite(v)||v<0||v>1e7)))throw Error('Invalid phase power');result.phase_power_w=r.phase_power_w;}
  for(const key of ['poll_interval_seconds','upload_interval_seconds'])if(r[key]!=null){if(!Number.isFinite(r[key])||r[key]<10||r[key]>86400)throw Error('Invalid cadence');result[key]=r[key];}
  for(const key of ['mbus_timestamp','meter_timestamp']){if(r[key]!=null&&(typeof r[key]!=='string'||r[key].length>40))throw Error('Invalid capture');result[key]=r[key]??null;}
  if(result.water_observed && result.hot_water_m3===null)throw Error('Missing observed volume');
  return {...item,reading:result};
}
async function authorized(request,env) {
  if(!env.WRITE_TOKEN)return false;
  const encoder=new TextEncoder();
  const provided=request.headers.get('Authorization')??'';
  if(provided.length>200)return false;
  const [a,b]=await Promise.all([provided,'Bearer '+env.WRITE_TOKEN].map(s=>crypto.subtle.digest('SHA-256',encoder.encode(s))));
  return crypto.subtle.timingSafeEqual(a,b);
}
export default {
 async scheduled(event,env,ctx){
  ctx.waitUntil(refreshDashboard(env.DB).then(result=>console.log(JSON.stringify({event:'dashboard_refresh',...result}))).catch(error=>console.error(JSON.stringify({event:'dashboard_refresh_failed',message:error.message}))));
 },
 async fetch(request,env,ctx) {
  const url=new URL(request.url);

  try {
   if(url.pathname==='/ingest'){
    if(request.method!=='POST')return json({error:'Method not allowed'},405);
    if(!await authorized(request,env))return json({error:'Unauthorized'},401);
    if(Number(request.headers.get('Content-Length'))>65536)return json({error:'Too large'},413);
    const reader=request.body?.getReader();let bytes=0,chunks=[];
    if(!reader)return json({error:'Missing body'},400);
    while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>65536){await reader.cancel();return json({error:'Too large'},413);}chunks.push(value);}
    const buffer=new Uint8Array(bytes);let offset=0;for(const c of chunks){buffer.set(c,offset);offset+=c.length;}
    let items;try {items=JSON.parse(new TextDecoder().decode(buffer));if(!Array.isArray(items)||items.length<1||items.length>50)throw Error();items=items.map(validateItem);}catch{return json({error:'Invalid batch'},400);}
    const received=new Date().toISOString();
    await env.DB.batch(items.map(i=>env.DB.prepare('INSERT OR IGNORE INTO readings(source_id,collector_id,timestamp,water_observed,hot_water_m3,payload,received_at) VALUES(?,?,?,?,?,?,?)').bind(i.source_id,i.collector_id,i.reading.timestamp,Number(i.reading.water_observed),i.reading.hot_water_m3,JSON.stringify(i.reading),received)));
    return json({ack:items.map(i=>i.source_id)});
   }
   if(url.pathname==='/api/water-comparison'||url.pathname==='/api/status'){
    if(request.method!=='GET')return json({error:'Method not allowed'},405);
    const unit=url.searchParams.get('period')||'day';
    if(url.pathname==='/api/water-comparison'&&!['day','week','month'].includes(unit))return json({error:'Invalid period'},400);
    const key=url.pathname==='/api/status'?'status':'water-'+unit;
    // Canonical key shares the edge cache between the custom domain and ingestion hostname.
    const cacheKey=new Request(url.origin+'/materialized-v2/'+key);
    const cached=await caches.default.match(cacheKey);
    if(cached){const response=new Response(cached.body,cached);response.headers.set('Cache-Control','no-store');return response;}
    let wire;
    try{wire=await readMaterializedWire(env,key);}catch(error){console.warn(JSON.stringify({event:'serialized_view_unavailable',message:error.message}));}
    if(wire!==null&&wire!==undefined){
     const response=new Response(wire,{headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
     ctx.waitUntil(caches.default.put(cacheKey,new Response(wire,{headers:{'Content-Type':'application/json','Cache-Control':'public,max-age=30'}})));
     return response;
    }
    let data;
    try{data=await readMaterialized(env,key);}catch(error){console.warn(JSON.stringify({event:'cached_view_unavailable',message:error.message}));}
    if(key==='status'&&(!data||data.materialization?.complete===false)){
     const fallback=await env.ASSETS.fetch(new Request(url.origin+'/fallback/status.json'));
     if(fallback.headers.get('Content-Type')?.includes('application/json')){const saved=await fallback.json();if(!data||Date.parse(saved.latest?.timestamp)>Date.parse(data.latest?.timestamp??0))data=decorateSnapshot(saved,Date.now(),true);}
    }
    if(!data)return json({error:'Yfirlitið bíður eftir að D1-dagkvóti endurstillist og samantektir byggist upp.'},503);
    const response=json(data);
    ctx.waitUntil(caches.default.put(cacheKey,new Response(response.clone().body,{headers:{'Content-Type':'application/json','Cache-Control':'public,max-age=30'}})));
    return response;
   }
   if(url.pathname==='/api/health')return json({ok:true});
   return env.ASSETS.fetch(request);
  }catch(error){console.error(JSON.stringify({event:'request_failed',path:url.pathname,message:error.message}));return json({error:'Service temporarily unavailable'},503);}
 }
};
