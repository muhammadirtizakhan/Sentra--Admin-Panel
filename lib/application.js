const express=require('express');
const {createClient}=require('@supabase/supabase-js');
const {createAuth}=require('./auth');
let cached;
function createApp(database){
 const db=database||(process.env.SUPABASE_URL&&process.env.SUPABASE_KEY?createClient(process.env.SUPABASE_URL,process.env.SUPABASE_KEY,{auth:{persistSession:false}}):null);
 const app=express();app.disable('x-powered-by');app.use(express.json({limit:'16kb'}));
 app.use((req,res,next)=>{res.set({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY'});next();});
 const auth=createAuth(db);app.use('/api',auth.csrf);
require('./admin').attachAdmin(app,db);
app.use((err,req,res,next)=>{console.error('SENTRA request failed',{code:err.code,name:err.name});if(!res.headersSent)res.status(err.status||503).json({ok:false,error:err.status===404?err.message:'Request unavailable. Check configuration and connectivity.'});});return app;}
module.exports={createApp,getApp:()=>cached||(cached=createApp())};
