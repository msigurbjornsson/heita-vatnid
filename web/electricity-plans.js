// Snapshot of Aurbjörg's listed unit prices, retrieved 2026-11-18.
export const PLAN_SOURCE='https://aurbjorg.is/rafmagn';
export const VERIFIED_ON='2026-11-18';
const suppliers=[
 ['straumlind','Straumlind',10.54,9.80,11.16,'Kjaraverð krefst fyrirframgreiðslu.'],
 ['orkusalan','Orkusalan',12.97,9.82,15.38,'Kjaraverð miðast við SparOrku.'],
 ['n1','N1',10.95,9.98,11.57,'Kjaraverð krefst N1-korts eða apps. N1-punktar eru ekki dregnir frá kostnaði.'],
 ['ov','Orkubú Vestfjarða',9.99,9.99,11.61,''],
 ['atlantsorka','Atlantsorka',9.99,9.99,null,''],
 ['heimilanna','Orka Heimilanna',9.82,9.82,10.55,'Aurbjörg tilgreinir 113 kr. fyrir reikning í banka; ekki innifalið hér.'],
 ['on','Orka náttúrunnar',11.41,11.41,11.91,''],
 ['hs','HS orka',12.18,12.18,15.21,'Almennt verð hér er fast verð til samanburðar; næturleiðin er sér valkostur.']
];
export const PLANS=suppliers.flatMap(([id,supplier,general,discount,origin,note])=>[
 {id:id+'-general',supplier,label:'Almennt verð',rate:general,note},
 {id:id+'-discount',supplier,label:'Kjaraverð',rate:discount,note},
 ...(origin==null?[]:[{id:id+'-origin',supplier,label:'Með upprunaábyrgð',rate:origin,note:note+' Tímaháðir afslættir eru ekki reiknaðir á upprunaábyrgðarverði.'}])
]);
PLANS.push(
 {id:'straumlind-night',supplier:'Straumlind',label:'Næturleið',kind:'straumlind',note:'10,54 kr./kWh · 7,03 kr. kl. 23–07.'},
 {id:'hs-night',supplier:'HS orka',label:'Næturleið',kind:'hs',note:'12,18 kr./kWh · 0 kr. kl. 01–06. Dreifing er áfram greidd.'},
 {id:'on-variable',supplier:'Orka náttúrunnar',label:'Orkuvísir',kind:'unavailable',note:'Vetrarverð 12,55 / 6,40 kr.; sumarverð 11,59 / 5,91 kr./kWh. Tímarammar og árstíðaskipti bíða staðfestingar; ekki hægt að reikna öruggan samanburð.',source:'https://www.on.is/verdskrar'}
);
export function planCost(plan,day){
 if(!day||!Number.isFinite(day.energy_kwh)||day.energy_kwh<0||day.status==='reset'||!Number.isFinite(day.distribution_cost_isk))return null;
 let supplier;
 if(plan.kind==='unavailable')return null;
 if(plan.kind==='hs')supplier=day.hs_orka?.supplier_cost_isk;
 else if(plan.kind==='straumlind')supplier=Number.isFinite(day.day_kwh)&&Number.isFinite(day.night_kwh)?day.day_kwh*10.54+day.night_kwh*7.03:null;
 else supplier=day.energy_kwh*plan.rate;
 if(!Number.isFinite(supplier))return null;
 return {supplier,distribution:day.distribution_cost_isk,total:supplier+day.distribution_cost_isk,saving:Number.isFinite(day.usage_cost_isk)?day.usage_cost_isk-supplier-day.distribution_cost_isk:null};
}
export function summarizePlan(plan,days){
 const costs=days.map(day=>planCost(plan,day));
 if(!days.length||costs.some(c=>c===null))return null;
 return costs.reduce((a,c)=>({supplier:a.supplier+c.supplier,distribution:a.distribution+c.distribution,total:a.total+c.total,saving:a.saving==null||c.saving==null?null:a.saving+c.saving}),{supplier:0,distribution:0,total:0,saving:0});
}
