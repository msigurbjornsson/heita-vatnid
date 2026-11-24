const HOUR = 3600000;
const numeric = value => typeof value === 'number' && Number.isFinite(value);
export const heatingThresholds = Object.freeze({delta_c:10,flow_lh:100,change_fraction:0.5,supply_drop_c:5,coverage:0.9});

// Raw observations only: a missing or stale M-Bus sample breaks coverage.
export function heatingInsights(rows, now = Date.now()) {
 const windows = Array.from({length:8}, (_,day) => ({from:now-day*24*HOUR-HOUR,to:now-day*24*HOUR,covered:0,low:0,flow:0,supply:0,delta:0}));
 let previous = null;
 for (const row of rows) {
  const t = Date.parse(row.timestamp);
  const capture = row.mbus_timestamp ? Date.parse(/(?:Z|[+-]\d\d:\d\d)$/.test(row.mbus_timestamp)?row.mbus_timestamp:row.mbus_timestamp+'Z') : NaN;
  const valid = !!row.water_observed && numeric(row.flow_m3h) && row.flow_m3h >= 0 && numeric(row.temp_supply_c) && numeric(row.temp_return_c) && row.temp_supply_c >= row.temp_return_c && Number.isFinite(t) && t-capture>=-5000 && t-capture<=180000;
  if (valid && previous) {
   const gap = t-previous.t;
   if (gap>0 && gap<=Math.min(180000,2.5*(previous.row.poll_interval_seconds||60)*1000)) {
    for (const w of windows) {
     const duration = Math.max(0,Math.min(t,w.to)-Math.max(previous.t,w.from));
     if (!duration) continue;
     const flow = previous.row.flow_m3h*1000, delta = previous.row.temp_supply_c-previous.row.temp_return_c;
     w.covered+=duration;w.flow+=flow*duration;w.supply+=previous.row.temp_supply_c*duration;w.delta+=delta*duration;
     if (flow>=heatingThresholds.flow_lh && delta<heatingThresholds.delta_c) w.low+=duration;
    }
   }
  }
  previous = valid ? {t,row} : null;
 }
 const summarize = w => ({from:new Date(w.from).toISOString(),to:new Date(w.to).toISOString(),coverage:w.covered/HOUR,flow_lh:w.covered?w.flow/w.covered:null,supply_c:w.covered?w.supply/w.covered:null,delta_c:w.covered?w.delta/w.covered:null});
 const current = summarize(windows[0]);
 const baseline = windows.slice(1).filter(w=>w.covered/HOUR>=heatingThresholds.coverage).map(summarize);
 const median = values => {const sorted=values.sort((a,b)=>a-b),m=Math.floor(sorted.length/2);return sorted.length%2?sorted[m]:(sorted[m-1]+sorted[m])/2;};
 const reference = baseline.length>=3 ? {days:baseline.length,flow_lh:median(baseline.map(w=>w.flow_lh)),supply_c:median(baseline.map(w=>w.supply_c))} : null;
 const fresh = previous && now-previous.t>=0 && now-previous.t<=180000;
 const ready = !!fresh && current.coverage>=heatingThresholds.coverage;
 const flags=[];
 if (ready) {
  if (windows[0].low/HOUR>=0.9) flags.push('low_delta');
  if (reference) {
   // Avoid large percentage changes around zero flow.
   if (reference.flow_lh>=100 && current.flow_lh<=reference.flow_lh*0.5) flags.push('flow_down');
   if (current.flow_lh>=100 && current.flow_lh>=reference.flow_lh*1.5 && current.flow_lh-reference.flow_lh>=50) flags.push('flow_up');
   if (current.flow_lh>=20 && current.supply_c<=reference.supply_c-heatingThresholds.supply_drop_c) flags.push('supply_down');
  }
 }
 return {state:!fresh?'stale':!ready?'insufficient':'ready',flags,current,reference,thresholds:heatingThresholds};
}
