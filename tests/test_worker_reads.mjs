import assert from 'node:assert/strict';
import worker from '../cloud/worker.js';
import {buildSnapshot} from '../cloud/snapshot.js';
const snapshot=buildSnapshot([],0),queries=[];let puts=0;
globalThis.caches={default:{async match(){return undefined;},async put(){puts++;}}};
const ctx={waitUntil(p){return p;}};
const env={DB:{prepare(sql){queries.push(sql);assert.ok(sql.startsWith('SELECT view.payload,meta.payload AS metadata FROM dashboard_cache AS view LEFT JOIN dashboard_cache'));
 return {bind(metaKey,key){assert.equal(metaKey,key+'-meta');return {async first(){return {payload:JSON.stringify(key==='status'?snapshot:{unit:key.slice(6),periods:[]}),metadata:JSON.stringify({complete:true,generated_at:new Date().toISOString(),latest_at:new Date().toISOString()})};}};}};
}},ASSETS:{async fetch(){throw Error('unexpected asset request');}}};
for(const path of ['/api/status','/api/water-comparison?period=day','/api/water-comparison?period=week','/api/water-comparison?period=month']){
 const r=await worker.fetch(new Request('https://dashboard.example.com'+path),env,ctx);assert.equal(r.status,200);await r.json();
}
assert.equal(queries.length,4);assert.equal(puts,4);
const bad=await worker.fetch(new Request('https://dashboard.example.com/api/water-comparison?period=bad'),env,ctx);assert.equal(bad.status,400);assert.equal(queries.length,4);
const blocked={DB:{prepare(){return {bind(){return {async first(){throw Error('quota exceeded');}};}};}},ASSETS:{async fetch(){return Response.json(snapshot);}}};
const response=await worker.fetch(new Request('https://dashboard.example.com/api/status'),blocked,ctx);assert.equal(response.status,200);assert.equal((await response.json()).health.connected,false);
console.log('Worker route checks: one indexed cache-row read per public request, no raw scans, invalid period rejection and quota fallback passed.');
