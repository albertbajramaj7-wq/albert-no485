-- =====================================================================
-- Albert NO.485 – ångra avslutade bokningar (körs efter 0007)
--
-- En bokning som av misstag markerats som avslutad kan nu
--  * ångras (tillbaka till incheckad), eller
--  * avbokas (räknas då inte längre som såld pizza).
-- Inget raderas – bara bokningens status ändras och allt loggas i historiken.
-- =====================================================================

create or replace function api_admin_booking(p jsonb) returns jsonb
language plpgsql as $$
declare
  a staff := _actor(p, 'staff');
  v_id uuid := _uuid(p -> 'id', 'Välj en giltig bokning.');
  b bookings;
  v_action text := p ->> 'action';
  v_from text[]; v_to text; v_reason text; v_rows int;
begin
  select * into b from bookings where id = v_id;
  if not found then perform _fail(404, 'Bokningen finns inte.'); end if;
  perform _lock_day(b.date);
  case v_action
    when 'checkin' then v_from := array['confirmed']; v_to := 'checked_in';
    when 'finish' then v_from := array['checked_in']; v_to := 'completed';
    when 'cancel' then v_from := array['confirmed', 'checked_in', 'completed']; v_to := 'cancelled';
    when 'undo_checkin' then v_from := array['checked_in']; v_to := 'confirmed';
    when 'undo_finish' then v_from := array['completed']; v_to := 'checked_in';
    else perform _fail(400, 'Välj en giltig åtgärd.');
  end case;
  if not (b.status = any (v_from)) then perform _fail(409, 'Bokningen har redan ändrats. Uppdatera listan.'); end if;
  if v_action = 'cancel' then v_reason := _text(p -> 'reason', 2, 250, 'Skriv en anledning till avbokningen.'); end if;
  update bookings set status = v_to, cancel_reason = coalesce(v_reason, cancel_reason), updated_at = now()
    where id = v_id and status = b.status;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then perform _fail(409, 'Bokningen har redan ändrats. Uppdatera listan.'); end if;
  perform _audit(b.date, a.name, 'booking_' || v_action, v_id::text,
    jsonb_build_object('time', _time_text(b.ready_min), 'count', b.count, 'reason', v_reason));
  return _admin_day(b.date, a);
end $$;

do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and (p.proname like 'api\_%' or p.proname like '\_%') loop
    execute format('revoke all on function %s from public', f.sig);
    if exists (select 1 from pg_roles where rolname = 'anon') then execute format('revoke all on function %s from anon', f.sig); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on function %s from authenticated', f.sig); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function %s to service_role', f.sig); end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on all tables in schema public from anon, authenticated';
    execute 'revoke all on all sequences in schema public from anon, authenticated';
  end if;
end $$;
