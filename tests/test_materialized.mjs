import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {SQLiteD1} from './sqlite-d1.mjs';
import {refreshDashboard,readMaterialized,readMaterializedWire,decorateSnapshot,comparisonsFromDays} from '../cloud/materialized.js';
import {buildSnapshot} from '../cloud/snapshot.js';
const folder=mkdtempSync(join(tmpdir(),'p1-cache-'));
try{
 const db=new SQLiteD1(join(folder,'readings.db'));
 await db.prepare('CREATE TABLE readings(seq INTEGER PRIMARY KEY AUTOINCREMENT,payload TEXT,received_at TEXT,timestamp TEXT)').run();
 let now=Date.parse('2026-11-09T12:00:00Z');const rows=[];
 for(let i=0;i<48;i++){const timestamp=new Date(Date.parse('2026-11-07T00:00:00Z')+i*3600000).toISOString();const r={id:i+1,timestamp,water_observed:true,hot_water_m3:100+i*.1,elec_import_kwh:200+i*.2,power_w:1000,voltages:[230,230,230],currents:[0,1,1],flow_m3h:.1,temp_supply_c:78,temp_return_c:28};rows.push(r);await db.prepare('INSERT INTO readings(payload,received_at,timestamp) VALUES(?,?,?)').bind(JSON.stringify(r),timestamp,timestamp).run();}
 let result;
 for(let attempt=0;attempt<10;attempt++){result=await refreshDashboard(db,now);now+=60000;if(result.complete)break;}
 assert.equal(result.complete,true);assert.equal(result.count,48);
 let cached=await readMaterialized({DB:db},'status',now);const expected=buildSnapshot(rows,48,now);
 assert.deepEqual(cached.daily.map(d=>d.volume_m3),expected.daily.map(d=>d.volume_m3));
 assert.equal(cached.electricity.daily[1].energy_kwh,expected.electricity.daily[1].energy_kwh);
 const before=db.trace.length;
 for(let i=0;i<25;i++)assert.equal((await readMaterialized({DB:db},'status',now)).reading_count,48);
 assert.ok(db.trace.slice(before).every(sql=>sql==='SELECT payload FROM dashboard_cache WHERE cache_key=?'));
 assert.ok(!db.trace.slice(before).some(sql=>sql.includes('readings')),'Public views must never scan raw readings');
 const timestamp=new Date(now-30000).toISOString();const latest={...rows.at(-1),id:49,timestamp,hot_water_m3:110,elec_import_kwh:220};rows.push(latest);
 await db.prepare('INSERT INTO readings(payload,received_at,timestamp) VALUES(?,?,?)').bind(JSON.stringify(latest),timestamp,timestamp).run();
 result=await refreshDashboard(db,now);assert.equal(result.raw_rows_read,1);assert.equal(result.count,49);
 const stored=await db.prepare("SELECT payload FROM dashboard_cache WHERE cache_key='status'").first();
 assert.equal(await readMaterializedWire({DB:db},'status',now),stored.payload,'Fresh views must pass through byte-for-byte without rebuilding JSON');
 const stale=JSON.parse(await readMaterializedWire({DB:db},'status',now+240000));
 assert.equal(stale.health.connected,false,'Serialized delivery must still mark an offline collector');
 const tomorrow=JSON.parse(await readMaterializedWire({DB:db},'status',Date.parse('2026-11-10T08:00:00Z')));
 assert.equal(tomorrow.daily[0].date,'2026-11-10');assert.equal(tomorrow.summary.today_m3,null);
 const again=await refreshDashboard(db,now);assert.equal(again.skipped,true,'Lease prevents duplicate builders');
 result=await refreshDashboard(db,now+60000);assert.equal(result.raw_rows_read,0);assert.equal(result.count,49,'Repeated refresh cannot double count');
 // A failed derived-view transaction cannot advance the source cursor.
 const next={...latest,id:50,timestamp:new Date(now+60000).toISOString(),hot_water_m3:110.1,elec_import_kwh:220.2};
 await db.prepare('INSERT INTO readings(payload,received_at,timestamp) VALUES(?,?,?)').bind(JSON.stringify(next),next.timestamp,next.timestamp).run();
 const originalBatch=db.batch.bind(db);let fail=true;
 db.batch=async statements=>{if(fail&&statements.some(s=>s.sql.startsWith('INSERT INTO telemetry_chunks'))){fail=false;throw Error('simulated transaction failure');}return originalBatch(statements);};
 await assert.rejects(refreshDashboard(db,now+120000));
 assert.equal(JSON.parse((await db.prepare("SELECT payload FROM dashboard_cache WHERE cache_key='build-state'").first()).payload).cursor,49);
 result=await refreshDashboard(db,now+180000);assert.equal(result.count,50);
 const fallback=decorateSnapshot(buildSnapshot(rows,49,now),Date.parse('2026-11-10T08:00:00Z'),true);
 assert.equal(fallback.health.connected,false);assert.equal(fallback.daily[0].date,'2026-11-10');assert.equal(fallback.summary.today_m3,null);assert.equal(fallback.electricity.pricing.current_band,'day');
 const month=comparisonsFromDays('month',[{bucket:'2026-11-07',first_at:'2026-11-07T00:00:00Z',last_at:'2026-11-07T23:59:30Z',first_m3:100,last_m3:102,samples:10,resets:0},{bucket:'2026-11-08',first_at:'2026-11-08T00:00:00Z',last_at:'2026-11-08T23:59:30Z',first_m3:103,last_m3:105,samples:10,resets:0}],now);
 assert.equal(month.periods.at(-1).volume_m3,5,'Aggregate endpoints must preserve midnight counter changes');
 console.log('Materialized views verified against SQLite: incremental cursor, parity, single-row public reads, lease, atomic retry, calendar endpoints and truthful stale fallback.');
}finally{rmSync(folder,{recursive:true,force:true});}
