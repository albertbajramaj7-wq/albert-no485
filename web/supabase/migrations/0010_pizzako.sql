-- =====================================================================
-- Albert NO.485 – löpande pizzakö (körs efter 0009_dropin_tider.sql)
--
-- Varje pizza tar X minuter att göra (standard 2). Bokningar och drop-in
-- ligger i en gemensam kö: 3 pizzor = 6 minuter, 5 pizzor = 10 minuter.
-- En bokning görs i minuterna precis före sin färdigtid. Drop-in får
-- första lucka som är tillräckligt lång, från just nu eller direkt efter
-- pizzorna som redan ligger i kön. Hemsidans lediga tider räknas om hela
-- tiden utifrån samma kö.
-- Sätt "Minuter per pizza" till 0 i Inställningar för att gå tillbaka till
-- de gamla tidsluckorna (X pizzor per lucka). Inget befintligt tas bort.
-- =====================================================================

alter table settings add column if not exists pizza_min int check (pizza_min between 1 and 30);
update settings set pizza_min = 2, version = version + 1, updated_at = now() where id = 1 and pizza_min is null;

-- Alla jobb i kön: [start, slut) i minuter. Slut = färdigtid.
create or replace function _line_jobs(p_date date, p_min int)
returns table (s int, e int)
language sql stable as $$
  select ready_min - count * p_min, ready_min from bookings where date = p_date and status <> 'cancelled'
  union all
  select ready_min - count * p_min, ready_min from dropins where date = p_date and status = 'active'
$$;

-- Hur många pizzor hinner bli klara precis till t? (p_from = tidigast start, t.ex. just nu)
create or replace function _line_room(p_date date, t int, p_from int, s settings) returns int
language sql stable as $$
  select case
    when exists (select 1 from _line_jobs(p_date, s.pizza_min) j where j.s < t and j.e > t) then 0
    else greatest(0, floor((t - greatest(coalesce(p_from, 0),
           coalesce((select max(j.e) from _line_jobs(p_date, s.pizza_min) j where j.s < t), 0)))::numeric / s.pizza_min)::int)
  end
$$;

-- Första färdigtid för p_count pizzor som startar tidigast p_from.
create or replace function _line_next(p_date date, p_count int, p_from int, s settings) returns int
language sql stable as $$
  select min(c.st) + p_count * s.pizza_min from (
    select p_from as st union select j.e from _line_jobs(p_date, s.pizza_min) j where j.e > p_from
  ) c
  where c.st + p_count * s.pizza_min <= 1439
    and not exists (select 1 from _line_jobs(p_date, s.pizza_min) j where j.s < c.st + p_count * s.pizza_min and j.e > c.st)
$$;

-- Ryms p_count pizzor till t? Löpande kö om minuter per pizza är satt, annars tidsluckor som förut.
create or replace function _oven_fits(p_date date, t int, p_count int, s settings) returns boolean
language sql stable as $$
  select case when s.pizza_min is not null then _line_room(p_date, t, null, s) >= p_count
  else not exists (
      select 1 from _booking_pieces(t, p_count, s.slot_cap, s.slot_min) n
      where n.qty + (select coalesce(sum(x.qty), 0) from _day_pieces(p_date, s.slot_cap, s.slot_min) x
                     where x.minute > n.minute - s.slot_min and x.minute <= n.minute) > s.slot_cap)
    and not exists (
      select 1 from generate_series(0, greatest(1, ceil(60.0 / s.slot_min)::int) - 1) k
      where (select coalesce(sum(x.qty), 0) from _day_pieces(p_date, s.slot_cap, s.slot_min) x
             where x.minute > t + k * s.slot_min - 60 and x.minute <= t + k * s.slot_min) + p_count > s.hour_cap)
  end
$$;

create or replace function _availability(p_date date, p_count int, p_mode text, p_guests int, p_now timestamptz, p_public boolean default true)
returns jsonb
language plpgsql stable as $$
declare
  s settings;
  d days;
  v_today date := _local_date(p_now);
  v_minute int := _local_minute(p_now);
  v_booked int;
  v_daily int;
  v_slots jsonb := '[]';
  t int; v_rem int; v_arr int; v_end int; v_close int; v_seats int; v_win int; w int; v_n int;
  v_future boolean; v_sitting_ok boolean;
begin
  select * into s from settings where id = 1;
  if p_public and (p_date < v_today or p_date > v_today + s.horizon_days) then
    perform _fail(400, 'Du kan boka från i dag och ' || s.horizon_days || ' dagar framåt.');
  end if;
  select * into d from days where date = p_date;
  if not found then d := row(p_date, null, 0, 0, false, false, 0)::days; end if;

  select coalesce(sum(count), 0) into v_booked from bookings where date = p_date and status <> 'cancelled';
  v_daily := case when d.prepared is null then null else greatest(0, d.prepared - v_booked - d.dropin - d.waste) end;

  if not (extract(dow from p_date)::int = any (s.open_weekdays)) or exists (select 1 from closed_dates c where c.date = p_date) then
    return jsonb_build_object('date', p_date, 'closed', true, 'paused', d.paused, 'dailyRemaining', v_daily, 'slots', '[]'::jsonb);
  end if;

  v_win := greatest(1, ceil(60.0 / s.slot_min)::int);

  for t in select g from generate_series(s.lunch_first, s.lunch_last, s.slot_min) g
           union all select g from generate_series(s.dinner_first, s.dinner_last, s.slot_min) g order by 1
  loop
    if s.pizza_min is not null then
      -- Löpande kö: så många pizzor som hinner göras i luckan före t (och inte före just nu).
      v_rem := least(s.max_count, _line_room(p_date, t, case when p_date = v_today then v_minute end, s));
    else
      v_rem := 0;
      v_n := least(s.max_count, s.slot_cap * 20);
      for w in 1 .. v_n loop
        exit when not _oven_fits(p_date, t, w, s);
        v_rem := w;
      end loop;
    end if;
    if v_daily is not null then v_rem := least(v_rem, v_daily); end if;

    v_arr := t - s.arrival_min;
    v_end := v_arr + s.sitting_min;
    v_seats := greatest(0, s.seats - _seats_used(p_date, v_arr, v_end, s));

    v_close := case when t <= s.lunch_last then s.lunch_last else s.dinner_last end;
    v_future := p_date > v_today or v_arr >= v_minute;
    v_sitting_ok := p_mode = 'away' or s.sit_after_close or d.allow_after_closing or v_end <= v_close;

    v_slots := v_slots || jsonb_build_object(
      'time', _time_text(t), 'minute', t, 'remaining', greatest(0, v_rem),
      'seats', case when p_mode = 'here' then v_seats else null end,
      'bookable', not d.paused and v_future and v_sitting_ok and v_rem >= p_count and (p_mode = 'away' or v_seats >= p_guests));
  end loop;

  return jsonb_build_object('date', p_date, 'closed', false, 'paused', d.paused, 'dailyRemaining', v_daily, 'slotMin', s.slot_min, 'slots', v_slots);
end $$;

create or replace function _dropin_suggest(p_date date, p_count int, p_now timestamptz, s settings) returns int
language plpgsql stable as $$
declare
  v_after int := case when p_date = _local_date(p_now) then _local_minute(p_now) else -1 end;
  t int;
begin
  if s.pizza_min is not null then
    -- Löpande kö: börja direkt (eller när föregående pizzor är klara) och lägg till X min per pizza.
    return _line_next(p_date, p_count, case when p_date = _local_date(p_now) then _local_minute(p_now) else s.lunch_first end, s);
  end if;
  -- Samma ugnsrytm som bokningarna: lunchens tider, sedan middagens tider (och vidare efter sista bokningstid).
  for t in select g from (
             select g from generate_series(s.lunch_first, s.dinner_first - 1, s.slot_min) g
             union all select g from generate_series(s.dinner_first, 1439, s.slot_min) g) x
           where g > v_after order by g loop
    if _oven_fits(p_date, t, p_count, s) then return t; end if;
  end loop;
  return null;
end $$;

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
        pizza_min = case when v ? 'pizzaMin' then nullif(_int(v -> 'pizzaMin', 0, 30, 'Minuter per pizza ska vara 0–30.'), 0) else pizza_min end,
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
