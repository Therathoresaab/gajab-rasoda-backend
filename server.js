const express=require('express');
const cors=require('cors');
const app=express();
app.use(cors());
app.use(express.json({limit:'4mb'}));
app.use(express.urlencoded({extended:true}));
const PORT=process.env.PORT||3000;
const now=()=>new Date().toISOString();
const id2=(p,n)=>p+String(n).padStart(2,'0');
let seq={customer:0,order:0,rider:1,restaurant:1,onboarding:0,grievance:0,partnerPayout:0,riderPayout:0};

const menu=[
{id:'chicken_thali',name:'Gajab Chicken Thali',price:169,available:true,category:'NON_VEG',image:''},
{id:'egg_curry',name:'Gajab Egg Curry [2 Eggs]',price:139,available:true,category:'EGG',image:''},
{id:'egg_bhurji',name:'Gajab Egg Bhurji [2 Eggs]',price:120,available:true,category:'EGG',image:''},
{id:'omelette',name:'Gajab Omelette [2 Eggs]',price:99,available:true,category:'EGG',image:''},
{id:'omelette_bread',name:'Gajab Omelette + Bread [2 Eggs]',price:129,available:true,category:'EGG',image:''},
{id:'tawa_roti',name:'Tawa Roti',price:15,available:true,category:'VEG',image:''},
{id:'butter_roti',name:'Tawa Roti with Butter',price:20,available:true,category:'VEG',image:''},
{id:'paratha',name:'Paratha',price:25,available:true,category:'VEG',image:''},
{id:'masala_chach',name:'Masala Chach',price:20,available:true,category:'VEG',image:''},
{id:'chach',name:'Chach',price:15,available:true,category:'VEG',image:''}
];
const restaurant={id:'GRR01',name:'Gajab Rasoda',status:'ONLINE',activationDate:now(),menu};
const customers={}, riders={'GRD01':{id:'GRD01',name:'Delivery Partner 01',mobile:'',status:'ACTIVE',online:false,createdAt:now()}};
const orders=[], onboarding=[], grievances=[], partnerPayouts=[], riderPayouts=[];
const locations={}, riderAccounts={}, partnerAccounts={'GRR01':{restaurantId:'GRR01',payoutMethod:'',upiId:'',bankLast4:'',payoutEnabled:false}};

function nextId(k,p){seq[k]++;return id2(p,seq[k]);}
function tomorrow(){const d=new Date();d.setDate(d.getDate()+1);return d.toISOString().slice(0,10);}
function riderEarning(km){km=Math.max(0,Number(km||0));return Math.round((30+Math.max(0,km-3)*8)*100)/100;}
function partnerSettlement(order){
  const gross=Number(order.total||0);
  const commission=Math.round(gross*0.10*100)/100;
  const processing=Math.round(gross*0.0184*100)/100;
  const net=Math.round((gross-commission-processing)*100)/100;
  return {gross,commission,processing,net};
}
function ensurePayoutLedgers(order){
  if(!riderPayouts.some(x=>x.orderId===order.id) && order.deliveryPartnerId){
    riderPayouts.unshift({id:'GRDP'+String(++seq.riderPayout).padStart(4,'0'),orderId:order.id,deliveryPartnerId:order.deliveryPartnerId,amount:riderEarning(order.deliveryDistanceKm),status:'SCHEDULED_T_PLUS_1',dueDate:tomorrow(),createdAt:now()});
  }
  if(!partnerPayouts.some(x=>x.orderId===order.id)){
    const x=partnerSettlement(order);
    partnerPayouts.unshift({id:'GRPP'+String(++seq.partnerPayout).padStart(4,'0'),orderId:order.id,restaurantId:order.restaurantId, ...x,status:'SCHEDULED_T_PLUS_1',dueDate:tomorrow(),createdAt:now()});
  }
}

app.get('/health',(req,res)=>res.json({ok:true,service:'Gajab Rasoda Backend',version:'consolidated-v4'}));

app.get('/customer/restaurant',(req,res)=>res.json(restaurant));
app.get('/customer/menu',(req,res)=>res.json({restaurantId:restaurant.id,status:restaurant.status,menu:restaurant.menu}));
app.post('/customer/profile',(req,res)=>{
  const phone=String(req.body.phone||'').trim();if(!phone)return res.status(400).json({error:'phone_required'});
  let c=customers[phone];if(!c)c=customers[phone]={customerId:nextId('customer','GRC'),name:'',phone,addresses:[],status:'ACTIVE',createdAt:now()};
  if(req.body.name)c.name=String(req.body.name);if(req.body.address&&!c.addresses.includes(req.body.address))c.addresses.unshift(String(req.body.address));
  c.updatedAt=now();res.json(c);
});
app.get('/customer/profile/:phone',(req,res)=>customers[req.params.phone]?res.json(customers[req.params.phone]):res.status(404).json({error:'customer_not_found'}));
app.post('/customer/profile/:phone/addresses',(req,res)=>{
  const c=customers[req.params.phone];if(!c)return res.status(404).json({error:'customer_not_found'});
  const a=String(req.body.address||'').trim();if(!a)return res.status(400).json({error:'address_required'});if(!c.addresses.includes(a))c.addresses.unshift(a);c.updatedAt=now();res.json(c);
});
app.post('/customer/orders',(req,res)=>{
  if(restaurant.status!=='ONLINE')return res.status(409).json({error:'restaurant_offline'});
  const items=req.body.items;if(!Array.isArray(items)||!items.length)return res.status(400).json({error:'items_required'});
  let total=0;const normalized=[];
  for(const raw of items){const m=menu.find(x=>x.id===raw.id)||menu.find(x=>x.name===raw.name);if(!m)return res.status(400).json({error:'unknown_item'});if(!m.available)return res.status(409).json({error:'item_unavailable',item:m.id});const q=Math.max(1,Number(raw.qty||1));normalized.push({id:m.id,name:m.name,qty:q,price:m.price,category:m.category,image:m.image||''});total+=m.price*q;}
  const o={id:nextId('order','GRO'),restaurantId:restaurant.id,customerId:String(req.body.customerId||''),customerName:String(req.body.customerName||'Customer'),customerPhone:String(req.body.customerPhone||''),address:String(req.body.address||''),items:normalized,total,status:'PLACED',deliveryPin:String(Math.floor(1000+Math.random()*9000)),deliveryPartnerId:'',deliveryDistanceKm:Number(req.body.deliveryDistanceKm||3),createdAt:now(),updatedAt:now()};
  orders.unshift(o);res.status(201).json(o);
});
app.get('/customer/orders',(req,res)=>{const cid=String(req.query.customerId||''),p=String(req.query.phone||'');res.json({orders:orders.filter(o=>(cid&&o.customerId===cid)||(p&&o.customerPhone===p))});});
app.get('/customer/orders/:id',(req,res)=>{const o=orders.find(x=>x.id===req.params.id);if(!o)return res.status(404).json({error:'order_not_found'});res.json({...o,tracking:locations[o.id]||null,restaurantStatus:restaurant.status});});

app.get('/partner/restaurant',(req,res)=>res.json(restaurant));
app.patch('/partner/restaurant/status',(req,res)=>{const s=String(req.body.status||'').toUpperCase();if(!['ONLINE','OFFLINE'].includes(s))return res.status(400).json({error:'invalid_status'});restaurant.status=s;res.json(restaurant);});
app.patch('/partner/menu/:id/availability',(req,res)=>{const m=menu.find(x=>x.id===req.params.id);if(!m)return res.status(404).json({error:'item_not_found'});m.available=!!req.body.available;res.json(m);});
app.post('/partner/menu',(req,res)=>{const name=String(req.body.name||'').trim(),price=Number(req.body.price||0);if(!name||price<=0)return res.status(400).json({error:'name_and_price_required'});const m={id:'dish_'+Date.now(),name,price,available:req.body.available!==false,category:String(req.body.category||'VEG'),image:String(req.body.image||'')};menu.push(m);res.status(201).json(m);});
app.patch('/partner/menu/:id',(req,res)=>{const m=menu.find(x=>x.id===req.params.id);if(!m)return res.status(404).json({error:'item_not_found'});['name','category','image'].forEach(k=>{if(req.body[k]!==undefined)m[k]=String(req.body[k]);});if(req.body.price!==undefined)m.price=Number(req.body.price);if(req.body.available!==undefined)m.available=!!req.body.available;res.json(m);});
app.get('/partner/orders',(req,res)=>res.json({orders:[...orders].sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)),serverTime:Date.now()}));
app.patch('/partner/orders/:id/status',(req,res)=>{const o=orders.find(x=>x.id===req.params.id);if(!o)return res.status(404).json({error:'order_not_found'});const s=String(req.body.status||'');if(!['ACCEPTED','REJECTED','PREPARING','READY','OUT_FOR_DELIVERY','DELIVERED'].includes(s))return res.status(400).json({error:'invalid_status'});o.status=s;o.updatedAt=now();if(s==='DELIVERED')ensurePayoutLedgers(o);res.json(o);});
app.get('/partner/finance',(req,res)=>{
  const delivered=orders.filter(o=>o.restaurantId===restaurant.id&&o.status==='DELIVERED');
  const gross=delivered.reduce((s,o)=>s+o.total,0),commission=Math.round(gross*.10*100)/100,processing=Math.round(gross*.0184*100)/100,net=Math.round((gross-commission-processing)*100)/100;
  const pending=partnerPayouts.filter(p=>p.status!=='PAID').reduce((s,p)=>s+p.net,0);
  res.json({restaurantId:restaurant.id,todaySales:gross,completedOrders:delivered.length,grossSales:gross,commission,processingFee:processing,netEarning:net,pendingSettlement:Math.round(pending*100)/100,payouts:partnerPayouts});
});
app.post('/partner/payout-account',(req,res)=>{const a=partnerAccounts[restaurant.id];a.upiId=String(req.body.upiId||'');a.bankLast4=String(req.body.bankLast4||'');a.payoutMethod=String(req.body.payoutMethod||'');a.payoutEnabled=!!(a.upiId||a.bankLast4);a.updatedAt=now();res.json(a);});
app.get('/partner/payout-account',(req,res)=>res.json(partnerAccounts[restaurant.id]));

app.post('/onboarding/restaurant',(req,res)=>{const x={id:'ONB'+String(++seq.onboarding).padStart(3,'0'),type:'RESTAURANT',name:String(req.body.restaurantName||''),ownerName:String(req.body.ownerName||''),mobile:String(req.body.mobile||''),address:String(req.body.address||''),status:'SUBMITTED',createdAt:now()};onboarding.unshift(x);res.status(201).json(x);});
app.post('/onboarding/rider',(req,res)=>{const x={id:'ONB'+String(++seq.onboarding).padStart(3,'0'),type:'RIDER',name:String(req.body.name||''),mobile:String(req.body.mobile||''),address:String(req.body.address||''),vehicle:String(req.body.vehicle||''),status:'SUBMITTED',createdAt:now()};onboarding.unshift(x);res.status(201).json(x);});
app.get('/onboarding/restaurant',(req,res)=>res.type('html').send('<html><body><h2>GAJAB RASODA Restaurant Onboarding</h2><p>Please submit from Partner onboarding form/API.</p></body></html>'));
app.get('/onboarding/rider',(req,res)=>res.type('html').send('<html><body><h2>GAJAB RASODA Rider Onboarding</h2><p>Please submit from Delivery onboarding form/API.</p></body></html>'));

app.get('/delivery/profile',(req,res)=>{const id=String(req.query.deliveryPartnerId||'GRD01');res.json({...riders[id],...(riderAccounts[id]||{deliveryPartnerId:id,payoutMethod:'',upiId:'',bankLast4:'',payoutEnabled:false})});});
app.post('/delivery/profile',(req,res)=>{const id=String(req.body.deliveryPartnerId||'GRD01');if(!riders[id])riders[id]={id,name:'',mobile:'',status:'ACTIVE',online:false,createdAt:now()};const a=riderAccounts[id]||{deliveryPartnerId:id};a.upiId=String(req.body.upiId||a.upiId||'');a.bankLast4=String(req.body.bankLast4||a.bankLast4||'');a.payoutMethod=String(req.body.payoutMethod||a.payoutMethod||'');a.payoutEnabled=!!(a.upiId||a.bankLast4);a.updatedAt=now();riderAccounts[id]=a;res.json(a);});
app.get('/delivery/orders',(req,res)=>{const id=String(req.query.deliveryPartnerId||'GRD01');res.json({orders:orders.filter(o=>['READY','OUT_FOR_DELIVERY'].includes(o.status)).filter(o=>!o.deliveryPartnerId||o.deliveryPartnerId===id).map(o=>({...o,riderEarning:riderEarning(o.deliveryDistanceKm),orderValueHidden:true})),serverTime:Date.now()});});
app.patch('/delivery/orders/:id/accept',(req,res)=>{const o=orders.find(x=>x.id===req.params.id);if(!o)return res.status(404).json({error:'order_not_found'});if(o.status!=='READY')return res.status(409).json({error:'order_not_ready'});const id=String(req.body.deliveryPartnerId||'GRD01');if(o.deliveryPartnerId&&o.deliveryPartnerId!==id)return res.status(409).json({error:'already_assigned'});o.deliveryPartnerId=id;o.updatedAt=now();res.json({...o,riderEarning:riderEarning(o.deliveryDistanceKm)});});
app.patch('/delivery/orders/:id/reject',(req,res)=>{const o=orders.find(x=>x.id===req.params.id);if(!o)return res.status(404).json({error:'order_not_found'});o.rejectedBy=o.rejectedBy||[];const id=String(req.body.deliveryPartnerId||'GRD01');if(!o.rejectedBy.includes(id))o.rejectedBy.push(id);res.json({ok:true});});
app.post('/delivery/orders/:id/picked-up',(req,res)=>{const o=orders.find(x=>x.id===req.params.id);if(!o)return res.status(404).json({error:'order_not_found'});if(o.deliveryPartnerId!==req.body.deliveryPartnerId)return res.status(403).json({error:'not_assigned'});o.status='OUT_FOR_DELIVERY';o.updatedAt=now();res.json(o);});
app.post('/delivery/orders/:id/verify-pin',(req,res)=>{const o=orders.find(x=>x.id===req.params.id);if(!o)return res.status(404).json({error:'order_not_found'});if(String(req.body.pin||'')!==String(o.deliveryPin))return res.status(400).json({error:'invalid_pin'});if(o.deliveryPartnerId&&req.body.deliveryPartnerId&&o.deliveryPartnerId!==req.body.deliveryPartnerId)return res.status(403).json({error:'wrong_rider'});o.status='DELIVERED';o.proof=String(req.body.proof||'');o.deliveredAt=now();o.updatedAt=now();ensurePayoutLedgers(o);res.json({ok:true,order:o,riderEarning:riderEarning(o.deliveryDistanceKm)});});
app.post('/delivery/location',(req,res)=>{const id=String(req.body.orderId||'');if(!id)return res.status(400).json({error:'orderId_required'});const lat=Number(req.body.lat),lng=Number(req.body.lng);if(!Number.isFinite(lat)||!Number.isFinite(lng))return res.status(400).json({error:'valid_location_required'});locations[id]={deliveryPartnerId:String(req.body.deliveryPartnerId||''),lat,lng,updatedAt:now(),shareUrl:`https://maps.google.com/?q=${lat},${lng}`};res.json({ok:true,tracking:locations[id]});});
app.get('/delivery/location/:id',(req,res)=>res.json(locations[req.params.id]||{}));
app.get('/delivery/history',(req,res)=>{const id=String(req.query.deliveryPartnerId||'GRD01');res.json({orders:orders.filter(o=>o.deliveryPartnerId===id&&o.status==='DELIVERED').map(o=>({...o,riderEarning:riderEarning(o.deliveryDistanceKm)}))});});
app.get('/delivery/earnings',(req,res)=>{const id=String(req.query.deliveryPartnerId||'GRD01');const done=orders.filter(o=>o.deliveryPartnerId===id&&o.status==='DELIVERED');res.json({deliveryPartnerId:id,totalEarnings:done.reduce((s,o)=>s+riderEarning(o.deliveryDistanceKm),0),completedDeliveries:done.length,payouts:riderPayouts.filter(p=>p.deliveryPartnerId===id)});});
app.get('/delivery/payouts',(req,res)=>{const id=String(req.query.deliveryPartnerId||'GRD01');res.json({payouts:riderPayouts.filter(p=>p.deliveryPartnerId===id)});});

app.post('/grievances',(req,res)=>{const x={id:'GRG'+String(++seq.grievance).padStart(4,'0'),source:String(req.body.source||'CUSTOMER'),sourceId:String(req.body.sourceId||''),orderId:String(req.body.orderId||''),category:String(req.body.category||'Other'),message:String(req.body.message||''),status:'OPEN',createdAt:now(),updatedAt:now()};grievances.unshift(x);res.status(201).json(x);});
app.get('/grievances',(req,res)=>res.json({grievances}));
app.patch('/admin/grievances/:id',(req,res)=>{const g=grievances.find(x=>x.id===req.params.id);if(!g)return res.status(404).json({error:'not_found'});if(req.body.status)g.status=String(req.body.status);if(req.body.adminReply!==undefined)g.adminReply=String(req.body.adminReply);g.updatedAt=now();res.json(g);});
app.post('/delivery/appeals',(req,res)=>{req.body.source='RIDER';req.body.sourceId=req.body.deliveryPartnerId||'';const x={id:'GRG'+String(++seq.grievance).padStart(4,'0'),source:'RIDER',sourceId:String(req.body.deliveryPartnerId||''),orderId:String(req.body.orderId||''),category:String(req.body.category||'Other'),message:String(req.body.message||''),status:'OPEN',createdAt:now(),updatedAt:now()};grievances.unshift(x);res.status(201).json(x);});
app.get('/delivery/appeals',(req,res)=>{const id=String(req.query.deliveryPartnerId||'');res.json({appeals:grievances.filter(g=>g.source==='RIDER'&&(!id||g.sourceId===id))});});
app.patch('/admin/delivery/appeals/:id',(req,res)=>{const g=grievances.find(x=>x.id===req.params.id);if(!g)return res.status(404).json({error:'not_found'});if(req.body.status)g.status=String(req.body.status);if(req.body.adminReply!==undefined)g.adminReply=String(req.body.adminReply);g.updatedAt=now();res.json(g);});

app.get('/admin/dashboard',(req,res)=>{
  const delivered=orders.filter(o=>o.status==='DELIVERED'),gross=delivered.reduce((s,o)=>s+o.total,0);
  res.json({customers:Object.keys(customers).length,riders:Object.keys(riders).length,restaurants:1,totalOrders:orders.length,openOrders:orders.filter(o=>o.status!=='DELIVERED'&&o.status!=='REJECTED').length,completedOrders:delivered.length,grossSales:gross,newOnboarding:onboarding.filter(x=>x.status==='SUBMITTED').length,openGrievances:grievances.filter(g=>g.status!=='RESOLVED').length,pendingPartnerPayouts:partnerPayouts.filter(p=>p.status!=='PAID').length,pendingRiderPayouts:riderPayouts.filter(p=>p.status!=='PAID').length});
});
app.get('/admin/customers',(req,res)=>res.json({customers:Object.values(customers)}));
app.get('/admin/riders',(req,res)=>res.json({riders:Object.values(riders).map(r=>({...r,payout:riderAccounts[r.id]||{}}))}));
app.get('/admin/orders',(req,res)=>res.json({orders}));
app.get('/admin/onboarding',(req,res)=>res.json({requests:onboarding}));
app.patch('/admin/onboarding/:id',(req,res)=>{const x=onboarding.find(a=>a.id===req.params.id);if(!x)return res.status(404).json({error:'not_found'});x.status=String(req.body.status||x.status);x.updatedAt=now();if(x.type==='RIDER'&&x.status==='APPROVED'){const id=nextId('rider','GRD');riders[id]={id,name:x.name,mobile:x.mobile,status:'ACTIVE',online:false,createdAt:now()};x.createdEntityId=id;}res.json(x);});
app.get('/admin/grievances',(req,res)=>res.json({grievances}));
app.get('/admin/payouts',(req,res)=>res.json({partnerPayouts,riderPayouts}));
app.patch('/admin/payouts/:type/:id',(req,res)=>{const list=req.params.type==='partner'?partnerPayouts:riderPayouts;const p=list.find(x=>x.id===req.params.id);if(!p)return res.status(404).json({error:'not_found'});p.status=String(req.body.status||p.status);p.reference=String(req.body.reference||p.reference||'');p.updatedAt=now();res.json(p);});

app.listen(PORT,()=>console.log('Gajab Rasoda backend v4 running on :'+PORT));
