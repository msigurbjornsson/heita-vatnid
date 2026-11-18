// Interactive charts use only the local collector's reviewed counter intervals.
const RANGES = {'1h':[1,60], '3h':[5,36], '6h':[15,24], '12h':[30,24], '24h':[60,24], '7d':[360,28]};
export function summarizeTrend(points, total, price) {
  const known=points.filter(p=>Number.isFinite(p.volume_m3));
  const full=Number.isFinite(total?.volume_m3);
  const volume=full?total.volume_m3:known.length?known.reduce((sum,p)=>sum+p.volume_m3,0):null;
  const estimated=full?!!total.estimated:known.some(p=>p.estimated);
  const peak=known.reduce((best,p)=>Number.isFinite(p.average_m3h) && (!best || p.average_m3h>best.average_m3h)?p:best,null);
  return {volume, cost:volume!=null && Number.isFinite(price)?volume*price:null, estimated, peak,
    known:known.length, count:points.length, estimatedCount:known.filter(p=>p.estimated).length, full};
}
export function createTrendChart({nf, stampLabel}) {
  const $=id=>document.getElementById(id);
  let range='24h', mode='flow', selected=null, snapshot=null, currentPoints=[], currentStep=60, chartWidth=0;
  const formatted=(v,estimated,digits=3)=>`${estimated && v!=null?'≈ ':''}${nf(v,digits)}`;
  const period=minutes=>minutes<60?`${minutes} mín.`:`${nf(minutes/60,0)} klst.`;
  const price=()=>snapshot?.pricing?.price_per_m3_isk;
  function value(point) {return mode==='cost' ? Number.isFinite(point.average_m3h) && Number.isFinite(price())?point.average_m3h*price():null : point.average_m3h;}
  function inspect(index) {
    if(!currentPoints.length)return;
    selected=Math.max(0,Math.min(currentPoints.length-1,index));
    const p=currentPoints[selected];
    $('trend-selected-time').textContent=`${stampLabel(p.from)} – ${stampLabel(p.to || p.end)}`;
    $('trend-selected-values').textContent=Number.isFinite(p.volume_m3)?`${formatted(p.volume_m3,p.estimated)} m³ · ${formatted(p.usage_cost_isk,p.estimated,2)} kr. · ${formatted(p.average_m3h,p.estimated)} m³/klst.`:'Engin mæligögn fyrir þetta bil';
    $('trend-selected-quality').textContent=p.estimated?'≈ Jafnað yfir lestrarrof':p.status==='reset'?'Mælir bakfærður':Number.isFinite(p.volume_m3)?'Mælt tímabil':'Óþekkt';
    $('trend-inspect').classList.toggle('estimated',!!p.estimated);
    const guide=$('trend-guide'), dot=$('trend-marker');
    if(guide) {
      const x=Number(guide.dataset.left)+(selected+.5)/currentPoints.length*Number(guide.dataset.width);
      guide.setAttribute('x1',x);guide.setAttribute('x2',x);guide.setAttribute('visibility','visible');
      if(dot && Number.isFinite(value(p))) {dot.setAttribute('cx',x);dot.setAttribute('cy',Number(guide.dataset.bottom)-value(p)/Number(guide.dataset.max)*Number(guide.dataset.height));dot.setAttribute('visibility','visible');}
      else dot?.setAttribute('visibility','hidden');
    }
  }
  function draw() {
    const host=$('trend-chart');
    const valid=currentPoints.filter(p=>Number.isFinite(value(p)));
    if(!valid.length) {host.textContent=mode==='cost' && !Number.isFinite(price())?'Veldu kostnaðarviðmið til að sjá kostnaðarþróun.':'Þróun birtist þegar mæligögn safnast.';return;}
    const width=Math.max(300,host.clientWidth), height=260, left=56, right=18, top=18, bottom=218, plot=width-left-right;
    chartWidth=host.clientWidth;
    const peak=Math.max(0,...valid.map(value)), base=peak>0?peak/4:.025;
    const power=10**Math.floor(Math.log10(base)), ratio=base/power, step=(ratio<=1?1:ratio<=2?2:ratio<=5?5:10)*power, max=step*4;
    const ns='http://www.w3.org/2000/svg', svg=document.createElementNS(ns,'svg');
    svg.setAttribute('viewBox',`0 0 ${width} ${height}`);svg.setAttribute('role','img');svg.setAttribute('tabindex','0');
    svg.setAttribute('aria-label',`${mode==='cost'?'Kostnaður í kr./klst.':'Meðalrennsli í m³/klst.'}. Vinstri og hægri örvar skoða einstök bil; nákvæm gildi eru í töflunni fyrir neðan.`);
    function element(tag,attrs,text) {const node=document.createElementNS(ns,tag);Object.entries(attrs).forEach(([k,v])=>node.setAttribute(k,v));if(text!==undefined)node.textContent=text;svg.append(node);return node;}
    const x=i=>left+(i+.5)/currentPoints.length*plot, y=v=>bottom-v/max*(bottom-top);
    for(let i=0;i<=4;i++){const v=i*step,py=y(v);element('line',{x1:left,x2:width-right,y1:py,y2:py,stroke:'#e3e9e1','stroke-dasharray':i?'3 5':'none'});element('text',{x:left-10,y:py+4,'text-anchor':'end',fill:'#7d8f81','font-size':11},nf(v,max<1?2:max<10?1:0));}
    // Shaded segments stop at unknown data. Dashed gold strokes identify estimated allocation.
    let segment=[];
    function area() {if(segment.length>1)element('path',{d:`M ${x(segment[0])} ${bottom} `+segment.map(i=>`L ${x(i)} ${y(value(currentPoints[i]))}`).join(' ')+` L ${x(segment.at(-1))} ${bottom} Z`,fill:'#315d48','fill-opacity':'.07',stroke:'none'});segment=[];}
    currentPoints.forEach((p,i)=>{if(Number.isFinite(value(p)))segment.push(i);else area();});area();
    currentPoints.forEach((p,i)=>{
      const v=value(p);if(!Number.isFinite(v))return;
      if(i && Number.isFinite(value(currentPoints[i-1]))) {const estimated=p.estimated || currentPoints[i-1].estimated;element('line',{x1:x(i-1),x2:x(i),y1:y(value(currentPoints[i-1])),y2:y(v),stroke:estimated?'#ab8045':'#315d48','stroke-width':2.3,'stroke-dasharray':estimated?'5 4':'none','stroke-linecap':'round'});}
      if(p.estimated) {const px=x(i),py=y(v);element('polygon',{points:`${px},${py-3.4} ${px+3.4},${py} ${px},${py+3.4} ${px-3.4},${py}`,fill:'#fffaf0',stroke:'#ab8045','stroke-width':1.4});}
      else element('circle',{cx:x(i),cy:y(v),r:2.5,fill:'#315d48'});
    });
    const end=Date.parse(currentPoints.at(-1)?.end || currentPoints.at(-1)?.to), start=end-currentPoints.length*currentStep*60000;
    const axisTime=epoch=>{const d=new Date(epoch);return currentPoints.length*currentStep>=1440?`${String(d.getDate()).padStart(2,'0')}.${String(d.getMonth()+1).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`:`${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;};
    const ticks=width<450?3:5;
    if(Number.isFinite(end))for(let i=0;i<ticks;i++) {const ratio=i/(ticks-1);element('text',{x:left+ratio*plot,y:height-14,'text-anchor':i===0?'start':i===ticks-1?'end':'middle',fill:'#7d8f81','font-size':11},axisTime(start+ratio*(end-start)));}
    const guide=element('line',{id:'trend-guide',x1:0,x2:0,y1:top,y2:bottom,stroke:'#718578','stroke-width':1,'stroke-dasharray':'3 4',visibility:'hidden'});
    Object.assign(guide.dataset,{left:String(left),width:String(plot),max:String(max),bottom:String(bottom),height:String(bottom-top)});
    element('circle',{id:'trend-marker',cx:0,cy:0,r:5,fill:'#fff',stroke:'#315d48','stroke-width':2,visibility:'hidden'});
    const pick=event=>{const rect=svg.getBoundingClientRect();const mouseX=(event.clientX-rect.left)/rect.width*width;inspect(Math.floor((mouseX-left)/plot*currentPoints.length));};
    svg.onpointermove=event=>{if(event.pointerType!=='touch')pick(event);};svg.onclick=pick;
    svg.onkeydown=event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();inspect(event.key==='Home'?0:event.key==='End'?currentPoints.length-1:(selected??currentPoints.length-1)+(event.key==='ArrowRight'?1:-1));}};
    const focused=host.contains(document.activeElement);host.replaceChildren(svg);if(focused)svg.focus({preventScroll:true});
    inspect(selected??currentPoints.length-1);
  }
  function render(data) {
    snapshot=data;
    const trend=data?.water_usage?.trends?.[range];currentPoints=trend?.points || [];currentStep=trend?.interval_minutes || RANGES[range][0];
    const stats=summarizeTrend(currentPoints,trend?.total,price());
    document.querySelectorAll('[data-trend-range]').forEach(button=>{const active=button.dataset.trendRange===range;button.classList.toggle('selected',active);button.setAttribute('aria-pressed',String(active));});
    document.querySelectorAll('[data-trend-mode]').forEach(button=>{const active=button.dataset.trendMode===mode;button.classList.toggle('selected',active);button.setAttribute('aria-pressed',String(active));if(button.dataset.trendMode==='cost')button.disabled=!Number.isFinite(price());});
    $('trend-scope').textContent=`${mode==='cost'?'Kostnaður við meðalrennsli':'Meðalrennsli'} · ${period(currentStep)} bil · ${data?.water_usage?.as_of?'til '+stampLabel(data.water_usage.as_of):'bíður eftir lestri'}`;
    $('trend-coverage').textContent=`${stats.known} af ${stats.count} bilum með gögnum${stats.estimatedCount?` · ${stats.estimatedCount} áætluð`:''}`;
    $('trend-volume').textContent=`${formatted(stats.volume,stats.estimated)} m³`;
    $('trend-cost').textContent=`${formatted(stats.cost,stats.estimated,2)} kr.`;
    $('trend-peak').textContent=`${formatted(stats.peak?.average_m3h,stats.peak?.estimated)} m³/klst.`;
    $('trend-unit').textContent=mode==='cost'?'kr./klst.':'m³/klst.';
    $('trend-data-rows').replaceChildren(...currentPoints.slice().reverse().map(p=>{const row=document.createElement('tr');[stampLabel(p.from),stampLabel(p.to || p.end),formatted(p.volume_m3,p.estimated),formatted(p.average_m3h,p.estimated),formatted(p.usage_cost_isk,p.estimated,2),p.estimated?'≈ Áætlað yfir rof':p.status==='reset'?'Mælir bakfærður':Number.isFinite(p.volume_m3)?'Mælt':'Vantar gögn'].forEach(text=>{const cell=document.createElement('td');cell.textContent=text;row.append(cell);});return row;}));
    if(!currentPoints.length){$('trend-selected-time').textContent='Bíður eftir nýrri mælisögu.';$('trend-selected-values').textContent='—';$('trend-selected-quality').textContent='';}
    draw();
  }
  document.querySelectorAll('[data-trend-range]').forEach(button=>button.onclick=()=>{range=button.dataset.trendRange;selected=null;render(snapshot);});
  document.querySelectorAll('[data-trend-mode]').forEach(button=>button.onclick=()=>{mode=button.dataset.trendMode;render(snapshot);});
  if(typeof ResizeObserver!=='undefined')new ResizeObserver(()=>{if(Math.abs($('trend-chart').clientWidth-chartWidth)>10)draw();}).observe($('trend-chart'));
  return {render, getView:()=>({range,mode}), restore:view=>{if(view && Object.hasOwn(RANGES,view.range))range=view.range;if(view && ['flow','cost'].includes(view.mode))mode=view.mode;}};
}
