-- =====================================================================
-- Albert NO.485 – Fortnox-koppling (körs efter 0003_veckobudget.sql)
--
-- Admin kopplar Fortnox en gång (OAuth). Nycklarna sparas krypterade
-- (servern krypterar innan de når databasen). Servern hämtar banksaldo och
-- leverantörsfakturor och sparar en sammanställning här. Admin läser bara
-- från Fortnox – inget skickas eller bokförs.
-- =====================================================================

create table integration_states (
  state        text primary key,
  provider     text not null,
  actor        text not null,
  redirect_uri text not null,
  created_at   timestamptz not null default now()
);

create table integration_tokens (
  provider     text primary key,
  data_enc     text,                -- krypterade nycklar (AES-GCM), null = frånkopplad
  scope        text not null default '',
  company_name text not null default '',
  connected_by text,
  connected_at timestamptz,
  updated_at   timestamptz not null default now()
);

create table fortnox_data (
  id               int primary key default 1 check (id = 1),
  bank_account     int not null default 1930,
  supplier_map     jsonb not null default '{}',   -- { leverantörsnummer: budgetpost }
  bank_balance     numeric(14,2),
  bank_as_of       timestamptz,
  supplier_invoices jsonb not null default '[]',  -- senaste 120 dagarna, kortfattat
  synced_at        timestamptz,
  synced_by        text,
  last_error       text,
  last_error_at    timestamptz
);
insert into fortnox_data (id) values (1);

alter table integration_states enable row level security;
alter table integration_tokens enable row level security;
alter table fortnox_data       enable row level security;

create or replace function _fortnox_status() returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'connected', exists (select 1 from integration_tokens where provider = 'fortnox' and data_enc is not null),
    'companyName', (select company_name from integration_tokens where provider = 'fortnox'),
    'connectedBy', (select connected_by from integration_tokens where provider = 'fortnox'),
    'connectedAt', (select connected_at from integration_tokens where provider = 'fortnox'),
    'bankAccount', d.bank_account, 'supplierMap', d.supplier_map,
    'bankBalance', d.bank_balance, 'bankAsOf', d.bank_as_of,
    'supplierInvoices', d.supplier_invoices,
    'syncedAt', d.synced_at, 'syncedBy', d.synced_by,
    'lastError', d.last_error, 'lastErrorAt', d.last_error_at)
  from fortnox_data d where d.id = 1
$$;

-- Admin-åtgärder (kräver inloggad admin).
create or replace function api_fortnox(p jsonb) returns jsonb
language plpgsql as $$
declare
  a staff := _actor(p, 'admin');
  v_action text := coalesce(p ->> 'action', 'status');
  k text; v jsonb; v_map jsonb := '{}';
begin
  if v_action = 'start' then
    if coalesce(length(p ->> 'state'), 0) < 32 then perform _fail(400, 'Ogiltig begäran.'); end if;
    delete from integration_states where created_at < now() - interval '1 hour';
    insert into integration_states (state, provider, actor, redirect_uri) values (p ->> 'state', 'fortnox', a.name, _text(p -> 'redirectUri', 10, 300, 'Ogiltig adress.'));
  elsif v_action = 'save_map' then
    if jsonb_typeof(p -> 'supplierMap') <> 'object' then perform _fail(400, 'Ogiltig koppling.'); end if;
    for k, v in select * from jsonb_each(p -> 'supplierMap') loop
      if k !~ '^[A-Za-z0-9_-]{1,40}$' then perform _fail(400, 'Ogiltigt leverantörsnummer.'); end if;
      if jsonb_typeof(v) = 'string' and v #>> '{}' ~ '^[a-z0-9_]{1,60}$' then v_map := v_map || jsonb_build_object(k, v); end if;
    end loop;
    update fortnox_data set supplier_map = v_map,
      bank_account = case when p -> 'bankAccount' is null or jsonb_typeof(p -> 'bankAccount') = 'null' then bank_account
                          else _int(p -> 'bankAccount', 1000, 9999, 'Ogiltigt kontonummer.') end where id = 1;
    perform _audit(_local_date(now()), a.name, 'fortnox_map', 'fortnox', '{}');
  elsif v_action = 'disconnect' then
    -- Nycklarna tas bort så att admin inte längre når Fortnox. Hämtad data finns kvar.
    update integration_tokens set data_enc = null, updated_at = now() where provider = 'fortnox';
    perform _audit(_local_date(now()), a.name, 'fortnox_disconnected', 'fortnox', '{}');
  elsif v_action <> 'status' then
    perform _fail(400, 'Okänd åtgärd.');
  end if;
  return _fortnox_status();
end $$;

-- Serverns egna åtgärder (anropas bara av servern, aldrig med användarens indata).
create or replace function api_fortnox_system(p jsonb) returns jsonb
language plpgsql as $$
declare
  v_action text := p ->> 'action';
  s integration_states;
begin
  if v_action = 'take_state' then
    delete from integration_states where state = p ->> 'state' and provider = 'fortnox' returning * into s;
    if not found or s.created_at < now() - interval '15 minutes' then perform _fail(400, 'Kopplingen tog för lång tid eller är redan använd. Försök igen från admin.'); end if;
    return jsonb_build_object('actor', s.actor, 'redirectUri', s.redirect_uri);
  elsif v_action = 'save_tokens' then
    insert into integration_tokens (provider, data_enc, scope, company_name, connected_by, connected_at, updated_at)
    values ('fortnox', p ->> 'dataEnc', coalesce(p ->> 'scope', ''), coalesce(p ->> 'companyName', ''), p ->> 'actor', now(), now())
    on conflict (provider) do update set data_enc = excluded.data_enc, updated_at = now(),
      scope = case when p ? 'scope' then excluded.scope else integration_tokens.scope end,
      company_name = case when p ? 'companyName' then excluded.company_name else integration_tokens.company_name end,
      connected_by = coalesce(excluded.connected_by, integration_tokens.connected_by),
      connected_at = case when p ? 'actor' then now() else integration_tokens.connected_at end;
    if p ? 'actor' then perform _audit(_local_date(now()), p ->> 'actor', 'fortnox_connected', 'fortnox', '{}'); end if;
    return jsonb_build_object('ok', true);
  elsif v_action = 'get_tokens' then
    return jsonb_build_object('dataEnc', (select data_enc from integration_tokens where provider = 'fortnox'),
                              'bankAccount', (select bank_account from fortnox_data where id = 1));
  elsif v_action = 'save_sync' then
    update fortnox_data set bank_balance = (p ->> 'bankBalance')::numeric, bank_as_of = now(),
      supplier_invoices = coalesce(p -> 'supplierInvoices', '[]'), synced_at = now(), synced_by = p ->> 'by',
      last_error = null, last_error_at = null where id = 1;
    return _fortnox_status();
  elsif v_action = 'save_error' then
    update fortnox_data set last_error = left(p ->> 'error', 300), last_error_at = now() where id = 1;
    return _fortnox_status();
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
