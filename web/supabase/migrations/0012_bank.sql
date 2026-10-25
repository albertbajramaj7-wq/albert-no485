-- =====================================================================
-- Albert NO.485 – Ekonomi & Bank (körs efter 0011_pizza_sekunder.sql)
--
-- Banksaldon och transaktioner som hämtats (ENDAST LÄSNING) från banken.
-- * Bara ägaren och administratörer som ägaren uttryckligen gett behörighet
--   kan läsa bankdata. Övrig personal nekas i databasen.
-- * Test- och produktionsdata hålls isär med kolumnen env (mock/sandbox/live).
-- * Samma transaktion kan aldrig sparas två gånger (unik nyckel).
-- * Alla tabeller har Row Level Security och är stängda för publika roller.
-- * Varje synk och läsning loggas (utan nycklar eller certifikat).
-- Inga befintliga tabeller eller funktioner ändras eller tas bort.
-- =====================================================================

alter table staff add column if not exists bank_access boolean not null default false;

-- Bankbehörigheten försvinner automatiskt om personen byter roll eller inaktiveras.
-- Ägaren måste då ge den igen.
create or replace function _bank_access_reset() returns trigger
language plpgsql as $$
begin
  if new.role is distinct from old.role or not new.active then new.bank_access := false; end if;
  return new;
end $$;
drop trigger if exists staff_bank_access_reset on staff;
create trigger staff_bank_access_reset before update of role, active on staff
  for each row execute function _bank_access_reset();

create table if not exists bank_accounts (
  env          text not null check (env in ('mock', 'sandbox', 'live')),
  provider     text not null,
  account_id   text not null,
  name         text not null default '',
  iban         text not null default '',
  bban         text not null default '',
  currency     text not null default 'SEK',
  balance      numeric(16,2),
  available    numeric(16,2),
  balance_at   timestamptz,
  updated_at   timestamptz not null default now(),
  primary key (env, provider, account_id)
);

create table if not exists bank_transactions (
  id            uuid primary key default gen_random_uuid(),
  env           text not null check (env in ('mock', 'sandbox', 'live')),
  provider      text not null,
  account_id    text not null,
  tx_key        text not null,
  booking_date  date not null,
  value_date    date,
  amount        numeric(16,2) not null,
  currency      text not null default 'SEK',
  counterparty  text not null default '',
  reference     text not null default '',
  tx_type       text not null default '',
  category      text not null default 'Övrigt',
  category_manual boolean not null default false,
  raw           jsonb,
  created_at    timestamptz not null default now(),
  unique (env, provider, tx_key)
);
create index if not exists bank_tx_date_idx on bank_transactions (env, booking_date desc);

create table if not exists bank_sync (
  env         text primary key check (env in ('mock', 'sandbox', 'live')),
  provider    text not null default '',
  status      text not null default 'never' check (status in ('never', 'ok', 'error')),
  synced_at   timestamptz,
  error_at    timestamptz,
  error       text,
  added       int not null default 0,
  by_name     text not null default ''
);

create table if not exists bank_access_log (
  id         bigserial primary key,
  at         timestamptz not null default now(),
  actor      text not null,
  action     text not null,
  env        text not null,
  detail     jsonb not null default '{}'
);
create index if not exists bank_access_log_at_idx on bank_access_log (at desc);

alter table bank_accounts enable row level security;
alter table bank_transactions enable row level security;
alter table bank_sync enable row level security;
alter table bank_access_log enable row level security;

-- Ägaren alltid, administratörer bara med uttrycklig behörighet. Personal aldrig.
create or replace function _bank_actor(p jsonb) returns staff
language plpgsql as $$
declare v staff := _actor(p, 'admin');
begin
  if v.role <> 'owner' and not (v.role = 'admin' and v.bank_access) then
    perform _fail(403, 'Ekonomi & Bank kräver särskild behörighet från ägaren.');
  end if;
  return v;
end $$;

create or replace function _bank_env(p jsonb) returns text
language plpgsql as $$
begin
  if p ->> 'env' not in ('mock', 'sandbox', 'live') then perform _fail(400, 'Ogiltig bankmiljö.'); end if;
  return p ->> 'env';
end $$;

-- Loggar läsning högst en gång per halvtimme och person (synk loggas alltid).
create or replace function _bank_log(a staff, p_action text, p_env text, p_detail jsonb) returns void
language plpgsql as $$
begin
  if p_action like 'view%' and exists (select 1 from bank_access_log where actor = a.name and action = p_action and env = p_env and at > now() - interval '30 minutes') then
    return;
  end if;
  insert into bank_access_log (actor, action, env, detail) values (a.name, p_action, p_env, coalesce(p_detail, '{}'));
end $$;

create or replace function _bank_overview(p_env text, p_today date) returns jsonb
language sql stable as $$
  with m as (select date_trunc('month', p_today)::date as start, (date_trunc('month', p_today) - interval '1 month')::date as prev),
  t as (select * from bank_transactions where env = p_env and currency = 'SEK'),
  cur as (select * from t, m where t.booking_date >= m.start and t.booking_date <= p_today),
  prv as (select * from t, m where t.booking_date >= m.prev and t.booking_date < m.start
            and extract(day from t.booking_date) <= extract(day from p_today)),
  wk as (select * from t where booking_date > p_today - 7 and booking_date <= p_today)
  select jsonb_build_object(
    'env', p_env,
    'accounts', coalesce((select jsonb_agg(jsonb_build_object('id', account_id, 'name', name, 'iban', iban, 'bban', bban, 'currency', currency,
        'balance', balance, 'available', available, 'balanceAt', balance_at) order by currency <> 'SEK', name) from bank_accounts where env = p_env), '[]'),
    'balanceSek', (select sum(balance) from bank_accounts where env = p_env and currency = 'SEK'),
    'availableSek', (select sum(available) from bank_accounts where env = p_env and currency = 'SEK' having count(available) = count(*)),
    'monthIn', (select coalesce(sum(amount), 0) from cur where amount > 0),
    'monthOut', (select coalesce(-sum(amount), 0) from cur where amount < 0),
    'prevMonthInSameDays', (select coalesce(sum(amount), 0) from prv where amount > 0),
    'prevMonthOutSameDays', (select coalesce(-sum(amount), 0) from prv where amount < 0),
    'weekIn', (select coalesce(sum(amount), 0) from wk where amount > 0),
    'weekOut', (select coalesce(-sum(amount), 0) from wk where amount < 0),
    'categories', coalesce((select jsonb_agg(x order by x ->> 'out' desc) from (
        select jsonb_build_object('category', c.category,
          'out', coalesce(-sum(c.amount) filter (where c.amount < 0), 0), 'in', coalesce(sum(c.amount) filter (where c.amount > 0), 0),
          'prevOut', coalesce((select -sum(pv.amount) from prv pv where pv.category = c.category and pv.amount < 0), 0)) x
        from cur c group by c.category) y), '[]'),
    'topCosts', coalesce((select jsonb_agg(x) from (
        select jsonb_build_object('counterparty', cp, 'amount', -sum(amount), 'count', count(*)) x
        from (select coalesce(nullif(counterparty, ''), '(okänd)') cp, amount from cur where amount < 0) z
        group by cp order by -sum(amount) desc limit 8) y), '[]'),
    'sync', (select jsonb_build_object('status', status, 'syncedAt', synced_at, 'errorAt', error_at, 'error', error, 'added', added, 'by', by_name, 'provider', provider)
             from bank_sync where env = p_env),
    'transactionCount', (select count(*) from bank_transactions where env = p_env),
    'firstDate', (select min(booking_date) from bank_transactions where env = p_env),
    'otherCurrencies', (select count(*) from bank_accounts where env = p_env and currency <> 'SEK')
  )
$$;

-- Läsning för inloggad ägare/behörig admin.
create or replace function api_bank(p jsonb) returns jsonb
language plpgsql as $$
declare
  a staff := _bank_actor(p);
  v_env text;
  v_action text := coalesce(p ->> 'action', 'overview');
  v_today date := _local_date(_now(p));
  v_from date; v_to date; v_min numeric; v_max numeric; v_q text; v_cat text; v_dir text; v_limit int; v_offset int;
  v_rows int; v_user uuid;
begin
  if v_action = 'access' then
    if a.role <> 'owner' then
      if p ? 'userId' and p ->> 'userId' is not null then perform _fail(403, 'Bara ägaren kan ändra behörigheten.'); end if;
      return jsonb_build_object('admins', null);
    end if;
    if p ? 'userId' and p ->> 'userId' is not null then
      v_user := _uuid(p -> 'userId', 'Välj en giltig person.');
      update staff set bank_access = _bool(p -> 'allow', 'Välj ja eller nej.') where user_id = v_user and role = 'admin' and active;
      get diagnostics v_rows = row_count;
      if v_rows = 0 then perform _fail(400, 'Bara administratörer kan få behörighet till Ekonomi & Bank.'); end if;
      perform _bank_log(a, 'access_changed', 'alla', jsonb_build_object('userId', v_user, 'allow', p -> 'allow'));
    end if;
    return jsonb_build_object('admins', coalesce((select jsonb_agg(jsonb_build_object('userId', user_id, 'name', name, 'email', email, 'bankAccess', bank_access) order by name)
      from staff where role = 'admin' and active), '[]'));
  end if;

  v_env := _bank_env(p);
  if v_action = 'overview' then
    perform _bank_log(a, 'view_overview', v_env, '{}');
    return _bank_overview(v_env, v_today) || jsonb_build_object('canManageAccess', a.role = 'owner');

  elsif v_action = 'transactions' then
    v_from := coalesce(nullif(p ->> 'from', '')::date, v_today - 90);
    v_to := coalesce(nullif(p ->> 'to', '')::date, v_today);
    v_min := nullif(p ->> 'min', '')::numeric;
    v_max := nullif(p ->> 'max', '')::numeric;
    v_q := nullif(trim(coalesce(p ->> 'q', '')), '');
    v_cat := nullif(p ->> 'category', '');
    v_dir := nullif(p ->> 'direction', '');
    v_limit := least(greatest(coalesce((p ->> 'limit')::int, 100), 1), 500);
    v_offset := greatest(coalesce((p ->> 'offset')::int, 0), 0);
    if v_q is not null and length(v_q) > 80 then perform _fail(400, 'Sökningen är för lång.'); end if;
    perform _bank_log(a, 'view_transactions', v_env, jsonb_build_object('from', v_from, 'to', v_to));
    return (
      with f as (
        select * from bank_transactions
        where env = v_env and booking_date between v_from and v_to
          and (v_min is null or abs(amount) >= v_min) and (v_max is null or abs(amount) <= v_max)
          and (v_cat is null or category = v_cat)
          and (v_dir is null or (v_dir = 'in' and amount > 0) or (v_dir = 'out' and amount < 0))
          and (v_q is null or counterparty ilike '%' || v_q || '%' or reference ilike '%' || v_q || '%')
      )
      select jsonb_build_object(
        'total', (select count(*) from f),
        'sumIn', (select coalesce(sum(amount), 0) from f where amount > 0),
        'sumOut', (select coalesce(-sum(amount), 0) from f where amount < 0),
        'categories', coalesce((select jsonb_agg(distinct category) from bank_transactions where env = v_env), '[]'),
        'items', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'date', booking_date, 'valueDate', value_date, 'amount', amount, 'currency', currency,
            'counterparty', counterparty, 'reference', reference, 'type', tx_type, 'category', category, 'manual', category_manual, 'account', account_id))
          from (select * from f order by booking_date desc, created_at desc limit v_limit offset v_offset) x), '[]'))
    );

  elsif v_action = 'set_category' then
    v_cat := _text(p -> 'category', 1, 40, 'Ange en kategori (högst 40 tecken).');
    update bank_transactions set category = v_cat, category_manual = true where id = _uuid(p -> 'id', 'Välj en transaktion.') and env = v_env;
    get diagnostics v_rows = row_count;
    if v_rows = 0 then perform _fail(404, 'Transaktionen finns inte.'); end if;
    perform _bank_log(a, 'category_changed', v_env, jsonb_build_object('id', p -> 'id', 'category', v_cat));
    return jsonb_build_object('ok', true);

  elsif v_action = 'analysis_data' then
    -- Underlag till prognos och AI: senaste 120 dagarna, bara fält som behövs.
    perform _bank_log(a, 'view_analysis', v_env, '{}');
    return jsonb_build_object('overview', _bank_overview(v_env, v_today), 'today', v_today,
      'transactions', coalesce((select jsonb_agg(jsonb_build_object('date', booking_date, 'amount', amount, 'counterparty', counterparty, 'category', category) order by booking_date)
        from bank_transactions where env = v_env and currency = 'SEK' and booking_date > v_today - 120), '[]'));

  elsif v_action = 'log' then
    return jsonb_build_object('items', coalesce((select jsonb_agg(jsonb_build_object('at', at, 'actor', actor, 'action', action, 'env', env) order by at desc)
      from (select * from bank_access_log where env in (v_env, 'alla') order by at desc limit 50) l), '[]'));
  end if;
  perform _fail(400, 'Okänd åtgärd.');
end $$;

-- Endast servern (service-nyckel). Sparar resultat från en synk.
create or replace function api_bank_system(p jsonb) returns jsonb
language plpgsql as $$
declare
  v_env text := _bank_env(p);
  v_action text := p ->> 'action';
  v_added int := 0;
  x jsonb;
begin
  if v_action = 'save_sync' then
    if jsonb_typeof(p -> 'accounts') <> 'array' or jsonb_typeof(p -> 'transactions') <> 'array' then perform _fail(400, 'Ogiltig bankdata.'); end if;
    if jsonb_array_length(p -> 'transactions') > 20000 then perform _fail(400, 'För många transaktioner i en synk.'); end if;
    for x in select * from jsonb_array_elements(p -> 'accounts') loop
      insert into bank_accounts (env, provider, account_id, name, iban, bban, currency, balance, available, balance_at, updated_at)
      values (v_env, p ->> 'provider', left(x ->> 'id', 120), left(coalesce(x ->> 'name', ''), 120), left(coalesce(x ->> 'iban', ''), 40), left(coalesce(x ->> 'bban', ''), 40),
              left(coalesce(x ->> 'currency', 'SEK'), 3), (x ->> 'balance')::numeric, (x ->> 'available')::numeric, (x ->> 'balanceAt')::timestamptz, now())
      on conflict (env, provider, account_id) do update set name = excluded.name, iban = excluded.iban, bban = excluded.bban, currency = excluded.currency,
        balance = excluded.balance, available = excluded.available, balance_at = excluded.balance_at, updated_at = now();
    end loop;
    with ins as (
      insert into bank_transactions (env, provider, account_id, tx_key, booking_date, value_date, amount, currency, counterparty, reference, tx_type, category, raw)
      select v_env, p ->> 'provider', left(t ->> 'account', 120), left(t ->> 'key', 200), (t ->> 'date')::date, nullif(t ->> 'valueDate', '')::date,
             (t ->> 'amount')::numeric, left(coalesce(t ->> 'currency', 'SEK'), 3), left(coalesce(t ->> 'counterparty', ''), 200),
             left(coalesce(t ->> 'reference', ''), 300), left(coalesce(t ->> 'type', ''), 80), left(coalesce(t ->> 'category', 'Övrigt'), 40), t -> 'raw'
      from jsonb_array_elements(p -> 'transactions') t
      on conflict (env, provider, tx_key) do nothing
      returning 1
    ) select count(*) into v_added from ins;
    insert into bank_sync (env, provider, status, synced_at, error, added, by_name)
    values (v_env, p ->> 'provider', 'ok', now(), null, v_added, coalesce(p ->> 'by', ''))
    on conflict (env) do update set provider = excluded.provider, status = 'ok', synced_at = now(), error = null, added = v_added, by_name = excluded.by_name;
    insert into bank_access_log (actor, action, env, detail)
      values (coalesce(p ->> 'by', 'system'), 'sync_ok', v_env, jsonb_build_object('accounts', jsonb_array_length(p -> 'accounts'), 'received', jsonb_array_length(p -> 'transactions'), 'added', v_added));
    return jsonb_build_object('added', v_added);
  elsif v_action = 'save_error' then
    insert into bank_sync (env, provider, status, error_at, error, by_name)
    values (v_env, coalesce(p ->> 'provider', ''), 'error', now(), left(p ->> 'error', 300), coalesce(p ->> 'by', ''))
    on conflict (env) do update set status = 'error', error_at = now(), error = left(p ->> 'error', 300), by_name = excluded.by_name;
    insert into bank_access_log (actor, action, env, detail) values (coalesce(p ->> 'by', 'system'), 'sync_error', v_env, jsonb_build_object('error', left(p ->> 'error', 300)));
    return jsonb_build_object('ok', true);
  elsif v_action = 'last_date' then
    return jsonb_build_object('lastDate', (select max(booking_date) from bank_transactions where env = v_env));
  end if;
  perform _fail(400, 'Okänd åtgärd.');
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
