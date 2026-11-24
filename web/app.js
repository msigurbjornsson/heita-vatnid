import { renderHeatingInsights } from './heating-insights.js';
import { createWaterComparison } from './comparison.js';
import { initializePages, renderDetails } from './details.js';
import { createTrendChart } from './trend.js';
const $ = id => document.getElementById(id);
const onComputer = ['localhost', '127.0.0.1'].includes(location.hostname);
const local = true; // Both Cloudflare and the local server provide the live API.
let snapshot = null, days = 14, toastTimer, imported = false;
let stream = null, serverReachable = false, streamState = 'connecting', refreshPending = false, pendingFrontendVersion = null;
const loadedFrontendVersion = document.querySelector('meta[name="frontend-version"]')?.content;
let restoredView = null;
try { restoredView = JSON.parse(sessionStorage.getItem('p1-live-view')); sessionStorage.removeItem('p1-live-view'); } catch {}
const nf = (v, digits = 1) => typeof v === 'number' && Number.isFinite(v) ? new Intl.NumberFormat('en-US', {minimumFractionDigits: digits, maximumFractionDigits: digits}).formatToParts(v).map(p=>p.type==='group'?'.':p.type==='decimal'?',':p.value).join('') : '—';
const measuredNumber = (value, estimated, digits=3) => `${estimated && value!=null?'≈ ':''}${nf(value,digits)}`;
const time = v => v && !Number.isNaN(Date.parse(v)) ? new Date(v).toLocaleTimeString('is-IS', {hour:'2-digit', minute:'2-digit', second:'2-digit'}) : '—';
function toast(message) { $('toast').textContent = message; $('toast').classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').classList.remove('visible'), 4500); }
const months = ['janúar','febrúar','mars','apríl','maí','júní','júlí','ágúst','september','október','nóvember','desember'];
const dateLabel = date => `${date.getDate()}. ${months[date.getMonth()]}`;
$('date').textContent = `${dateLabel(new Date())} ${new Date().getFullYear()}`;
const trendChart=createTrendChart({nf,stampLabel});
const comparison=createWaterComparison({nf,stampLabel});
function render() {
  const data = snapshot, r = data?.latest || {}, s = data?.summary || {}, quality = data?.usage_quality || {};
  $('date').textContent = `${dateLabel(new Date())} ${new Date().getFullYear()}`;
  $('volume').textContent = nf(r.hot_water_m3, 3);
  $('today').textContent = measuredNumber(s.today_m3,quality.today_estimated); $('yesterday').textContent = measuredNumber(s.yesterday_m3,quality.yesterday_estimated); $('seven').textContent = measuredNumber(s.seven_days_m3,quality.seven_days_estimated);
  $('litres').textContent = s.today_m3 == null ? 'Vantar tvo lestra í dag' : `${nf(s.today_m3 * 1000, 0)} lítrar · ${quality.today_estimated?'áætluð skipting yfir rof':'frá fyrsta lestri dagsins'}`;
  $('yesterday-quality').textContent=quality.yesterday_estimated?'≈ Áætluð skipting yfir lestrarrof':'Mismunur fyrsta og síðasta lesturs';
  $('cost').textContent = s.seven_days_cost_isk != null ? `${measuredNumber(s.seven_days_cost_isk,quality.seven_days_estimated,2)} kr. · notkunarkostnaður` : s.seven_days_m3 == null ? 'Vantar gögn fyrir heila viku' : 'Mismunur fyrsta og síðasta lesturs';
  $('flow-m3h').textContent = nf(r.flow_m3h, 3);
  $('flow').textContent = nf(r.flow_m3h == null ? null : r.flow_m3h * 1000, 0);
  $('flow-bar').style.width = `${Math.max(0, Math.min(100, (r.flow_m3h || 0) * 100))}%`;
  if($('now-price-today'))$('now-price-today').textContent=measuredNumber(s.today_cost_isk,quality.today_estimated,2);
  if($('now-price-hour'))$('now-price-hour').textContent = nf(s.current_cost_per_hour_isk,2);
  if($('now-price-note'))$('now-price-note').textContent=data?.pricing?.price_per_m3_isk!=null?`${nf(data.pricing.price_per_m3_isk,2)} kr./m³ · án fastra gjalda`:'Kostnaðarviðmið ekki stillt';
  $('now-capture').textContent=r.mbus_timestamp?`Vatnsmæling kl. ${r.mbus_timestamp.slice(11,19)}`:'Bíður eftir vatnsmælingu';
  $('power').textContent = nf(r.power_w, 0); $('electric-total').textContent = nf(r.elec_import_kwh, 3); $('energy').textContent = nf(r.energy_wh, 3);
  $('capture').textContent = r.mbus_timestamp ? `Vatnsmælir lesinn kl. ${r.mbus_timestamp.slice(11,19)} · síðasta staðfesta mæling` : 'Bíður eftir fyrsta lestri';
  $('voltages').replaceChildren(...[0,1,2].map(i => { const div = document.createElement('div'); div.className = 'phase'; const small = document.createElement('small'); small.textContent = `FASI ${i+1}`; const strong = document.createElement('strong'); strong.textContent = nf(r.voltages?.[i]); div.append(small, strong, document.createTextNode('V')); div.title = `Straumur: ${nf(r.currents?.[i])} A`; return div; }));
  $('count').textContent = `${nf(data?.reading_count || 0, 0)} lestrar`;
  const showCosts = local && data?.pricing?.price_per_m3_isk != null;
  $('cost-daily-heading').hidden = !showCosts;
  $('cost-window-heading').hidden = !showCosts;
  const rows = (data?.daily || []).slice(0,14).map((day, i) => {
    const tr=document.createElement('tr'), date=new Date(day.date+'T12:00:00');
    const label=!Number.isNaN(+date)?dateLabel(date):'Óþekkt';
    const status=day.reset?'Mælir bakfærður':day.volume_m3==null?'Vantar gögn':day.estimated?'≈ Áætlað yfir lestrarrof':i===0?'Dagurinn í gangi':'Mæld notkun';
    const values=[label,`${measuredNumber(day.volume_m3,day.estimated)} m³`,nf(day.volume_m3==null?null:day.volume_m3*1000,0),nf(day.samples,0)];
    if(showCosts)values.push(measuredNumber(day.usage_cost_isk,day.estimated,2));
    values.push(status);
    values.forEach((value,j)=>{const td=document.createElement('td');if(j===values.length-1){const span=document.createElement('span');span.className='table-status';span.textContent=value;td.append(span);}else td.textContent=value;tr.append(td);});
    return tr;
  });
  $('history-rows').replaceChildren(...rows);
  const demo = data?.mode === 'demo';
  const stale = !data?.health?.last_success || Date.now() - Date.parse(data.health.last_success) > Math.max(180000, (data?.poll_interval_seconds || 60)*3000);
  const connected = local && !imported && !!data?.health?.connected && !data?.health?.error && !stale && serverReachable;
  $('service-notice').hidden=!data?.health?.error;
  $('service-notice').textContent=data?.health?.error||'';
  $('status-dot').className = 'status-dot ' + (connected ? 'online' : 'offline');
  $('connection-label').textContent = demo ? 'Sýnigögn · ekki raunmælingar' : imported ? 'Innlesin skrá · engin lifandi tenging' : connected ? 'Tengt' : local ? 'Bíður eftir tengingu við mæli' : 'Engin tenging við staðbundinn safnara';
  if (local && data && !connected && !demo && !imported) $('connection-label').textContent = 'Tenging rofin · síðustu gildi varðveitt';
  $('connection-detail').textContent = demo ? 'Öll gildi hér eru tilbúin til sýnis.' : data?.health?.last_success ? `Síðasti lestur kl. ${time(data.health.last_success)}${(r.water_observed === 0 || r.water_observed === false) ? ' · Vatnsgögn vantar í síðasta skeyti' : ''}` : 'Mæligögn eru aðeins lesin á heimilinu.';
  $('footer-mode').textContent = demo ? 'Sýnigögn · ekki raunmælingar' : imported ? 'Skrá lesin í vafranum · engin upphleðsla' : onComputer ? 'Staðbundin gögn' : 'Lifandi gögn';
  $('refresh').hidden = local && !demo && !imported;
  $('automatic-status').hidden = !local || demo || imported;
  $('automatic-status').textContent = streamState==='live' ? 'Lifandi · uppfærist sjálfkrafa' : serverReachable ? 'Uppfærist sjálfkrafa' : 'Endurtengi sjálfkrafa…';
  renderPricing();
  trendChart.render(data);
  renderUsage();
  drawChart();
  renderDetails(data,nf);
  renderHeatingInsights(data,nf,{connected:connected&&!demo&&!imported});
  comparison.update(data);
}
function renderPricing() {
  const p=snapshot?.pricing, s=snapshot?.summary || {};
  $('pricing-section').hidden=!local || !p || p.price_per_m3_isk==null;
  if($('pricing-section').hidden)return;
  $('tariff-label').textContent=p.basis==='veitur'?`${p.tariff_label} · kostnaðarviðmið`:'Sérstillt einingaverð · kostnaðarviðmið';
  $('tariff-price').textContent=nf(p.price_per_m3_isk,2);
  $('tariff-tax').textContent=p.basis==='veitur'?'2% vatnsskattur og 11% vsk. innifalin':'Verð úr staðbundnum stillingum';
  $('tariff-date').textContent=p.effective_from?`Verðskrá frá ${dateLabel(new Date(p.effective_from+'T12:00:00'))} ${p.effective_from.slice(0,4)} · staðfest ${p.verified_on}`:'Engin verðskrá tengd sérstilltu verði';
  $('price-today').textContent=measuredNumber(s.today_cost_isk,snapshot.usage_quality?.today_estimated,2);
  $('price-yesterday').textContent=measuredNumber(s.yesterday_cost_isk,snapshot.usage_quality?.yesterday_estimated,2);
  const last24=snapshot.water_usage?.intervals?.find(i=>i.minutes===1440);
  $('price-24h').textContent=measuredNumber(last24?.usage_cost_isk,last24?.estimated,2);
  $('price-week').textContent=last24?.usage_cost_isk==null?'Vantar mælisögu fyrir 24 klst.':last24?.estimated?'≈ Áætluð skipting yfir lestrarrof':'Miðað við mælda notkun síðustu 24 klst.';
  $('price-hour').textContent=nf(s.current_cost_per_hour_isk,2);
  $('price-projection').textContent=s.current_cost_per_hour_isk==null?'Bíður eftir rennslisgildi':`${nf(s.current_cost_per_hour_isk*24,0)} kr./sólarhring ef sama rennsli helst`;
  $('tariff-assumption').textContent=p.basis==='veitur'?`Miðað er við ${p.tariff_code==='H1'?'þéttbýli (H1)':'dreifbýli (J1)'}. Taxti heimilisins er óstaðfestur; berðu viðmiðið saman við reikning Veitna. Viðmiðið þarf að samræma taxta heimilisins ef hann er annar.`:'Einingaverðið er sérstillt í config.json og getur verið annað en verðskrá Veitna.';
  $('fixed-fee-status').textContent=p.fixed_per_day_isk==null?'Stærð vatnsmælis er óstaðfest. Fast gjald er því ekki lagt við kostnaðartölurnar.':`Stilltur mælaflokkur: ${p.tariff_code}${p.meter_class} · ${nf(p.fixed_per_day_isk,2)} kr./dag. Sýnt sér, ekki lagt við notkunartölur.`;
  $('fixed-fee-rows').replaceChildren(...(p.fixed_rates || []).map(rate=>{const tr=document.createElement('tr');[`${p.tariff_code}${rate.class}`,rate.size,`${nf(rate.per_day_isk,2)} kr.`].forEach(text=>{const td=document.createElement('td');td.textContent=text;tr.append(td);});return tr;}));
}

const windowLabels = {1:'1 mín.',5:'5 mín.',15:'15 mín.',30:'30 mín.',60:'1 klst.',180:'3 klst.',360:'6 klst.',720:'12 klst.',1440:'24 klst.',2880:'48 klst.',10080:'7 dagar'};
function stampLabel(stamp) {
  if(!stamp || Number.isNaN(Date.parse(stamp))) return '—';
  const date = new Date(stamp);
  return `${dateLabel(date)} · ${time(stamp)}`;
}
function renderUsage() {
  const usage = snapshot?.water_usage;
  const selected = Number($('usage-period').value);
  $('usage-as-of').textContent = usage?.as_of ? `Miðað við vatnsmælingu ${stampLabel(usage.as_of)}` : 'Vantar mælisögu fyrir þessi tímabil.';
  $('usage-windows').replaceChildren(...Object.entries(windowLabels).map(([minutes,label])=>{
    const value = usage?.intervals?.find(w=>w.minutes===Number(minutes));
    const card = document.createElement('article');card.className='usage-window'+(Number(minutes)===selected?' selected':'')+(value?.estimated?' estimated':'');
    const container = Number(minutes)<=1440 ? document.createElement('button') : document.createElement('div');
    if(container.tagName==='BUTTON') {container.type='button';container.setAttribute('aria-label',`Sýna notkun á ${label} bilum`);container.onclick=()=>{$('usage-period').value=minutes;renderUsage();};}
    const title = document.createElement('h3');title.textContent=Number(minutes)===1?'Síðasta mínúta':Number(minutes)===60?'Síðasta klukkustund':`Síðustu ${label}`;
    const strong=document.createElement('strong');strong.textContent=measuredNumber(value?.volume_m3,value?.estimated);
    const unit=document.createElement('small');unit.textContent='m³';
    const caption=document.createElement('p');caption.textContent=value?.volume_m3 == null ? value?.status==='reset'?'Mælir bakfærður':'Vantar mælisögu':`${nf(value.volume_m3*1000,0)} lítrar${Math.abs(value.duration_seconds-Number(minutes)*60)>2?` · ${nf(value.duration_seconds/60,1)} mín. mældar`:''}`;
    container.append(title,strong,unit,caption);
    if(local && snapshot?.pricing?.price_per_m3_isk!=null){const cost=document.createElement('p');cost.className='interval-cost';cost.textContent=`${measuredNumber(value?.usage_cost_isk,value?.estimated,2)} kr. í notkun`;container.append(cost);}
    if(value?.estimated){const badge=document.createElement('p');badge.className='estimate-label';badge.textContent='≈ Áætlað yfir lestrarrof';container.append(badge);}
    card.append(container);
    if(value?.from && value?.to)card.title=`${stampLabel(value.from)} – ${stampLabel(value.to)} · raunlengd ${nf(value.duration_seconds/60,1)} mín.`;
    return card;
  }));
  const rows=(usage?.series?.[String(selected)] || []).slice().reverse().map(value=>{
    const tr=document.createElement('tr');
    const status=value.status==='reset'?'Mælir bakfærður':value.volume_m3 == null?'Vantar mælisögu':value.estimated?'≈ Áætlað yfir lestrarrof':`Mælt · ${nf(value.duration_seconds/60,1)} mín.`;
    const cells=[stampLabel(value.from),stampLabel(value.to || value.end),measuredNumber(value.volume_m3,value.estimated),nf(value.volume_m3 == null?null:value.volume_m3*1000,0),nf(value.average_m3h,3)];
    if(local && snapshot?.pricing?.price_per_m3_isk!=null)cells.push(measuredNumber(value.usage_cost_isk,value.estimated,2));
    cells.push(status);
    cells.forEach(v=>{const td=document.createElement('td');td.textContent=v;tr.append(td);});
    return tr;
  });
  if(!rows.length){const tr=document.createElement('tr'),td=document.createElement('td');td.colSpan=local && snapshot?.pricing?.price_per_m3_isk!=null?7:6;td.textContent='Engin gögn fyrir valið tímabil. Eldri JSON-skrár kunna að vanta tímabilasögu.';tr.append(td);rows.push(tr);}
  $('usage-rows').replaceChildren(...rows);
  const gaps=usage?.gaps || [];
  $('gap-details').hidden=!gaps.length;
  $('gap-summary').textContent=`${usage?.gap_count || gaps.length} lestrarrof · sjá heildarnotkun og meðalrennsli`;
  $('gap-rows').replaceChildren(...gaps.slice().reverse().map(gap=>{const tr=document.createElement('tr');[stampLabel(gap.from),stampLabel(gap.to),`${nf(gap.duration_seconds/3600,2)} klst.`,gap.status==='reset'?'Óþekkt · mælir bakfærður':`${nf(gap.volume_m3,3)} m³`,`${nf(gap.average_m3h,3)} m³/klst.`].forEach(text=>{const td=document.createElement('td');td.textContent=text;tr.append(td);});return tr;}));
}

function drawChart() {
  const history = (snapshot?.daily || []).slice(0,days).reverse();
  $('estimated-legend').hidden=!history.some(day=>day.estimated);
  if(!history.some(d => d.volume_m3 != null)) { $('chart').textContent = 'Notkunarsagan birtist þegar mælingar safnast.'; $('chart').setAttribute('aria-label','Engin notkunargögn enn'); return; }
  const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns,'svg'); svg.setAttribute('viewBox','0 0 680 210');
  function el(tag, attrs, text) { const n = document.createElementNS(ns,tag); Object.entries(attrs).forEach(([k,v]) => n.setAttribute(k,v)); if(text !== undefined) n.textContent = text; svg.append(n); return n; }
  const max = Math.max(.1, ...history.map(d => d.volume_m3 || 0)) * 1.2;
  for(let i=0;i<4;i++){ const y=12+i*52; el('line',{x1:35,x2:675,y1:y,y2:y,stroke:'#e9ede5','stroke-dasharray':'3 4'}); el('text',{x:0,y:y+3,fill:'#a2ac99','font-size':9},nf(max*(1-i/3),1)); }
  const slot=630/history.length;
  history.forEach((d,i) => { const h=d.volume_m3 == null ? 0 : d.volume_m3/max*156; const x=39+i*slot+(slot*.2); const bar = el('rect',{x,y:168-h,width:slot*.6,height:Math.max(h,2),rx:3,fill:d.volume_m3 == null ? '#e6e9e0' : d.estimated ? '#c7a265' : i===history.length-1 ? '#315d48' : '#a6bea0'}); const title=document.createElementNS(ns,'title'); title.textContent=`${d.date}: ${measuredNumber(d.volume_m3,d.estimated)} m³ · ${d.estimated?'áætluð skipting yfir rof · ':''}${d.samples} lestrar`; bar.append(title); el('text',{x:x+slot*.3,y:192,'text-anchor':'middle',fill:'#9ba68f','font-size':9},d.date.slice(8,10)); });
  $('chart').replaceChildren(svg); $('chart').setAttribute('aria-label',`Vatnsnotkun síðustu ${history.length} daga. Nákvæm gildi í notkunarsögutöflu.`);
}
function maybeReloadFrontend() {
  if(!local || imported || snapshot?.mode==='demo' || !pendingFrontendVersion || pendingFrontendVersion===loadedFrontendVersion || document.querySelector('dialog[open]')) return;
  try { sessionStorage.setItem('p1-live-view', JSON.stringify({days, period:$('usage-period').value, trend:trendChart.getView(), scrollY:window.scrollY})); } catch {}
  location.reload();
}
function receiveSnapshot(data) {
  if(imported || snapshot?.mode==='demo') return;
  serverReachable=true;
  pendingFrontendVersion=data.frontend_version;
  if(pendingFrontendVersion && loadedFrontendVersion && pendingFrontendVersion!==loadedFrontendVersion) {
    maybeReloadFrontend();
    if(!document.querySelector('dialog[open]')) return;
  }
  if(data.latest?.id && snapshot?.latest?.id && data.latest.id<snapshot.latest.id) return;
  snapshot=data;
  render();
  if(restoredView) { const scrollY=Number(restoredView.scrollY)||0; restoredView=null; requestAnimationFrame(()=>window.scrollTo(0,scrollY)); }
}
async function refresh({silent=true}={}) {
  if(!local || imported || snapshot?.mode==='demo') { if(!silent)toast('Lifandi gögn eru á localhost:8080. Lestu inn nýja skrá hér.'); return; }
  if(refreshPending)return;
  refreshPending=true;
  try { const response=await fetch('/api/status',{cache:'no-store',signal:AbortSignal.timeout(7000)}); if(!response.ok) throw Error('API unavailable'); receiveSnapshot(await response.json()); }
  catch { serverReachable=false;render();if(!silent)toast('Safnari svarar ekki. Reynt aftur sjálfkrafa.'); }
  finally { refreshPending=false; }
}
function startLiveUpdates() {
  if(!local)return;
  if(onComputer && typeof EventSource!=='undefined') {
    stream=new EventSource('/api/events');
    stream.onopen=()=>{streamState='live';serverReachable=true;render();};
    stream.addEventListener('reading',event=>{try {receiveSnapshot(JSON.parse(event.data));}catch {refresh();}});
    stream.onerror=()=>{streamState='retrying';serverReachable=false;render();refresh();};
  } else {streamState='polling';refresh();}
  setInterval(()=>{maybeReloadFrontend();if(!stream || stream.readyState!==EventSource.OPEN)refresh();},15000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden){maybeReloadFrontend();refresh();}});
  window.addEventListener('online',()=>refresh());
  window.addEventListener('pageshow',event=>{if(event.persisted)refresh();});
}

$('usage-period').onchange=renderUsage;
$('refresh').onclick=()=>refresh({silent:false});
document.querySelectorAll('[data-days]').forEach(button=>button.onclick=()=>{days=Number(button.dataset.days);document.querySelectorAll('[data-days]').forEach(b=>{b.classList.toggle('selected',b===button);b.setAttribute('aria-pressed',String(b===button));});drawChart();});
$('about').onclick=()=>$('info').showModal();$('close-dialog').onclick=()=>$('info').close();
initializePages();
if(restoredView) {
  trendChart.restore(restoredView.trend);
  if([7,14].includes(restoredView.days))days=restoredView.days;
  if([...$('usage-period').options].some(option=>option.value===restoredView.period))$('usage-period').value=restoredView.period;
  document.querySelectorAll('[data-days]').forEach(button=>{const selected=Number(button.dataset.days)===days;button.classList.toggle('selected',selected);button.setAttribute('aria-pressed',String(selected));});
}
render();startLiveUpdates();
