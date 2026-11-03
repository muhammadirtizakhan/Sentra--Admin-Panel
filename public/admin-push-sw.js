'use strict';
const {hash}=require('./auth');
const {validSubscription,pushConfigured}=require('./push-validation');
const wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
function createAdminPush(db,env=process.env,identity,sender){
 if(!sender&&pushConfigured(env))sender=require('web-push');
 if(pushConfigured(env))sender.setVapidDetails(env.VAPID_SUBJECT,env.VAPID_PUBLIC_KEY,env.VAPID_PRIVATE_KEY);
 async function send(sub,payload){return sender.sendNotification(sub,JSON.stringify(payload),{TTL:3600,urgency:'high',timeout:10000});}
 async function checked(query){const r=await query;if(r.error)throw r.error;return r.data;}
 async function tick(limit=4){
  const jobs=await checked(db.rpc('sentra_claim_admin_push',{p_limit:Math.max(1,Math.min(4,limit))}));
  await Promise.all((jobs||[]).map(async j=>{
   const sub=await checked(db.from('sentra_admin_push_subscriptions').select('*').eq('id',j.subscription_id).maybeSingle());
   if(!sub||sub.admin_identity!==identity()){
    await checked(db.from('sentra_admin_push_jobs').update({status:'failed',lease_until:null}).eq('id',j.id));return;
   }
   // Identity is checked again at delivery, so changing admin credentials revokes old devices.
   try {await send(sub.subscription,j.payload);}
   catch(e){
    if([404,410].includes(e.statusCode)){await checked(db.from('sentra_admin_push_subscriptions').delete().eq('id',sub.id));return;}
    await checked(db.from('sentra_admin_push_jobs').update({status:j.attempts>=8?'failed':'pending',lease_until:null,next_attempt_at:new Date(Date.now()+Math.min(300,2**j.attempts)*1000).toISOString()}).eq('id',j.id));return;
   }
   await checked(db.from('sentra_admin_push_jobs').update({status:'done',lease_until:null}).eq('id',j.id));
  }));
 }
 return {tick,send,checked};
}
function attachAdminPush(app,db,{env,requireAdmin,identity}){
 let push;const service=()=>push||(push=createAdminPush(db,env,identity));
 const root='/api/company-admin/push/';
 app.get(root+'config',requireAdmin,(req,res)=>res.json({ok:true,configured:pushConfigured(env),publicKey:env.VAPID_PUBLIC_KEY||null}));
 app.post(root+'subscribe',requireAdmin,wrap(async(req,res)=>{
  if(!pushConfigured(env))return res.status(503).json({ok:false,error:'Admin notifications are not configured'});
  const s=req.body?.subscription;
  if(!validSubscription(s))return res.status(400).json({ok:false,error:'Unsupported push subscription'});
  const {checked}=service();
  const existing=await checked(db.from('sentra_admin_push_subscriptions').select('id').eq('admin_identity',identity()));
  const h=hash(s.endpoint);
  const found=await checked(db.from('sentra_admin_push_subscriptions').select('id').eq('endpoint_hash',h).maybeSingle());
  if(!found&&(existing||[]).length>=10)return res.status(400).json({ok:false,error:'Admin device limit reached'});
  await checked(db.from('sentra_admin_push_subscriptions').upsert({admin_identity:identity(),endpoint_hash:h,subscription:{endpoint:s.endpoint,keys:{p256dh:s.keys.p256dh,auth:s.keys.auth}}}, {onConflict:'endpoint_hash'}));
  res.json({ok:true});
 }));
 app.post(root+'unsubscribe',requireAdmin,wrap(async(req,res)=>{
  await service().checked(db.from('sentra_admin_push_subscriptions').delete().eq('admin_identity',identity()).eq('endpoint_hash',hash(req.body?.endpoint||'')));
  res.json({ok:true});
 }));
 app.post(root+'test',requireAdmin,wrap(async(req,res)=>{
  if(!pushConfigured(env))return res.status(503).json({ok:false,error:'Admin notifications are not configured'});
  const {checked,send}=service();
  const allowed=await checked(db.rpc('sentra_take_limit',{p_key:'admin-push-test:'+identity(),p_max:5,p_seconds:600}));
  if(!allowed)return res.status(429).json({ok:false,error:'Please wait before sending another test'});
  const sub=await checked(db.from('sentra_admin_push_subscriptions').select('subscription').eq('admin_identity',identity()).eq('endpoint_hash',hash(req.body?.endpoint||'')).maybeSingle());
  if(!sub)return res.status(400).json({ok:false,error:'Enable admin notifications first'});
  await send(sub.subscription,{id:'test-'+Date.now(),title:'SENTRA Admin',body:'Admin notifications are connected.',url:'/#overview'});
  res.json({ok:true});
 }));
}
module.exports={createAdminPush,attachAdminPush};
