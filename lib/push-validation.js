'use strict';
function validSubscription(s){
 try{const u=new URL(s.endpoint);if(u.protocol!=='https:'||u.username||u.password||u.port||s.endpoint.length>2048)return false;
 const hosts=['fcm.googleapis.com','updates.push.services.mozilla.com'];
 if(!hosts.includes(u.hostname)&&!u.hostname.endsWith('.notify.windows.com'))return false;
 return /^[\w-]+$/.test(s.keys?.p256dh||'')&&/^[\w-]+$/.test(s.keys?.auth||'')&&Buffer.from(s.keys.p256dh,'base64url').length===65&&Buffer.from(s.keys.auth,'base64url').length===16;
 }catch{return false;}
}
function pushConfigured(env=process.env){return !!(env.VAPID_PUBLIC_KEY&&env.VAPID_PRIVATE_KEY&&env.VAPID_SUBJECT);}
module.exports={validSubscription,pushConfigured};
