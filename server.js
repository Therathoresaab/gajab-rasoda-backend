const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const orders = [];

function id(prefix='ord') { return `${prefix}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`; }

app.get('/health', (req,res)=>res.json({ok:true, service:'Gajab Rasoda Backend'}));

app.post('/customer/orders', (req,res)=>{
  const {customerName, customerPhone, address, items, total} = req.body || {};
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({error:'items_required'});
  const order = {
    id: id(),
    customerName: customerName || 'Customer',
    customerPhone: customerPhone || '',
    address: address || '',
    items,
    total: Number(total || 0),
    status: 'PLACED',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  orders.unshift(order);
  res.status(201).json(order);
});

app.get('/partner/orders', (req,res)=>{
  const since = Number(req.query.since || 0);
  const data = since ? orders.filter(o => new Date(o.updatedAt).getTime() > since) : orders;
  res.json({orders:data, serverTime:Date.now()});
});

app.patch('/partner/orders/:id/status', (req,res)=>{
  const order = orders.find(o=>o.id===req.params.id);
  if (!order) return res.status(404).json({error:'order_not_found'});
  const allowed = ['ACCEPTED','REJECTED','PREPARING','READY','OUT_FOR_DELIVERY','DELIVERED'];
  if (!allowed.includes(req.body.status)) return res.status(400).json({error:'invalid_status'});
  order.status = req.body.status;
  order.updatedAt = new Date().toISOString();
  res.json(order);
});

app.get('/customer/orders/:id', (req,res)=>{
  const order = orders.find(o=>o.id===req.params.id);
  if (!order) return res.status(404).json({error:'order_not_found'});
  res.json(order);
});

app.listen(PORT, ()=>console.log(`Gajab Rasoda backend running on :${PORT}`));
