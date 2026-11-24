const messages = {
 low_delta:['Lítil kæling við mælinn','Vatnið hefur skilað sér lítið kælt samhliða umtalsverðu rennsli. Hugsanlega er ástæða til að láta yfirfara stillingar hitakerfisins.'],
 flow_up:['Meira rennsli en áður','Rennsli er hærra en á sama tíma fyrri daga. Athugaðu hvort notkun eða stillingar hafi breyst.'],
 flow_down:['Minna rennsli en áður','Rennsli er lægra en á sama tíma fyrri daga. Ef húshitun hefur líka versnað eða kraftur heita vatnsins minnkað skaltu ræða við veituna eða fagmann um inntakssíu og þrýstijafnara.'],
 supply_down:['Lægri framrásarhiti','Framrásarhiti er lægri en á sama tíma fyrri daga. Athugaðu hvort húshitun hafi breyst og kannaðu tilkynningar veitunnar.']
};
export function renderHeatingInsights(data,nf,{connected=false}={}) {
 const h=data?.heating_insights;
 const ready=connected&&h?.state==='ready'&&Date.now()-Date.parse(h?.current?.to)<=180000;
 const flags=ready?(h.flags||[]).filter(key=>messages[key]):[];
 document.getElementById('heating-state').textContent=!connected?'Mat bíður eftir lifandi tengingu við mæli.':!ready?'Vantar nýjar vatnsmælingar með nægri þekju síðustu klukkustund.':flags.length?'Vísbendingar sem gæti verið gagnlegt að skoða.':'Engin frávik yfir sýndum viðmiðum. Það staðfestir ekki að allt hitakerfið sé í lagi.';
 document.getElementById('heating-flags').replaceChildren(...flags.map(key=>{
  const item=document.createElement('article');item.className='heating-flag';
  const title=document.createElement('h3'),body=document.createElement('p');
  title.textContent=messages[key][0];body.textContent=messages[key][1];item.append(title,body);return item;
 }));
 const c=h?.current,r=h?.reference;
 document.getElementById('heating-evidence').textContent=ready?`Síðasta klst.: ${nf(c.flow_lh,0)} L/klst. · framrás ${nf(c.supply_c,1)} °C · hitamunur ${nf(c.delta_c,1)} °C · þekja ${nf(c.coverage*100,0)}%. ${r?`Sama tímabil ${r.days} fyrri daga: miðgildi rennslis ${nf(r.flow_lh,0)} L/klst. og framrásar ${nf(r.supply_c,1)} °C.`:'Samanburður við fyrri daga bíður eftir minnst þremur dögum með nægri þekju.'}`:'';
 document.getElementById('heating-overview').hidden=!flags.length;
 document.getElementById('heating-overview-link').textContent=flags.length?`Hitakerfið: ${flags.map(key=>messages[key][0].toLocaleLowerCase('is-IS')).join(' · ')}. Skoða nánar ↗`:'';
}
