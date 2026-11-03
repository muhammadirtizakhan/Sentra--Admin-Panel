-- Run after 007. Deletes request + unused email codes only. No CCTV/account deletion.
begin;
create or replace function public.sentra_delete_invitation_request(p_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.sentra_invitation_requests%rowtype;
begin
 select * into r from public.sentra_invitation_requests where id=p_id for update;
 if not found then return jsonb_build_object('ok',false,'reason','missing'); end if;
 -- A sending lease may still be in use; do not race the email sender.
 if r.status='sending' then return jsonb_build_object('ok',false,'reason','sending'); end if;
 delete from public.sentra_dashboard_invites where email=r.email and used_at is null;
 delete from public.sentra_invitation_requests where id=p_id;
 return jsonb_build_object('ok',true);
end;$$;
revoke all on function public.sentra_delete_invitation_request(uuid) from public,anon,authenticated;
grant execute on function public.sentra_delete_invitation_request(uuid) to service_role;
commit;
