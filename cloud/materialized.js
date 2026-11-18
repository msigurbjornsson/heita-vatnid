import {buildSnapshot} from './snapshot.js';
import {calendarPeriods,buildComparisons} from './comparisons.js';
import waterTariff from '../veitur_tariffs.json' with {type:'json'};
import electricityTariff from '../electricity_tariffs.json' with {type:'json'};
import {bandAt} from './electricity-cost.js';
const DAY=86400000, PAGE=500;
export const MATERIALIZED_SCHEMA=[
 'CREATE TABLE IF NOT EXISTS dashboard_cache(cache_key TEXT PRIMARY KEY,payload TEXT NOT NULL,updated_at TEXT NOT NULL)',
 'CREATE TABLE IF NOT EXISTS telemetry_chunks(chunk_key TEXT PRIMARY KEY,payload TEXT NOT NULL)',
 'CREATE TABLE IF NOT EXISTS water_days(day TEXT PRIMARY KEY,payload TEXT NOT NULL)',
 'CREATE TABLE IF NOT EXISTS dashboard_lease(id INTEGER PRIMARY KEY,until_ms INTEGER NOT NULL)'
];
const hourKey=r=>r.timestamp.slice(0,13);
const mergeRows=(a,b)=>{const map=new Map([...a,...b].map(r=>[r.id,r]));return [...map.values()].sort((a,b)=>a.timestamp.localeCompare(b.timestamp)||a.id-b.id);};
export function summarizeWaterDay(day,rows){
 const water=rows.filter(r=>r.water_observed&&r.hot_water_m3!=null).sort((a,b)=>a.timestamp.localeCompare(b.timestamp)||a.id-b.id);
 return {bucket:day,first_at:water[0]?.timestamp??null,last_at:water.at(-1)?.timestamp??null,first_m3:water[0]?.hot_water_m3??null,last_m3:water.at(-1)?.hot_water_m3??null,samples:water.length,resets:water.slice(1).filter((r,i)=>r.hot_water_m3<water[i].hot_water_m3).length};
}
export function comparisonsFromDays(unit,days,now){
 const buckets=calendarPeriods(unit,now),summaries=[];
 for(const p of buckets){const subset=days.filter(d=>d.samples&&d.bucket>=p.key&&d.bucket<p.end.slice(0,10)).sort((a,b)=>a.bucket.localeCompare(b.bucket));if(!subset.length)continue;
  summaries.push({bucket:p.key,first_at:subset[0].first_at,last_at:subset.at(-1).last_at,first_m3:subset[0].first_m3,last_m3:subset.at(-1).last_m3,samples:subset.reduce((n,d)=>n+d.samples,0),resets:subset.reduce((n,d,i)=>n+d.resets+Number(i>0&&d.first_m3<subset[i-1].last_m3),0)});
 }
 return buildComparisons(unit,summaries,waterTariff.tariffs.H1.price_per_m3_isk,now);
}
export async function refreshDashboard(db,now=Date.now()){
 await db.batch(MATERIALIZED_SCHEMA.map(sql=>db.prepare(sql)));
 // One writer at a time; all cursor/chunk/summary changes commit atomically.
 const acquired=await db.prepare('INSERT INTO dashboard_lease(id,until_ms) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET until_ms=excluded.until_ms WHERE dashboard_lease.until_ms<=?').bind(now+120000,now).run();
 if(!acquired.meta.changes)return {skipped:true};
 try{
  const stateRow=await db.prepare("SELECT payload FROM dashboard_cache WHERE cache_key='build-state'").first();
  const state=stateRow?JSON.parse(stateRow.payload):{cursor:0,count:0};
  const next=await db.prepare('SELECT seq,payload,received_at FROM readings WHERE seq>? ORDER BY seq LIMIT ?').bind(state.cursor,PAGE).all();
  // Bound unique hours per transaction, including a sparse historical import.
  const hours=new Set(),delta=[];
  for(const record of next.results){const reading={...JSON.parse(record.payload),id:record.seq,received_at:record.received_at};const key=hourKey(reading);if(!hours.has(key)&&hours.size>=8)break;hours.add(key);delta.push(reading);}
  const cutoff=new Date(now-15*DAY).toISOString().slice(0,13);
  const chunksResult=await db.prepare('SELECT chunk_key,payload FROM telemetry_chunks WHERE chunk_key>=? OR chunk_key IN (SELECT value FROM json_each(?))').bind(cutoff,JSON.stringify([...hours])).all();
  const chunks=new Map(chunksResult.results.map(r=>[r.chunk_key,JSON.parse(r.payload)]));
  for(const key of hours)chunks.set(key,mergeRows(chunks.get(key)||[],delta.filter(r=>hourKey(r)===key)));
  const recent=[...chunks.entries()].filter(([key])=>key>=cutoff).flatMap(([,rows])=>rows).sort((a,b)=>a.timestamp.localeCompare(b.timestamp)||a.id-b.id);
  const affectedDays=[...new Set(delta.map(r=>r.timestamp.slice(0,10)))],statements=[];
  for(const key of hours)if(key>=cutoff)statements.push(db.prepare('INSERT INTO telemetry_chunks(chunk_key,payload) VALUES(?,?) ON CONFLICT(chunk_key) DO UPDATE SET payload=excluded.payload').bind(key,JSON.stringify(chunks.get(key))));
  const dayRows=await db.prepare('SELECT day,payload FROM water_days WHERE day>=?').bind(calendarPeriods('month',now)[0].key).all();
  const days=new Map(dayRows.results.map(r=>[r.day,JSON.parse(r.payload)]));
  for(const day of affectedDays){
   let rows=recent.filter(r=>r.timestamp.startsWith(day));
   // Rare backfills older than the rolling cache use the timestamp index once for that day.
   if(day<cutoff.slice(0,10)){
    const end=new Date(Date.parse(day+'T00:00:00Z')+DAY).toISOString();
    const old=await db.prepare('SELECT seq,payload,received_at FROM readings WHERE timestamp>=? AND timestamp<? ORDER BY timestamp,seq').bind(day+'T00:00:00.000Z',end).all();
    rows=old.results.map(r=>({...JSON.parse(r.payload),id:r.seq,received_at:r.received_at}));
   }
   const summary=summarizeWaterDay(day,rows);days.set(day,summary);
   statements.push(db.prepare('INSERT INTO water_days(day,payload) VALUES(?,?) ON CONFLICT(day) DO UPDATE SET payload=excluded.payload').bind(day,JSON.stringify(summary)));
  }
  const updated=new Date(now).toISOString(),cursor=delta.at(-1)?.id??state.cursor,count=state.count+delta.length;
  const complete=next.results.length<PAGE&&delta.length===next.results.length;
  const snapshot=buildSnapshot(recent,count,now);
  snapshot.materialization={generated_at:updated,complete,cursor,raw_rows_read:delta.length,chunk_rows_read:chunksResult.results.length};
  if(!complete)snapshot.health={...snapshot.health,connected:false,error:'Verið er að byggja yfirlitið úr varðveittri mælisögu. Gögnin birtast sjálfkrafa.'};
  const values=[['build-state',{cursor,count}],['status',snapshot],['status-meta',{generated_at:updated,latest_at:snapshot.latest?.timestamp,complete}],...['day','week','month'].map(unit=>['water-'+unit,comparisonsFromDays(unit,[...days.values()],now)])];
  for(const [key,value] of values)statements.push(db.prepare('INSERT INTO dashboard_cache(cache_key,payload,updated_at) VALUES(?,?,?) ON CONFLICT(cache_key) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at').bind(key,JSON.stringify(value),updated));
  statements.push(db.prepare('DELETE FROM telemetry_chunks WHERE chunk_key<?').bind(cutoff));
  statements.push(db.prepare('UPDATE dashboard_lease SET until_ms=? WHERE id=1').bind(now+55000));
  await db.batch(statements);
  return {cursor,count,complete,raw_rows_read:delta.length,chunk_rows_read:chunksResult.results.length};
 }catch(error){
  // No partial cursor advancement; a later scheduled invocation can retry the same page.
  try{await db.prepare('UPDATE dashboard_lease SET until_ms=? WHERE id=1').bind(now+55000).run();}catch{}
  throw error;
 }
}
export function decorateSnapshot(snapshot,now=Date.now(),fallback=false){
 const latest=snapshot.latest?.timestamp,fresh=latest&&now-Date.parse(latest)<180000;
 if(fallback||!fresh)snapshot.health={...snapshot.health,connected:false,error:fallback?'D1-dagkvóti er tímabundið lokaður. Sýni síðustu varðveittu gögn; nýjar sendingar eru endurreyndar sjálfkrafa.':snapshot.health?.error||'Yfirlitið bíður eftir nýjum mæligögnum. Síðustu gildi eru varðveitt.'};
 const today=new Date(now).toISOString().slice(0,10);
 if(snapshot.daily?.[0]?.date!==today){
  const old=snapshot.daily||[],electric=snapshot.electricity?.daily||[];
  const dates=Array.from({length:14},(_,i)=>new Date(now-i*DAY).toISOString().slice(0,10));
  snapshot.daily=dates.map(date=>old.find(d=>d.date===date)||{date,volume_m3:null,usage_cost_isk:null,samples:0,estimated:false});
  if(snapshot.electricity)snapshot.electricity.daily=dates.map(date=>electric.find(d=>d.date===date)||{date,energy_kwh:null,usage_cost_isk:null,samples:0});
  Object.assign(snapshot.summary,{today_m3:snapshot.daily[0].volume_m3,today_cost_isk:snapshot.daily[0].usage_cost_isk,yesterday_m3:snapshot.daily[1].volume_m3,yesterday_cost_isk:snapshot.daily[1].usage_cost_isk,seven_days_m3:null,seven_days_cost_isk:null});
 }
 if(snapshot.electricity?.pricing){const p=snapshot.electricity.pricing,band=bandAt(now);p.current_band=band;p.current_supplier_price_per_kwh_isk=band==='night'?electricityTariff.supplier.night_price_per_kwh_isk:electricityTariff.supplier.day_price_per_kwh_isk;p.current_total_price_per_kwh_isk=p.current_supplier_price_per_kwh_isk+electricityTariff.distribution.price_per_kwh_isk;}
 return snapshot;
}
export async function readMaterialized(env,key,now=Date.now()){
 const row=await env.DB.prepare('SELECT payload FROM dashboard_cache WHERE cache_key=?').bind(key).first();
 return row?key==='status'?decorateSnapshot(JSON.parse(row.payload),now):JSON.parse(row.payload):null;
}

// Serve the already serialized view without parsing the large history on every cache miss.
// Two primary-key lookups return the view and a tiny freshness record.
export async function readMaterializedWire(env,key,now=Date.now()){
 const row=await env.DB.prepare('SELECT view.payload,meta.payload AS metadata FROM dashboard_cache AS view LEFT JOIN dashboard_cache AS meta ON meta.cache_key=? WHERE view.cache_key=?').bind(key+'-meta',key).first();
 if(!row)return null;
 if(key!=='status')return row.payload;
 const meta=row.metadata?JSON.parse(row.metadata):null;
 if(!meta?.complete)return null; // Bootstrap still uses the existing truthful fallback path.
 const latest=Date.parse(meta.latest_at),generated=Date.parse(meta.generated_at);
 const fresh=now-latest<150000&&now-generated<90000;
 const sameDay=meta.generated_at?.slice(0,10)===new Date(now).toISOString().slice(0,10);
 if(fresh&&sameDay&&bandAt(generated)===bandAt(now))return row.payload;
 // An offline collector, delayed builder, midnight or tariff transition needs decoration.
 return JSON.stringify(decorateSnapshot(JSON.parse(row.payload),now));
}
