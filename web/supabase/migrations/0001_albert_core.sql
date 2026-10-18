-- =====================================================================
-- Albert NO.485 – databas för Supabase (Postgres)
--
-- Bygger vidare på ChatGPT:s bokningsmodell (pizzor + färdigtid) och lägger
-- till personalroller, svinn med orsak, meny, stängda datum, inställningar
-- och statistik.
--
-- Säkerhet:
--  * RLS är påslaget på alla tabeller utan policyer, så Supabase publika
--    nycklar (anon/authenticated) kan inte läsa eller skriva något direkt.
--  * All åtkomst går via funktionerna api_*, som bara servern får anropa
--    (rollen service_role). Varje adminfunktion kontrollerar själv att den
--    som anropar är aktiv personal med rätt roll.
--  * Ingenting raderas: bokningar avbokas, svinn makuleras, uppgifter och
--    menyrätter arkiveras/döljs, personal inaktiveras.
--
-- Fel: funktionerna kastar fel med koderna PT400, PT401, PT403, PT404 och
-- PT409. Supabase (PostgREST) skickar dem vidare som HTTP-status.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Tabeller
-- ---------------------------------------------------------------------
create table settings (
  id               int primary key default 1 check (id = 1),
  slot_cap         int not null default 8   check (slot_cap between 1 and 100),    -- pizzor per kvart
  hour_cap         int not null default 31  check (hour_cap between 1 and 500),    -- pizzor per rullande timme
  seats            int not null default 31  check (seats between 0 and 500),       -- sittplatser
  sitting_min      int not null default 60  check (sitting_min between 15 and 240),
  arrival_min      int not null default 10  check (arrival_min between 0 and 60),  -- ankomst före färdigtid
  horizon_days     int not null default 30  check (horizon_days between 1 and 365),
  max_count        int not null default 8   check (max_count between 1 and 50),    -- pizzor per bokning
  max_guests       int not null default 31  check (max_guests between 1 and 500),
  open_weekdays    int[] not null default '{0,3,4,5,6}',                            -- 0 = söndag
  lunch_first      int not null default 735,   -- första färdigtid 12:15 (minuter efter midnatt)
  lunch_last       int not null default 870,   -- sista färdigtid 14:30, även stängning för lunch
  dinner_first     int not null default 1005,  -- 16:45
  dinner_last      int not null default 1260,  -- 21:00
  avg_pizza_price  int not null default 160 check (avg_pizza_price between 0 and 10000), -- för uppskattad försäljning
  waste_cost       int not null default 35  check (waste_cost between 0 and 10000),      -- råvarukostnad per pizza
  version          int not null default 0,
  updated_at       timestamptz not null default now(),
  check (lunch_first <= lunch_last and lunch_last < dinner_first and dinner_first <= dinner_last
         and lunch_first >= 0 and dinner_last < 1440 and lunch_first % 15 = 0 and lunch_last % 15 = 0
         and dinner_first % 15 = 0 and dinner_last % 15 = 0)
);
insert into settings (id) values (1);

create table closed_dates (
  date        date primary key,
  reason      text not null default '',
  created_by  text not null,
  created_at  timestamptz not null default now()
);

create table days (
  date                date primary key,
  prepared            int check (prepared between 0 and 10000),   -- förberedda pizzor, null = ingen gräns
  dropin              int not null default 0 check (dropin >= 0),
  waste               int not null default 0 check (waste >= 0),
  paused              boolean not null default false,
  allow_after_closing boolean not null default false,
  version             int not null default 0
);

create table bookings (
  id            uuid primary key default gen_random_uuid(),
  request_key   uuid not null unique,
  date          date not null,
  ready_min     int not null check (ready_min between 0 and 1439),
  count         int not null check (count between 1 and 50),
  guests        int not null check (guests between 0 and 500),
  mode          text not null check (mode in ('here', 'away')),
  name          text not null,
  email         text not null,
  phone         text not null,
  status        text not null default 'confirmed' check (status in ('confirmed', 'checked_in', 'completed', 'cancelled')),
  cancel_reason text,
  source        text not null default 'web' check (source in ('web', 'staff')),
  created_by    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index bookings_day_time on bookings (date, ready_min);

create table staff (
  user_id     uuid primary key,              -- samma id som i Supabase Auth
  email       text not null unique,
  name        text not null,
  title       text not null default '',
  role        text not null check (role in ('owner', 'admin', 'staff')),
  active      boolean not null default true,
  bankid_verified_at timestamptz,            -- förberett för BankID
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table tasks (
  id           uuid primary key default gen_random_uuid(),
  date         date not null,
  title        text not null,
  category     text not null check (category in ('opening', 'general', 'closing')),
  area         text not null default 'other' check (area in ('kitchen', 'service', 'hygiene', 'other')),
  template_key text,
  done         boolean not null default false,
  archived     boolean not null default false,
  updated_by   text not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (date, template_key)
);
create index tasks_day on tasks (date);

create table audit (
  id         uuid primary key default gen_random_uuid(),
  date       date not null,
  actor      text not null,
  action     text not null,
  target     text not null,
  detail     jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index audit_day on audit (date, created_at desc);

create table booking_emails (
  booking_id       uuid primary key references bookings(id),
  status           text not null default 'pending',
  attempts         int not null default 0,
  payload          text,
  first_attempt_at bigint,
  lease_token      uuid,
  lease_until      bigint not null default 0,
  next_attempt_at  bigint not null default 0,
  provider_id      text,
  last_error       text,
  sent_at          timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create table waste_entries (
  id         uuid primary key default gen_random_uuid(),
  date       date not null,
  item       text not null,
  qty        int not null check (qty between 1 and 100),
  reason     text not null check (reason in ('burnt', 'dough', 'dropped', 'wrong_order', 'complaint', 'other')),
  note       text not null default '',
  actor      text not null,
  created_at timestamptz not null default now(),
  voided_at  timestamptz,
  voided_by  text
);
create index waste_day on waste_entries (date);

create table menu_items (
  id          uuid primary key default gen_random_uuid(),
  category    text not null check (category in ('pizza', 'dolce')),
  name        text not null,
  description text not null default '',
  price       int not null check (price between 0 and 10000),
  active      boolean not null default true,
  sort_order  int not null default 0,
  updated_at  timestamptz not null default now()
);
insert into menu_items (category, name, description, price, sort_order) values
  ('pizza', 'Marinara', 'San Marzano tomatsås, finskivad vitlök, torkad oregano, basilikablad och olivolja.', 145, 10),
  ('pizza', 'Margherita', 'San Marzano tomatsås, mozzarella, basilikablad, pecorino och olivolja.', 155, 20),
  ('pizza', 'Diavola', 'San Marzano tomatsås, salami, mozzarella, lagrad ost, oregano och basilikablad.', 165, 30),
  ('pizza', 'Prosciutto e Pomodorino', 'San Marzano tomatsås, körsbärstomater, mozzarella, lufttorkad skinka, rucola, parmesan och olivolja.', 175, 40),
  ('pizza', 'Bosco', 'Mozzarella, skogschampinjoner, körsbärstomat, rucola, parmesan och olivolja.', 165, 50),
  ('dolce', 'Tiramisu', 'Fråga oss om dagens tillgång. Begränsat antal.', 60, 60),
  ('dolce', 'Espresso', 'En liten kopp efter maten, eller bara för att.', 35, 70);

-- RLS på, inga policyer: ingen direktåtkomst via publika nycklar.
alter table settings       enable row level security;
alter table closed_dates   enable row level security;
alter table days           enable row level security;
alter table bookings       enable row level security;
alter table staff          enable row level security;
alter table tasks          enable row level security;
alter table audit          enable row level security;
alter table booking_emails enable row level security;
alter table waste_entries  enable row level security;
alter table menu_items     enable row level security;

-- ---------------------------------------------------------------------
-- Hjälpfunktioner
-- ---------------------------------------------------------------------
create or replace function _fail(p_status int, p_message text) returns void
language plpgsql as $$
begin
  raise exception using errcode = 'PT' || p_status::text, message = p_message;
end $$;

-- Stockholmstid. p ->> 'now' används bara av tester; servern skickar aldrig med den.
create or replace function _now(p jsonb) returns timestamptz
language sql stable as $$ select coalesce((p ->> 'now')::timestamptz, now()) $$;

create or replace function _local_date(p_now timestamptz) returns date
language sql stable as $$ select (p_now at time zone 'Europe/Stockholm')::date $$;

create or replace function _local_minute(p_now timestamptz) returns int
language sql stable as $$
  select (extract(hour from p_now at time zone 'Europe/Stockholm') * 60
        + extract(minute from p_now at time zone 'Europe/Stockholm'))::int
$$;

create or replace function _time_text(p_min int) returns text
language sql immutable as $$ select lpad((p_min / 60)::text, 2, '0') || ':' || lpad((p_min % 60)::text, 2, '0') $$;

create or replace function _date(p_value text) returns date
language plpgsql as $$
declare v date;
begin
  if p_value is null or p_value !~ '^\d{4}-\d{2}-\d{2}$' then perform _fail(400, 'Välj ett giltigt datum.'); end if;
  begin v := p_value::date; exception when others then perform _fail(400, 'Välj ett giltigt datum.'); end;
  if to_char(v, 'YYYY-MM-DD') <> p_value then perform _fail(400, 'Välj ett giltigt datum.'); end if;
  return v;
end $$;

create or replace function _int(p_value jsonb, p_min int, p_max int, p_message text default 'Skriv ett giltigt antal.') returns int
language plpgsql as $$
declare v numeric;
begin
  if p_value is null or jsonb_typeof(p_value) <> 'number' then perform _fail(400, p_message); end if;
  v := p_value::text::numeric;
  if v <> trunc(v) or v < p_min or v > p_max then perform _fail(400, p_message); end if;
  return v::int;
end $$;

create or replace function _text(p_value jsonb, p_min int, p_max int, p_message text) returns text
language plpgsql as $$
declare v text;
begin
  if p_value is null or jsonb_typeof(p_value) <> 'string' then perform _fail(400, p_message); end if;
  v := btrim(p_value #>> '{}');
  if length(v) < p_min or length(v) > p_max or v ~ '[\x01-\x08\x0b-\x1f]' then perform _fail(400, p_message); end if;
  return v;
end $$;

create or replace function _uuid(p_value jsonb, p_message text) returns uuid
language plpgsql as $$
declare v text := p_value #>> '{}';
begin
  if v is null or v !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then perform _fail(400, p_message); end if;
  return v::uuid;
end $$;

create or replace function _bool(p_value jsonb, p_message text) returns boolean
language plpgsql as $$
begin
  if p_value is null or jsonb_typeof(p_value) <> 'boolean' then perform _fail(400, p_message); end if;
  return p_value::text::boolean;
end $$;

create or replace function _audit(p_date date, p_actor text, p_action text, p_target text, p_detail jsonb) returns void
language sql as $$
  insert into audit (date, actor, action, target, detail) values (p_date, p_actor, p_action, p_target, coalesce(p_detail, '{}'));
$$;

-- Lås en dag så att samtidiga bokningar och ändringar inte krockar.
create or replace function _lock_day(p_date date) returns void
language sql as $$ select pg_advisory_xact_lock(hashtext('albert-day:' || p_date::text)) $$;

create or replace function _ensure_day(p_date date) returns days
language plpgsql as $$
declare v days;
begin
  insert into days (date) values (p_date) on conflict do nothing;
  select * into v from days where date = p_date;
  return v;
end $$;

-- Kontrollera att anroparen är aktiv personal med minst given roll.
create or replace function _actor(p jsonb, p_min_role text) returns staff
language plpgsql as $$
declare
  v staff;
  v_rank int;
  v_need int := case p_min_role when 'owner' then 3 when 'admin' then 2 else 1 end;
begin
  select * into v from staff where user_id = (p ->> 'actor')::uuid and active;
  if not found then perform _fail(403, 'Ditt konto har inte behörighet till admin.'); end if;
  v_rank := case v.role when 'owner' then 3 when 'admin' then 2 else 1 end;
  if v_rank < v_need then perform _fail(403, 'Din roll har inte behörighet till den här funktionen.'); end if;
  return v;
end $$;

-- ---------------------------------------------------------------------
-- Tillgänglighet (samma regler som ChatGPT:s version, men inställbara)
-- ---------------------------------------------------------------------
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
  t int; v_start int; v_rem int; v_arr int; v_end int; v_close int; v_used int; v_seats int;
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

  for t in select g from generate_series(s.lunch_first, s.lunch_last, 15) g
           union all select g from generate_series(s.dinner_first, s.dinner_last, 15) g order by 1
  loop
    select s.slot_cap - coalesce(sum(count), 0) into v_rem from bookings
      where date = p_date and status <> 'cancelled' and ready_min = t;
    foreach v_start in array array[t - 45, t - 30, t - 15, t] loop
      v_rem := least(v_rem, s.hour_cap - (select coalesce(sum(count), 0) from bookings
                 where date = p_date and status <> 'cancelled' and ready_min between v_start and v_start + 45));
    end loop;
    if v_daily is not null then v_rem := least(v_rem, v_daily); end if;

    v_arr := t - s.arrival_min;
    v_end := v_arr + s.sitting_min;
    -- Högsta antal sittande gäster samtidigt under den nya sittningen.
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
    v_sitting_ok := p_mode = 'away' or d.allow_after_closing or v_end <= v_close;

    v_slots := v_slots || jsonb_build_object(
      'time', _time_text(t), 'minute', t, 'remaining', greatest(0, v_rem),
      'seats', case when p_mode = 'here' then v_seats else null end,
      'bookable', not d.paused and v_future and v_sitting_ok and v_rem >= p_count and (p_mode = 'away' or v_seats >= p_guests));
  end loop;

  return jsonb_build_object('date', p_date, 'closed', false, 'paused', d.paused, 'dailyRemaining', v_daily, 'slots', v_slots);
end $$;

create or replace function _mode(p jsonb) returns text
language plpgsql as $$
begin
  if p ->> 'mode' in ('here', 'away') then return p ->> 'mode'; end if;
  perform _fail(400, 'Välj äta här eller ta med.');
end $$;

create or replace function api_availability(p jsonb) returns jsonb
language plpgsql as $$
declare
  s settings;
  v_mode text := _mode(p);
begin
  select * into s from settings where id = 1;
  return _availability(_date(p ->> 'date'), _int(p -> 'count', 1, s.max_count), v_mode,
    case when v_mode = 'here' then _int(p -> 'guests', 1, s.max_guests) else 0 end, _now(p));
end $$;

-- ---------------------------------------------------------------------
-- Publik bokning
-- ---------------------------------------------------------------------
create or replace function _confirmation(b bookings, s settings) returns jsonb
language sql stable as $$
  select jsonb_build_object('id', b.id, 'date', b.date, 'time', _time_text(b.ready_min),
    'arrival', _time_text(b.ready_min - s.arrival_min),
    'sittingEnd', case when b.mode = 'here' then _time_text(b.ready_min - s.arrival_min + s.sitting_min) end,
    'count', b.count, 'mode', b.mode, 'guests', b.guests)
$$;

create or replace function api_create_booking(p jsonb) returns jsonb
language plpgsql as $$
declare
  s settings;
  v_key uuid := _uuid(p -> 'key', 'Bokningen behöver en giltig referens. Ladda om sidan.');
  v_date date := _date(p ->> 'date');
  v_mode text := _mode(p);
  v_count int; v_guests int;
  v_name text; v_email text; v_phone text;
  v_old bookings; v_new bookings;
  v_av jsonb; v_slot jsonb;
  v_staff boolean := (p ->> 'actor') is not null;
  v_actor staff;
begin
  select * into s from settings where id = 1;
  if v_staff then v_actor := _actor(p, 'staff'); end if;
  v_count := _int(p -> 'count', 1, s.max_count);
  v_guests := case when v_mode = 'here' then _int(p -> 'guests', 1, s.max_guests) else 0 end;
  v_name := _text(p #> '{contact,name}', 2, 100, 'Skriv ditt namn.');
  v_phone := _text(p #> '{contact,phone}', 8, 30, 'Skriv ett giltigt telefonnummer.');
  if v_staff and coalesce(btrim(p #>> '{contact,email}'), '') = '' then
    v_email := '';
  else
    v_email := lower(_text(p #> '{contact,email}', 5, 180, 'Skriv en giltig e-postadress.'));
    if v_email !~* '^[^\s@<>,;:"\\]+@[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$' or position('..' in v_email) > 0 then
      perform _fail(400, 'Skriv en giltig e-postadress.');
    end if;
  end if;
  if v_phone !~ '^(\+|00)?[0-9\s().-]{8,24}$' then perform _fail(400, 'Skriv ett giltigt telefonnummer.'); end if;

  perform _lock_day(v_date);

  select * into v_old from bookings where request_key = v_key;
  -- Skydd mot massbokningar: högst 3 aktiva webbokningar per telefon eller e-post och dag.
  if v_old.id is null and not v_staff and (select count(*) from bookings where date = v_date and source = 'web' and status <> 'cancelled'
      and (email = v_email or regexp_replace(phone, '\D', '', 'g') = regexp_replace(v_phone, '\D', '', 'g'))) >= 3 then
    perform _fail(409, 'Du har redan flera bokningar den här dagen. Ring oss på 0340–827 75 om du behöver fler.');
  end if;
  if v_old.id is not null then
    if v_old.date <> v_date or v_old.count <> v_count or v_old.mode <> v_mode or v_old.guests <> v_guests
       or v_old.email <> v_email or v_old.phone <> v_phone or _time_text(v_old.ready_min) <> (p ->> 'time') then
      perform _fail(409, 'Referensen hör redan till en annan bokning.');
    end if;
    return _confirmation(v_old, s);
  end if;

  -- Personal får lägga in bokningar bakåt i tiden samma dag (t.ex. telefon), men taket gäller ändå.
  v_av := _availability(v_date, v_count, v_mode, v_guests, _now(p), not v_staff);
  select x into v_slot from jsonb_array_elements(v_av -> 'slots') x
    where x ->> 'time' = p ->> 'time' and (x ->> 'bookable')::boolean;
  if v_slot is null then perform _fail(409, 'Tiden är inte längre ledig. Välj en annan tid.'); end if;

  perform _ensure_day(v_date);
  insert into bookings (request_key, date, ready_min, count, guests, mode, name, email, phone, source, created_by)
    values (v_key, v_date, (v_slot ->> 'minute')::int, v_count, v_guests, v_mode, v_name, v_email, v_phone,
            case when v_staff then 'staff' else 'web' end, case when v_staff then v_actor.name end)
    returning * into v_new;
  perform _audit(v_date, coalesce(v_actor.name, 'guest'), 'booking_created', v_new.id::text,
    jsonb_build_object('count', v_count, 'mode', v_mode, 'time', p ->> 'time'));
  if v_email <> '' then
    insert into booking_emails (booking_id) values (v_new.id);
  end if;
  return _confirmation(v_new, s);
end $$;

-- ---------------------------------------------------------------------
-- Inloggning: koppla Supabase-användare till personal
-- ---------------------------------------------------------------------
create or replace function api_authorize(p jsonb) returns jsonb
language plpgsql as $$
declare
  v staff;
  v_user uuid := _uuid(p -> 'userId', 'Logga in för att öppna admin.');
  v_email text := lower(coalesce(p ->> 'email', ''));
  v_owner text := lower(coalesce(p ->> 'ownerEmail', ''));
begin
  select * into v from staff where user_id = v_user;
  if found then
    if not v.active then perform _fail(403, 'Ditt konto är inaktiverat. Kontakta Albert.'); end if;
    return to_jsonb(v);
  end if;
  -- Första inloggningen med ägarens e-post skapar ägarkontot.
  if v_owner <> '' and v_email = v_owner and coalesce((p ->> 'emailConfirmed')::boolean, false)
     and not exists (select 1 from staff where role = 'owner') then
    insert into staff (user_id, email, name, title, role) values (v_user, v_email, coalesce(nullif(p ->> 'name', ''), 'Albert'), 'Ägare', 'owner')
      returning * into v;
    perform _audit(_local_date(now()), v.name, 'staff_owner_bootstrap', v.user_id::text, jsonb_build_object('email', v_email));
    return to_jsonb(v);
  end if;
  perform _fail(403, 'Ditt konto har inte behörighet till admin.');
end $$;

-- ---------------------------------------------------------------------
-- Dagsvy
-- ---------------------------------------------------------------------
create or replace function _admin_day(p_date date, a staff) returns jsonb
language plpgsql stable as $$
declare
  s settings;
  d days;
  v_booked int;
  v_order text[] := array['open-dough','open-tomato','open-topping','open-stations','open-tables','open-bookings','open-surfaces','open-toilet',
    'day-topping','day-tables','day-toilet','day-surfaces','close-stock','close-stations','close-tables','close-counts','close-waste','close-toilet'];
begin
  select * into s from settings where id = 1;
  select * into d from days where date = p_date;
  if not found then d := row(p_date, null, 0, 0, false, false, 0)::days; end if;
  select coalesce(sum(count), 0) into v_booked from bookings where date = p_date and status <> 'cancelled';
  return jsonb_build_object(
    'day', to_jsonb(d),
    'closed', not (extract(dow from p_date)::int = any (s.open_weekdays)) or exists (select 1 from closed_dates where date = p_date),
    'closedReason', (select reason from closed_dates where date = p_date),
    'bookings', coalesce((select jsonb_agg(to_jsonb(b) || jsonb_build_object('confirmationEmail',
        (select jsonb_build_object('status', e.status, 'sent_at', e.sent_at) from booking_emails e where e.booking_id = b.id))
        order by b.ready_min, b.created_at) from bookings b where b.date = p_date), '[]'),
    'tasks', coalesce((select jsonb_agg(to_jsonb(t) order by coalesce(array_position(v_order, t.template_key), 100), t.created_at, t.id)
        from tasks t where t.date = p_date and not t.archived), '[]'),
    'checklistStarted', exists (select 1 from tasks where date = p_date and template_key is not null),
    'history', coalesce((select jsonb_agg(to_jsonb(h) order by h.created_at desc) from
        (select * from audit where date = p_date order by created_at desc limit 100) h), '[]'),
    'waste', coalesce((select jsonb_agg(to_jsonb(w) order by w.created_at desc) from waste_entries w where w.date = p_date), '[]'),
    'menu', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name) order by m.sort_order, m.name)
        from menu_items m where m.active and m.category = 'pizza'), '[]'),
    'limits', jsonb_build_object('slot', s.slot_cap, 'hour', s.hour_cap, 'seats', s.seats, 'sitting', s.sitting_min,
        'arrival', s.arrival_min, 'maxCount', s.max_count, 'maxGuests', s.max_guests),
    'actor', jsonb_build_object('name', a.name, 'email', a.email, 'role', a.role),
    'stats', jsonb_build_object(
      'booked', v_booked,
      'guestsPresent', (select coalesce(sum(guests), 0) from bookings where date = p_date and status = 'checked_in' and mode = 'here'),
      'cancelled', (select count(*) from bookings where date = p_date and status = 'cancelled'),
      'remaining', case when d.prepared is null then null else greatest(0, d.prepared - v_booked - d.dropin - d.waste) end));
end $$;

create or replace function api_admin_day(p jsonb) returns jsonb
language plpgsql as $$
declare a staff := _actor(p, 'staff');
begin
  return _admin_day(_date(p ->> 'date'), a);
end $$;

create or replace function api_admin_counter(p jsonb) returns jsonb
language plpgsql as $$
declare
  a staff := _actor(p, 'staff');
  v_date date := _date(p ->> 'date');
  v_field text := case when p ->> 'field' in ('dropin', 'waste') then p ->> 'field' end;
  v_value int; v_version int; v_delta int; v_rows int;
begin
  if v_field is null then perform _fail(400, 'Välj en giltig räknare.'); end if;
  perform _lock_day(v_date);
  perform _ensure_day(v_date);
  if p ->> 'mode' = 'set' then
    v_value := _int(p -> 'value', 0, 10000);
    v_version := _int(p -> 'version', 0, 2147483647);
    execute format('update days set %I = $1, version = version + 1 where date = $2 and version = $3', v_field)
      using v_value, v_date, v_version;
  else
    v_delta := _int(p -> 'delta', -1, 1);
    if v_delta = 0 then perform _fail(400, 'Välj en ändring.'); end if;
    execute format('update days set %I = %I + $1, version = version + 1 where date = $2 and %I + $1 >= 0', v_field, v_field, v_field)
      using v_delta, v_date;
  end if;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then perform _fail(409, 'Antalet ändrades eller är redan noll. Uppdatera och försök igen.'); end if;
  perform _audit(v_date, a.name, v_field || '_changed', v_date::text,
    jsonb_build_object('mode', coalesce(p ->> 'mode', 'delta'), 'value', p -> 'value', 'delta', p -> 'delta'));
  return _admin_day(v_date, a);
end $$;

create or replace function api_admin_save_day(p jsonb) returns jsonb
language plpgsql as $$
declare
  a staff := _actor(p, 'staff');
  v_date date := _date(p ->> 'date');
  v_version int := _int(p -> 'version', 0, 2147483647);
  v_prepared int := case when p -> 'prepared' is null or jsonb_typeof(p -> 'prepared') = 'null' then null else _int(p -> 'prepared', 0, 10000) end;
  v_paused boolean := _bool(p -> 'paused', 'Välj giltiga dagsinställningar.');
  v_after boolean := _bool(p -> 'allowAfterClosing', 'Välj giltiga dagsinställningar.');
  d days;
  v_rows int;
begin
  perform _lock_day(v_date);
  d := _ensure_day(v_date);
  -- Personal får ändra dagens pizzantal; paus och sena sittningar kräver admin.
  if (v_paused <> d.paused or v_after <> d.allow_after_closing) and a.role = 'staff' then
    perform _fail(403, 'Bara administratörer kan pausa bokningen eller tillåta sena sittningar.');
  end if;
  update days set prepared = v_prepared, paused = v_paused, allow_after_closing = v_after, version = version + 1
    where date = v_date and version = v_version;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then perform _fail(409, 'Dagen har ändrats. Uppdatera innan du sparar igen.'); end if;
  perform _audit(v_date, a.name, 'day_settings', v_date::text,
    jsonb_build_object('prepared', v_prepared, 'paused', v_paused, 'allowAfterClosing', v_after));
  return _admin_day(v_date, a);
end $$;

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
    when 'cancel' then v_from := array['confirmed', 'checked_in']; v_to := 'cancelled';
    when 'undo_checkin' then v_from := array['checked_in']; v_to := 'confirmed';
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

create or replace function api_admin_task(p jsonb) returns jsonb
language plpgsql as $$
declare
  a staff := _actor(p, 'staff');
  v_date date := _date(p ->> 'date');
  v_action text := p ->> 'action';
  v_id uuid; v_title text; v_cat text; v_area text; v_rows int;
begin
  if v_action = 'start_checklist' then
    insert into tasks (date, title, category, area, template_key, updated_by)
    select v_date, x.title, x.category, x.area, x.key, a.name from (values
      ('open-dough','opening','kitchen','Kontrollera dagens degbollar och pizzantal'),
      ('open-tomato','opening','kitchen','Förbered tomatsås'),
      ('open-topping','opening','kitchen','Förbered mozzarella och övrig topping'),
      ('open-stations','opening','kitchen','Gör pizzastationerna redo'),
      ('open-tables','opening','service','Duka bord och gör serveringen redo'),
      ('open-bookings','opening','service','Gå igenom dagens bokningar'),
      ('open-surfaces','opening','hygiene','Kontrollera rena arbetsytor och handfat'),
      ('open-toilet','opening','hygiene','Kontrollera toalett, papper och tvål'),
      ('day-topping','general','kitchen','Fyll på råvaror vid pizzastationerna'),
      ('day-tables','general','service','Torka bord och håll serveringen i ordning'),
      ('day-toilet','general','hygiene','Se över toaletten och fyll på vid behov'),
      ('day-surfaces','general','hygiene','Håll handfat och arbetsytor rena'),
      ('close-stock','closing','kitchen','Ställ in och märk råvaror i kylen'),
      ('close-stations','closing','kitchen','Rengör pizzastationer och redskap'),
      ('close-tables','closing','service','Städa lokalen och ställ i ordning borden'),
      ('close-counts','closing','service','Stäm av bokningar, drop-in och svinn'),
      ('close-waste','closing','hygiene','Töm sopor och byt påsar'),
      ('close-toilet','closing','hygiene','Städa toalett och handfat')) as x(key, category, area, title)
    on conflict (date, template_key) do nothing;
    get diagnostics v_rows = row_count;
    if v_rows > 0 then perform _audit(v_date, a.name, 'task_create', v_date::text, jsonb_build_object('preset', true, 'count', v_rows)); end if;
    return _admin_day(v_date, a);
  end if;

  if v_action in ('create', 'update') then
    v_title := _text(p -> 'title', 2, 180, 'Skriv en uppgift.');
    v_cat := coalesce(p ->> 'category', 'general');
    v_area := coalesce(p ->> 'area', 'other');
    if v_cat not in ('opening', 'general', 'closing') or v_area not in ('kitchen', 'service', 'hygiene', 'other') then
      perform _fail(400, 'Välj en giltig del av dagen och ett område.');
    end if;
    if v_action = 'create' then
      insert into tasks (date, title, category, area, updated_by) values (v_date, v_title, v_cat, v_area, a.name) returning id into v_id;
      v_rows := 1;
    else
      v_id := _uuid(p -> 'id', 'Välj en giltig uppgift.');
      update tasks set title = v_title, category = v_cat, area = v_area, updated_by = a.name, updated_at = now()
        where id = v_id and date = v_date and not archived;
      get diagnostics v_rows = row_count;
    end if;
  else
    v_id := _uuid(p -> 'id', 'Välj en giltig uppgift.');
    if v_action = 'done' then
      update tasks set done = _bool(p -> 'done', 'Välj en giltig åtgärd.'), updated_by = a.name, updated_at = now()
        where id = v_id and date = v_date and not archived;
    elsif v_action = 'archive' then
      update tasks set archived = true, updated_by = a.name, updated_at = now() where id = v_id and date = v_date and not archived;
    else
      perform _fail(400, 'Välj en giltig åtgärd.');
    end if;
    get diagnostics v_rows = row_count;
  end if;
  if v_rows = 0 then perform _fail(409, 'Uppgiften har ändrats. Uppdatera listan.'); end if;
  perform _audit(v_date, a.name, 'task_' || v_action, v_id::text,
    jsonb_build_object('title', p -> 'title', 'done', p -> 'done', 'category', p -> 'category', 'area', p -> 'area'));
  return _admin_day(v_date, a);
end $$;

-- ---------------------------------------------------------------------
-- Svinn med orsak (håller dagens svinnräknare i takt)
-- ---------------------------------------------------------------------
create or replace function api_admin_waste(p jsonb) returns jsonb
language plpgsql as $$
declare
  a staff := _actor(p, 'staff');
  v_date date := _date(p ->> 'date');
  w waste_entries;
  v_qty int; v_item text; v_reason text; v_note text;
begin
  perform _lock_day(v_date);
  perform _ensure_day(v_date);
  if p ->> 'action' = 'void' then
    select * into w from waste_entries where id = _uuid(p -> 'id', 'Välj en giltig registrering.') and date = v_date;
    if not found then perform _fail(404, 'Registreringen finns inte.'); end if;
    if w.voided_at is not null then perform _fail(409, 'Registreringen är redan makulerad.'); end if;
    update waste_entries set voided_at = now(), voided_by = a.name where id = w.id;
    update days set waste = greatest(0, waste - w.qty), version = version + 1 where date = v_date;
    perform _audit(v_date, a.name, 'waste_voided', w.id::text, jsonb_build_object('item', w.item, 'count', w.qty));
  else
    v_item := _text(p -> 'item', 1, 100, 'Välj vad som förstördes.');
    v_qty := _int(p -> 'qty', 1, 100, 'Skriv ett antal mellan 1 och 100.');
    v_reason := p ->> 'reason';
    if v_reason is null or v_reason not in ('burnt', 'dough', 'dropped', 'wrong_order', 'complaint', 'other') then
      perform _fail(400, 'Välj en orsak.');
    end if;
    v_note := case when p -> 'note' is null or btrim(p ->> 'note') = '' then '' else _text(p -> 'note', 1, 250, 'Anteckningen är för lång.') end;
    insert into waste_entries (date, item, qty, reason, note, actor) values (v_date, v_item, v_qty, v_reason, v_note, a.name) returning * into w;
    update days set waste = waste + v_qty, version = version + 1 where date = v_date;
    perform _audit(v_date, a.name, 'waste_registered', w.id::text, jsonb_build_object('item', v_item, 'count', v_qty, 'reason', v_reason));
  end if;
  return _admin_day(v_date, a);
end $$;

-- ---------------------------------------------------------------------
-- Statistik (admin)
-- ---------------------------------------------------------------------
create or replace function api_admin_stats(p jsonb) returns jsonb
language plpgsql as $$
declare
  a staff := _actor(p, 'admin');
  v_from date := _date(p ->> 'from');
  v_to date := _date(p ->> 'to');
  s settings;
begin
  if v_to < v_from or v_to - v_from > 366 then perform _fail(400, 'Välj en period på högst ett år.'); end if;
  select * into s from settings where id = 1;
  return jsonb_build_object(
    'from', v_from, 'to', v_to, 'avgPizzaPrice', s.avg_pizza_price, 'wasteCost', s.waste_cost,
    'days', (select jsonb_agg(jsonb_build_object(
        'date', g::date,
        'bookedPizzas', (select coalesce(sum(count), 0) from bookings where date = g::date and status <> 'cancelled'),
        'bookings', (select count(*) from bookings where date = g::date and status <> 'cancelled'),
        'guests', (select coalesce(sum(guests), 0) from bookings where date = g::date and status <> 'cancelled' and mode = 'here'),
        'takeaway', (select coalesce(sum(count), 0) from bookings where date = g::date and status <> 'cancelled' and mode = 'away'),
        'cancelled', (select count(*) from bookings where date = g::date and status = 'cancelled'),
        'dropin', coalesce((select dropin from days where date = g::date), 0),
        'waste', coalesce((select waste from days where date = g::date), 0),
        'prepared', (select prepared from days where date = g::date)) order by g)
      from generate_series(v_from, v_to, interval '1 day') g),
    'wasteByReason', coalesce((select jsonb_object_agg(reason, qty) from
        (select reason, sum(qty) qty from waste_entries where date between v_from and v_to and voided_at is null group by reason) r), '{}'),
    'wasteByItem', coalesce((select jsonb_object_agg(item, qty) from
        (select item, sum(qty) qty from waste_entries where date between v_from and v_to and voided_at is null group by item) r), '{}'));
end $$;

-- ---------------------------------------------------------------------
-- Meny
-- ---------------------------------------------------------------------
create or replace function api_menu(p jsonb) returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'category', category, 'name', name, 'description', description, 'price', price)
    order by sort_order, name), '[]') from menu_items where active
$$;

create or replace function api_admin_menu(p jsonb) returns jsonb
language plpgsql as $$
declare
  a staff;
  m menu_items;
  v_item jsonb := p -> 'item';
  v_id uuid;
begin
  if p ->> 'action' = 'save' then
    a := _actor(p, 'admin');
    if v_item -> 'id' is not null and jsonb_typeof(v_item -> 'id') <> 'null' then
      v_id := _uuid(v_item -> 'id', 'Välj en giltig rätt.');
      update menu_items set
        category = case when v_item ->> 'category' in ('pizza', 'dolce') then v_item ->> 'category' else category end,
        name = _text(v_item -> 'name', 2, 80, 'Skriv ett namn.'),
        description = _text(coalesce(v_item -> 'description', '""'), 0, 300, 'Beskrivningen är för lång.'),
        price = _int(v_item -> 'price', 0, 10000, 'Skriv ett giltigt pris.'),
        active = _bool(v_item -> 'active', 'Välj om rätten ska visas.'),
        sort_order = case when v_item -> 'sortOrder' is null then sort_order else _int(v_item -> 'sortOrder', 0, 10000, 'Ogiltig ordning.') end,
        updated_at = now()
      where id = v_id returning * into m;
      if not found then perform _fail(404, 'Rätten finns inte.'); end if;
    else
      insert into menu_items (category, name, description, price, active, sort_order) values (
        case when v_item ->> 'category' = 'dolce' then 'dolce' else 'pizza' end,
        _text(v_item -> 'name', 2, 80, 'Skriv ett namn.'),
        _text(coalesce(v_item -> 'description', '""'), 0, 300, 'Beskrivningen är för lång.'),
        _int(v_item -> 'price', 0, 10000, 'Skriv ett giltigt pris.'),
        case when v_item -> 'active' is null then false else _bool(v_item -> 'active', 'Välj om rätten ska visas.') end,
        coalesce((select max(sort_order) + 10 from menu_items), 10)) returning * into m;
    end if;
    perform _audit(_local_date(now()), a.name, 'menu_saved', m.id::text, jsonb_build_object('name', m.name, 'price', m.price, 'active', m.active));
  else
    a := _actor(p, 'staff');
  end if;
  return coalesce((select jsonb_agg(to_jsonb(x) order by x.sort_order, x.name) from menu_items x), '[]');
end $$;

-- ---------------------------------------------------------------------
-- Inställningar och stängda datum (admin)
-- ---------------------------------------------------------------------
create or replace function _settings_json() returns jsonb
language sql stable as $$
  select to_jsonb(s) || jsonb_build_object('closedDates',
    coalesce((select jsonb_agg(to_jsonb(c) order by c.date) from closed_dates c where c.date >= _local_date(now()) - 1), '[]'))
  from settings s where id = 1
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

-- ---------------------------------------------------------------------
-- Personal (admin). Själva inloggningskontot skapas i Supabase Auth av servern.
-- ---------------------------------------------------------------------
create or replace function api_admin_staff(p jsonb) returns jsonb
language plpgsql as $$
declare
  a staff;
  t staff;
  v_role text;
  v_user uuid;
begin
  if p ->> 'action' is null or p ->> 'action' = 'list' then
    a := _actor(p, 'admin');
  elsif p ->> 'action' = 'create' then
    a := _actor(p, 'admin');
    v_role := p ->> 'role';
    if v_role is null or v_role not in ('admin', 'staff') then perform _fail(400, 'Välj en giltig roll.'); end if;
    if v_role = 'admin' and a.role <> 'owner' then perform _fail(403, 'Bara ägaren kan lägga till administratörer.'); end if;
    v_user := _uuid(p -> 'userId', 'Kontot kunde inte skapas.');
    insert into staff (user_id, email, name, title, role) values (v_user,
      lower(_text(p -> 'email', 5, 180, 'Skriv en giltig e-postadress.')),
      _text(p -> 'name', 2, 100, 'Skriv ett namn.'),
      _text(coalesce(p -> 'title', '""'), 0, 60, 'Titeln är för lång.'), v_role)
    on conflict do nothing;
    perform _audit(_local_date(now()), a.name, 'staff_created', v_user::text, jsonb_build_object('name', p ->> 'name', 'role', v_role));
  elsif p ->> 'action' in ('set_role', 'set_active', 'password_reset') then
    a := _actor(p, 'admin');
    select * into t from staff where user_id = _uuid(p -> 'userId', 'Välj en giltig person.');
    if not found then perform _fail(404, 'Personen finns inte.'); end if;
    if t.user_id = a.user_id then perform _fail(403, 'Du kan inte ändra ditt eget konto här.'); end if;
    if t.role = 'owner' then perform _fail(403, 'Ägarens konto kan inte ändras här.'); end if;
    if t.role = 'admin' and a.role <> 'owner' then perform _fail(403, 'Bara ägaren kan ändra administratörer.'); end if;
    if p ->> 'action' = 'set_role' then
      v_role := p ->> 'role';
      if v_role is null or v_role not in ('admin', 'staff') then perform _fail(400, 'Välj en giltig roll.'); end if;
      if v_role = 'admin' and a.role <> 'owner' then perform _fail(403, 'Bara ägaren kan göra någon till administratör.'); end if;
      update staff set role = v_role, updated_at = now() where user_id = t.user_id;
      perform _audit(_local_date(now()), a.name, 'staff_role', t.user_id::text, jsonb_build_object('name', t.name, 'role', v_role));
    elsif p ->> 'action' = 'set_active' then
      update staff set active = _bool(p -> 'active', 'Välj aktiv eller inaktiv.'), updated_at = now() where user_id = t.user_id;
      perform _audit(_local_date(now()), a.name, 'staff_active', t.user_id::text, jsonb_build_object('name', t.name, 'active', p -> 'active'));
    else
      -- Servern byter lösenordet i Supabase Auth först efter att den här kontrollen gått igenom.
      perform _audit(_local_date(now()), a.name, 'staff_password_reset', t.user_id::text, jsonb_build_object('name', t.name));
    end if;
  else
    perform _fail(400, 'Välj en giltig åtgärd.');
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('userId', user_id, 'email', email, 'name', name, 'title', title,
      'role', role, 'active', active, 'createdAt', created_at) order by case role when 'owner' then 0 when 'admin' then 1 else 2 end, name)
    from staff), '[]');
end $$;

-- ---------------------------------------------------------------------
-- Bekräftelsemejl (utkorg). Själva utskicket görs av servern via Resend.
-- ---------------------------------------------------------------------
create or replace function api_email_state(p jsonb) returns jsonb
language sql stable as $$
  select jsonb_build_object('booking', (select to_jsonb(b) from bookings b where b.id = (p ->> 'id')::uuid),
    'outbox', (select to_jsonb(e) - 'payload' || jsonb_build_object('hasPayload', e.payload is not null)
               from booking_emails e where e.booking_id = (p ->> 'id')::uuid),
    'settings', (select jsonb_build_object('arrival', arrival_min, 'sitting', sitting_min) from settings where id = 1))
$$;

create or replace function api_email_mark(p jsonb) returns void
language plpgsql as $$
begin
  -- Sätter skipped/review/blocked utan att röra ett pågående eller skickat utskick.
  update booking_emails set status = p ->> 'status', last_error = p ->> 'error', updated_at = now()
  where booking_id = (p ->> 'id')::uuid and status not in ('sent', 'review')
    and lease_until <= (p ->> 'nowMs')::bigint and p ->> 'status' in ('skipped', 'review', 'blocked');
end $$;

create or replace function api_email_claim(p jsonb) returns jsonb
language plpgsql as $$
declare
  v_ms bigint := (p ->> 'nowMs')::bigint;
  v_payload text;
begin
  update booking_emails set status = 'sending', attempts = attempts + 1, payload = coalesce(payload, p ->> 'payload'),
    first_attempt_at = coalesce(first_attempt_at, v_ms), lease_token = (p ->> 'token')::uuid, lease_until = v_ms + 30000, updated_at = now()
  where booking_id = (p ->> 'id')::uuid and status not in ('sent', 'review', 'skipped') and lease_until <= v_ms
    and next_attempt_at <= v_ms and (first_attempt_at is null or first_attempt_at > v_ms - (p ->> 'retryWindow')::bigint)
    and exists (select 1 from bookings where id = (p ->> 'id')::uuid and status in ('confirmed', 'checked_in'))
  returning payload into v_payload;
  return case when v_payload is null then null else jsonb_build_object('payload', v_payload) end;
end $$;

create or replace function api_email_finish(p jsonb) returns void
language plpgsql as $$
declare v_rows int; v_date date;
begin
  update booking_emails set status = p ->> 'status', last_error = p ->> 'error', provider_id = coalesce(p ->> 'providerId', provider_id),
    sent_at = case when p ->> 'status' = 'sent' then now() else sent_at end, lease_token = null, lease_until = 0,
    next_attempt_at = coalesce((p ->> 'retryAt')::bigint, 0), updated_at = now()
  where booking_id = (p ->> 'id')::uuid and lease_token = (p ->> 'token')::uuid;
  get diagnostics v_rows = row_count;
  if v_rows > 0 then
    select date into v_date from bookings where id = (p ->> 'id')::uuid;
    perform _audit(v_date, 'system', 'booking_email', p ->> 'id', jsonb_build_object('status', p ->> 'status', 'error', p ->> 'error'));
  end if;
end $$;

create or replace function api_email_request(p jsonb) returns jsonb
language plpgsql as $$
declare a staff := _actor(p, 'staff'); b bookings;
begin
  select * into b from bookings where id = _uuid(p -> 'id', 'Välj en giltig bokning.');
  if not found then perform _fail(404, 'Bokningen finns inte.'); end if;
  if b.email = '' then perform _fail(409, 'Bokningen saknar e-postadress.'); end if;
  insert into booking_emails (booking_id) values (b.id) on conflict do nothing;
  perform _audit(b.date, a.name, 'booking_email_requested', b.id::text, '{}');
  return jsonb_build_object('date', b.date);
end $$;

-- ---------------------------------------------------------------------
-- Behörighet: bara servern (service_role) får anropa funktionerna.
-- ---------------------------------------------------------------------
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

-- Funktioner som skapas i senare migreringar ska inte heller vara öppna för publika roller.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'alter default privileges in schema public revoke execute on functions from public, anon, authenticated';
    execute 'revoke all on all tables in schema public from anon, authenticated';
  end if;
end $$;
