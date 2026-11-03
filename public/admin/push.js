'use strict';
(() => {
 let busy=false;
 const supported=()=>isSecureContext&&'serviceWorker' in navigator&&'PushManager' in window&&'Notification' in window;
 const message=text=>{document.querySelector('#admin-push-status').textContent=text;};
 async function request(action,body){const r=await fetch('/api/company-admin/push/'+action,{method:body===undefined?'GET':'POST',credentials:'same-origin',headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const d=await r.json();if(!r.ok)throw new Error(d.error||'Notification request failed');return d;}
 async function subscription(){const r=await navigator.serviceWorker.getRegistration('/');return r?await r.pushManager.getSubscription():null;}
 function keyBytes(key){return Uint8Array.from(atob(key.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-key.length%4)%4)),c=>c.charCodeAt(0));}
 async function disable(){if(!supported())return;const s=await subscription();if(s){await request('unsubscribe',{endpoint:s.endpoint});await s.unsubscribe();}}
 window.sentraAdminPushDisable=disable;
 function mount(){
  const target=document.querySelector('#admin-refresh');if(!target)return;
  const panel=document.createElement('section');panel.style.cssText='padding:12px;display:flex;gap:10px;flex-wrap:wrap;align-items:center';
  panel.innerHTML='<button type="button" data-push="enable">Enable notifications</button><button type="button" data-push="test">Test notification</button><button type="button" data-push="disable">Disable notifications</button><span id="admin-push-status" role="status">Admin notifications: enable on this device.</span>';
  target.parentElement.append(panel);
  panel.addEventListener('click',async e=>{
   const action=e.target.dataset.push;if(!action||busy)return;busy=true;panel.querySelectorAll('button').forEach(b=>b.disabled=true);
   try{
    if(!supported())throw new Error('This browser does not support background push. Open admin in Chrome.');
    if(action==='disable'){await disable();message('Notifications disabled on this device.');return;}
    if(action==='enable'){
     const permission=await Notification.requestPermission();if(permission!=='granted')throw new Error('Allow notifications in browser and phone settings.');
     const config=await request('config');if(!config.configured)throw new Error('Admin VAPID configuration is missing.');
     await navigator.serviceWorker.register('/admin-push-sw.js',{scope:'/'});const reg=await navigator.serviceWorker.ready;
     let s=await reg.pushManager.getSubscription();
     if(s&&Array.from(new Uint8Array(s.options.applicationServerKey||[])).join()!==Array.from(keyBytes(config.publicKey)).join()){await request('unsubscribe',{endpoint:s.endpoint});await s.unsubscribe();s=null;}
     s=s||await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:keyBytes(config.publicKey)});
     await request('subscribe',{subscription:s.toJSON()});message('Enabled. Send a test notification to verify delivery.');
    }else{const s=await subscription();if(!s)throw new Error('Enable notifications first.');await request('test',{endpoint:s.endpoint});message('Test submitted. Check the phone notification tray.');}
   }catch(err){message(err.message);}finally{busy=false;panel.querySelectorAll('button').forEach(b=>b.disabled=false);}
  });
 }
 mount();
})();
