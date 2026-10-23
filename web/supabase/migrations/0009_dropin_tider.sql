-- =====================================================================
-- Albert NO.485 – drop-in med ugnstid (körs efter 0008_angra_avslut.sql)
--
-- Drop-in registreras med antal pizzor och får automatiskt första lediga
-- ugnstid efter redan bokade pizzor. Tiden tar plats i ugnen precis som en
-- bokning, så lediga tider på hemsidan uppdateras direkt.
-- Dagens drop-in-räknare (days.dropin) följer med automatiskt, så statistik
-- och "återstående pizzor" fungerar som förut. Plus/minus-räknaren finns kvar.
-- Inget befintligt tas bort.
-- =====================================================================

create table if not exists dropins (
  id          uuid primary key default gen_random_uuid(),
  date        date not null,
  ready_min   int not null check (ready_min between 0 and 1439),
  sit_start   int not null check (sit_start between 0 and 1439),
  count       int not null check (count between 1 and 100),
  mode        text not null default 'here' check (mode in ('here', 'away')),
  guests      int not null default 0 check (guests between 0 and 100),
  status      text not null default 'active' check (status in ('active', 'void')),
  created_by  text not null default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists dropins_date_idx on dropins (date) where status = 'active';
alter table dropins enable row level security;

-- Ugnens bakning: bokningar + drop-in fördelade på sina luckor.
create or replace function _day_pieces(p_date date, p_cap int, p_slot int)
returns table (minute int, qty int)
language sql stable as $$
  select x.minute, x.qty from bookings b, _booking_pieces(b.ready_min, b.count, p_cap, p_slot) x
  where b.date = p_date and b.status <> 'cancelled'
  union all
  select x.minute, x.qty from dropins r, _booking_pieces(r.ready_min, r.count, p_cap, p_slot) x
  where r.date = p_date and r.status = 'active'
$$;

-- Ryms p_count pizzor i ugnen om de ska vara klara vid t?
create or replace function _oven_fits(p_date date, t int, p_count int, s settings) returns boolean
language sql stable as $$
  select not exists (
      select 1 from _booking_pieces(t, p_count, s.slot_cap, s.slot_min) n
      where n.qty + (select coalesce(sum(x.qty), 0) from _day_pieces(p_date, s.slot_cap, s.slot_min) x
                     where x.minute > n.minute - s.slot_min and x.minute <= n.minute) > s.slot_cap)
    and not exists (
      select 1 from generate_series(0, greatest(1, ceil(60.0 / s.slot_min)::int) - 1) k
      where (select coalesce(sum(x.qty), 0) from _day_pieces(p_date, s.slot_cap, s.slot_min) x
             where x.minute > t + k * s.slot_min - 60 and x.minute <= t + k * s.slot_min) + p_count > s.hour_cap)
$$;

-- Upptagna platser vid en viss minut (bokningar + drop-in som äter här).
create or replace function _seats_used(p_date date, p_from int, p_to int, s settings) returns int
language sql stable as $$
  with overlapping as (
    select ready_min - s.arrival_min as b_start, ready_min - s.arrival_min + s.sitting_min as b_end, guests
    from bookings where date = p_date and mode = 'here' and status in ('confirmed', 'checked_in')
    union all
    select sit_start, sit_start + s.sitting_min, guests
    from dropins where date = p_date and mode = 'here' and status = 'active'
  ), relevant as (
    select * from overlapping where b_start < p_to and b_end > p_from
  ), points as (
    select p_from as point union select b_start from relevant where b_start >= p_from and b_start < p_to
  )
  select coalesce(max((select coalesce(sum(o.guests), 0) from relevant o where o.b_start <= p.point and o.b_end > p.point)), 0)::int
  from points p
$$;

-- Samma som i 0005, men platserna räknar nu även drop-in som sitter i restaurangen.
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
    v_rem := 0;
    v_n := least(s.max_count, s.slot_cap * 20);
    for w in 1 .. v_n loop
      exit when not _oven_fits(p_date, t, w, s);
      v_rem := w;
    end loop;
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

-- Första ugnstid efter just nu (i dag) då p_count pizzor ryms i ugnen.
create or replace function _dropin_suggest(p_date date, p_count int, p_now timestamptz, s settings) returns int
language plpgsql stable as $$
declare
  v_after int := case when p_date = _local_date(p_now) then _local_minute(p_now) else -1 end;
  t int;
begin
  -- Samma ugnsrytm som bokningarna: lunchens tider, sedan middagens tider (och vidare efter sista bokningstid).
  for t in select g from (
             select g from generate_series(s.lunch_first, s.dinner_first - 1, s.slot_min) g
             union all select g from generate_series(s.dinner_first, 1439, s.slot_min) g) x
           where g > v_after order by g loop
    if _oven_fits(p_date, t, p_count, s) then return t; end if;
  end loop;
  return null;
end $$;

create or replace function _dropins_json(p_date date) returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'time', _time_text(ready_min), 'minute', ready_min, 'count', count,
           'mode', mode, 'guests', guests, 'createdBy', created_by, 'createdAt', created_at) order by ready_min, created_at), '[]')
  from dropins where date = p_date and status = 'active'
$$;

-- Dagsvyn: samma som förut + dagens drop-in med tider.
do $$
begin
  if not exists (select 1 from pg_proc where proname = '_admin_day_base') then
    alter function _admin_day(date, staff) rename to _admin_day_base;
  end if;
end $$;

create or replace function _admin_day(p_date date, a staff) returns jsonb
language sql stable as $$
  select _admin_day_base(p_date, a) || jsonb_build_object('dropins', _dropins_json(p_date))
$$;

-- suggest: visa föreslagen tid · add: registrera · void: ångra
create or replace function api_admin_dropin(p jsonb) returns jsonb
language plpgsql as $$
declare
  a staff := _actor(p, 'staff');
  s settings;
  v_date date := _date(p ->> 'date');
  v_action text := coalesce(p ->> 'action', 'suggest');
  v_count int; v_mode text; v_guests int; v_ready int; v_sit int; v_seats int; v_id uuid; r dropins;
begin
  select * into s from settings where id = 1;
  if v_action in ('suggest', 'add') then
    v_count := _int(p -> 'count', 1, 100, 'Ange antal pizzor (1–100).');
    v_mode := case when p ->> 'mode' = 'away' then 'away' else 'here' end;
    v_guests := case when v_mode = 'here' then coalesce(_int(coalesce(p -> 'guests', '0'), 0, 100, 'Ange antal gäster.'), 0) else 0 end;
    v_sit := case when v_date = _local_date(_now(p)) then _local_minute(_now(p)) else s.lunch_first end;
  end if;

  if v_action = 'suggest' then
    v_ready := _dropin_suggest(v_date, v_count, _now(p), s);
    v_seats := greatest(0, s.seats - _seats_used(v_date, v_sit, v_sit + s.sitting_min, s));
    return jsonb_build_object('time', _time_text(v_ready), 'minute', v_ready,
      'waitMin', case when v_date = _local_date(_now(p)) and v_ready is not null then v_ready - _local_minute(_now(p)) end,
      'seatsFree', v_seats, 'seatsOk', v_mode = 'away' or v_seats >= v_guests);
  end if;

  perform _lock_day(v_date);
  perform _ensure_day(v_date);

  if v_action = 'add' then
    if p ? 'minute' and p ->> 'minute' is not null then
      v_ready := _int(p -> 'minute', 0, 1439, 'Välj en giltig tid.');
      if not _oven_fits(v_date, v_ready, v_count, s) then perform _fail(409, 'Ugnen hinner inte så många pizzor på den tiden. Välj en senare tid.'); end if;
    else
      v_ready := _dropin_suggest(v_date, v_count, _now(p), s);
    end if;
    if v_ready is null then perform _fail(409, 'Det finns ingen ledig ugnstid kvar i dag för så många pizzor.'); end if;
    insert into dropins (date, ready_min, sit_start, count, mode, guests, created_by)
      values (v_date, v_ready, v_sit, v_count, v_mode, v_guests, a.name) returning id into v_id;
    update days set dropin = dropin + v_count, version = version + 1 where date = v_date;
    perform _audit(v_date, a.name, 'dropin_added', v_id::text,
      jsonb_build_object('time', _time_text(v_ready), 'count', v_count, 'mode', v_mode, 'guests', v_guests));
  elsif v_action = 'void' then
    v_id := _uuid(p -> 'id', 'Välj en giltig drop-in.');
    update dropins set status = 'void', updated_at = now() where id = v_id and date = v_date and status = 'active' returning * into r;
    if r.id is null then perform _fail(409, 'Drop-in är redan borttagen. Uppdatera listan.'); end if;
    update days set dropin = greatest(0, dropin - r.count), version = version + 1 where date = v_date;
    perform _audit(v_date, a.name, 'dropin_voided', v_id::text, jsonb_build_object('time', _time_text(r.ready_min), 'count', r.count));
  else
    perform _fail(400, 'Välj en giltig åtgärd.');
  end if;
  return _admin_day(v_date, a);
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
