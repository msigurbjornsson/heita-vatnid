// Calendar periods use Iceland's local time (UTC), Monday-start weeks and actual month lengths.
export function calendarPeriods(unit, now=Date.now()) {
 const counts={day:14,week:8,month:6};
 if(!Object.hasOwn(counts,unit))throw Error('Invalid calendar unit');
 const current=new Date(now);current.setUTCHours(0,0,0,0);
 if(unit==='week')current.setUTCDate(current.getUTCDate()-(current.getUTCDay()+6)%7);
 if(unit==='month')current.setUTCDate(1);
 const shift=(date,offset)=>{const d=new Date(date);if(unit==='month')d.setUTCMonth(d.getUTCMonth()+offset);else d.setUTCDate(d.getUTCDate()+offset*(unit==='week'?7:1));return d;};
 return Array.from({length:counts[unit]},(_,i)=>{const start=shift(current,i-counts[unit]+1),end=shift(start,1);return {key:start.toISOString().slice(0,10),start:start.toISOString(),end:end.toISOString()};});
}
export function comparisonQuery(unit) {
 const bucket={day:"substr(timestamp,1,10)",week:"date(timestamp, '-' || ((CAST(strftime('%w',timestamp) AS INTEGER)+6)%7) || ' days')",month:"date(timestamp,'start of month')"}[unit];
 if(!bucket)throw Error('Invalid calendar unit');
 return `WITH ordered AS (
 SELECT seq,timestamp,hot_water_m3,LAG(hot_water_m3) OVER (ORDER BY timestamp,seq) AS previous_m3
 FROM readings WHERE water_observed=1 AND timestamp>=? AND timestamp<?
 ), bucketed AS (SELECT *,${bucket} AS bucket FROM ordered), totals AS (
 SELECT bucket,MIN(timestamp) AS first_at,MAX(timestamp) AS last_at,COUNT(*) AS samples,
 SUM(CASE WHEN previous_m3>hot_water_m3 THEN 1 ELSE 0 END) AS resets
 FROM bucketed GROUP BY bucket)
 SELECT t.*,
 (SELECT hot_water_m3 FROM readings WHERE water_observed=1 AND timestamp=t.first_at ORDER BY seq LIMIT 1) AS first_m3,
 (SELECT hot_water_m3 FROM readings WHERE water_observed=1 AND timestamp=t.last_at ORDER BY seq DESC LIMIT 1) AS last_m3
 FROM totals t ORDER BY bucket`;
}
export function buildComparisons(unit,summaries,price,now=Date.now()) {
 const periods=calendarPeriods(unit,now).map(p=>{
  const row=summaries.find(s=>s.bucket===p.key),closed=Date.parse(p.end)<=now;
  const valid=!!row&&row.samples>=2&&Date.parse(row.last_at)>Date.parse(row.first_at);
  const reset=!!row?.resets;
  const volume=valid&&!reset?Math.round((row.last_m3-row.first_m3)*1e6)/1e6:null;
  const startsComplete=valid&&Date.parse(row.first_at)-Date.parse(p.start)<=90000;
  const aligned=startsComplete&&Date.parse(p.end)-Date.parse(row.last_at)<=90000;
  const complete=closed&&aligned&&!reset;
  const duration=valid?(Date.parse(row.last_at)-Date.parse(row.first_at))/1000:null;
  return {...p,closed,complete,volume_m3:volume!=null&&volume>=0?volume:null,
   usage_cost_isk:volume!=null&&volume>=0&&Number.isFinite(price)?Math.round(volume*price*100)/100:null,
   from:row?.first_at??null,to:row?.last_at??null,samples:row?.samples??0,duration_seconds:duration,
   status:reset?'reset':!valid?'insufficient':!closed?(startsComplete?'ongoing':'ongoing_partial'):complete?'complete':'partial'};
 });
 // A percent comparison is available only for two consecutive, fully captured closed periods.
 let comparison=null;
 for(let i=periods.length-1;i>0;i--){const current=periods[i],previous=periods[i-1];if(current.complete&&previous.complete){comparison={current_key:current.key,previous_key:previous.key,difference_m3:Math.round((current.volume_m3-previous.volume_m3)*1e6)/1e6,percent:previous.volume_m3>0?(current.volume_m3/previous.volume_m3-1)*100:null};break;}}
 return {unit,periods,comparison,as_of:new Date(now).toISOString(),price_per_m3_isk:price,timezone:'Atlantic/Reykjavik',week_starts_on:'monday'};
}
