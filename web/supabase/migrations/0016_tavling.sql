-- =====================================================================
-- Albert NO.485 – tävlingslista på hemsidan (körs efter 0015_omfordela.sql)
--
-- En lista över deltagarna i Instagram-tävlingen: Instagram-namn, om allt
-- är avklarat, vad som annars är kvar att göra och om deltagaren har dubbel
-- chans. Visas på /tavling/ när den är påslagen och ändras i admin under
-- Tävling. Själva namnen läggs in i databasen, aldrig i koden. Inget
-- befintligt tas bort eller ändras.
-- =====================================================================

create table if not exists giveaway_entries (
  username text primary key check (username ~ '^[a-z0-9._]{1,30}$'),
  approved boolean not null default false,
  -- Vad som är kvar att göra: follow (följa), tag (tagga en vän), story (dela i story). Tom = inget känt.
  missing text[] not null default '{}' check (missing <@ array['follow', 'tag', 'story']),
  -- true = dubbel chans (kvitto på pizzaköp har kommit in).
  double_chance boolean not null default false,
  -- true = status ändrad för hand i admin. Den automatiska uppdateringen rör då aldrig statusen.
  manual boolean not null default false,
  -- true = dubbel chans ändrad för hand i admin. Den automatiska uppdateringen rör då aldrig den.
  double_manual boolean not null default false,
  -- true = borttagen från listan (visas inte och läggs inte tillbaka automatiskt).
  hidden boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by text not null default ''
);

create table if not exists giveaway_state (
  id int primary key default 1 check (id = 1),
  published boolean not null default false,
  updated_at timestamptz not null default now()
);
insert into giveaway_state (id) values (1) on conflict do nothing;

alter table giveaway_entries enable row level security;
alter table giveaway_state enable row level security;

create or replace function _giveaway_username(p_value jsonb) returns text
language plpgsql as $$
declare
  v text := regexp_replace(lower(btrim(coalesce(p_value #>> '{}', ''))), '^@', '');
begin
  if v !~ '^[a-z0-9._]{1,30}$' then perform _fail(400, 'Skriv ett giltigt Instagram-namn.'); end if;
  return v;
end $$;

-- Publik lista: namn, status, vad som är kvar att göra och dubbel chans. Bara när listan är påslagen.
create or replace function api_giveaway(p jsonb) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'published', s.published,
    'updatedAt', case when s.published then (select max(updated_at) from giveaway_entries where not hidden) end,
    'entries', case when s.published then coalesce((select jsonb_agg(jsonb_build_object('u', e.username, 'ok', e.approved, 'miss', to_jsonb(e.missing), 'x2', e.double_chance) order by e.username)
        from giveaway_entries e where not e.hidden), '[]') else '[]'::jsonb end)
  from giveaway_state s where s.id = 1
$$;

create or replace function _giveaway_admin_json() returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'published', (select published from giveaway_state where id = 1),
    'entries', coalesce((select jsonb_agg(jsonb_build_object('u', username, 'ok', approved, 'miss', to_jsonb(missing), 'x2', double_chance, 'manual', manual, 'x2manual', double_manual, 'hidden', hidden,
        'updatedAt', updated_at, 'updatedBy', updated_by) order by username) from giveaway_entries), '[]'))
$$;

create or replace function api_admin_giveaway(p jsonb) returns jsonb
language plpgsql as $$
declare
  a staff;
  v_action text := coalesce(p ->> 'action', 'list');
  v_user text;
  v_ok boolean;
begin
  if v_action = 'list' then
    a := _actor(p, 'staff');
    return _giveaway_admin_json();
  end if;
  a := _actor(p, 'admin');
  if v_action = 'publish' then
    update giveaway_state set published = _bool(p -> 'published', 'Välj om listan ska visas.'), updated_at = now() where id = 1;
    return _giveaway_admin_json();
  end if;
  v_user := _giveaway_username(p -> 'username');
  if v_action = 'add' then
    v_ok := _bool(p -> 'approved', 'Välj avklarat eller ej avklarat.');
    if exists (select 1 from giveaway_entries where username = v_user and not hidden) then perform _fail(409, 'Namnet finns redan i listan.'); end if;
    insert into giveaway_entries (username, approved, manual, updated_by) values (v_user, v_ok, true, a.name)
    on conflict (username) do update set approved = excluded.approved, missing = case when excluded.approved then '{}' else giveaway_entries.missing end,
      manual = true, hidden = false, updated_at = now(), updated_by = excluded.updated_by;
  elsif v_action = 'set' then
    v_ok := _bool(p -> 'approved', 'Välj avklarat eller ej avklarat.');
    update giveaway_entries set approved = v_ok, missing = case when v_ok then '{}' else missing end, manual = true, updated_at = now(), updated_by = a.name
    where username = v_user;
    if not found then perform _fail(404, 'Namnet finns inte i listan.'); end if;
  elsif v_action = 'double' then
    v_ok := _bool(p -> 'double', 'Välj dubbel chans eller inte.');
    update giveaway_entries set double_chance = v_ok, double_manual = true, updated_at = now(), updated_by = a.name where username = v_user;
    if not found then perform _fail(404, 'Namnet finns inte i listan.'); end if;
  elsif v_action in ('remove', 'restore') then
    update giveaway_entries set hidden = (v_action = 'remove'), updated_at = now(), updated_by = a.name where username = v_user;
    if not found then perform _fail(404, 'Namnet finns inte i listan.'); end if;
  else
    perform _fail(400, 'Okänd åtgärd.');
  end if;
  return _giveaway_admin_json();
end $$;

-- Automatisk uppdatering (anropas bara direkt mot databasen, inte från hemsidan).
-- Varje post: {"u": namn, "miss": ["follow" | "tag" | "story", ...], "x2": true/false}.
-- Tom miss = avklarat. Lägger till nya namn och uppdaterar det som ingen har ändrat för hand.
create or replace function api_giveaway_sync(p jsonb) returns jsonb
language plpgsql as $$
declare
  x jsonb;
  v_user text;
  v_miss text[];
  v_double boolean;
  v_added int := 0;
  v_changed int := 0;
  n int;
begin
  if p -> 'entries' is null or jsonb_typeof(p -> 'entries') <> 'array' or jsonb_array_length(p -> 'entries') > 5000 then
    perform _fail(400, 'Ogiltig lista.');
  end if;
  for x in select * from jsonb_array_elements(p -> 'entries') loop
    v_user := _giveaway_username(x -> 'u');
    if x -> 'miss' is null or jsonb_typeof(x -> 'miss') <> 'array' then perform _fail(400, 'Ogiltig status.'); end if;
    select coalesce(array_agg(distinct m order by m), '{}') into v_miss from jsonb_array_elements_text(x -> 'miss') m;
    if not v_miss <@ array['follow', 'tag', 'story'] then perform _fail(400, 'Ogiltig status.'); end if;
    v_double := case when x -> 'x2' is null then false else _bool(x -> 'x2', 'Ogiltig status.') end;
    insert into giveaway_entries (username, approved, missing, double_chance, updated_by)
    values (v_user, cardinality(v_miss) = 0, v_miss, v_double, 'Automatiskt') on conflict (username) do nothing;
    get diagnostics n = row_count;
    if n = 1 then
      v_added := v_added + 1;
    else
      update giveaway_entries set
        approved = case when manual then approved else cardinality(v_miss) = 0 end,
        missing = case when manual then missing else v_miss end,
        double_chance = case when double_manual then double_chance else v_double end,
        updated_at = now(), updated_by = 'Automatiskt'
      where username = v_user
        and ((not manual and (approved is distinct from (cardinality(v_miss) = 0) or missing is distinct from v_miss))
          or (not double_manual and double_chance is distinct from v_double));
      get diagnostics n = row_count;
      v_changed := v_changed + n;
    end if;
  end loop;
  return jsonb_build_object('added', v_added, 'changed', v_changed, 'total', (select count(*) from giveaway_entries where not hidden));
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
