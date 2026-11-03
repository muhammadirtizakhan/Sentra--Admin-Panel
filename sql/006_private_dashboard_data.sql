-- Run AFTER confirming BOTH Python and dashboard use the server-only service_role key.
-- This closes direct anonymous/authenticated REST access to CCTV data.
-- No existing records or policies are deleted. Server service_role access remains.
begin;
do $$
declare t text;
begin
 foreach t in array array['video_sources','cctv_events','cctv_alerts','event_timeline','tracked_objects','incidents','zones','rule_configurations','sentra_video_media'] loop
  if to_regclass('public.'||t) is not null then
   execute format('alter table public.%I enable row level security',t);
   execute format('revoke all on public.%I from anon, authenticated',t);
   execute format('grant all on public.%I to service_role',t);
  end if;
 end loop;
end $$;
-- New dashboard signs evidence URLs only after account/device authorization.
update storage.buckets set public=false where id='evidence';
commit;
