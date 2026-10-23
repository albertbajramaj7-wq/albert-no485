-- =====================================================================
-- Albert NO.485 – tid per pizza i sekunder (körs efter 0010_pizzako.sql)
--
-- Gör det möjligt med t.ex. 2,5 minuter per pizza. Kön räknas i sekunder,
-- färdigtiden avrundas uppåt till hel minut. Standard sätts till 2,5 min.
-- Inget befintligt tas bort.
-- =====================================================================

alter table settings add column if not exists pizza_sec int check (pizza_sec between 30 and 1800);
update settings set pizza_sec = 150, pizza_min = 3, version = version + 1, updated_at = now() where id = 1;

create or replace function _pizza_minutes(p_value jsonb) returns numeric
language plpgsql as $$
declare v numeric;
begin
  begin v := replace(p_value #>> '{}', ',', '.')::numeric; exception when others then v := null; end;
  if v is null or v < 0 or v > 30 or (v > 0 and v < 0.5) then perform _fail(400, 'Minuter per pizza ska vara 0–30 (t.ex. 2,5).'); end if;
  return v;
end $$;

create or replace function _pizza_seconds(s settings) returns int
language sql immutable as $$ select coalesce(s.pizza_sec, s.pizza_min * 60) $$;

-- Kön i sekunder: [start, slut), slut = färdigtid.
create or replace function _line_jobs_sec(p_date date, p_sec int)
returns table (s int, e int)
language sql stable as $$
  select ready_min * 60 - count * p_sec, ready_min * 60 from bookings where date = p_date and status <> 'cancelled'
  union all
  select ready_min * 60 - count * p_sec, ready_min * 60 from dropins where date = p_date and status = 'active'
$$;

create or replace function _line_room(p_date date, t int, p_from int, s settings) returns int
language sql stable as $$
  select case
    when exists (select 1 from _line_jobs_sec(p_date, _pizza_seconds(_line_room.s)) j where j.s < t * 60 and j.e > t * 60) then 0
    else greatest(0, floor((t * 60 - greatest(coalesce(p_from, 0) * 60,
           coalesce((select max(j.e) from _line_jobs_sec(p_date, _pizza_seconds(_line_room.s)) j where j.s < t * 60), 0)))::numeric / _pizza_seconds(_line_room.s))::int)
  end
$$;

-- Första färdigtid (hel minut) för p_count pizzor som startar tidigast p_from.
create or replace function _line_next(p_date date, p_count int, p_from int, s settings) returns int
language sql stable as $$
  with c as (
    select st, ceil((st + p_count * _pizza_seconds(_line_next.s))::numeric / 60)::int as ready from (
      select p_from * 60 as st union select j.e from _line_jobs_sec(p_date, _pizza_seconds(_line_next.s)) j where j.e > p_from * 60
    ) x
  )
  select min(c.ready) from c
  where c.ready <= 1439
    and not exists (select 1 from _line_jobs_sec(p_date, _pizza_seconds(_line_next.s)) j
                    where j.s < c.ready * 60 and j.e > c.ready * 60 - p_count * _pizza_seconds(_line_next.s))
$$;

create or replace function api_admin_settings(p jsonb) returns jsonb
language plpgsql as $$
declare
  a staff;
  v jsonb := p -> 'settings';
  v_rows int;
  v_date date;
  v_days int[];
begin
  if p ->> 'action' is null or p ->> 'action' = 'get' then
    a := _actor(p, 'staff');
    return _settings_json();
  end if;
  a := _actor(p, 'admin');
  if p ->> 'action' = 'save' then
    if jsonb_typeof(v -> 'openWeekdays') is distinct from 'array' then perform _fail(400, 'Välj vilka dagar ni har öppet.'); end if;
    select array_agg(_int(x, 0, 6, 'Välj vilka dagar ni har öppet.')) into v_days from jsonb_array_elements(v -> 'openWeekdays') x;
    if v_days is null or exists (select 1 from unnest(v_days) d where d not between 0 and 6) then perform _fail(400, 'Välj vilka dagar ni har öppet.'); end if;
    begin
      update settings set
        slot_cap = _int(v -> 'slotCap', 1, 100), hour_cap = _int(v -> 'hourCap', 1, 500), seats = _int(v -> 'seats', 0, 500),
        sitting_min = _int(v -> 'sittingMin', 15, 240), arrival_min = _int(v -> 'arrivalMin', 0, 60),
        horizon_days = _int(v -> 'horizonDays', 1, 365), max_count = _int(v -> 'maxCount', 1, 50), max_guests = _int(v -> 'maxGuests', 1, 500),
        open_weekdays = v_days,
        lunch_first = _int(v -> 'lunchFirst', 0, 1439), lunch_last = _int(v -> 'lunchLast', 0, 1439),
        dinner_first = _int(v -> 'dinnerFirst', 0, 1439), dinner_last = _int(v -> 'dinnerLast', 0, 1439),
        avg_pizza_price = _int(v -> 'avgPizzaPrice', 0, 10000), waste_cost = _int(v -> 'wasteCost', 0, 10000),
        slot_min = case when v ? 'slotMin' then _int(v -> 'slotMin', 5, 60, 'Tidsluckan ska vara 5–60 minuter.') else slot_min end,
        sit_after_close = case when v ? 'sitAfterClose' then _bool(v -> 'sitAfterClose', 'Välj om gäster får sitta efter stängning.') else sit_after_close end,
        pizza_min = case when v ? 'pizzaMin' then nullif(ceil(_pizza_minutes(v -> 'pizzaMin'))::int, 0) else pizza_min end,
        pizza_sec = case when v ? 'pizzaMin' then nullif(round(_pizza_minutes(v -> 'pizzaMin') * 60)::int, 0) else pizza_sec end,
        version = version + 1, updated_at = now()
      where id = 1 and version = _int(v -> 'version', 0, 2147483647);
    exception when check_violation then
      perform _fail(400, 'Tiderna går inte ihop. Lunch måste sluta före middag, och alla tider ska vara hela kvartar.');
    end;
    get diagnostics v_rows = row_count;
    if v_rows = 0 then perform _fail(409, 'Inställningarna har ändrats av någon annan. Uppdatera och försök igen.'); end if;
    perform _audit(_local_date(now()), a.name, 'settings_saved', 'settings', v);
  elsif p ->> 'action' = 'close_date' then
    v_date := _date(p ->> 'date');
    perform _lock_day(v_date);
    insert into closed_dates (date, reason, created_by)
      values (v_date, coalesce(_text(coalesce(p -> 'reason', '""'), 0, 200, 'Anledningen är för lång.'), ''), a.name)
      on conflict (date) do update set reason = excluded.reason;
    perform _audit(v_date, a.name, 'date_closed', v_date::text, jsonb_build_object('reason', p ->> 'reason',
      'activeBookings', (select count(*) from bookings where date = v_date and status in ('confirmed', 'checked_in'))));
  elsif p ->> 'action' = 'reopen_date' then
    v_date := _date(p ->> 'date');
    delete from closed_dates where date = v_date;
    perform _audit(v_date, a.name, 'date_reopened', v_date::text, '{}');
  else
    perform _fail(400, 'Välj en giltig åtgärd.');
  end if;
  return _settings_json();
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
  end if;
end $$;
