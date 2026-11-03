'use strict';
const crypto = require('node:crypto');
function createCronHandler({env=process.env, getPush}={}) {
 return async function handler(req,res) {
  res.setHeader('Cache-Control','no-store');
  res.setHeader('X-Content-Type-Options','nosniff');
  if (!['GET','POST'].includes(req.method)) {res.setHeader('Allow','GET, POST');return res.status(405).json({ok:false,error:'Method not allowed'});}
  const secret=env.CRON_SECRET || '';
  if (secret.length<32) return res.status(503).json({ok:false,error:'Push scheduler is not configured'});
  const actual=Buffer.from(String(req.headers.authorization || ''));
  const expected=Buffer.from('Bearer '+secret);
  if (actual.length!==expected.length || !crypto.timingSafeEqual(actual,expected)) return res.status(401).json({ok:false,error:'Unauthorized'});
  if (!env.SUPABASE_URL || !env.SUPABASE_KEY || !env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !env.VAPID_SUBJECT) return res.status(503).json({ok:false,error:'Push service is not configured'});
  try {
   // One bounded batch; persisted database leases coordinate concurrent invocations.
   await getPush().tick(4);
   return res.status(200).json({ok:true,message:'Push queue checked. Provider/device delivery is not guaranteed.'});
  } catch (error) {
   console.error('Push scheduler failed',{code:error?.code || 'unknown'});
   return res.status(503).json({ok:false,error:'Push queue processing failed; check server logs and database migrations'});
  }
 };
}
module.exports={createCronHandler};
