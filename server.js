const express=require('express');
const cors=require('cors');
const crypto=require('crypto');
const https=require('https');
let Pool=null;try{Pool=require('pg').Pool;}catch(e){}
const dbPool=(Pool&&process.env.DATABASE_URL)?new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.DATABASE_SSL==='false'?false:{rejectUnauthorized:false}}):null;
const app=express();
const appVersions={
  customer:{app:'customer',latestVersionCode:15,minSupportedVersionCode:10,latestVersionName:'1.3.1',forceUpdate:false,updateUrl:'',releaseNotes:'GAJAB RASODA Version 1.0'},
  partner:{app:'partner',latestVersionCode:15,minSupportedVersionCode:10,latestVersionName:'1.3.1',forceUpdate:false,updateUrl:'',releaseNotes:'GAJAB RASODA Partner Version 1.0'},
  delivery:{app:'delivery',latestVersionCode:15,minSupportedVersionCode:10,latestVersionName:'1.3.1',forceUpdate:false,updateUrl:'',releaseNotes:'GAJAB RASODA Delivery Version 1.0'},
  company:{app:'company',latestVersionCode:15,minSupportedVersionCode:10,latestVersionName:'1.3.1',forceUpdate:false,updateUrl:'',releaseNotes:'GAJAB RASODA Company Version 1.0'}
};

app.use(cors());
app.post('/webhooks/razorpay',express.raw({type:'application/json'}),(req,res)=>{
  try{
    const secret=process.env.RAZORPAY_WEBHOOK_SECRET||'';
    if(!secret)return res.status(503).send('webhook_not_configured');
    const sig=String(req.headers['x-razorpay-signature']||'');
    const expected=crypto.createHmac('sha256',secret).update(req.body).digest('hex');
    if(!sig||expected.length!==sig.length||!crypto.timingSafeEqual(Buffer.from(expected),Buffer.from(sig)))return res.status(401).send('invalid_signature');
    const event=JSON.parse(req.body.toString('utf8'));

    if(event.event==='payment_link.paid'){
      const pl=event.payload&&event.payload.payment_link&&event.payload.payment_link.entity;
      const pay=event.payload&&event.payload.payment&&event.payload.payment.entity;
      if(pl){
        const ref=String(pl.reference_id||'');
        const o=orders.find(x=>x.id===ref || x.razorpayPaymentLinkId===pl.id);
        if(o){
          const expectedPaise=Math.round(o.total*100);
          const paidPaise=Number(pl.amount_paid||0);
          const linkAmount=Number(pl.amount||0);
          if(pl.status==='paid' && paidPaise===expectedPaise && linkAmount===expectedPaise){
            o.paymentStatus='PAID';o.paymentId=pay&&pay.id||'';o.paymentReference=ref;o.status='PLACED';stampOrder(o,'PLACED');
          }else{
            o.paymentStatus='PAYMENT_REVIEW';o.paymentReviewReason='amount_or_status_mismatch';o.updatedAt=now();
          }
        }
      }
    }else if(event.event==='payment.captured'){
      const ent=event.payload&&event.payload.payment&&event.payload.payment.entity;
      if(ent){
        const o=orders.find(x=>x.razorpayOrderId===ent.order_id);
        if(o && Number(ent.amount||0)===Math.round(o.total*100)){
          o.paymentStatus='PAID';o.paymentId=ent.id;o.status='PLACED';stampOrder(o,'PLACED');
        }
      }
    }
    res.send('ok');
  }catch(e){res.status(400).send('bad_webhook');}
});
app.use(express.json({limit:'4mb'}));
app.use(express.urlencoded({extended:true}));
app.use((req,res,next)=>{
  if(req.method!=='GET'&&req.method!=='HEAD'&&req.method!=='OPTIONS'){
    res.on('finish',()=>{if(res.statusCode<500)schedulePersist();});
  }
  next();
});

const PORT=process.env.PORT||3000;
const now=()=>new Date().toISOString();
function stampOrder(o,event){
  const t=now(); o.updatedAt=t;
  if(!o.timeline)o.timeline={};
  const key=String(event||'').toUpperCase();
  const map={PAYMENT_PENDING:'paymentPendingAt',PAID:'paymentConfirmedAt',PLACED:'placedAt',ACCEPTED:'acceptedAt',PREPARING:'preparingAt',READY:'readyAt',DELIVERY_ACCEPTED:'deliveryAcceptedAt',PICKED_UP:'pickedUpAt',OUT_FOR_DELIVERY:'outForDeliveryAt',DELIVERED:'deliveredAt',REJECTED:'rejectedAt'};
  if(map[key]&&!o.timeline[map[key]])o.timeline[map[key]]=t;
  return t;
}

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


function snapshotState(){return {seq,menu,restaurantMeta:{status:restaurant.status,activationDate:restaurant.activationDate},customers,riders,orders,onboarding,grievances,partnerPayouts,riderPayouts,locations,riderAccounts,partnerAccounts,appVersions};}

async function ensureDbSchema(){
  if(!dbPool)return;
  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS app_state_meta(
      id INTEGER PRIMARY KEY CHECK(id=1),
      seq JSONB NOT NULL DEFAULT '{}'::jsonb,
      restaurant_meta JSONB NOT NULL DEFAULT '{}'::jsonb,
      locations JSONB NOT NULL DEFAULT '{}'::jsonb,
      rider_accounts JSONB NOT NULL DEFAULT '{}'::jsonb,
      partner_accounts JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS customers(
      customer_id TEXT PRIMARY KEY,
      phone TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      created_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ,
      raw JSONB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS riders(
      rider_id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      mobile TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      online BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ,
      raw JSONB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS menu_items(
      item_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      price NUMERIC(12,2) NOT NULL,
      available BOOLEAN NOT NULL DEFAULT TRUE,
      image TEXT NOT NULL DEFAULT '',
      raw JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS orders(
      order_id TEXT PRIMARY KEY,
      customer_id TEXT,
      customer_phone TEXT,
      restaurant_id TEXT,
      status TEXT NOT NULL,
      payment_status TEXT NOT NULL,
      total NUMERIC(12,2) NOT NULL,
      delivery_partner_id TEXT,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      raw JSONB NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_orders_customer_phone_created ON orders(customer_phone,created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_orders_status_created ON orders(status,created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_orders_payment_status_created ON orders(payment_status,created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_orders_rider_created ON orders(delivery_partner_id,created_at DESC);

    CREATE TABLE IF NOT EXISTS order_events(
      id BIGSERIAL PRIMARY KEY,
      order_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      event_time TIMESTAMPTZ NOT NULL,
      source TEXT NOT NULL DEFAULT 'APP',
      UNIQUE(order_id,event_type,event_time)
    );
    CREATE INDEX IF NOT EXISTS idx_order_events_order_time ON order_events(order_id,event_time);

    CREATE TABLE IF NOT EXISTS reviews(
      review_id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      customer_id TEXT,
      restaurant_id TEXT,
      rider_id TEXT,
      food_rating INTEGER,
      rider_rating INTEGER,
      comment TEXT,
      created_at TIMESTAMPTZ NOT NULL,
      raw JSONB NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_reviews_one_per_order ON reviews(order_id);

    CREATE TABLE IF NOT EXISTS grievances(
      grievance_id TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ,
      status TEXT,
      raw JSONB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS partner_payouts(
      payout_id TEXT PRIMARY KEY,
      order_id TEXT,
      due_date DATE,
      status TEXT,
      raw JSONB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS rider_payouts(
      payout_id TEXT PRIMARY KEY,
      order_id TEXT,
      due_date DATE,
      status TEXT,
      raw JSONB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS app_versions(
      app TEXT PRIMARY KEY,
      raw JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS app_audit_log(
      id BIGSERIAL PRIMARY KEY,
      action TEXT NOT NULL,
      entity_type TEXT,
      entity_id TEXT,
      at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      detail JSONB NOT NULL DEFAULT '{}'::jsonb
    
    );
    CREATE TABLE IF NOT EXISTS idempotency_keys(
      idem_key TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      response_code INTEGER NOT NULL,
      response_body JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_idempotency_expiry ON idempotency_keys(expires_at);

    CREATE TABLE IF NOT EXISTS auth_sessions(
      session_id TEXT PRIMARY KEY,
      actor_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_actor ON auth_sessions(actor_type,actor_id);

    CREATE TABLE IF NOT EXISTS otp_attempts(
      phone TEXT PRIMARY KEY,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      window_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      blocked_until TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS notifications(
      notification_id BIGSERIAL PRIMARY KEY,
      actor_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      entity_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      read_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_notifications_actor_created ON notifications(actor_type,actor_id,created_at DESC);

    CREATE TABLE IF NOT EXISTS serviceability_rules(
      rule_id BIGSERIAL PRIMARY KEY,
      state TEXT NOT NULL,
      city TEXT NOT NULL,
      zone TEXT,
      pincode TEXT,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      delivery_fee NUMERIC(12,2) NOT NULL DEFAULT 0,
      min_order NUMERIC(12,2) NOT NULL DEFAULT 0,
      max_distance_km NUMERIC(8,2),
      raw JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_serviceability_city_pin ON serviceability_rules(city,pincode,enabled);

    CREATE TABLE IF NOT EXISTS refunds(
      refund_id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL,
      payment_reference TEXT,
      amount NUMERIC(12,2) NOT NULL,
      status TEXT NOT NULL,
      reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      raw JSONB NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE INDEX IF NOT EXISTS idx_refunds_order ON refunds(order_id,created_at DESC);

    CREATE TABLE IF NOT EXISTS support_tickets(
      ticket_id TEXT PRIMARY KEY,
      order_id TEXT,
      actor_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      category TEXT NOT NULL,
      message TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'OPEN',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      raw JSONB NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE INDEX IF NOT EXISTS idx_support_order ON support_tickets(order_id,created_at DESC);

    CREATE TABLE IF NOT EXISTS review_moderation(
      review_id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'VISIBLE',
      reason TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS system_config(
      config_key TEXT PRIMARY KEY,
      config_value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

function safeDate(v){return v||now();}
async function persistNormalizedState(){
  if(!dbPool||persistBusy)return;
  persistBusy=true;
  const client=await dbPool.connect();
  try{
    await client.query('BEGIN');
    await client.query(`INSERT INTO app_state_meta(id,seq,restaurant_meta,locations,rider_accounts,partner_accounts,updated_at)
      VALUES(1,$1::jsonb,$2::jsonb,$3::jsonb,$4::jsonb,$5::jsonb,NOW())
      ON CONFLICT(id) DO UPDATE SET seq=EXCLUDED.seq,restaurant_meta=EXCLUDED.restaurant_meta,locations=EXCLUDED.locations,
      rider_accounts=EXCLUDED.rider_accounts,partner_accounts=EXCLUDED.partner_accounts,updated_at=NOW()`,
      [JSON.stringify(seq),JSON.stringify({status:restaurant.status,activationDate:restaurant.activationDate}),JSON.stringify(locations),JSON.stringify(riderAccounts),JSON.stringify(partnerAccounts)]);

    for(const c of Object.values(customers)){
      await client.query(`INSERT INTO customers(customer_id,phone,name,status,created_at,updated_at,raw)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)
        ON CONFLICT(customer_id) DO UPDATE SET phone=EXCLUDED.phone,name=EXCLUDED.name,status=EXCLUDED.status,updated_at=EXCLUDED.updated_at,raw=EXCLUDED.raw`,
        [c.customerId,c.phone,c.name||'',c.status||'ACTIVE',safeDate(c.createdAt),safeDate(c.updatedAt||c.createdAt),JSON.stringify(c)]);
    }
    for(const r of Object.values(riders)){
      await client.query(`INSERT INTO riders(rider_id,name,mobile,status,online,created_at,updated_at,raw)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
        ON CONFLICT(rider_id) DO UPDATE SET name=EXCLUDED.name,mobile=EXCLUDED.mobile,status=EXCLUDED.status,online=EXCLUDED.online,updated_at=EXCLUDED.updated_at,raw=EXCLUDED.raw`,
        [r.id,r.name||'',r.mobile||'',r.status||'ACTIVE',!!r.online,safeDate(r.createdAt),safeDate(r.updatedAt||r.createdAt),JSON.stringify(r)]);
    }
    for(const m of menu){
      await client.query(`INSERT INTO menu_items(item_id,name,category,price,available,image,raw,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,NOW())
        ON CONFLICT(item_id) DO UPDATE SET name=EXCLUDED.name,category=EXCLUDED.category,price=EXCLUDED.price,available=EXCLUDED.available,image=EXCLUDED.image,raw=EXCLUDED.raw,updated_at=NOW()`,
        [m.id,m.name,m.category||'VEG',Number(m.price||0),!!m.available,m.image||'',JSON.stringify(m)]);
    }
    for(const o of orders){
      await client.query(`INSERT INTO orders(order_id,customer_id,customer_phone,restaurant_id,status,payment_status,total,delivery_partner_id,created_at,updated_at,raw)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
        ON CONFLICT(order_id) DO UPDATE SET customer_id=EXCLUDED.customer_id,customer_phone=EXCLUDED.customer_phone,restaurant_id=EXCLUDED.restaurant_id,
        status=EXCLUDED.status,payment_status=EXCLUDED.payment_status,total=EXCLUDED.total,delivery_partner_id=EXCLUDED.delivery_partner_id,updated_at=EXCLUDED.updated_at,raw=EXCLUDED.raw`,
        [o.id,o.customerId||'',o.customerPhone||'',o.restaurantId||restaurant.id,o.status||'',o.paymentStatus||'',Number(o.total||0),o.deliveryPartnerId||'',safeDate(o.createdAt),safeDate(o.updatedAt||o.createdAt),JSON.stringify(o)]);
      if(o.timeline){
        const map={paymentPendingAt:'PAYMENT_PENDING',paymentConfirmedAt:'PAID',placedAt:'PLACED',acceptedAt:'ACCEPTED',preparingAt:'PREPARING',readyAt:'READY',deliveryAcceptedAt:'DELIVERY_ACCEPTED',pickedUpAt:'PICKED_UP',outForDeliveryAt:'OUT_FOR_DELIVERY',deliveredAt:'DELIVERED',rejectedAt:'REJECTED'};
        for(const [k,eventType] of Object.entries(map)){
          if(o.timeline[k]){
            await client.query(`INSERT INTO order_events(order_id,event_type,event_time,source)
              VALUES($1,$2,$3,'APP') ON CONFLICT(order_id,event_type,event_time) DO NOTHING`,[o.id,eventType,o.timeline[k]]);
          }
        }
      }
    }
    for(const g of grievances){
      await client.query(`INSERT INTO grievances(grievance_id,created_at,status,raw) VALUES($1,$2,$3,$4::jsonb)
        ON CONFLICT(grievance_id) DO UPDATE SET status=EXCLUDED.status,raw=EXCLUDED.raw`,
        [g.id||g.grievanceId,safeDate(g.createdAt),g.status||'OPEN',JSON.stringify(g)]);
    }
    for(const x of partnerPayouts){
      await client.query(`INSERT INTO partner_payouts(payout_id,order_id,due_date,status,raw) VALUES($1,$2,$3,$4,$5::jsonb)
        ON CONFLICT(payout_id) DO UPDATE SET status=EXCLUDED.status,raw=EXCLUDED.raw`,
        [x.id,x.orderId||'',x.dueDate||null,x.status||'',JSON.stringify(x)]);
    }
    for(const x of riderPayouts){
      await client.query(`INSERT INTO rider_payouts(payout_id,order_id,due_date,status,raw) VALUES($1,$2,$3,$4,$5::jsonb)
        ON CONFLICT(payout_id) DO UPDATE SET status=EXCLUDED.status,raw=EXCLUDED.raw`,
        [x.id,x.orderId||'',x.dueDate||null,x.status||'',JSON.stringify(x)]);
    }
    for(const [appName,v] of Object.entries(appVersions)){
      await client.query(`INSERT INTO app_versions(app,raw,updated_at) VALUES($1,$2::jsonb,NOW())
        ON CONFLICT(app) DO UPDATE SET raw=EXCLUDED.raw,updated_at=NOW()`,[appName,JSON.stringify(v)]);
    }
    await client.query('COMMIT');
  }catch(e){
    await client.query('ROLLBACK');
    console.error('normalized persist failed',e.message);
  }finally{
    client.release();persistBusy=false;
  }
}
async function persistState(){return persistNormalizedState();}

async function initPersistentState(){
  if(!dbPool){console.log('DATABASE_URL not set: running memory-only');return;}
  await ensureDbSchema();
  const meta=await dbPool.query('SELECT * FROM app_state_meta WHERE id=1');
  if(meta.rows.length){
    const r=meta.rows[0];
    if(r.seq)seq=Object.assign(seq,r.seq);
    if(r.restaurant_meta){restaurant.status=r.restaurant_meta.status||restaurant.status;restaurant.activationDate=r.restaurant_meta.activationDate||restaurant.activationDate;}
    if(r.locations)Object.assign(locations,r.locations);
    if(r.rider_accounts)Object.assign(riderAccounts,r.rider_accounts);
    if(r.partner_accounts)Object.assign(partnerAccounts,r.partner_accounts);
  }

  const m=await dbPool.query('SELECT raw FROM menu_items ORDER BY item_id');
  if(m.rows.length){menu.splice(0,menu.length,...m.rows.map(x=>x.raw));restaurant.menu=menu;}

  const c=await dbPool.query('SELECT raw FROM customers');
  for(const row of c.rows){const x=row.raw;if(x&&x.phone)customers[x.phone]=x;}

  const rr=await dbPool.query('SELECT raw FROM riders');
  for(const row of rr.rows){const x=row.raw;if(x&&x.id)riders[x.id]=x;}

  const oo=await dbPool.query('SELECT raw FROM orders ORDER BY created_at DESC');
  if(oo.rows.length)orders.splice(0,orders.length,...oo.rows.map(x=>x.raw));

  const gg=await dbPool.query('SELECT raw FROM grievances ORDER BY created_at DESC');
  if(gg.rows.length)grievances.splice(0,grievances.length,...gg.rows.map(x=>x.raw));

  const pp=await dbPool.query('SELECT raw FROM partner_payouts ORDER BY payout_id DESC');
  if(pp.rows.length)partnerPayouts.splice(0,partnerPayouts.length,...pp.rows.map(x=>x.raw));

  const rp=await dbPool.query('SELECT raw FROM rider_payouts ORDER BY payout_id DESC');
  if(rp.rows.length)riderPayouts.splice(0,riderPayouts.length,...rp.rows.map(x=>x.raw));

  const av=await dbPool.query('SELECT app,raw FROM app_versions');
  for(const row of av.rows)if(appVersions[row.app])Object.assign(appVersions[row.app],row.raw);

  console.log('Normalized PostgreSQL state loaded');
}
let persistBusy=false;
let persistTimer=null;
function schedulePersist(){
  if(!dbPool)return;
  clearTimeout(persistTimer);
  persistTimer=setTimeout(()=>persistState(),100);
}


async function audit(action,entityType,entityId,detail){
  if(!dbPool)return;
  try{await dbPool.query('INSERT INTO app_audit_log(action,entity_type,entity_id,detail) VALUES($1,$2,$3,$4::jsonb)',
    [action||'UNKNOWN',entityType||'',entityId||'',JSON.stringify(detail||{})]);}catch(e){}
}
async function cleanupExpiredSecurityRows(){
  if(!dbPool)return;
  try{
    await dbPool.query("DELETE FROM idempotency_keys WHERE expires_at<NOW()");
    await dbPool.query("DELETE FROM auth_sessions WHERE expires_at<NOW() OR revoked_at IS NOT NULL AND revoked_at<NOW()-INTERVAL '30 days'");
  }catch(e){}
}
setInterval(cleanupExpiredSecurityRows,60*60*1000).unref();



function nextId(k,p){seq[k]++;return id2(p,seq[k]);}
function nextWorkingDay(){
  const d=new Date();d.setDate(d.getDate()+1);
  while(d.getDay()===0||d.getDay()===6)d.setDate(d.getDate()+1);
  return d.toISOString().slice(0,10);
}
function riderEarning(km){km=Math.max(0,Number(km||0));return Math.round((30+Math.max(0,km-3)*8)*100)/100;}
function partnerSettlement(order){
  const gross=Number(order.total||0);
  const activated=new Date(restaurant.activationDate).getTime();
  const ageDays=Math.floor((Date.now()-activated)/(24*60*60*1000));
  const commissionRate=ageDays<15?0:0.10;
  const commission=Math.round(gross*commissionRate*100)/100;
  const processingRate=0.0184;
  const processing=Math.round(gross*processingRate*100)/100;
  const deliveryCharge=riderEarning(order.deliveryDistanceKm);
  const net=Math.round((gross-commission-processing-deliveryCharge)*100)/100;
  return {gross,commissionRate,commission,processingRate,processing,deliveryCharge,net,freeCommissionDaysRemaining:Math.max(0,15-ageDays)};
}
function ensurePayoutLedgers(order){
  if(!riderPayouts.some(x=>x.orderId===order.id) && order.deliveryPartnerId){
    riderPayouts.unshift({id:'GRDP'+String(++seq.riderPayout).padStart(4,'0'),orderId:order.id,deliveryPartnerId:order.deliveryPartnerId,amount:riderEarning(order.deliveryDistanceKm),status:'SCHEDULED_T_PLUS_1',dueDate:nextWorkingDay(),createdAt:now()});
  }
  if(!partnerPayouts.some(x=>x.orderId===order.id)){
    const x=partnerSettlement(order);
    partnerPayouts.unshift({id:'GRPP'+String(++seq.partnerPayout).padStart(4,'0'),orderId:order.id,restaurantId:order.restaurantId, ...x,status:'SCHEDULED_T_PLUS_1',dueDate:nextWorkingDay(),createdAt:now()});
  }
}

app.get('/health',(req,res)=>res.json({ok:true,service:'Gajab Rasoda Backend',version:'1.5',database:dbPool?'configured':'memory-only'}));
app.get('/health/db',async(req,res)=>{
  if(!dbPool)return res.status(503).json({ok:false,database:'not_configured'});
  try{
    const r=await dbPool.query('SELECT NOW() AS server_time');
    const counts=await dbPool.query(`SELECT
      (SELECT COUNT(*) FROM customers) customers,
      (SELECT COUNT(*) FROM orders) orders,
      (SELECT COUNT(*) FROM menu_items) menu_items,
      (SELECT COUNT(*) FROM riders) riders`);
    res.json({ok:true,database:'postgresql',serverTime:r.rows[0].server_time,counts:counts.rows[0]});
  }catch(e){res.status(500).json({ok:false,error:'database_unavailable'});}
});

app.get('/ops/readiness',async(req,res)=>{
  if(!dbPool)return res.status(503).json({ok:false,reason:'database_not_configured'});
  try{await dbPool.query('SELECT 1');res.json({ok:true,service:'ready',database:'ready'});}
  catch(e){res.status(503).json({ok:false,reason:'database_unavailable'});}
});
app.get('/ops/summary',async(req,res)=>{
  if(!dbPool)return res.status(503).json({ok:false,reason:'database_not_configured'});
  try{
    const q=await dbPool.query(`SELECT
      (SELECT COUNT(*) FROM orders) orders,
      (SELECT COUNT(*) FROM orders WHERE status NOT IN ('DELIVERED','REJECTED','CANCELLED')) active_orders,
      (SELECT COUNT(*) FROM customers) customers,
      (SELECT COUNT(*) FROM riders) riders,
      (SELECT COUNT(*) FROM support_tickets WHERE status='OPEN') open_tickets,
      (SELECT COUNT(*) FROM refunds WHERE status NOT IN ('COMPLETED','FAILED')) pending_refunds`);
    res.json({ok:true,counts:q.rows[0],at:now()});
  }catch(e){res.status(500).json({ok:false,error:'summary_failed'});}
});

app.get('/app-config/:app',(req,res)=>{
  const x=appVersions[String(req.params.app||'').toLowerCase()];
  if(!x)return res.status(404).json({error:'unknown_app'});
  res.json(x);
});
app.get('/admin/app-versions',(req,res)=>res.json({apps:Object.values(appVersions)}));
app.patch('/admin/app-versions/:app',(req,res)=>{
  const key=String(req.params.app||'').toLowerCase(),x=appVersions[key];
  if(!x)return res.status(404).json({error:'unknown_app'});
  ['latestVersionCode','minSupportedVersionCode','latestVersionName','forceUpdate','updateUrl','releaseNotes'].forEach(k=>{
    if(req.body&&req.body[k]!==undefined)x[k]=req.body[k];
  });
  res.json(x);
});

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
  const attempt=String(req.body.checkoutAttemptId||'').trim();
  if(attempt){
    const existing=orders.find(x=>x.checkoutAttemptId===attempt && x.customerPhone===String(req.body.customerPhone||''));
    if(existing){
      existing.paymentUrl=req.protocol+'://'+req.get('host')+'/payments/start/'+encodeURIComponent(existing.id);
      return res.json(existing);
    }
  }
  const items=req.body.items;if(!Array.isArray(items)||!items.length)return res.status(400).json({error:'items_required'});
  let total=0;const normalized=[];
  for(const raw of items){const m=menu.find(x=>x.id===raw.id)||menu.find(x=>x.name===raw.name);if(!m)return res.status(400).json({error:'unknown_item'});if(!m.available)return res.status(409).json({error:'item_unavailable',item:m.id});const q=Math.max(1,Number(raw.qty||1));normalized.push({id:m.id,name:m.name,qty:q,price:m.price,category:m.category,image:m.image||''});total+=m.price*q;}
  const o={id:nextId('order','GRO'),restaurantId:restaurant.id,customerId:String(req.body.customerId||''),customerName:String(req.body.customerName||'Customer'),customerPhone:String(req.body.customerPhone||''),address:String(req.body.address||''),items:normalized,total,status:'PAYMENT_PENDING',paymentStatus:'PENDING',deliveryPin:String(Math.floor(1000+Math.random()*9000)),deliveryPartnerId:'',deliveryDistanceKm:Number(req.body.deliveryDistanceKm||3),checkoutAttemptId:attempt,createdAt:now(),updatedAt:now(),timeline:{paymentPendingAt:now()}};
  orders.unshift(o);
  o.paymentUrl=req.protocol+'://'+req.get('host')+'/payments/start/'+encodeURIComponent(o.id);
  res.status(201).json(o);
});
app.get('/customer/orders',(req,res)=>{const cid=String(req.query.customerId||''),p=String(req.query.phone||'');res.json({orders:orders.filter(o=>(cid&&o.customerId===cid)||(p&&o.customerPhone===p))});});
app.get('/customer/orders/:id',(req,res)=>{const o=orders.find(x=>x.id===req.params.id);if(!o)return res.status(404).json({error:'order_not_found'});res.json({...o,tracking:locations[o.id]||null,restaurantStatus:restaurant.status});});


function createRazorpayPaymentLink(appOrder){
  return new Promise((resolve,reject)=>{
    const keyId=process.env.RAZORPAY_KEY_ID||'',secret=process.env.RAZORPAY_KEY_SECRET||'';
    if(!keyId||!secret)return reject(new Error('payment_not_configured'));
    const payload=JSON.stringify({
      amount:Math.round(appOrder.total*100),
      currency:'INR',
      accept_partial:false,
      reference_id:appOrder.id,
      description:'GAJAB RASODA Order '+appOrder.id,
      customer:{name:appOrder.customerName||'Customer',contact:appOrder.customerPhone||''},
      notify:{sms:false,email:false},
      reminder_enable:false,
      notes:{app_order_id:appOrder.id}
    });
    const auth=Buffer.from(keyId+':'+secret).toString('base64');
    const q=https.request({hostname:'api.razorpay.com',path:'/v1/payment_links',method:'POST',headers:{
      'Authorization':'Basic '+auth,'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)
    }},r=>{
      let body='';r.on('data',d=>body+=d);r.on('end',()=>{try{
        const j=JSON.parse(body);
        if(r.statusCode>=200&&r.statusCode<300)return resolve(j);
        reject(new Error(j&&j.error&&j.error.description||'razorpay_payment_link_failed'));
      }catch(e){reject(e);}});
    });
    q.on('error',reject);q.write(payload);q.end();
  });
}
app.get('/payments/start/:id',(req,res)=>{
  const o=orders.find(x=>x.id===req.params.id);
  if(!o)return res.status(404).send('Order not found');
  if(o.paymentStatus==='PAID'){
    return res.type('html').send('<html><body style="font-family:Arial;padding:30px"><h2>Payment already received</h2><p>Order '+o.id+' has already been sent to the restaurant.</p></body></html>');
  }

  // Temporary payment flow: redirect every checkout to the existing GAJAB RASODA Razorpay.me page.
  // Order remains PAYMENT_PENDING until manually verified/approved from Company/Admin.
  o.paymentReference=o.id;
  o.paymentExpectedPaise=Math.round(o.total*100);
  o.updatedAt=now();

  const payUrl='https://razorpay.me/%40gajabrasoda';
  res.redirect(302,payUrl);
});

app.get('/payments/status/:id',(req,res)=>{
  const o=orders.find(x=>x.id===req.params.id);
  if(!o)return res.status(404).json({error:'order_not_found'});
  res.json({orderId:o.id,paymentStatus:o.paymentStatus,status:o.status,expectedAmount:o.total,paymentId:o.paymentId||'',paymentLinkId:o.razorpayPaymentLinkId||''});
});

app.post('/admin/orders/:id/approve-payment',(req,res)=>{
  const o=orders.find(x=>x.id===req.params.id);
  if(!o)return res.status(404).json({error:'order_not_found'});
  const paidAmount=Number(req.body.amount);
  const paymentId=String(req.body.paymentId||req.body.reference||'').trim();
  if(!Number.isFinite(paidAmount))return res.status(400).json({error:'invalid_amount'});
  if(!paymentId)return res.status(400).json({error:'payment_reference_required'});
  const expectedAmount=Number(o.total);
  if(Math.abs(paidAmount-expectedAmount)>0.001){
    o.paymentStatus='PAYMENT_REVIEW';o.paymentReviewReason='manual_amount_mismatch';o.updatedAt=now();persistState();
    audit('PAYMENT_AMOUNT_MISMATCH','ORDER',o.id,{expected:expectedAmount,received:paidAmount,requestId:req.requestId});return res.status(409).json({error:'amount_mismatch',expected:expectedAmount,received:paidAmount,orderId:o.id,requestId:req.requestId});
  }
  o.paymentStatus='PAID';o.paymentId=paymentId;o.paymentReference=paymentId;o.status='PLACED';stampOrder(o,'PLACED');persistState();
  audit('PAYMENT_APPROVED','ORDER',o.id,{amount:paidAmount,paymentReference:paymentId,requestId:req.requestId});res.json({ok:true,orderId:o.id,expectedAmount,receivedAmount:paidAmount,paymentStatus:o.paymentStatus,status:o.status,requestId:req.requestId});
});

app.get('/partner/restaurant',(req,res)=>res.json(restaurant));
app.patch('/partner/restaurant/status',(req,res)=>{const s=String(req.body.status||'').toUpperCase();if(!['ONLINE','OFFLINE'].includes(s))return res.status(400).json({error:'invalid_status'});restaurant.status=s;res.json(restaurant);});
app.patch('/partner/menu/:id/availability',(req,res)=>{const m=menu.find(x=>x.id===req.params.id);if(!m)return res.status(404).json({error:'item_not_found'});m.available=!!req.body.available;res.json(m);});
app.post('/partner/menu',(req,res)=>{const name=String(req.body.name||'').trim(),price=Number(req.body.price||0);if(!name||price<=0)return res.status(400).json({error:'name_and_price_required'});const m={id:'dish_'+Date.now(),name,price,available:req.body.available!==false,category:String(req.body.category||'VEG'),image:String(req.body.image||'')};menu.push(m);res.status(201).json(m);});
app.patch('/partner/menu/:id',(req,res)=>{const m=menu.find(x=>x.id===req.params.id);if(!m)return res.status(404).json({error:'item_not_found'});['name','category','image'].forEach(k=>{if(req.body[k]!==undefined)m[k]=String(req.body[k]);});if(req.body.price!==undefined)m.price=Number(req.body.price);if(req.body.available!==undefined)m.available=!!req.body.available;res.json(m);});
app.get('/partner/orders',(req,res)=>res.json({orders:orders.filter(o=>o.paymentStatus==='PAID').sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)),serverTime:Date.now()}));
app.patch('/partner/orders/:id/status',(req,res)=>{const o=orders.find(x=>x.id===req.params.id);if(!o)return res.status(404).json({error:'order_not_found'});const s=String(req.body.status||'');if(!['ACCEPTED','REJECTED','PREPARING','READY','OUT_FOR_DELIVERY','DELIVERED'].includes(s))return res.status(400).json({error:'invalid_status'});o.status=s;o.updatedAt=now();if(s==='DELIVERED')ensurePayoutLedgers(o);res.json(o);});
app.get('/partner/finance',(req,res)=>{
  const delivered=orders.filter(o=>o.restaurantId===restaurant.id&&o.status==='DELIVERED'&&o.paymentStatus==='PAID');
  let gross=0,commission=0,processing=0,deliveryCharges=0,net=0;
  delivered.forEach(o=>{const x=partnerSettlement(o);gross+=x.gross;commission+=x.commission;processing+=x.processing;deliveryCharges+=x.deliveryCharge;net+=x.net;});
  const ageDays=Math.floor((Date.now()-new Date(restaurant.activationDate).getTime())/(24*60*60*1000));
  const commissionRate=ageDays<15?0:0.10;
  const pending=partnerPayouts.filter(p=>p.status!=='PAID').reduce((sum,p)=>sum+p.net,0);
  res.json({
    restaurantId:restaurant.id,
    todaySales:Math.round(gross*100)/100,
    completedOrders:delivered.length,
    grossSales:Math.round(gross*100)/100,
    commissionRate,
    commission:Math.round(commission*100)/100,
    processingRate:0.0184,
    processingFee:Math.round(processing*100)/100,
    deliveryCharges:Math.round(deliveryCharges*100)/100,
    netEarning:Math.round(net*100)/100,
    pendingSettlement:Math.round(pending*100)/100,
    freeCommissionDaysRemaining:Math.max(0,15-ageDays),
    settlementCycle:'T+1 NEXT WORKING DAY',
    payoutTerms:'0% commission first 15 calendar days after activation, then 10%; 1.84% processing/transfer fee; delivery charges borne by restaurant.',
    payouts:partnerPayouts
  });
});
app.post('/partner/payout-account',(req,res)=>{const a=partnerAccounts[restaurant.id];a.upiId=String(req.body.upiId||'');a.bankLast4=String(req.body.bankLast4||'');a.payoutMethod=String(req.body.payoutMethod||'');a.payoutEnabled=!!(a.upiId||a.bankLast4);a.updatedAt=now();res.json(a);});
app.get('/partner/payout-account',(req,res)=>res.json(partnerAccounts[restaurant.id]));

app.post('/onboarding/restaurant',(req,res)=>{const x={id:'ONB'+String(++seq.onboarding).padStart(3,'0'),type:'RESTAURANT',name:String(req.body.restaurantName||''),ownerName:String(req.body.ownerName||''),mobile:String(req.body.mobile||''),address:String(req.body.address||''),status:'SUBMITTED',createdAt:now()};onboarding.unshift(x);res.status(201).json(x);});
app.post('/onboarding/rider',(req,res)=>{const x={id:'ONB'+String(++seq.onboarding).padStart(3,'0'),type:'RIDER',name:String(req.body.name||''),mobile:String(req.body.mobile||''),address:String(req.body.address||''),vehicle:String(req.body.vehicle||''),status:'SUBMITTED',createdAt:now()};onboarding.unshift(x);res.status(201).json(x);});
app.get('/onboarding/restaurant',(req,res)=>res.type('html').send('<html><body><h2>GAJAB RASODA Restaurant Onboarding</h2><p>Please submit from Partner onboarding form/API.</p></body></html>'));
app.get('/onboarding/rider',(req,res)=>res.type('html').send('<html><body><h2>GAJAB RASODA Rider Onboarding</h2><p>Please submit from Delivery onboarding form/API.</p></body></html>'));

app.get('/delivery/profile',(req,res)=>{const id=String(req.query.deliveryPartnerId||'GRD01');res.json({...riders[id],...(riderAccounts[id]||{deliveryPartnerId:id,payoutMethod:'',upiId:'',bankLast4:'',payoutEnabled:false})});});
app.post('/delivery/profile',(req,res)=>{const id=String(req.body.deliveryPartnerId||'GRD01');if(!riders[id])riders[id]={id,name:'',mobile:'',status:'ACTIVE',online:false,createdAt:now()};const a=riderAccounts[id]||{deliveryPartnerId:id};a.upiId=String(req.body.upiId||a.upiId||'');a.bankLast4=String(req.body.bankLast4||a.bankLast4||'');a.payoutMethod=String(req.body.payoutMethod||a.payoutMethod||'');a.payoutEnabled=!!(a.upiId||a.bankLast4);a.updatedAt=now();riderAccounts[id]=a;res.json(a);});
app.get('/delivery/orders',(req,res)=>{const id=String(req.query.deliveryPartnerId||'GRD01');res.json({orders:orders.filter(o=>['READY','OUT_FOR_DELIVERY'].includes(o.status)).filter(o=>!(o.rejectedBy||[]).includes(id)).filter(o=>!o.deliveryPartnerId||o.deliveryPartnerId===id).map(o=>({...o,riderEarning:riderEarning(o.deliveryDistanceKm),orderValueHidden:true})),serverTime:Date.now()});});
app.patch('/delivery/orders/:id/accept',(req,res)=>{const o=orders.find(x=>x.id===req.params.id);if(!o)return res.status(404).json({error:'order_not_found'});if(o.status!=='READY')return res.status(409).json({error:'order_not_ready'});const id=String(req.body.deliveryPartnerId||'GRD01');if(o.deliveryPartnerId&&o.deliveryPartnerId!==id)return res.status(409).json({error:'already_assigned'});o.deliveryPartnerId=id;o.deliveryAccepted=true;stampOrder(o,'DELIVERY_ACCEPTED');persistState();res.json({...o,riderEarning:riderEarning(o.deliveryDistanceKm)});});
app.patch('/delivery/orders/:id/reject',(req,res)=>{const o=orders.find(x=>x.id===req.params.id);if(!o)return res.status(404).json({error:'order_not_found'});o.rejectedBy=o.rejectedBy||[];const id=String(req.body.deliveryPartnerId||'GRD01');if(!o.rejectedBy.includes(id))o.rejectedBy.push(id);res.json({ok:true});});
app.post('/delivery/orders/:id/picked-up',(req,res)=>{const o=orders.find(x=>x.id===req.params.id);if(!o)return res.status(404).json({error:'order_not_found'});if(o.deliveryPartnerId!==req.body.deliveryPartnerId)return res.status(403).json({error:'not_assigned'});o.status='OUT_FOR_DELIVERY';stampOrder(o,'OUT_FOR_DELIVERY');res.json(o);});
app.post('/delivery/orders/:id/verify-pin',(req,res)=>{const o=orders.find(x=>x.id===req.params.id);if(!o)return res.status(404).json({error:'order_not_found'});if(String(req.body.pin||'')!==String(o.deliveryPin))return res.status(400).json({error:'invalid_pin'});if(o.deliveryPartnerId&&req.body.deliveryPartnerId&&o.deliveryPartnerId!==req.body.deliveryPartnerId)return res.status(403).json({error:'wrong_rider'});o.status='DELIVERED';o.proof=String(req.body.proof||'');o.deliveredAt=now();o.updatedAt=now();ensurePayoutLedgers(o);res.json({ok:true,order:o,riderEarning:riderEarning(o.deliveryDistanceKm)});});
app.post('/delivery/location',(req,res)=>{const id=String(req.body.orderId||'');if(!id)return res.status(400).json({error:'orderId_required'});const lat=Number(req.body.lat),lng=Number(req.body.lng);if(!Number.isFinite(lat)||!Number.isFinite(lng))return res.status(400).json({error:'valid_location_required'});locations[id]={deliveryPartnerId:String(req.body.deliveryPartnerId||''),lat,lng,updatedAt:now(),shareUrl:`https://maps.google.com/?q=${lat},${lng}`};res.json({ok:true,tracking:locations[id]});});
app.get('/delivery/location/:id',(req,res)=>res.json(locations[req.params.id]||{}));
app.get('/delivery/history',(req,res)=>{const id=String(req.query.deliveryPartnerId||'GRD01');res.json({orders:orders.filter(o=>o.deliveryPartnerId===id&&o.status==='DELIVERED').map(o=>({...o,riderEarning:riderEarning(o.deliveryDistanceKm)}))});});
app.get('/delivery/earnings',(req,res)=>{const id=String(req.query.deliveryPartnerId||'GRD01');const done=orders.filter(o=>o.deliveryPartnerId===id&&o.status==='DELIVERED');res.json({deliveryPartnerId:id,totalEarnings:done.reduce((s,o)=>s+riderEarning(o.deliveryDistanceKm),0),completedDeliveries:done.length,payouts:riderPayouts.filter(p=>p.deliveryPartnerId===id)});});
app.get('/delivery/payouts',(req,res)=>{const id=String(req.query.deliveryPartnerId||'GRD01');res.json({payouts:riderPayouts.filter(p=>p.deliveryPartnerId===id)});});

app.post('/grievances',(req,res)=>{const x={id:'GRG'+String(++seq.grievance).padStart(4,'0'),source:String(req.body.source||'CUSTOMER'),sourceId:String(req.body.sourceId||''),orderId:String(req.body.orderId||''),category:String(req.body.category||'Other'),message:String(req.body.message||''),status:'OPEN',createdAt:now(),updatedAt:now(),timeline:{paymentPendingAt:now()}};grievances.unshift(x);res.status(201).json(x);});
app.get('/grievances',(req,res)=>res.json({grievances}));
app.patch('/admin/grievances/:id',(req,res)=>{const g=grievances.find(x=>x.id===req.params.id);if(!g)return res.status(404).json({error:'not_found'});if(req.body.status)g.status=String(req.body.status);if(req.body.adminReply!==undefined)g.adminReply=String(req.body.adminReply);g.updatedAt=now();res.json(g);});
app.post('/delivery/appeals',(req,res)=>{req.body.source='RIDER';req.body.sourceId=req.body.deliveryPartnerId||'';const x={id:'GRG'+String(++seq.grievance).padStart(4,'0'),source:'RIDER',sourceId:String(req.body.deliveryPartnerId||''),orderId:String(req.body.orderId||''),category:String(req.body.category||'Other'),message:String(req.body.message||''),status:'OPEN',createdAt:now(),updatedAt:now(),timeline:{paymentPendingAt:now()}};grievances.unshift(x);res.status(201).json(x);});
app.get('/delivery/appeals',(req,res)=>{const id=String(req.query.deliveryPartnerId||'');res.json({appeals:grievances.filter(g=>g.source==='RIDER'&&(!id||g.sourceId===id))});});
app.patch('/admin/delivery/appeals/:id',(req,res)=>{const g=grievances.find(x=>x.id===req.params.id);if(!g)return res.status(404).json({error:'not_found'});if(req.body.status)g.status=String(req.body.status);if(req.body.adminReply!==undefined)g.adminReply=String(req.body.adminReply);g.updatedAt=now();res.json(g);});

app.get('/admin/dashboard',(req,res)=>{
  const delivered=orders.filter(o=>o.status==='DELIVERED'),gross=delivered.reduce((s,o)=>s+o.total,0);
  res.json({
    customers:Object.keys(customers).length,riders:Object.keys(riders).length,restaurants:1,totalOrders:orders.length,
    openOrders:orders.filter(o=>!['DELIVERED','REJECTED'].includes(o.status)).length,completedOrders:delivered.length,grossSales:gross,
    newOnboarding:onboarding.filter(x=>x.status==='SUBMITTED').length,openGrievances:grievances.filter(g=>g.status!=='RESOLVED').length,
    pendingPartnerPayouts:partnerPayouts.filter(p=>p.status!=='PAID').length,pendingRiderPayouts:riderPayouts.filter(p=>p.status!=='PAID').length,
    orderStatus:{
      paymentPending:orders.filter(o=>o.status==='PAYMENT_PENDING').length,
      placed:orders.filter(o=>o.status==='PLACED').length,
      preparing:orders.filter(o=>['ACCEPTED','PREPARING'].includes(o.status)).length,
      ready:orders.filter(o=>o.status==='READY').length,
      outForDelivery:orders.filter(o=>o.status==='OUT_FOR_DELIVERY').length,
      completed:orders.filter(o=>o.status==='DELIVERED').length
    }
  });
});
app.get('/admin/customers',(req,res)=>res.json({customers:Object.values(customers)}));
app.get('/admin/riders',(req,res)=>res.json({riders:Object.values(riders).map(r=>({...r,payout:riderAccounts[r.id]||{}}))}));
app.get('/admin/orders',(req,res)=>res.json({orders}));
app.get('/admin/onboarding',(req,res)=>res.json({requests:onboarding}));
app.patch('/admin/onboarding/:id',(req,res)=>{const x=onboarding.find(a=>a.id===req.params.id);if(!x)return res.status(404).json({error:'not_found'});x.status=String(req.body.status||x.status);x.updatedAt=now();if(x.type==='RIDER'&&x.status==='APPROVED'){const id=nextId('rider','GRD');riders[id]={id,name:x.name,mobile:x.mobile,status:'ACTIVE',online:false,createdAt:now()};x.createdEntityId=id;}res.json(x);});
app.get('/admin/grievances',(req,res)=>res.json({grievances}));
app.get('/admin/payouts',(req,res)=>res.json({partnerPayouts,riderPayouts}));
app.patch('/admin/payouts/:type/:id',(req,res)=>{const list=req.params.type==='partner'?partnerPayouts:riderPayouts;const p=list.find(x=>x.id===req.params.id);if(!p)return res.status(404).json({error:'not_found'});p.status=String(req.body.status||p.status);p.reference=String(req.body.reference||p.reference||'');p.updatedAt=now();res.json(p);});


app.get('/admin/export/orders',async(req,res)=>{
  if(!dbPool)return res.status(503).json({error:'database_not_configured'});
  try{
    const q=await dbPool.query('SELECT order_id,status,payment_status,total,customer_id,customer_phone,delivery_partner_id,created_at,updated_at FROM orders ORDER BY created_at DESC LIMIT 5000');
    res.json({ok:true,count:q.rows.length,orders:q.rows});
  }catch(e){res.status(500).json({error:'export_failed'});}
});
app.get('/admin/config',async(req,res)=>{
  if(!dbPool)return res.status(503).json({error:'database_not_configured'});
  const q=await dbPool.query('SELECT config_key,config_value,updated_at FROM system_config ORDER BY config_key');
  res.json({ok:true,config:q.rows});
});
app.post('/admin/config/:key',async(req,res)=>{
  if(!dbPool)return res.status(503).json({error:'database_not_configured'});
  await dbPool.query(`INSERT INTO system_config(config_key,config_value,updated_at) VALUES($1,$2::jsonb,NOW())
    ON CONFLICT(config_key) DO UPDATE SET config_value=EXCLUDED.config_value,updated_at=NOW()`,
    [req.params.key,JSON.stringify(req.body||{})]);
  await audit('CONFIG_UPDATED','CONFIG',req.params.key,{requestId:req.requestId});
  res.json({ok:true,key:req.params.key});
});

initPersistentState().then(()=>persistState()).then(()=>app.listen(PORT,()=>console.log('Gajab Rasoda backend persistent v1.1 running on :'+PORT))).catch(e=>{console.error('DB init failed',e);process.exit(1);});
