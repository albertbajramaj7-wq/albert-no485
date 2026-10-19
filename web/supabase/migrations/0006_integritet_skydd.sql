-- =====================================================================
-- Albert NO.485 – integritet och skydd (körs efter 0005_tidsluckor.sql)
--
-- 1) Gamla bokningar anonymiseras automatiskt (namn, e-post, telefon tas bort,
--    antal pizzor och tider finns kvar för statistiken). Standard: 365 dagar.
-- 2) Spärr mot för många bokningar/inloggningar från samma avsändare.
--    Bara en hash av IP-adressen sparas, aldrig själva adressen, och den
--    rensas efter ett dygn.
-- =====================================================================

alter table settings add column if not exists retention_days int not null default 365 check (retention_days between 30 and 3650);

create table if not exists rate_limits (
  key          text not null,
  window_start timestamptz not null,
  hits         int not null default 0,
  primary key (key, window_start)
);
alter table rate_limits enable row level security;

create table if not exists app_state (
  key        text primary key,
  value      jsonb not null default '{}',
  updated_at timestamptz not null default now()
);
alter table app_state enable row level security;

-- Räknar ett försök. Kastar 429 om gränsen passeras inom fönstret.
create or replace function api_rate_limit(p jsonb) returns jsonb
language plpgsql as $$
declare
  v_key text := p ->> 'key';
  v_max int := (p ->> 'max')::int;
  v_sec int := (p ->> 'seconds')::int;
  v_start timestamptz;
  v_hits int;
begin
  if v_key is null or length(v_key) > 120 or v_max is null or v_sec is null or v_sec < 10 then perform _fail(400, 'Ogiltig begäran.'); end if;
  v_start := to_timestamp(floor(extract(epoch from _now(p)) / v_sec) * v_sec);
  insert into rate_limits (key, window_start, hits) values (v_key, v_start, 1)
  on conflict (key, window_start) do update set hits = rate_limits.hits + 1
  returning hits into v_hits;
  if v_hits > v_max then perform _fail(429, 'För många försök på kort tid. Vänta några minuter och försök igen, eller ring oss på 0340–827 75.'); end if;
  return jsonb_build_object('hits', v_hits);
end $$;

-- Daglig städning. Körs av nattjobbet och vid behov när admin öppnas (högst en gång per dygn).
create or replace function api_maintenance(p jsonb) returns jsonb
language plpgsql as $$
declare
  v_force boolean := coalesce((p ->> 'force')::boolean, false);
  v_last timestamptz := (select (value ->> 'at')::timestamptz from app_state where key = 'maintenance');
  v_days int := (select retention_days from settings where id = 1);
  v_cut date := _local_date(_now(p)) - v_days;
  v_anon int := 0;
begin
  if not v_force and v_last is not null and v_last > _now(p) - interval '20 hours' then
    return jsonb_build_object('skipped', true, 'lastRun', v_last);
  end if;
  perform pg_advisory_xact_lock(hashtext('albert-maintenance'));

  with old as (
    update bookings set name = 'Anonymiserad', email = '', phone = '',
      cancel_reason = case when cancel_reason is null then null else 'Anonymiserad' end, updated_at = now()
    where date < v_cut and name <> 'Anonymiserad'
    returning id
  ), mails as (
    update booking_emails e set payload = null, updated_at = now() from old where e.booking_id = old.id
    returning e.booking_id
  )
  select count(*) into v_anon from old;
  -- Mejlkopior för äldre, redan anonymiserade bokningar.
  update booking_emails e set payload = null from bookings b
    where b.id = e.booking_id and b.date < v_cut and e.payload is not null;

  delete from rate_limits where window_start < _now(p) - interval '1 day';
  delete from integration_states where created_at < _now(p) - interval '1 hour';

  insert into app_state (key, value, updated_at) values ('maintenance', jsonb_build_object('at', _now(p), 'anonymized', v_anon, 'cutoff', v_cut), now())
  on conflict (key) do update set value = excluded.value, updated_at = now();
  if v_anon > 0 then
    perform _audit(_local_date(_now(p)), 'system', 'privacy_anonymized', 'bookings', jsonb_build_object('count', v_anon, 'before', v_cut));
  end if;
  return jsonb_build_object('anonymized', v_anon, 'cutoff', v_cut, 'retentionDays', v_days);
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
