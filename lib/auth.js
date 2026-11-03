'use strict';
const crypto=require('node:crypto');
const {promisify}=require('node:util');
const scrypt=promisify(crypto.scrypt);
const COOKIE='sentra_session';
const hash=s=>crypto.createHash('sha256').update(String(s)).digest('hex');
const safeUser=u=>({id:u.id,email:u.email,name:u.name,timezone:u.timezone});
const email=s=>String(s||'').trim().toLowerCase();
const validEmail=s=>s.length<=254&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
const validPassword=s=>typeof s==='string'&&s.length>=12&&Buffer.byteLength(s)<=128;
async function passwordHash(password){const salt=crypto.randomBytes(16).toString('hex');return salt+':'+(await scrypt(password,salt,64)).toString('hex');}
async function verify(password,stored){const [salt,key]=String(stored||'').split(':');if(!/^[a-f0-9]{32}$/.test(salt||'')||!/^[a-f0-9]{128}$/.test(key||''))return false;const actual=await scrypt(String(password),salt,64);return crypto.timingSafeEqual(actual,Buffer.from(key,'hex'));}
const tokenFrom=req=>{const x=(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith(COOKIE+'='));return x?x.slice(COOKIE.length+1):'';};
function createAuth(db){
 const fail=(res,status,error)=>res.status(status).json({ok:false,error});
 const denied=(req,res,message)=>req.path==='/app'?res.redirect('/login'):fail(res,401,message);
 const wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(()=>fail(res,503,'Account service unavailable. Check server configuration.'));
 async function limit(req,res,type,max=10){
  const global=await db.rpc('sentra_take_limit',{p_key:hash('ip:'+type+':'+req.ip),p_max:type==='register'?15:50,p_seconds:600});
  if(global.error)throw global.error;if(!global.data){fail(res,429,'Too many attempts. Try again later.');return false;}
  const key=hash(type+':'+req.ip+':'+email(req.body?.email));
  const {data,error}=await db.rpc('sentra_take_limit',{p_key:key,p_max:max,p_seconds:600});
  if(error)throw error;if(!data){fail(res,429,'Too many attempts. Try again later.');return false;}return true;
 }
 function clear(res){res.clearCookie(COOKIE,{path:'/',httpOnly:true,sameSite:'strict',secure:String(process.env.PUBLIC_ORIGIN||'').startsWith('https://')});}
 async function session(req,res,uid){const token=crypto.randomBytes(32).toString('hex');const ttl=12*3600000;
  const {error}=await db.from('sentra_dashboard_sessions').insert({token_hash:hash(token),user_id:uid,expires_at:new Date(Date.now()+ttl).toISOString()});if(error)throw error;
  res.cookie(COOKIE,token,{httpOnly:true,secure:req.secure||String(process.env.PUBLIC_ORIGIN||'').startsWith('https://'),sameSite:'strict',path:'/',maxAge:ttl});
 }
 const requireUser=wrap(async(req,res,next)=>{
  if(!db)return fail(res,503,'Database not configured');const token=tokenFrom(req);
  if(!/^[a-f0-9]{64}$/.test(token))return denied(req,res,'Sign in required');
  const s=await db.from('sentra_dashboard_sessions').select('user_id').eq('token_hash',hash(token)).gt('expires_at',new Date().toISOString()).maybeSingle();if(s.error)throw s.error;
  if(!s.data){clear(res);return denied(req,res,'Session expired. Sign in again.');}
  const u=await db.from('sentra_dashboard_users').select('id,email,name,timezone,disabled').eq('id',s.data.user_id).maybeSingle();if(u.error)throw u.error;
  if(!u.data||u.data.disabled)return denied(req,res,'Account unavailable');
  const d=await db.from('sentra_user_devices').select('device_id').eq('user_id',u.data.id);if(d.error)throw d.error;
  req.user=u.data;req.devices=(d.data||[]).map(x=>x.device_id);next();
 });
 function csrf(req,res,next){
  if(['GET','HEAD','OPTIONS'].includes(req.method))return next();
  const expected=process.env.PUBLIC_ORIGIN||`${req.protocol}://${req.get('host')}`;
  if(req.get('origin')!==expected)return fail(res,403,'Request origin denied');
  if(!req.is('application/json'))return fail(res,415,'JSON body required');next();
 }
 function routes(app){
  app.post('/api/auth/register',wrap(async(req,res)=>{
   if(!db)return fail(res,503,'Database not configured');if(!await limit(req,res,'register',5))return;
   const e=email(req.body.email),name=String(req.body.name||'').trim(),password=req.body.password,invite=String(req.body.invite||'');
   if(!validEmail(e)||!name||name.length>80||!validPassword(password)||!/^[a-f0-9]{64}$/.test(invite))return fail(res,400,'Use your invited email, invitation code, name and a password of 12–128 bytes.');
   const {data,error}=await db.rpc('sentra_register_invite',{p_token:hash(invite),p_email:e,p_name:name,p_password:await passwordHash(password)});
   if(error)return fail(res,400,'Invitation invalid, expired, already used, or email already registered.');
   await session(req,res,data);res.json({ok:true});
  }));
  app.post('/api/auth/login',wrap(async(req,res)=>{
   if(!db)return fail(res,503,'Database not configured');if(!await limit(req,res,'login'))return;
   const e=email(req.body.email),password=String(req.body.password||'');if(!validEmail(e)||Buffer.byteLength(password)>128)return fail(res,400,'Enter valid credentials');
   const u=await db.from('sentra_dashboard_users').select('*').eq('email',e).maybeSingle();if(u.error)throw u.error;
   // Fixed valid dummy hash keeps missing-account requests on the same expensive path.
   const dummy='0'.repeat(32)+':'+ '0'.repeat(128);
   const match=await verify(password,u.data?.password_hash||dummy);
   if(!u.data||u.data.disabled||!match)return fail(res,401,'Email or password is incorrect');
   await session(req,res,u.data.id);res.json({ok:true});
  }));
  app.get('/api/auth/me',requireUser,(req,res)=>res.json({ok:true,user:safeUser(req.user),devices:req.devices}));
  app.post('/api/auth/logout',requireUser,wrap(async(req,res)=>{
   const removed=await db.from('sentra_dashboard_sessions').delete().eq('token_hash',hash(tokenFrom(req)));if(removed.error)throw removed.error;
   if(req.body.endpointHash)await db.from('sentra_push_subscriptions').delete().eq('user_id',req.user.id).eq('endpoint_hash',req.body.endpointHash);
   clear(res);res.json({ok:true});
  }));
  app.patch('/api/profile',requireUser,wrap(async(req,res)=>{
   const name=String(req.body.name||'').trim(),tz=String(req.body.timezone||'');
   if(tz.length>128)return fail(res,400,'Invalid timezone');
   try{new Intl.DateTimeFormat('en',{timeZone:tz}).format();}catch{return fail(res,400,'Invalid timezone');}
   if(!name||name.length>80)return fail(res,400,'Name must contain 1–80 characters');
   const r=await db.from('sentra_dashboard_users').update({name,timezone:tz}).eq('id',req.user.id);if(r.error)throw r.error;
   res.json({ok:true,user:{...safeUser(req.user),name,timezone:tz}});
  }));
  app.post('/api/profile/password',requireUser,wrap(async(req,res)=>{
   if(!await limit(req,res,'password',5))return;
   const old=String(req.body.currentPassword||''),next=req.body.password;
   if(Buffer.byteLength(old)>128||!validPassword(next))return fail(res,400,'Use a new password of at least 12 characters, at most 128 bytes.');
   const u=await db.from('sentra_dashboard_users').select('password_hash').eq('id',req.user.id).single();if(u.error)throw u.error;
   if(!await verify(old,u.data.password_hash))return fail(res,400,'Current password is incorrect');
   const r=await db.rpc('sentra_change_password',{p_user:req.user.id,p_old:u.data.password_hash,p_new:await passwordHash(next)});if(r.error)throw r.error;
   if(!r.data)return fail(res,409,'Account changed. Sign in and retry.');
   clear(res);res.json({ok:true});
  }));
 }
 return {requireUser,csrf,routes};
}
module.exports={createAuth,hash,passwordHash,verify,safeUser};
