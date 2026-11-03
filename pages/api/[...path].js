import {getApp} from '../../lib/application';
export const config={api:{bodyParser:false,externalResolver:true,responseLimit:false}};
export default function handler(req,res){return new Promise((resolve,reject)=>{res.once('finish',resolve);res.once('close',resolve);getApp()(req,res,err=>{if(err)reject(err);else {res.statusCode=404;res.end(JSON.stringify({ok:false,error:'Not found'}));resolve();}});});}
