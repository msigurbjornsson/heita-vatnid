const $=id=>document.getElementById(id);
const months=['janúar','febrúar','mars','apríl','maí','júní','júlí','ágúst','september','október','nóvember','desember'];
const scopes={day:'Síðustu 14 dagar',week:'Síðustu 8 vikur',month:'Síðustu 6 mánuðir'};
function date(value,short=false){const d=new Date(value);return `${d.getUTCDate()}. ${short?months[d.getUTCMonth()].slice(0,3)+'.':months[d.getUTCMonth()]}`;}
function label(p,unit,short=false){if(unit==='month'){const d=new Date(p.start);return `${short?months[d.getUTCMonth()].slice(0,3)+'.':months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;}if(unit==='week')return `${date(p.start,short)} – ${date(Date.parse(p.end)-86400000,short)}`;return date(p.start,short);}
function status(p){if(p.status==='reset')return 'Mælir bakfærður';if(p.status==='insufficient')return 'Næg mælisaga vantar';if(p.status==='ongoing_partial')return 'Í gangi · upphaf tímabils vantar';if(p.status==='ongoing')return 'Í gangi · skráð notkun';if(p.status==='partial')return 'Takmörkuð mælisaga';return 'Heilt tímabil';}
export function createWaterComparison({nf,stampLabel}) {
 let period='day',metric='volume',data=null,request=null,lastFetch=0,selected=null,sourceMode='live';
 function render(){
  $('comparison-scope').textContent=scopes[period]+(data?.as_of?' · uppfært kl. '+data.as_of.slice(11,19):'');
  document.querySelectorAll('[data-compare-period]').forEach(b=>{const chosen=b.dataset.comparePeriod===period;b.classList.toggle('selected',chosen);b.setAttribute('aria-pressed',String(chosen));});
  const chart=$('comparison-chart'),previousScroll=chart.scrollLeft,samePeriod=chart.dataset.period===period;chart.replaceChildren();
  if(!data){$('comparison-rows').replaceChildren();return;}
  const points=data.periods,key=metric==='cost'?'usage_cost_isk':'volume_m3',unit=metric==='cost'?'kr.':'m³';
  const known=points.filter(p=>p[key]!=null),max=Math.max(.001,...known.map(p=>p[key]));
  const bars=document.createElement('div');bars.className='comparison-bars';bars.style.minWidth=Math.max(300,points.length*(period==='week'?76:46))+'px';
  for(const p of points){
   const column=document.createElement('button');column.type='button';column.className='comparison-column'+(p.complete?' complete':' partial')+(p.key===selected?' selected':'');
   column.setAttribute('aria-label',`${label(p,period)}: ${p[key]==null?'Vantar gögn':nf(p[key],metric==='cost'?0:3)+' '+unit}. ${status(p)}`);
   column.setAttribute('aria-pressed',String(p.key===selected));
   const value=document.createElement('span');value.className='comparison-value';value.textContent=p[key]==null?'—':nf(p[key],metric==='cost'?0:2);
   const track=document.createElement('span');track.className='comparison-bar-track';
   const bar=document.createElement('i');bar.className=p[key]==null?'comparison-no-data':'comparison-bar';bar.style.height=p[key]==null?'0':`${Math.max(1,p[key]/max*100)}%`;track.append(bar);
   const caption=document.createElement('span');caption.className='comparison-caption';caption.textContent=label(p,period,true);
   column.append(value,track,caption);column.onclick=()=>{selected=p.key;render();};bars.append(column);
  }
  chart.append(bars);chart.dataset.period=period;chart.scrollLeft=samePeriod?previousScroll:chart.scrollWidth;chart.setAttribute('aria-label',`${scopes[period]} · ${unit}. Takmörkuð eða ólokin tímabil eru röndótt. Nákvæm gildi í töflu.`);
  $('comparison-rows').replaceChildren(...points.slice().reverse().map(p=>{const tr=document.createElement('tr');if(p.key===selected)tr.className='selected-comparison-row';for(const text of [label(p,period),nf(p.volume_m3,3),nf(p.usage_cost_isk,2),p.from&&p.to?`${stampLabel(p.from)} – ${stampLabel(p.to)}`:'—',nf(p.samples,0),status(p)]){const td=document.createElement('td');td.textContent=text;tr.append(td);}return tr;}));
  const chosen=points.find(p=>p.key===selected);
  if(chosen){$('comparison-result').textContent=`${label(chosen,period)}: ${chosen.volume_m3==null?'notkun óþekkt':nf(chosen.volume_m3,3)+' m³ · '+nf(chosen.usage_cost_isk,2)+' kr.'} · ${status(chosen)}${chosen.from&&chosen.to?' · '+stampLabel(chosen.from)+' – '+stampLabel(chosen.to):''}`;}
  else if(data.comparison){const c=data.comparison,a=points.find(p=>p.key===c.current_key),b=points.find(p=>p.key===c.previous_key);$('comparison-result').textContent=`${label(a,period)} á móti ${label(b,period)}: ${c.percent==null?nf(c.difference_m3,3)+' m³ breyting':nf(Math.abs(c.percent),1)+'% '+(c.percent>0?'meiri':c.percent<0?'minni':'óbreytt')+' notkun'} (${c.difference_m3>0?'+':''}${nf(c.difference_m3,3)} m³). Samanburður heilla tímabila.`;}
  else $('comparison-result').textContent='Vantar tvö samliggjandi heil tímabil fyrir prósentusamanburð. Skráð notkun birtist hér að ofan; óþekkt tímabil eru ekki sýnd sem núll.';
 }
 async function refresh(force=false){
  if(document.querySelector('[data-page="water"]').hidden)return;
  if(sourceMode!=='live'){data=null;render();$('comparison-result').textContent='Almanakssamanburður er aðeins í boði með lifandi gagnagrunninum.';return;}
  if(request||!force&&Date.now()-lastFetch<120000)return;
  const controller=new AbortController();request=controller;const requested=period;const timeout=setTimeout(()=>controller.abort(),15000);
  if(!data)$('comparison-result').textContent='Sækir samanburð…';
  try{const response=await fetch('/api/water-comparison?period='+requested,{cache:'no-store',signal:controller.signal});if(!response.ok)throw Error();const result=await response.json();if(result.unit!==requested||!Array.isArray(result.periods))throw Error();if(requested!==period)return;data=result;lastFetch=Date.now();render();}
  catch(error){if(request===controller)$('comparison-result').textContent='Ekki tókst að sækja samanburð. Reynt verður aftur sjálfkrafa.';}
  finally{clearTimeout(timeout);if(request===controller)request=null;}
 }
 document.querySelectorAll('[data-compare-period]').forEach(b=>b.onclick=()=>{request?.abort();request=null;period=b.dataset.comparePeriod;selected=null;data=null;lastFetch=0;render();refresh(true);});
 $('comparison-metric').onchange=()=>{metric=$('comparison-metric').value;render();};
 window.addEventListener('dashboard:pagechange',event=>{if(event.detail==='water')refresh();});
 return {update(snapshot){sourceMode=snapshot?.mode==='demo'?'demo':snapshot?.mode==='import'?'import':'live';refresh();}};
}
