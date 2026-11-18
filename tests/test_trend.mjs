import assert from 'node:assert/strict';
import { summarizeTrend } from '../web/trend.js';
const points=[{volume_m3:null,average_m3h:null},{volume_m3:1,average_m3h:2,estimated:true},{volume_m3:2,average_m3h:1,estimated:false}];
const partial=summarizeTrend(points,null,227.56);
assert.equal(partial.known,2);
assert.equal(partial.count,3);
assert.equal(partial.volume,3);
assert.ok(Math.abs(partial.cost-682.68)<1e-8);
assert.equal(partial.estimated,true);
assert.equal(partial.peak.average_m3h,2);
assert.equal(partial.full,false);
const full=summarizeTrend(points,{volume_m3:3,estimated:false},227.56);
assert.equal(full.estimated,false); // The whole counter difference can be measured even when timing is estimated.
assert.equal(full.full,true);
assert.equal(summarizeTrend(points,null,null).cost,null);
assert.equal(summarizeTrend([{volume_m3:null}],null,227.56).volume,null);
assert.equal(summarizeTrend([],{volume_m3:0,estimated:false},227.56).cost,0);
console.log('Trend summaries: missing coverage, measured totals, estimates, cost and zero usage verified.');
