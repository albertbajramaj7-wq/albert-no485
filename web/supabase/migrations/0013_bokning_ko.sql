-- =====================================================================
-- Albert NO.485 – bokningar i samma pizzakö som drop-in (körs efter 0012_bank.sql)
--
-- Med "Minuter per pizza" påslaget räknas bokningsbara tider fram ur kön:
-- kunden får färdigtiden för SISTA pizzan och ska komma 10 min före.
-- Är kön ledig blir tiderna samma som förut (var 8:e minut). Ligger andra
-- pizzor i vägen flyttas tiden fram i stället för att försvinna.
-- Tidsluckor (Minuter per pizza = 0) fungerar som förut. Inget tas bort.
-- =====================================================================

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
  v_from int; v_ready int; v_seen int[] := '{}';
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

  -- Löpande kö: kunden får tiden när den SISTA pizzan är klar, precis som drop-in.
  -- För varje önskad tid t: börja göra pizzorna X min per pizza före t – eller så snart kön
  -- (och klockan, i dag) tillåter – och visa den faktiska färdigtiden. Ledig kö = samma tid som t.
  if s.pizza_min is not null then
    for t in select g from generate_series(s.lunch_first, s.lunch_last, s.slot_min) g
             union all select g from generate_series(s.dinner_first, s.dinner_last, s.slot_min) g order by 1
    loop
      v_close := case when t <= s.lunch_last then s.lunch_last else s.dinner_last end;
      v_from := floor((t * 60 - p_count * _pizza_seconds(s))::numeric / 60)::int;
      if p_date = v_today then v_from := greatest(v_from, v_minute); end if;
      v_ready := _line_next(p_date, p_count, v_from, s);
      continue when v_ready is null or v_ready > v_close or v_ready = any (v_seen);
      v_seen := v_seen || v_ready;
      v_rem := greatest(p_count, least(s.max_count, _line_room(p_date, v_ready, case when p_date = v_today then v_minute end, s)));
      if v_daily is not null then v_rem := least(v_rem, v_daily); end if;
      v_arr := v_ready - s.arrival_min;
      v_end := v_arr + s.sitting_min;
      v_seats := greatest(0, s.seats - _seats_used(p_date, v_arr, v_end, s));
      v_future := p_date > v_today or v_arr >= v_minute;
      v_sitting_ok := p_mode = 'away' or s.sit_after_close or d.allow_after_closing or v_end <= v_close;
      v_slots := v_slots || jsonb_build_object(
        'time', _time_text(v_ready), 'minute', v_ready, 'remaining', greatest(0, v_rem),
        'seats', case when p_mode = 'here' then v_seats else null end,
        'bookable', not d.paused and v_future and v_sitting_ok and v_rem >= p_count and (p_mode = 'away' or v_seats >= p_guests));
    end loop;
    return jsonb_build_object('date', p_date, 'closed', false, 'paused', d.paused, 'dailyRemaining', v_daily, 'slotMin', s.slot_min, 'queue', true, 'slots', v_slots);
  end if;

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
