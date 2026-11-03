begin;
create table if not exists public.sentra_dashboard_users(
 id uuid primary key default gen_random_uuid(),email text not null unique,name text not null,
 password_hash text not null,timezone text not null default 'Asia/Karachi',disabled boolean not null default false,
 created_at timestamptz not null default now()
);
create table if not exists public.sentra_dashboard_invites(
 token_hash text primary key,email text not null,devices text[] not null check(cardinality(devices)>0),
 expires_at timestamptz not null,used_at timestamptz
);
create table if not exists public.sentra_user_devices(
 user_id uuid references public.sentra_dashboard_users on delete cascade,device_id text not null,
 primary key(user_id,device_id)
);
create table if not exists public.sentra_dashboard_sessions(
 token_hash text primary key,user_id uuid not null references public.sentra_dashboard_users on delete cascade,
 expires_at timestamptz not null,created_at timestamptz not null default now()
);
create index if not exists sentra_sessions_expiry on public.sentra_dashboard_sessions(expires_at);
create table if not exists public.sentra_dashboard_limits(key text primary key,hits integer not null,expires_at timestamptz not null);
create table if not exists public.sentra_push_subscriptions(
 id uuid primary key default gen_random_uuid(),user_id uuid not null references public.sentra_dashboard_users on delete cascade,
 endpoint_hash text not null unique,subscription jsonb not null,created_at timestamptz not null default now(),last_error text
);
create table if not exists public.sentra_push_jobs(
 id uuid primary key default gen_random_uuid(),subscription_id uuid not null references public.sentra_push_subscriptions on delete cascade,
 alert_id uuid not null references public.cctv_alerts on delete cascade,status text not null default 'pending' check(status in ('pending','sending','done','failed')),
 payload jsonb not null,attempts integer not null default 0,next_attempt_at timestamptz not null default now(),lease_until timestamptz,
 unique(subscription_id,alert_id)
);
create index if not exists sentra_push_due on public.sentra_push_jobs(status,next_attempt_at);
create or replace function public.sentra_register_invite(p_token text,p_email text,p_name text,p_password text)
returns uuid language plpgsql security definer set search_path=public as $$
declare inv sentra_dashboard_invites%rowtype;uid uuid;
begin
 select * into inv from sentra_dashboard_invites where token_hash=p_token for update;
 if not found or inv.used_at is not null or inv.expires_at<=now() or inv.email<>p_email then raise exception 'Invalid invitation';end if;
 insert into sentra_dashboard_users(email,name,password_hash) values(p_email,p_name,p_password) returning id into uid;
 insert into sentra_user_devices(user_id,device_id) select uid,unnest(inv.devices);
 update sentra_dashboard_invites set used_at=now() where token_hash=p_token;
 return uid;
end;$$;
create or replace function public.sentra_take_limit(p_key text,p_max integer,p_seconds integer)
returns boolean language plpgsql security definer set search_path=public as $$
declare n integer;
begin
 if p_max<1 or p_seconds<1 then return false;end if;
 insert into sentra_dashboard_limits values(p_key,1,now()+make_interval(secs=>p_seconds))
 on conflict(key) do update set hits=case when sentra_dashboard_limits.expires_at<=now() then 1 else sentra_dashboard_limits.hits+1 end,
 expires_at=case when sentra_dashboard_limits.expires_at<=now() then excluded.expires_at else sentra_dashboard_limits.expires_at end returning hits into n;
 return n<=p_max;
end;$$;
create or replace function public.sentra_change_password(p_user uuid,p_old text,p_new text)
returns boolean language plpgsql security definer set search_path=public as $$
begin
 update sentra_dashboard_users set password_hash=p_new where id=p_user and password_hash=p_old and not disabled;
 if not found then return false;end if;
 delete from sentra_dashboard_sessions where user_id=p_user;
 delete from sentra_push_subscriptions where user_id=p_user;
 return true;
end;$$;
create or replace function public.sentra_enqueue_alert_push()
returns trigger language plpgsql security definer set search_path=public as $$
declare dev text;
begin
 dev:=new.device_id;
 if dev is null then select coalesce(e.device_id,v.device_id) into dev from cctv_events e left join video_sources v on v.id=e.video_source_id where e.id=new.event_id;end if;
 insert into sentra_push_jobs(subscription_id,alert_id,payload)
 select s.id,new.id,jsonb_build_object('id',new.id,'title','SENTRA · '||coalesce(new.alert_level,'Alert'),'body',left(coalesce(new.alert_title,'New security event'),150),'url','/app#alerts?alert='||new.id)
 from sentra_push_subscriptions s join sentra_user_devices d on d.user_id=s.user_id
 join sentra_dashboard_users u on u.id=s.user_id where d.device_id=dev and not u.disabled
 on conflict(subscription_id,alert_id) do nothing;
 return new;
end;$$;
drop trigger if exists sentra_alert_push on public.cctv_alerts;
create trigger sentra_alert_push after insert on public.cctv_alerts for each row execute function public.sentra_enqueue_alert_push();
create or replace function public.sentra_claim_push(p_limit integer default 20)
returns setof public.sentra_push_jobs language plpgsql security definer set search_path=public as $$
begin
 return query update sentra_push_jobs j set status='sending',lease_until=now()+interval '2 minutes',attempts=j.attempts+1
 where j.id in(select q.id from sentra_push_jobs q where ((q.status='pending' and q.next_attempt_at<=now()) or (q.status='sending' and q.lease_until<now())) and q.attempts<8 order by q.next_attempt_at for update skip locked limit greatest(1,least(p_limit,20))) returning j.*;
 update sentra_push_jobs set status='failed' where attempts>=8 and status='sending' and lease_until<now();
end;$$;
alter table public.sentra_dashboard_users enable row level security;
alter table public.sentra_dashboard_invites enable row level security;
alter table public.sentra_user_devices enable row level security;
alter table public.sentra_dashboard_sessions enable row level security;
alter table public.sentra_dashboard_limits enable row level security;
alter table public.sentra_push_subscriptions enable row level security;
alter table public.sentra_push_jobs enable row level security;
revoke all on public.sentra_dashboard_users,public.sentra_dashboard_invites,public.sentra_user_devices,public.sentra_dashboard_sessions,public.sentra_dashboard_limits,public.sentra_push_subscriptions,public.sentra_push_jobs from anon,authenticated;
grant all on public.sentra_dashboard_users,public.sentra_dashboard_invites,public.sentra_user_devices,public.sentra_dashboard_sessions,public.sentra_dashboard_limits,public.sentra_push_subscriptions,public.sentra_push_jobs to service_role;
revoke all on function public.sentra_register_invite(text,text,text,text),public.sentra_take_limit(text,integer,integer),public.sentra_change_password(uuid,text,text),public.sentra_enqueue_alert_push(),public.sentra_claim_push(integer) from public,anon,authenticated;
grant execute on function public.sentra_register_invite(text,text,text,text),public.sentra_take_limit(text,integer,integer),public.sentra_change_password(uuid,text,text),public.sentra_claim_push(integer) to service_role;
commit;
