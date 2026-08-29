const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const app = express();
app.use(cors());
app.use(express.json({limit:'3mb'}));
app.use(express.urlencoded({extended:true}));
const PORT = process.env.PORT || 3000;

let customerSeq=0, orderSeq=0, restaurantSeq=1, deliverySeq=1, appealSeq=0;
const id2=(prefix,n)=>prefix+String(n).padStart(2,'0');
const now=()=>new Date().toISOString();

const menu = [
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

const restaurant={id:'GRR01',name:'Gajab Rasoda',status:'ONLINE',menu};
const orders=[], appeals=[], partnerOnboarding=[], payouts=[];
const locations={}, customers={}, riderAccounts={};

function menuId(name){return 'dish_'+String(name||'item').toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'')+'_'+Date.now();}
function earningForKm(km){
  km=Math.max(0,Number(km||0));
  const base=30, included=3, extraRate=8;
  return Math.round((base + Math.max(0,km-included)*extraRate)*100)/100;
}
function tomorrowDate(){
  const d=new Date(); d.setDate(d.getDate()+1); return d.toISOString().slice(0,10);
}

app.get('/health',(req,res)=>res.json({ok:true,service:'Gajab Rasoda Backend',version:'consolidated-v3'}));

app.get('/customer/restaurant',(req,res)=>res.json(restaurant));
app.get('/customer/menu',(req,res)=>res.json({restaurantId:restaurant.id,status:restaurant.status,menu:restaurant.menu}));

app.get('/partner/restaurant',(req,res)=>res.json(restaurant));
app.patch('/partner/restaurant/status',(req,res)=>{
  const s=String(req.body.status||'').toUpperCase();
  if(!['ONLINE','OFFLINE'].includes(s)) return res.status(400).json({error:'invalid_status'});
  restaurant.status=s; res.json(restaurant);
});
app.patch('/partner/menu/:itemId/availability',(req,res)=>{
  const item=menu.find(x=>x.id===req.params.itemId);
  if(!item) return res.status(404).json({error:'item_not_found'});
  item.available=!!req.body.available; res.json(item);
});
app.post('/partner/menu',(req,res)=>{
  const name=String(req.body.name||'').trim(), price=Number(req.body.price||0);
  if(!name || price<=0) return res.status(400).json({error:'name_and_price_required'});
  const item={id:menuId(name),name,price,available:req.body.available!==false,category:String(req.body.category||'VEG'),image:String(req.body.image||'')};
  menu.push(item); res.status(201).json(item);
});
app.patch('/partner/menu/:itemId',(req,res)=>{
  const item=menu.find(x=>x.id===req.params.itemId);
  if(!item) return res.status(404).json({error:'item_not_found'});
  if(req.body.name!==undefined)item.name=String(req.body.name);
  if(req.body.price!==undefined)item.price=Number(req.body.price);
  if(req.body.category!==undefined)item.category=String(req.body.category);
  if(req.body.image!==undefined)item.image=String(req.body.image);
  if(req.body.available!==undefined)item.available=!!req.body.available;
  res.json(item);
});

app.post('/customer/profile',(req,res)=>{
  const {name,phone,address}=req.body||{};
  if(!phone) return res.status(400).json({error:'phone_required'});
  let c=customers[phone];
  if(!c)c=customers[phone]={customerId:id2('GRC',++customerSeq),name:name||'',phone,addresses:[],createdAt:now()};
  if(name)c.name=name;
  if(address && !c.addresses.includes(address))c.addresses.unshift(address);
  c.updatedAt=now(); customers[phone]=c; res.json(c);
});
app.get('/customer/profile/:phone',(req,res)=>{
  const c=customers[req.params.phone]; if(!c)return res.status(404).json({error:'customer_not_found'}); res.json(c);
});
app.post('/customer/profile/:phone/addresses',(req,res)=>{
  const c=customers[req.params.phone]; if(!c)return res.status(404).json({error:'customer_not_found'});
  const a=String(req.body.address||'').trim();if(!a)return res.status(400).json({error:'address_required'});
  if(!c.addresses.includes(a))c.addresses.unshift(a);c.updatedAt=now();res.json(c);
});

app.post('/customer/orders',(req,res)=>{
  if(restaurant.status!=='ONLINE')return res.status(409).json({error:'restaurant_offline'});
  const {customerName,customerPhone,customerId,address,items}=req.body||{};
  if(!Array.isArray(items)||!items.length)return res.status(400).json({error:'items_required'});
  const normalized=[];let total=0;
  for(const raw of items){
    const item=menu.find(x=>x.id===raw.id) || menu.find(x=>x.name===raw.name);
    if(!item)return res.status(400).json({error:'unknown_item',item:raw.id||raw.name});
    if(!item.available)return res.status(409).json({error:'item_unavailable',item:item.id});
    const qty=Math.max(1,Number(raw.qty||1));
    normalized.push({id:item.id,name:item.name,qty,price:item.price,category:item.category,image:item.image||''});
    total+=item.price*qty;
  }
  const order={
    id:id2('GRO',++orderSeq),restaurantId:restaurant.id,customerId:customerId||'',
    customerName:customerName||'Customer',customerPhone:customerPhone||'',address:address||'',
    items:normalized,total,status:'PLACED',deliveryPin:String(Math.floor(1000+Math.random()*9000)),
    deliveryPartnerId:'',deliveryDistanceKm:Number(req.body.deliveryDistanceKm||3),
    createdAt:now(),updatedAt:now()
  };
  orders.unshift(order);res.status(201).json(order);
});

app.get('/partner/orders',(req,res)=>res.json({orders:[...orders].sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)),serverTime:Date.now()}));
app.patch('/partner/orders/:id/status',(req,res)=>{
  const o=orders.find(x=>x.id===req.params.id);if(!o)return res.status(404).json({error:'order_not_found'});
  const allowed=['ACCEPTED','REJECTED','PREPARING','READY','OUT_FOR_DELIVERY','DELIVERED'];
  if(!allowed.includes(req.body.status))return res.status(400).json({error:'invalid_status'});
  o.status=req.body.status;if(req.body.deliveryPartnerId)o.deliveryPartnerId=req.body.deliveryPartnerId;o.updatedAt=now();res.json(o);
});
app.get('/customer/orders/:id',(req,res)=>{
  const o=orders.find(x=>x.id===req.params.id);if(!o)return res.status(404).json({error:'order_not_found'});
  res.json({...o,tracking:locations[o.id]||null,restaurantStatus:restaurant.status});
});
app.get('/customer/orders',(req,res)=>{
  const cid=String(req.query.customerId||''), phone=String(req.query.phone||'');
  const data=orders.filter(o=>(cid&&o.customerId===cid)||(phone&&o.customerPhone===phone));
  res.json({orders:data});
});

app.get('/delivery/profile',(req,res)=>{
  const riderId=req.query.deliveryPartnerId||'GRD01';
  const acct=riderAccounts[riderId]||{deliveryPartnerId:riderId,payoutMethod:'',upiId:'',bankLast4:'',payoutEnabled:false};
  res.json(acct);
});
app.post('/delivery/profile',(req,res)=>{
  const riderId=req.body.deliveryPartnerId||'GRD01';
  const acct=riderAccounts[riderId]||{deliveryPartnerId:riderId};
  if(req.body.upiId!==undefined)acct.upiId=String(req.body.upiId);
  if(req.body.bankLast4!==undefined)acct.bankLast4=String(req.body.bankLast4);
  if(req.body.payoutMethod!==undefined)acct.payoutMethod=String(req.body.payoutMethod);
  acct.payoutEnabled=!!(acct.upiId||acct.bankLast4);
  acct.updatedAt=now();riderAccounts[riderId]=acct;res.json(acct);
});
app.get('/delivery/orders',(req,res)=>{
  const rider=req.query.deliveryPartnerId||'';
  const data=orders.filter(o=>o.status==='READY'||o.status==='OUT_FOR_DELIVERY').filter(o=>!rider||!o.deliveryPartnerId||o.deliveryPartnerId===rider)
    .map(o=>({...o,riderEarning:earningForKm(o.deliveryDistanceKm),orderValueHidden:true}));
  res.json({orders:data,serverTime:Date.now()});
});
app.patch('/delivery/orders/:id/accept',(req,res)=>{
  const o=orders.find(x=>x.id===req.params.id);if(!o)return res.status(404).json({error:'order_not_found'});
  if(o.status!=='READY')return res.status(409).json({error:'order_not_ready'});
  if(o.deliveryPartnerId && o.deliveryPartnerId!==req.body.deliveryPartnerId)return res.status(409).json({error:'already_assigned'});
  o.deliveryPartnerId=req.body.deliveryPartnerId||'GRD01';o.updatedAt=now();res.json({...o,riderEarning:earningForKm(o.deliveryDistanceKm)});
});
app.patch('/delivery/orders/:id/reject',(req,res)=>{
  const o=orders.find(x=>x.id===req.params.id);if(!o)return res.status(404).json({error:'order_not_found'});
  if(o.status!=='READY')return res.status(409).json({error:'order_not_ready'});
  o.rejectedBy=o.rejectedBy||[]; const rider=req.body.deliveryPartnerId||'GRD01';
  if(!o.rejectedBy.includes(rider))o.rejectedBy.push(rider);res.json({ok:true});
});
app.post('/delivery/orders/:id/picked-up',(req,res)=>{
  const o=orders.find(x=>x.id===req.params.id);if(!o)return res.status(404).json({error:'order_not_found'});
  if(o.deliveryPartnerId!==req.body.deliveryPartnerId)return res.status(403).json({error:'not_assigned'});
  o.status='OUT_FOR_DELIVERY';o.pickedUpAt=now();o.updatedAt=now();res.json(o);
});
app.post('/delivery/orders/:id/verify-pin',(req,res)=>{
  const o=orders.find(x=>x.id===req.params.id);if(!o)return res.status(404).json({error:'order_not_found'});
  if(String(req.body.pin||'')!==String(o.deliveryPin))return res.status(400).json({error:'invalid_pin'});
  if(o.deliveryPartnerId && req.body.deliveryPartnerId && o.deliveryPartnerId!==req.body.deliveryPartnerId)return res.status(403).json({error:'wrong_rider'});
  o.status='DELIVERED';o.deliveryPartnerId=req.body.deliveryPartnerId||o.deliveryPartnerId;o.proof=req.body.proof||'';o.deliveredAt=now();o.updatedAt=now();
  const earning=earningForKm(o.deliveryDistanceKm);
  if(!payouts.some(p=>p.orderId===o.id)){
    payouts.unshift({id:'PAY'+String(payouts.length+1).padStart(4,'0'),orderId:o.id,deliveryPartnerId:o.deliveryPartnerId,amount:earning,status:'SCHEDULED_T_PLUS_1',dueDate:tomorrowDate(),createdAt:now()});
  }
  res.json({ok:true,order:o,riderEarning:earning});
});
app.post('/delivery/location',(req,res)=>{
  const {orderId,deliveryPartnerId,lat,lng}=req.body||{};if(!orderId)return res.status(400).json({error:'orderId_required'});
  if(!Number.isFinite(Number(lat))||!Number.isFinite(Number(lng)))return res.status(400).json({error:'valid_location_required'});
  locations[orderId]={deliveryPartnerId:deliveryPartnerId||'',lat:Number(lat),lng:Number(lng),updatedAt:now(),shareUrl:`https://maps.google.com/?q=${Number(lat)},${Number(lng)}`};
  res.json({ok:true,tracking:locations[orderId]});
});
app.get('/delivery/location/:orderId',(req,res)=>res.json(locations[req.params.orderId]||{}));
app.get('/delivery/history',(req,res)=>{
  const rider=req.query.deliveryPartnerId||'GRD01';
  const data=orders.filter(o=>o.deliveryPartnerId===rider&&o.status==='DELIVERED').map(o=>({...o,riderEarning:earningForKm(o.deliveryDistanceKm)}));
  res.json({orders:data});
});
app.get('/delivery/earnings',(req,res)=>{
  const rider=req.query.deliveryPartnerId||'GRD01';
  const done=orders.filter(o=>o.deliveryPartnerId===rider&&o.status==='DELIVERED');
  const total=done.reduce((s,o)=>s+earningForKm(o.deliveryDistanceKm),0);
  const riderPayouts=payouts.filter(p=>p.deliveryPartnerId===rider);
  res.json({deliveryPartnerId:rider,totalEarnings:Math.round(total*100)/100,completedDeliveries:done.length,payouts:riderPayouts});
});
app.get('/delivery/payouts',(req,res)=>{
  const rider=req.query.deliveryPartnerId||'GRD01';res.json({payouts:payouts.filter(p=>p.deliveryPartnerId===rider)});
});
app.post('/admin/payouts/run-due',(req,res)=>{
  const today=new Date().toISOString().slice(0,10);let changed=0;
  for(const p of payouts){
    if(p.status==='SCHEDULED_T_PLUS_1'&&p.dueDate<=today){p.status='DUE_FOR_RAZORPAYX';p.updatedAt=now();changed++;}
  }
  res.json({ok:true,changed,note:'Actual money transfer requires configured RazorpayX payout credentials/fund account.'});
});

app.post('/delivery/appeals',(req,res)=>{
  const t={id:'GRA'+String(++appealSeq).padStart(2,'0'),deliveryPartnerId:req.body.deliveryPartnerId||'',orderId:req.body.orderId||'',category:req.body.category||'Other',message:req.body.message||'',status:'OPEN',createdAt:now(),updatedAt:now()};
  appeals.unshift(t);res.status(201).json(t);
});
app.get('/delivery/appeals',(req,res)=>{const r=req.query.deliveryPartnerId;res.json({appeals:r?appeals.filter(x=>x.deliveryPartnerId===r):appeals});});
app.patch('/admin/delivery/appeals/:id',(req,res)=>{
  const a=appeals.find(x=>x.id===req.params.id);if(!a)return res.status(404).json({error:'appeal_not_found'});
  a.status=req.body.status||a.status;a.adminReply=req.body.adminReply||a.adminReply||'';a.updatedAt=now();res.json(a);
});

app.get('/onboarding/restaurant',(req,res)=>res.type('html').send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Join GAJAB RASODA</title><style>body{font-family:Arial;background:#111;color:#fff;padding:24px;max-width:560px;margin:auto}input,textarea,button{width:100%;padding:14px;margin:8px 0;border-radius:12px;border:0;box-sizing:border-box}button{background:#e51e24;color:#fff;font-weight:700}.gold{color:#e8ab2e}</style></head><body><h1 class="gold">GAJAB RASODA</h1><h2>Restaurant Partner Onboarding</h2><form method="post" action="/partner/onboarding"><input name="restaurantName" placeholder="Restaurant Name" required><input name="ownerName" placeholder="Owner Name" required><input name="mobile" placeholder="Mobile Number" required><textarea name="address" placeholder="Restaurant Address" required></textarea><button type="submit">Submit Onboarding Request</button></form></body></html>`));
app.post('/partner/onboarding',(req,res)=>{
  const x={id:'ONB'+String(partnerOnboarding.length+1).padStart(3,'0'),restaurantName:req.body.restaurantName||'',ownerName:req.body.ownerName||'',mobile:req.body.mobile||'',address:req.body.address||'',status:'SUBMITTED',createdAt:now()};
  partnerOnboarding.unshift(x);if(req.is('application/json'))return res.status(201).json(x);
  res.type('html').send(`<html><body style="font-family:Arial;padding:30px"><h2>Request Submitted ✓</h2><p>Your onboarding ID is <b>${x.id}</b></p></body></html>`);
});
app.get('/admin/partner/onboarding',(req,res)=>res.json({requests:partnerOnboarding}));

app.listen(PORT,()=>console.log(`Gajab Rasoda backend running on :${PORT}`));
