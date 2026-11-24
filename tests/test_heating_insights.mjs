import assert from 'node:assert/strict';
import { heatingInsights } from '../cloud/heating-insights.js';
const now=Date.UTC(2026,10,24,12);
function hour(day, overrides={}) {
 return Array.from({length:61},(_,i)=>{
  const timestamp=new Date(now-day*86400000-3600000+i*60000).toISOString();
  return {timestamp,mbus_timestamp:timestamp,water_observed:true,flow_m3h:.2,temp_supply_c:75,temp_return_c:30,poll_interval_seconds:60,...overrides};
 });
}
const evaluate=(current,base={},days=3)=>heatingInsights([...Array.from({length:days},(_,i)=>hour(days-i,base)).flat(),...current],now);
let h=evaluate(hour(0));
assert.equal(h.state,'ready');assert.deepEqual(h.flags,[]);assert.equal(h.reference.days,3);assert.equal(h.current.coverage,1);
h=evaluate(hour(0,{temp_return_c:70}));assert.deepEqual(h.flags,['low_delta']);
// A short shower or one unusually warm return observation must not flag.
h=evaluate(hour(0).map((r,i)=>i>50?{...r,temp_return_c:70}:r));assert.deepEqual(h.flags,[]);
h=evaluate(hour(0,{flow_m3h:0,temp_return_c:70}));assert.ok(!h.flags.includes('low_delta'));
h=evaluate(hour(0,{flow_m3h:.4}));assert.ok(h.flags.includes('flow_up'));
h=evaluate(hour(0,{flow_m3h:.09}));assert.ok(h.flags.includes('flow_down'));
h=evaluate(hour(0,{temp_supply_c:69}));assert.ok(h.flags.includes('supply_down'));
h=evaluate(hour(0,{flow_m3h:.03}),{flow_m3h:.01});assert.deepEqual(h.flags,[]);
h=evaluate(hour(0,{flow_m3h:.4}),{},2);assert.equal(h.reference,null);assert.deepEqual(h.flags,[]);
// No bridging missing water, invalid sensors, polling gaps or frozen M-Bus values.
for(const current of [hour(0).filter((_,i)=>i<20||i>40),hour(0,{water_observed:false}),hour(0,{temp_return_c:null}),hour(0,{temp_return_c:90}),hour(0,{mbus_timestamp:new Date(now-3600000).toISOString()}),hour(0,{mbus_timestamp:'invalid'}),hour(0,{flow_m3h:NaN})]) {
 h=evaluate(current);assert.notEqual(h.state,'ready');assert.deepEqual(h.flags,[]);
}
h=heatingInsights(hour(0,{temp_return_c:70}),now+300000);assert.equal(h.state,'stale');assert.deepEqual(h.flags,[]);
assert.equal(heatingInsights([],now).state,'stale');
// Raw meter timestamps without a zone are Iceland UTC, independent of browser timezone.
h=evaluate(hour(0).map(r=>({...r,mbus_timestamp:r.mbus_timestamp.replace('Z','')})));assert.equal(h.state,'ready');
console.log('Heating insights: persistence, baseline, freshness, missing sensors and gaps passed.');
// A disconnected or old cached response must never keep an active indication visible.
import { renderHeatingInsights } from '../web/heating-insights.js';
const elements=new Map();
globalThis.document={getElementById(id){if(!elements.has(id))elements.set(id,{textContent:'',hidden:false,replaceChildren(...children){this.children=children;}});return elements.get(id);},createElement(){return {append(){}};}};
const active={heating_insights:{...evaluate(hour(0,{temp_return_c:70})),current:{...h.current,to:new Date().toISOString()}}};
renderHeatingInsights(active,String,{connected:true});assert.equal(elements.get('heating-overview').hidden,false);
renderHeatingInsights(active,String,{connected:false});assert.equal(elements.get('heating-overview').hidden,true);assert.equal(elements.get('heating-flags').children.length,0);
active.heating_insights.current.to=new Date(Date.now()-300000).toISOString();
renderHeatingInsights(active,String,{connected:true});assert.equal(elements.get('heating-overview').hidden,true);
console.log('Heating UI: live indication and disconnected/stale suppression passed.');
