const express=require('express');
const cors=require('cors');
const crypto=require('crypto');
const https=require('https');
let Pool=null;try{Pool=require('pg').Pool;}catch(e){}
const dbPool=(Pool&&process.env.DATABASE_URL)?new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.DATABASE_SSL==='false'?false:{rejectUnauthorized:false}}):null;
const app=express();
const appVersions={
  customer:{app:'customer',latestVersionCode:1101,minSupportedVersionCode:10,latestVersionName:'1.10.1',forceUpdate:false,updateUrl:'',releaseNotes:'GAJAB RASODA Version 1.0'},
  partner:{app:'partner',latestVersionCode:1101,minSupportedVersionCode:10,latestVersionName:'1.10.1',forceUpdate:false,updateUrl:'',releaseNotes:'GAJAB RASODA Partner Version 1.0'},
  delivery:{app:'delivery',latestVersionCode:1101,minSupportedVersionCode:10,latestVersionName:'1.10.1',forceUpdate:false,updateUrl:'',releaseNotes:'GAJAB RASODA Delivery Version 1.0'},
  company:{app:'company',latestVersionCode:1101,minSupportedVersionCode:10,latestVersionName:'1.10.1',forceUpdate:false,updateUrl:'',releaseNotes:'GAJAB RASODA Company Version 1.0'}
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
            o.paymentStatus='PAID';o.paymentId=pay&&pay.id||'';o.paymentReference=ref;o.status='PLACED';stampOrder(o,'PAID');stampOrder(o,'PLACED');schedulePersist();
          }else{
            o.paymentStatus='PAYMENT_REVIEW';o.paymentReviewReason='amount_or_status_mismatch';o.updatedAt=now();
          }
        }
      }
    }else if(event.event==='payment.captured' || event.event==='order.paid'){
      const ent=event.payload&&event.payload.payment&&event.payload.payment.entity;
      const ord=event.payload&&event.payload.order&&event.payload.order.entity;
      const razorOrderId=String((ent&&ent.order_id)||(ord&&ord.id)||'');
      const o=orders.find(x=>x.razorpayOrderId===razorOrderId);
      if(o){
        const paidPaise=Number((ent&&ent.amount)||(ord&&ord.amount_paid)||0);
        if(paidPaise===Math.round(o.total*100)){
          o.paymentStatus='PAID';o.paymentId=String(ent&&ent.id||o.paymentId||'');o.status='PLACED';o.paymentReviewReason='';stampOrder(o,'PAID');stampOrder(o,'PLACED');schedulePersist();
        }else if(paidPaise>0){
          o.paymentStatus='PAYMENT_REVIEW';o.paymentReviewReason='webhook_amount_mismatch';o.updatedAt=now();schedulePersist();
        }
      }
    }else if(event.event==='payment.failed'){
      const ent=event.payload&&event.payload.payment&&event.payload.payment.entity;
      const o=ent&&orders.find(x=>x.razorpayOrderId===ent.order_id);
      if(o && o.paymentStatus!=='PAID'){
        o.paymentStatus='FAILED';o.status='PAYMENT_FAILED';o.paymentFailureReason=String(ent.error_description||ent.error_reason||'Payment failed');o.updatedAt=now();schedulePersist();
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
function riderEarning(km){km=Math.max(0,Number(km||0));return Math.round((km*10)*100)/100;}
function partnerSettlement(order){
  const gross=Number(order.total||0);
  const activated=new Date(restaurant.activationDate).getTime();
  const ageDays=Math.floor((Date.now()-activated)/(24*60*60*1000));
  const commissionRate=ageDays<15?0:0.10;
  const commission=Math.round(gross*commissionRate*100)/100;
  const processingRate=0.0184;
  const processing=Math.round(gross*processingRate*100)/100;
  const deliveryCharge=riderEarning(order.deliveryDistanceKm);
  const net=Math.max(0,Math.round((gross-commission-processing-deliveryCharge)*100)/100);
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


// V1.12 RazorpayX payout engine.
// Live payout is disabled unless all RazorpayX environment variables are configured.
// Required env:
// RAZORPAYX_KEY_ID, RAZORPAYX_KEY_SECRET, RAZORPAYX_ACCOUNT_NUMBER
// Optional: RAZORPAYX_PAYOUTS_ENABLED=true
function payoutConfig(){
  return {
    keyId:String(process.env.RAZORPAYX_KEY_ID||'').trim(),
    keySecret:String(process.env.RAZORPAYX_KEY_SECRET||'').trim(),
    accountNumber:String(process.env.RAZORPAYX_ACCOUNT_NUMBER||'').trim(),
    enabled:String(process.env.RAZORPAYX_PAYOUTS_ENABLED||'false').toLowerCase()==='true'
  };
}
function payoutConfigReady(){
  const c=payoutConfig();
  return !!(c.enabled&&c.keyId&&c.keySecret&&c.accountNumber);
}
function isPayoutDue(p){
  return ['SCHEDULED_T_PLUS_1','RETRY_PENDING','FAILED_RETRYABLE'].includes(String(p.status||'')) &&
    String(p.dueDate||'') <= new Date().toISOString().slice(0,10) &&
    Number(p.net!==undefined?p.net:p.amount)>0;
}
function payoutAmount(p){return Math.round(Number(p.net!==undefined?p.net:p.amount||0)*100)/100;}
function payoutBeneficiary(type,p){
  const id=type==='partner'?String(p.restaurantId||'GRR01'):String(p.deliveryPartnerId||'GRD01');
  const a=type==='partner'?(partnerAccounts[id]||{}):(riderAccounts[id]||{});
  return {id,account:a};
}
function safePayoutView(type,p){
  const b=payoutBeneficiary(type,p),a=b.account||{};
  return {...p,
    beneficiaryId:b.id,
    payoutEnabled:!!a.payoutEnabled,
    payoutMethod:String(a.payoutMethod||''),
    bankLast4:String(a.bankLast4||''),
    upiMasked:a.upiId?String(a.upiId).replace(/^(.{1,2}).*(@.*)$/,'$1***$2'):'',
    fundAccountReady:!!a.razorpayFundAccountId,
    razorpayFundAccountId:a.razorpayFundAccountId?'configured':''
  };
}
async function razorpayXRequest(method,path,body,extraHeaders={}){
  const c=payoutConfig();
  if(!payoutConfigReady())throw Object.assign(new Error('razorpayx_not_configured'),{code:'RAZORPAYX_NOT_CONFIGURED'});
  const auth=Buffer.from(c.keyId+':'+c.keySecret).toString('base64');
  const r=await fetch('https://api.razorpay.com'+path,{
    method,headers:{'Authorization':'Basic '+auth,'Content-Type':'application/json',...extraHeaders},
    body:body?JSON.stringify(body):undefined
  });
  const text=await r.text();let j={};try{j=JSON.parse(text)}catch(e){j={raw:text}}
  if(!r.ok){const err=new Error('razorpayx_api_error');err.status=r.status;err.payload=j;throw err;}
  return j;
}
async function ensureRazorpayXFundAccount(type,p){
  const b=payoutBeneficiary(type,p),a=b.account||{};
  if(a.razorpayFundAccountId)return a.razorpayFundAccountId;
  if(!a.payoutEnabled)throw Object.assign(new Error('beneficiary_payout_not_enabled'),{code:'BENEFICIARY_NOT_READY'});
  // UPI/VPA is preferred for this lightweight onboarding flow.
  // Bank account creation needs a full bank account + IFSC; only last4 is not enough.
  if(!a.upiId)throw Object.assign(new Error('upi_required_or_existing_fund_account'),{code:'FUND_ACCOUNT_REQUIRED'});
  const contact=await razorpayXRequest('POST','/v1/contacts',{
    name:String(a.accountName||b.id),contact:String(a.mobile||''),email:String(a.email||''),
    type:'vendor',reference_id:b.id,notes:{gajab_role:type,gajab_id:b.id}
  });
  const fa=await razorpayXRequest('POST','/v1/fund_accounts',{
    contact_id:contact.id,account_type:'vpa',vpa:{address:String(a.upiId)}
  });
  a.razorpayContactId=contact.id;a.razorpayFundAccountId=fa.id;a.payoutVerifiedAt=now();
  if(type==='partner')partnerAccounts[b.id]=a;else riderAccounts[b.id]=a;
  schedulePersist();
  return fa.id;
}
async function executeOnePayout(type,p,actor='COMPANY_ONE_CLICK'){
  if(!isPayoutDue(p)&&!['READY_TO_PAY','RETRY_PENDING','FAILED_RETRYABLE'].includes(String(p.status||''))){
    return {ok:false,skipped:true,id:p.id,status:p.status,reason:'not_due'};
  }
  const amount=payoutAmount(p);
  if(amount<=0){p.status='ZERO_PAYOUT';p.updatedAt=now();schedulePersist();return {ok:true,skipped:true,id:p.id,status:p.status};}
  if(p.razorpayPayoutId&&['PROCESSING','INITIATED','QUEUED','PAID','PROCESSED'].includes(String(p.status||''))){
    return {ok:true,skipped:true,id:p.id,status:p.status,razorpayPayoutId:p.razorpayPayoutId};
  }
  if(!payoutConfigReady())return {ok:false,id:p.id,status:'CONFIG_REQUIRED',reason:'razorpayx_not_configured'};
  try{
    const fundAccountId=await ensureRazorpayXFundAccount(type,p);
    const c=payoutConfig();
    const idem='gajab-'+String(p.id).toLowerCase()+'-'+String(p.orderId||'na').toLowerCase();
    const out=await razorpayXRequest('POST','/v1/payouts',{
      account_number:c.accountNumber,
      fund_account_id:fundAccountId,
      amount:Math.round(amount*100),
      currency:'INR',
      mode:'UPI',
      purpose:'payout',
      queue_if_low_balance:true,
      reference_id:p.id,
      narration:'GAJAB RASODA '+p.id,
      notes:{gajab_payout_id:p.id,gajab_order_id:p.orderId||'',gajab_type:type}
    },{'X-Payout-Idempotency':idem});
    p.razorpayPayoutId=String(out.id||'');
    p.razorpayStatus=String(out.status||'');
    p.status=String(out.status||'initiated').toUpperCase();
    p.paidAmount=amount;p.attempts=Number(p.attempts||0)+1;p.lastAttemptAt=now();p.updatedAt=now();p.initiatedBy=actor;
    audit('PAYOUT_INITIATED',type.toUpperCase()+'_PAYOUT',p.id,{amount,razorpayPayoutId:p.razorpayPayoutId,actor});
    schedulePersist();
    return {ok:true,id:p.id,status:p.status,amount,razorpayPayoutId:p.razorpayPayoutId};
  }catch(e){
    p.attempts=Number(p.attempts||0)+1;p.lastAttemptAt=now();p.updatedAt=now();
    p.lastError=String((e.payload&&e.payload.error&&e.payload.error.description)||e.code||e.message||'payout_failed');
    p.status=(e.status>=500||e.status===429)?'FAILED_RETRYABLE':'FAILED_REVIEW';
    audit('PAYOUT_FAILED',type.toUpperCase()+'_PAYOUT',p.id,{error:p.lastError,status:p.status});
    schedulePersist();
    return {ok:false,id:p.id,status:p.status,reason:p.lastError};
  }
}
async function runDuePayouts(actor='AUTO_T_PLUS_1'){
  const results=[];
  for(const p of partnerPayouts.filter(isPayoutDue))results.push({type:'partner',...(await executeOnePayout('partner',p,actor))});
  for(const p of riderPayouts.filter(isPayoutDue))results.push({type:'rider',...(await executeOnePayout('rider',p,actor))});
  return results;
}
// Best-effort scheduler while the web service is awake.
// A production always-on instance or external cron should call /jobs/payouts/t-plus-1.
setInterval(()=>{if(payoutConfigReady())runDuePayouts('AUTO_T_PLUS_1').catch(()=>{});},5*60*1000).unref();


app.get('/health',(req,res)=>res.json({ok:true,service:'Gajab Rasoda Backend',version:'1.12.0',database:dbPool?'configured':'memory-only'}));
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
      const sameCart=JSON.stringify((existing.items||[]).map(i=>({id:i.id,qty:Number(i.qty||1)})))===JSON.stringify((req.body.items||[]).map(i=>({id:i.id,qty:Number(i.qty||1)})));
      const reusable=existing.paymentStatus==='PENDING' && existing.status==='PAYMENT_PENDING' && sameCart;
      if(reusable){
        existing.paymentUrl=req.protocol+'://'+req.get('host')+'/payments/start/'+encodeURIComponent(existing.id);
        return res.json(existing);
      }
    }
  }
  const items=req.body.items;if(!Array.isArray(items)||!items.length)return res.status(400).json({error:'items_required'});
  let total=0;const normalized=[];
  for(const raw of items){const m=menu.find(x=>x.id===raw.id)||menu.find(x=>x.name===raw.name);if(!m)return res.status(400).json({error:'unknown_item'});if(!m.available)return res.status(409).json({error:'item_unavailable',item:m.id});const q=Math.max(1,Number(raw.qty||1));normalized.push({id:m.id,name:m.name,qty:q,price:m.price,category:m.category,image:m.image||''});total+=m.price*q;}
  const o={id:nextId('order','GRO'),restaurantId:restaurant.id,customerId:String(req.body.customerId||''),customerName:String(req.body.customerName||'Customer'),customerPhone:String(req.body.customerPhone||''),address:String(req.body.address||''),items:normalized,total,status:'PAYMENT_PENDING',paymentStatus:'PENDING',deliveryPin:String(Math.floor(1000+Math.random()*9000)),deliveryPartnerId:'',deliveryDistanceKm:Number(req.body.deliveryDistanceKm||3),checkoutAttemptId:attempt,createdAt:now(),updatedAt:now(),history:[{status:'OPEN',at:now(),message:'Grievance submitted'}]};
  orders.unshift(o);
  o.paymentUrl=req.protocol+'://'+req.get('host')+'/payments/start/'+encodeURIComponent(o.id);
  res.status(201).json(o);
});
app.patch('/admin/orders/:id/cancel-test',(req,res)=>{const o=orders.find(x=>x.id===req.params.id);if(!o)return res.status(404).json({error:'order_not_found'});if(o.status==='DELIVERED')return res.status(409).json({error:'delivered_order_cannot_be_cancelled'});o.status='CANCELLED';o.paymentStatus=o.paymentStatus==='PAID'?'PAID':'CANCELLED';o.updatedAt=now();audit('TEST_ORDER_CANCELLED','ORDER',o.id,{requestId:req.requestId});schedulePersist();res.json({ok:true,order:o});});
app.get('/customer/orders',(req,res)=>{const cid=String(req.query.customerId||''),p=String(req.query.phone||'');res.json({orders:orders.filter(o=>(cid&&o.customerId===cid)||(p&&o.customerPhone===p))});});
app.get('/customer/orders/:id',(req,res)=>{const o=orders.find(x=>x.id===req.params.id);if(!o)return res.status(404).json({error:'order_not_found'});res.json({...o,tracking:locations[o.id]||null,restaurantStatus:restaurant.status});});


function razorpayRequest(path,method,data){
  return new Promise((resolve,reject)=>{
    const keyId=process.env.RAZORPAY_KEY_ID||'',secret=process.env.RAZORPAY_KEY_SECRET||'';
    if(!keyId||!secret)return reject(new Error('payment_not_configured'));
    const payload=data?JSON.stringify(data):'';
    const auth=Buffer.from(keyId+':'+secret).toString('base64');
    const q=https.request({hostname:'api.razorpay.com',path,method:method||'POST',headers:{
      'Authorization':'Basic '+auth,'Content-Type':'application/json',...(payload?{'Content-Length':Buffer.byteLength(payload)}:{})
    }},r=>{let body='';r.on('data',d=>body+=d);r.on('end',()=>{try{const j=body?JSON.parse(body):{};if(r.statusCode>=200&&r.statusCode<300)return resolve(j);reject(new Error(j&&j.error&&j.error.description||'razorpay_request_failed'));}catch(e){reject(e);}});});
    q.on('error',reject);if(payload)q.write(payload);q.end();
  });
}
async function ensureRazorpayOrder(o){
  if(o.razorpayOrderId)return o.razorpayOrderId;
  const r=await razorpayRequest('/v1/orders','POST',{amount:Math.round(o.total*100),currency:'INR',receipt:o.id,notes:{app_order_id:o.id}});
  o.razorpayOrderId=String(r.id||'');o.paymentExpectedPaise=Math.round(o.total*100);o.paymentReference=o.id;o.updatedAt=now();schedulePersist();
  if(!o.razorpayOrderId)throw new Error('razorpay_order_missing');return o.razorpayOrderId;
}
app.get('/payments/start/:id',async(req,res)=>{
  const o=orders.find(x=>x.id===req.params.id);if(!o)return res.status(404).send('Order not found');
  if(o.paymentStatus==='PAID')return res.type('html').send('<html><body style="font-family:Arial;padding:30px"><h2>Payment already received</h2><p>Order '+o.id+' has already been sent to the restaurant.</p></body></html>');
  try{
    if(o.paymentStatus==='FAILED'){o.paymentStatus='PENDING';o.status='PAYMENT_PENDING';stampOrder(o,'PAYMENT_PENDING');}
    const razorOrderId=await ensureRazorpayOrder(o),keyId=process.env.RAZORPAY_KEY_ID||'';
    const safe=x=>JSON.stringify(String(x||''));
    res.type('html').send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pay ${o.id}</title><script src="https://checkout.razorpay.com/v1/checkout.js"></script></head><body style="font-family:Arial;background:#0b0b0b;color:#fff;padding:28px"><h2>GAJAB RASODA</h2><p>Order <b>${o.id}</b> • ₹${Number(o.total).toFixed(2)}</p><p id="msg">Opening secure Razorpay checkout…</p><button id="retry" style="display:none;padding:14px 22px">Retry Payment</button><script>
const opts={key:${safe(keyId)},amount:${Math.round(o.total*100)},currency:'INR',name:'GAJAB RASODA',description:'Order ${o.id}',order_id:${safe(razorOrderId)},prefill:{name:${safe(o.customerName)},contact:${safe(o.customerPhone)}},theme:{color:'#e52323'},handler:async function(r){document.getElementById('msg').textContent='Verifying payment…';const x=await fetch('/payments/verify/${encodeURIComponent(o.id)}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(r)});const j=await x.json();if(x.ok&&j.paymentStatus==='PAID'){document.body.innerHTML='<h2>Payment successful</h2><p>Order ${o.id} has been sent to the restaurant.</p>';}else{document.getElementById('msg').textContent='Payment verification needs review. Please do not pay again.';}}};
const rz=new Razorpay(opts);rz.on('payment.failed',async function(r){await fetch('/payments/failed/${encodeURIComponent(o.id)}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({reason:(r.error&&r.error.description)||'Payment failed'})});document.getElementById('msg').textContent='Payment failed. You can retry safely.';document.getElementById('retry').style.display='inline-block';});
function openPay(){rz.open()} document.getElementById('retry').onclick=openPay;openPay();
</script></body></html>`);
  }catch(e){res.status(503).type('html').send('<html><body style="font-family:Arial;padding:30px"><h2>Payment temporarily unavailable</h2><p>Please try again shortly.</p></body></html>');}
});
app.post('/payments/verify/:id',(req,res)=>{
  const o=orders.find(x=>x.id===req.params.id);if(!o)return res.status(404).json({error:'order_not_found'});
  const paymentId=String(req.body.razorpay_payment_id||''),razorOrderId=String(req.body.razorpay_order_id||''),sig=String(req.body.razorpay_signature||'');
  if(!paymentId||!razorOrderId||!sig||razorOrderId!==o.razorpayOrderId)return res.status(400).json({error:'invalid_payment_response'});
  const secret=process.env.RAZORPAY_KEY_SECRET||'';const expected=crypto.createHmac('sha256',secret).update(razorOrderId+'|'+paymentId).digest('hex');
  if(!secret||expected.length!==sig.length||!crypto.timingSafeEqual(Buffer.from(expected),Buffer.from(sig))){o.paymentStatus='PAYMENT_REVIEW';o.paymentReviewReason='checkout_signature_mismatch';o.updatedAt=now();schedulePersist();return res.status(401).json({error:'signature_verification_failed',paymentStatus:o.paymentStatus});}
  o.paymentStatus='PAID';o.paymentId=paymentId;o.paymentReference=razorOrderId;o.status='PLACED';o.paymentReviewReason='';stampOrder(o,'PAID');stampOrder(o,'PLACED');schedulePersist();
  res.json({ok:true,orderId:o.id,paymentStatus:o.paymentStatus,status:o.status});
});
app.post('/payments/failed/:id',(req,res)=>{const o=orders.find(x=>x.id===req.params.id);if(!o)return res.status(404).json({error:'order_not_found'});if(o.paymentStatus!=='PAID'){o.paymentStatus='FAILED';o.status='PAYMENT_FAILED';o.paymentFailureReason=String(req.body.reason||'Payment failed');o.updatedAt=now();schedulePersist();}res.json({ok:true,paymentStatus:o.paymentStatus,status:o.status});});

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
app.patch('/partner/orders/:id/status',(req,res)=>{const o=orders.find(x=>x.id===req.params.id);if(!o)return res.status(404).json({error:'order_not_found'});const st=String(req.body.status||'');if(!['ACCEPTED','REJECTED','PREPARING','READY','OUT_FOR_DELIVERY','DELIVERED'].includes(st))return res.status(400).json({error:'invalid_status'});o.status=st;o.updatedAt=now();if(st==='ACCEPTED'){stampOrder(o,'ACCEPTED');if(!o.prepMinutes)o.prepMinutes=25;o.prepDueAt=new Date(Date.now()+o.prepMinutes*60000).toISOString();}if(st==='PREPARING'){stampOrder(o,'PREPARING');if(!o.prepMinutes)o.prepMinutes=25;if(!o.prepDueAt)o.prepDueAt=new Date(Date.now()+o.prepMinutes*60000).toISOString();}if(st==='READY')stampOrder(o,'READY');if(st==='REJECTED')stampOrder(o,'REJECTED');if(st==='DELIVERED'){stampOrder(o,'DELIVERED');ensurePayoutLedgers(o);}schedulePersist();res.json(o);});
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
app.post('/partner/payout-account',(req,res)=>{const a=partnerAccounts[restaurant.id]||{restaurantId:restaurant.id};['upiId','bankLast4','payoutMethod','accountName','mobile','email','razorpayFundAccountId'].forEach(k=>{if(req.body[k]!==undefined)a[k]=String(req.body[k]||'').trim();});a.payoutEnabled=!!(a.razorpayFundAccountId||a.upiId);a.updatedAt=now();partnerAccounts[restaurant.id]=a;schedulePersist();res.json({restaurantId:restaurant.id,payoutMethod:a.payoutMethod||'',bankLast4:a.bankLast4||'',upiMasked:a.upiId?String(a.upiId).replace(/^(.{1,2}).*(@.*)$/,'$1***$2'):'',payoutEnabled:a.payoutEnabled,fundAccountReady:!!a.razorpayFundAccountId});});
app.get('/partner/payout-account',(req,res)=>{const a=partnerAccounts[restaurant.id]||{};res.json({restaurantId:restaurant.id,payoutMethod:a.payoutMethod||'',bankLast4:a.bankLast4||'',upiMasked:a.upiId?String(a.upiId).replace(/^(.{1,2}).*(@.*)$/,'$1***$2'):'',payoutEnabled:!!a.payoutEnabled,fundAccountReady:!!a.razorpayFundAccountId});});

app.post('/onboarding/restaurant',(req,res)=>{const x={id:'ONB'+String(++seq.onboarding).padStart(3,'0'),type:'RESTAURANT',name:String(req.body.restaurantName||''),ownerName:String(req.body.ownerName||''),mobile:String(req.body.mobile||''),address:String(req.body.address||''),status:'SUBMITTED',createdAt:now()};onboarding.unshift(x);res.status(201).json(x);});
app.post('/onboarding/rider',(req,res)=>{const x={id:'ONB'+String(++seq.onboarding).padStart(3,'0'),type:'RIDER',name:String(req.body.name||''),mobile:String(req.body.mobile||''),address:String(req.body.address||''),vehicle:String(req.body.vehicle||''),status:'SUBMITTED',createdAt:now()};onboarding.unshift(x);res.status(201).json(x);});
app.get('/onboarding/restaurant',(req,res)=>res.type('html').send('<html><body><h2>GAJAB RASODA Restaurant Onboarding</h2><p>Please submit from Partner onboarding form/API.</p></body></html>'));
app.get('/onboarding/rider',(req,res)=>res.type('html').send('<html><body><h2>GAJAB RASODA Rider Onboarding</h2><p>Please submit from Delivery onboarding form/API.</p></body></html>'));

app.get('/delivery/profile',(req,res)=>{const id=String(req.query.deliveryPartnerId||'GRD01');res.json({...riders[id],...(riderAccounts[id]||{deliveryPartnerId:id,payoutMethod:'',upiId:'',bankLast4:'',payoutEnabled:false})});});
app.post('/delivery/profile',(req,res)=>{const id=String(req.body.deliveryPartnerId||'GRD01');if(!riders[id])riders[id]={id,name:'',mobile:'',status:'ACTIVE',online:false,createdAt:now()};const a=riderAccounts[id]||{deliveryPartnerId:id};['upiId','bankLast4','payoutMethod','accountName','mobile','email','razorpayFundAccountId'].forEach(k=>{if(req.body[k]!==undefined)a[k]=String(req.body[k]||'').trim();});a.payoutEnabled=!!(a.razorpayFundAccountId||a.upiId);a.updatedAt=now();riderAccounts[id]=a;schedulePersist();res.json({deliveryPartnerId:id,payoutMethod:a.payoutMethod||'',bankLast4:a.bankLast4||'',upiMasked:a.upiId?String(a.upiId).replace(/^(.{1,2}).*(@.*)$/,'$1***$2'):'',payoutEnabled:a.payoutEnabled,fundAccountReady:!!a.razorpayFundAccountId});});
app.patch('/partner/orders/:id/prep-time',(req,res)=>{const o=orders.find(x=>x.id===req.params.id);if(!o)return res.status(404).json({error:'order_not_found'});if(!['ACCEPTED','PREPARING'].includes(o.status))return res.status(409).json({error:'prep_time_not_editable',status:o.status});let mins=Math.round(Number(req.body.minutes));if(!Number.isFinite(mins))return res.status(400).json({error:'invalid_minutes'});mins=Math.max(5,Math.min(120,mins));o.prepMinutes=mins;o.prepDueAt=new Date(Date.now()+mins*60000).toISOString();o.updatedAt=now();audit('PREP_TIME_UPDATED','ORDER',o.id,{minutes:mins});schedulePersist();res.json({ok:true,prepMinutes:mins,prepDueAt:o.prepDueAt});});
app.get('/delivery/orders',(req,res)=>{const id=String(req.query.deliveryPartnerId||'GRD01');res.json({orders:orders.filter(o=>['READY','DELIVERY_ACCEPTED','PICKED_UP','OUT_FOR_DELIVERY'].includes(o.status)).filter(o=>!(o.rejectedBy||[]).includes(id)).filter(o=>!o.deliveryPartnerId||o.deliveryPartnerId===id).map(o=>({...o,riderEarning:riderEarning(o.deliveryDistanceKm),orderValueHidden:true})),serverTime:Date.now()});});
app.patch('/delivery/orders/:id/accept',(req,res)=>{const o=orders.find(x=>x.id===req.params.id);if(!o)return res.status(404).json({error:'order_not_found'});if(o.status!=='READY')return res.status(409).json({error:'order_not_ready'});const id=String(req.body.deliveryPartnerId||'GRD01');if(o.deliveryPartnerId&&o.deliveryPartnerId!==id)return res.status(409).json({error:'already_assigned'});o.deliveryPartnerId=id;o.deliveryAccepted=true;o.status='DELIVERY_ACCEPTED';stampOrder(o,'DELIVERY_ACCEPTED');o.deliveryAcceptedAt=now();o.updatedAt=now();audit('DELIVERY_ACCEPTED','ORDER',o.id,{deliveryPartnerId:id});schedulePersist();res.json({...o,riderEarning:riderEarning(o.deliveryDistanceKm)});});
app.patch('/delivery/orders/:id/reject',(req,res)=>{const o=orders.find(x=>x.id===req.params.id);if(!o)return res.status(404).json({error:'order_not_found'});if(o.status!=='READY')return res.status(409).json({error:'order_not_ready'});o.rejectedBy=o.rejectedBy||[];const id=String(req.body.deliveryPartnerId||'GRD01');if(!o.rejectedBy.includes(id))o.rejectedBy.push(id);audit('DELIVERY_REJECTED','ORDER',o.id,{deliveryPartnerId:id});schedulePersist();res.json({ok:true});});
app.post('/delivery/orders/:id/picked-up',(req,res)=>{const o=orders.find(x=>x.id===req.params.id);if(!o)return res.status(404).json({error:'order_not_found'});if(o.deliveryPartnerId!==req.body.deliveryPartnerId)return res.status(403).json({error:'not_assigned'});if(!['DELIVERY_ACCEPTED','PICKED_UP'].includes(o.status))return res.status(409).json({error:'invalid_delivery_state',status:o.status});o.status='PICKED_UP';stampOrder(o,'PICKED_UP');schedulePersist();res.json(o);});
app.post('/delivery/orders/:id/out-for-delivery',(req,res)=>{const o=orders.find(x=>x.id===req.params.id);if(!o)return res.status(404).json({error:'order_not_found'});if(o.deliveryPartnerId!==req.body.deliveryPartnerId)return res.status(403).json({error:'not_assigned'});if(o.status!=='PICKED_UP')return res.status(409).json({error:'order_not_picked_up',status:o.status});o.status='OUT_FOR_DELIVERY';stampOrder(o,'OUT_FOR_DELIVERY');schedulePersist();res.json(o);});
app.post('/delivery/orders/:id/verify-pin',(req,res)=>{const o=orders.find(x=>x.id===req.params.id);if(!o)return res.status(404).json({error:'order_not_found'});if(String(req.body.pin||'')!==String(o.deliveryPin))return res.status(400).json({error:'invalid_pin'});if(o.deliveryPartnerId&&req.body.deliveryPartnerId&&o.deliveryPartnerId!==req.body.deliveryPartnerId)return res.status(403).json({error:'wrong_rider'});o.status='DELIVERED';o.proof=String(req.body.proof||'');o.deliveredAt=now();o.updatedAt=now();stampOrder(o,'DELIVERED');ensurePayoutLedgers(o);schedulePersist();res.json({ok:true,order:o,riderEarning:riderEarning(o.deliveryDistanceKm)});});
app.post('/delivery/location',(req,res)=>{const id=String(req.body.orderId||'');if(!id)return res.status(400).json({error:'orderId_required'});const lat=Number(req.body.lat),lng=Number(req.body.lng);if(!Number.isFinite(lat)||!Number.isFinite(lng))return res.status(400).json({error:'valid_location_required'});locations[id]={deliveryPartnerId:String(req.body.deliveryPartnerId||''),lat,lng,updatedAt:now(),shareUrl:`https://maps.google.com/?q=${lat},${lng}`};res.json({ok:true,tracking:locations[id]});});
app.get('/delivery/location/:id',(req,res)=>res.json(locations[req.params.id]||{}));
app.get('/delivery/history',(req,res)=>{const id=String(req.query.deliveryPartnerId||'GRD01');res.json({orders:orders.filter(o=>o.deliveryPartnerId===id&&o.status==='DELIVERED').map(o=>({...o,riderEarning:riderEarning(o.deliveryDistanceKm)}))});});
app.get('/delivery/earnings',(req,res)=>{const id=String(req.query.deliveryPartnerId||'GRD01');const done=orders.filter(o=>o.deliveryPartnerId===id&&o.status==='DELIVERED');res.json({deliveryPartnerId:id,totalEarnings:done.reduce((s,o)=>s+riderEarning(o.deliveryDistanceKm),0),completedDeliveries:done.length,payouts:riderPayouts.filter(p=>p.deliveryPartnerId===id)});});
app.get('/delivery/payouts',(req,res)=>{const id=String(req.query.deliveryPartnerId||'GRD01');res.json({payouts:riderPayouts.filter(p=>p.deliveryPartnerId===id)});});

app.post('/grievances',(req,res)=>{const x={id:'GRG'+String(++seq.grievance).padStart(4,'0'),source:String(req.body.source||'CUSTOMER'),sourceId:String(req.body.sourceId||''),orderId:String(req.body.orderId||''),category:String(req.body.category||'Other'),message:String(req.body.message||''),status:'OPEN',createdAt:now(),updatedAt:now(),history:[{status:'OPEN',at:now(),message:'Grievance submitted'}]};grievances.unshift(x);res.status(201).json(x);});
app.get('/grievances',(req,res)=>res.json({grievances}));
app.patch('/admin/grievances/:id',(req,res)=>{const g=grievances.find(x=>x.id===req.params.id);if(!g)return res.status(404).json({error:'not_found'});if(req.body.status)g.status=String(req.body.status);if(req.body.adminReply!==undefined)g.adminReply=String(req.body.adminReply);g.updatedAt=now();g.history=g.history||[];g.history.push({status:g.status,at:g.updatedAt,reply:g.adminReply||''});res.json(g);});
app.post('/delivery/appeals',(req,res)=>{req.body.source='RIDER';req.body.sourceId=req.body.deliveryPartnerId||'';const x={id:'GRG'+String(++seq.grievance).padStart(4,'0'),source:'RIDER',sourceId:String(req.body.deliveryPartnerId||''),orderId:String(req.body.orderId||''),category:String(req.body.category||'Other'),message:String(req.body.message||''),status:'OPEN',createdAt:now(),updatedAt:now(),history:[{status:'OPEN',at:now(),message:'Grievance submitted'}]};grievances.unshift(x);res.status(201).json(x);});
app.get('/delivery/appeals',(req,res)=>{const id=String(req.query.deliveryPartnerId||'');res.json({appeals:grievances.filter(g=>g.source==='RIDER'&&(!id||g.sourceId===id))});});
app.patch('/admin/delivery/appeals/:id',(req,res)=>{const g=grievances.find(x=>x.id===req.params.id);if(!g)return res.status(404).json({error:'not_found'});if(req.body.status)g.status=String(req.body.status);if(req.body.adminReply!==undefined)g.adminReply=String(req.body.adminReply);g.updatedAt=now();g.history=g.history||[];g.history.push({status:g.status,at:g.updatedAt,reply:g.adminReply||''});res.json(g);});

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
app.patch('/admin/onboarding/:id',(req,res)=>{const x=onboarding.find(a=>a.id===req.params.id);if(!x)return res.status(404).json({error:'not_found'});x.status=String(req.body.status||x.status);x.updatedAt=now();if(x.type==='RESTAURANT'&&x.status==='APPROVED'&&!x.createdEntityId){x.createdEntityId=nextId('restaurant','GRR');}if(x.type==='RIDER'&&x.status==='APPROVED'&&!x.createdEntityId){const id=nextId('rider','GRD');riders[id]={id,name:x.name,mobile:x.mobile,status:'ACTIVE',online:false,createdAt:now()};x.createdEntityId=id;}res.json(x);});
app.get('/admin/grievances',(req,res)=>res.json({grievances}));
app.get('/admin/payouts',(req,res)=>{const partner=partnerPayouts.map(p=>safePayoutView('partner',p)),rider=riderPayouts.map(p=>safePayoutView('rider',p));const all=[...partner.map(x=>({...x,type:'partner'})),...rider.map(x=>({...x,type:'rider'}))];res.json({razorpayXConfigured:payoutConfigReady(),summary:{due:all.filter(isPayoutDue).length,processing:all.filter(x=>['PROCESSING','INITIATED','QUEUED','PENDING'].includes(String(x.status))).length,paid:all.filter(x=>['PAID','PROCESSED'].includes(String(x.status))).length,failed:all.filter(x=>String(x.status).startsWith('FAILED')).length,dueAmount:Math.round(all.filter(isPayoutDue).reduce((a,x)=>a+payoutAmount(x),0)*100)/100},partnerPayouts:partner,riderPayouts:rider});});
app.post('/admin/payouts/run-due',async(req,res)=>{const results=await runDuePayouts('COMPANY_ONE_CLICK_ALL');res.json({ok:true,results,processed:results.filter(x=>x.ok&&!x.skipped).length,failed:results.filter(x=>!x.ok).length});});
app.post('/admin/payouts/:type/:id/pay',async(req,res)=>{const type=req.params.type==='partner'?'partner':'rider';const list=type==='partner'?partnerPayouts:riderPayouts;const p=list.find(x=>x.id===req.params.id);if(!p)return res.status(404).json({error:'not_found'});const result=await executeOnePayout(type,p,'COMPANY_ONE_CLICK');res.status(result.ok?200:(result.status==='CONFIG_REQUIRED'?503:409)).json(result);});
app.patch('/admin/payouts/:type/:id',(req,res)=>{const list=req.params.type==='partner'?partnerPayouts:riderPayouts;const p=list.find(x=>x.id===req.params.id);if(!p)return res.status(404).json({error:'not_found'});if(req.body.status)p.status=String(req.body.status);if(req.body.reference)p.reference=String(req.body.reference);p.updatedAt=now();schedulePersist();res.json(p);});
app.post('/jobs/payouts/t-plus-1',async(req,res)=>{const token=String(req.headers['x-job-token']||'');const expected=String(process.env.PAYOUT_JOB_TOKEN||'');if(expected&&token!==expected)return res.status(401).json({error:'unauthorized'});const results=await runDuePayouts('T_PLUS_1_JOB');res.json({ok:true,results});});



// V1.10 consolidated operations: India time, serviceability, outlet, onboarding/grievance badges.
function istNow(){return new Intl.DateTimeFormat('en-IN',{timeZone:'Asia/Kolkata',dateStyle:'medium',timeStyle:'medium',hour12:true}).format(new Date());}

// RazorpayX payout webhook status reconciliation.
// Configure a separate webhook in RazorpayX for payout.pending, queued, initiated, processed, reversed, failed/rejected where available.
app.post('/webhooks/razorpayx/payouts',(req,res)=>{
  try{
    const event=String(req.body&&req.body.event||'');
    const entity=req.body&&req.body.payload&&req.body.payload.payout&&req.body.payload.payout.entity;
    if(!entity||!entity.id)return res.status(200).json({ok:true,ignored:true});
    const all=[...partnerPayouts.map(p=>({type:'partner',p})),...riderPayouts.map(p=>({type:'rider',p}))];
    const hit=all.find(x=>String(x.p.razorpayPayoutId||'')===String(entity.id)||String(x.p.id)===String(entity.reference_id||''));
    if(!hit)return res.status(200).json({ok:true,ignored:true,reason:'unknown_payout'});
    const map={processed:'PAID',reversed:'REVERSED',failed:'FAILED_REVIEW',rejected:'FAILED_REVIEW',queued:'QUEUED',pending:'PENDING',initiated:'INITIATED',processing:'PROCESSING'};
    const st=String(entity.status||event.replace('payout.','')).toLowerCase();
    hit.p.razorpayStatus=String(entity.status||st);hit.p.status=map[st]||String(st).toUpperCase();hit.p.updatedAt=now();
    if(hit.p.status==='PAID'){hit.p.paidAt=now();hit.p.reference=String(entity.utr||entity.id||'');}
    if(hit.p.status==='REVERSED')hit.p.reversedAt=now();
    audit('PAYOUT_WEBHOOK',hit.type.toUpperCase()+'_PAYOUT',hit.p.id,{event,status:hit.p.status,razorpayPayoutId:entity.id});
    schedulePersist();res.json({ok:true,id:hit.p.id,status:hit.p.status});
  }catch(e){res.status(500).json({error:'payout_webhook_failed'});}
});

app.get('/time',(req,res)=>res.json({serverTime:now(),timeZone:'Asia/Kolkata',indiaTime:istNow()}));

async function readCfg(key,fallback){
  if(!dbPool)return fallback;
  try{const q=await dbPool.query('SELECT config_value FROM system_config WHERE config_key=$1',[key]);return q.rows.length?q.rows[0].config_value:fallback;}catch(e){return fallback;}
}
async function writeCfg(key,value){
  if(!dbPool)throw new Error('database_not_configured');
  await dbPool.query(`INSERT INTO system_config(config_key,config_value,updated_at) VALUES($1,$2::jsonb,NOW()) ON CONFLICT(config_key) DO UPDATE SET config_value=EXCLUDED.config_value,updated_at=NOW()`,[key,JSON.stringify(value)]);
  return value;
}
app.get('/serviceability',async(req,res)=>{const rules=await readCfg('serviceability_rules_v1',{enabled:true,state:'Rajasthan',city:'Bhilwara',zones:[],pincodes:[]});res.json({rules});});
app.post('/serviceability/check',async(req,res)=>{const r=await readCfg('serviceability_rules_v1',{enabled:true,state:'Rajasthan',city:'Bhilwara',zones:[],pincodes:[]});const state=String(req.body.state||''),city=String(req.body.city||''),zone=String(req.body.zone||''),pin=String(req.body.pincode||'');const ok=!!r.enabled&&(!r.state||r.state.toLowerCase()===state.toLowerCase())&&(!r.city||r.city.toLowerCase()===city.toLowerCase())&&(!(r.zones||[]).length||(r.zones||[]).map(String).some(x=>x.toLowerCase()===zone.toLowerCase()))&&(!(r.pincodes||[]).length||(r.pincodes||[]).map(String).includes(pin));res.json({serviceable:ok,rules:r});});
app.put('/admin/serviceability',async(req,res)=>{try{const x={enabled:req.body.enabled!==false,state:String(req.body.state||'Rajasthan'),city:String(req.body.city||'Bhilwara'),zones:Array.isArray(req.body.zones)?req.body.zones:[],pincodes:Array.isArray(req.body.pincodes)?req.body.pincodes:[],updatedAt:now()};await writeCfg('serviceability_rules_v1',x);res.json({ok:true,rules:x});}catch(e){res.status(503).json({error:'database_not_configured'});}});

app.get('/partner/outlet',async(req,res)=>{const x=await readCfg('partner_outlet_GRR01',{restaurantId:'GRR01',name:restaurant.name,address:'Near Ahinsa Circle, Bhilwara, Rajasthan, India',phones:[],timings:{},staff:[]});res.json(x);});
app.put('/partner/outlet',async(req,res)=>{try{const old=await readCfg('partner_outlet_GRR01',{});const x={...old,...req.body,restaurantId:'GRR01',updatedAt:now()};await writeCfg('partner_outlet_GRR01',x);res.json(x);}catch(e){res.status(503).json({error:'database_not_configured'});}});

app.get('/notifications/summary',(req,res)=>res.json({paymentVerification:orders.filter(o=>o.status==='PAYMENT_PENDING'&&o.paymentStatus==='PENDING').length,onboarding:onboarding.filter(x=>x.status==='SUBMITTED').length,grievances:grievances.filter(g=>!['RESOLVED','REJECTED'].includes(g.status)).length,partnerOrders:orders.filter(o=>o.paymentStatus==='PAID'&&o.status==='PLACED').length,deliveryJobs:orders.filter(o=>o.status==='READY'&&!o.deliveryPartnerId).length}));
app.get('/onboarding/history',(req,res)=>{const mobile=String(req.query.mobile||'');const type=String(req.query.type||'').toUpperCase();res.json({requests:onboarding.filter(x=>(!mobile||x.mobile===mobile)&&(!type||x.type===type))});});
app.get('/grievances/history',(req,res)=>{const source=String(req.query.source||'').toUpperCase(),sourceId=String(req.query.sourceId||'');res.json({grievances:grievances.filter(g=>(!source||g.source===source)&&(!sourceId||g.sourceId===sourceId)).sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt))});});

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
