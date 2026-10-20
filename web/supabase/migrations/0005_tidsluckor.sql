-- =====================================================================
-- Albert NO.485 – tidsluckor i valfri längd (körs efter 0004_fortnox.sql)
--
-- Ugnen: X pizzor per tidslucka på Y minuter (nu 4 pizzor var 8:e minut).
-- En bokning med fler pizzor än en lucka rymmer bakas i luckorna närmast
-- före färdigtiden. Gäster som äter här får sitta kvar efter stängning.
-- Tidigare funktioner i 0001 lämnas orörda; här ersätts de med nya versioner.
-- =====================================================================

alter table settings
  add column if not exists slot_min int not null default 15 check (slot_min between 5 and 60),
  add column if not exists sit_after_close boolean not null default false;

update settings set slot_min = 8, slot_cap = 4, sit_after_close = true, version = version + 1, updated_at = now() where id = 1;

-- Pizzor per lucka för en bokning: fyller färdigtidens lucka först, resten i luckorna innan.
create or replace function _booking_pieces(p_ready int, p_count int, p_cap int, p_slot int)
returns table (minute int, qty int)
language sql immutable as $$
  select p_ready - k * p_slot, least(p_cap, p_count - k * p_cap)
  from generate_series(0, ceil(p_count::numeric / p_cap)::int - 1) k
$$;

-- Dagens bakning: alla aktiva bokningar fördelade på sina luckor.
create or replace function _day_pieces(p_date date, p_cap int, p_slot int)
returns table (minute int, qty int)
language sql stable as $$
  select x.minute, x.qty from bookings b, _booking_pieces(b.ready_min, b.count, p_cap, p_slot) x
  where b.date = p_date and b.status <> 'cancelled'
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
  t int; v_rem int; v_arr int; v_end int; v_close int; v_used int; v_seats int; v_win int; w int; v_n int;
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

  v_win := greatest(1, ceil(60.0 / s.slot_min)::int);   -- luckor per rullande timme

  for t in select g from generate_series(s.lunch_first, s.lunch_last, s.slot_min) g
           union all select g from generate_series(s.dinner_first, s.dinner_last, s.slot_min) g order by 1
  loop
    -- Hur många pizzor får plats om färdigtiden är t? Pröva antal tills någon lucka blir full.
    v_rem := 0;
    v_n := least(s.max_count, s.slot_cap * 20);
    for w in 1 .. v_n loop
      -- Varje lucka som bokningen använder får inte bli överfull.
      exit when exists (
        select 1 from _booking_pieces(t, w, s.slot_cap, s.slot_min) n
        where n.qty + (select coalesce(sum(x.qty), 0) from _day_pieces(p_date, s.slot_cap, s.slot_min) x
                       where x.minute > n.minute - s.slot_min and x.minute <= n.minute) > s.slot_cap);
      -- Rullande timme: inget timfönster runt färdigtiden får passera taket.
      exit when exists (
        select 1 from generate_series(0, v_win - 1) k
        where (select coalesce(sum(x.qty), 0) from _day_pieces(p_date, s.slot_cap, s.slot_min) x
               where x.minute > t + k * s.slot_min - 60 and x.minute <= t + k * s.slot_min) + w > s.hour_cap);
      v_rem := w;
    end loop;
    if v_daily is not null then v_rem := least(v_rem, v_daily); end if;

    v_arr := t - s.arrival_min;
    v_end := v_arr + s.sitting_min;
    with overlapping as (
      select ready_min - s.arrival_min as b_start, ready_min - s.arrival_min + s.sitting_min as b_end, guests
      from bookings
      where date = p_date and mode = 'here' and status in ('confirmed', 'checked_in')
        and ready_min - s.arrival_min < v_end and ready_min - s.arrival_min + s.sitting_min > v_arr
    ), points as (
      select v_arr as point union select b_start from overlapping where b_start >= v_arr and b_start < v_end
    )
    select coalesce(max((select coalesce(sum(o.guests), 0) from overlapping o where o.b_start <= p.point and o.b_end > p.point)), 0)
      into v_used from points p;
    v_seats := greatest(0, s.seats - v_used);

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
end $$;
