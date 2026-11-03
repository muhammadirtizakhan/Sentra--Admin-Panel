const {createClient}=require('@supabase/supabase-js');
const {hash}=require('../../../lib/auth');
const {createAdminPush}=require('../../../lib/admin-push');
const {createCronHandler}=require('../../../lib/push-cron');
let push;
export const config={api:{bodyParser:false},maxDuration:60};
export default createCronHandler({getPush:()=>{
 const env=process.env;
 if(!env.ADMIN_EMAIL||!env.ADMIN_PASSWORD||!env.ADMIN_SESSION_SECRET)throw new Error('Admin not configured');
 const identity=()=>hash(String(env.ADMIN_EMAIL).trim().toLowerCase()+':'+hash(String(env.ADMIN_EMAIL).trim().toLowerCase()+':'+env.ADMIN_PASSWORD));
 return push||(push=createAdminPush(createClient(env.SUPABASE_URL,env.SUPABASE_KEY,{auth:{persistSession:false}}),env,identity));
}});
