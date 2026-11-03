self.addEventListener('push',event=>{
 let data={};try{data=event.data?.json()||{};}catch{}
 const url=new URL(data.url||'/#overview',self.location.origin);
 event.waitUntil(self.registration.showNotification(data.title||'SENTRA Admin',{
  body:data.body||'New company activity',icon:'/assets/icon-192.png',badge:'/assets/icon-192.png',
  tag:String(data.id||'admin-activity'),data:{url:url.origin===self.location.origin?url.href:self.location.origin+'/#overview'}
 }));
});
self.addEventListener('notificationclick',event=>{
 event.notification.close();const url=event.notification.data?.url||self.location.origin+'/#overview';
 event.waitUntil((async()=>{const windows=await clients.matchAll({type:'window',includeUncontrolled:true});for(const w of windows){if(new URL(w.url).origin===self.location.origin){await w.navigate(url);return w.focus();}}return clients.openWindow(url);})());
});
