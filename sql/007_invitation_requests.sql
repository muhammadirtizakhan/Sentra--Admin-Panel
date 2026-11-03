-- Additive: run after 005. Existing accounts, invitations and CCTV data are preserved.
begin;
create table if not exists public.sentra_invitation_requests(
 id uuid primary key default gen_random_uuid(),email text not null unique,name text not null,
 status text not null default 'pending' check(status in ('pending','sending','approved','failed','rejected')),
 created_at timestamptz not null default now(),approved_at timestamptz,last_error text,
 claim_token uuid,lease_until timestamptz
);
alter table public.sentra_invitation_requests enable row level security;
revoke all on public.sentra_invitation_requests from anon,authenticated;
grant all on public.sentra_invitation_requests to service_role;
create or replace function public.sentra_request_invitation(p_email text,p_name text)
returns void language plpgsql security definer set search_path=public as $$
begin
 -- Same response for existing accounts/requests; public requests never grant devices.
 if exists(select 1 from sentra_dashboard_users where email=p_email) then return;end if;
 insert into sentra_invitation_requests(email,name) values(p_email,p_name) on conflict(email) do nothing;
end;$$;
create or replace function public.sentra_claim_invitation_request(p_id uuid,p_claim uuid)
returns setof public.sentra_invitation_requests language plpgsql security definer set search_path=public as $$
begin
 return query update sentra_invitation_requests r set status='sending',claim_token=p_claim,lease_until=now()+interval '5 minutes',last_error=null
 where r.id=p_id and (r.status in ('pending','failed','approved') or (r.status='sending' and r.lease_until<now())) returning r.*;
end;$$;
revoke all on function public.sentra_request_invitation(text,text),public.sentra_claim_invitation_request(uuid,uuid) from public,anon,authenticated;
grant execute on function public.sentra_request_invitation(text,text),public.sentra_claim_invitation_request(uuid,uuid) to service_role;
commit;
