-- =====================================================================
-- Albert NO.485 – veckobudget (körs efter 0002_lager_inkop.sql)
--
-- Samma upplägg som Google-arket Albert_NO485_Veckobudget:
--   * budget_settings: procentfördelning, fasta kostnader, moms- och kortmix
--   * budget_weeks:    en rad per vecka (måndag) med omsättning och utfall
-- Uträkningen görs på servern i lib/budget.js. Inget raderas.
-- Endast ägare och admin har åtkomst.
-- =====================================================================

create table budget_settings (
  id         int primary key default 1 check (id = 1),
  data       jsonb not null default '{}',
  updated_at timestamptz not null default now(),
  updated_by text
);
insert into budget_settings (id) values (1);

create table budget_weeks (
  week_start  date primary key check (extract(isodow from week_start) = 1),
  kind        text not null default 'actual' check (kind in ('actual', 'example')),
  revenue     numeric(14,2) check (revenue >= 0),
  sales_vat   numeric(14,2) check (sales_vat >= 0),
  card_amount numeric(14,2) check (card_amount >= 0),
  card_count  int check (card_count >= 0),
  note        text not null default '',
  actuals     jsonb not null default '{}',   -- { postnyckel: kronor }
  source      jsonb not null default '{}',   -- varifrån värden kom (manuellt, fortnox, caspeco)
  updated_at  timestamptz not null default now(),
  updated_by  text
);

alter table budget_settings enable row level security;
alter table budget_weeks    enable row level security;

create or replace function _amount(p_value jsonb, p_message text) returns numeric
language plpgsql as $$
declare v numeric;
begin
  if p_value is null or jsonb_typeof(p_value) = 'null' then return null; end if;
  if jsonb_typeof(p_value) <> 'number' then perform _fail(400, p_message); end if;
  v := p_value::text::numeric;
  if v < 0 or v > 100000000 then perform _fail(400, p_message); end if;
  return round(v, 2);
end $$;

create or replace function _budget_json() returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'settings', (select data from budget_settings where id = 1),
    'settingsUpdatedAt', (select updated_at from budget_settings where id = 1),
    'weeks', coalesce((select jsonb_agg(jsonb_build_object(
        'weekStart', w.week_start, 'kind', w.kind, 'revenue', w.revenue, 'salesVat', w.sales_vat,
        'cardAmount', w.card_amount, 'cardCount', w.card_count, 'note', w.note, 'actuals', w.actuals,
        'updatedAt', w.updated_at, 'updatedBy', w.updated_by) order by w.week_start)
      from budget_weeks w), '[]'),
    -- Mottagna leveranser i admin per vecka (kronor ex moms, där pris finns).
    'received', coalesce((select jsonb_object_agg(wk, total) from (
        select date_trunc('week', o.received_at at time zone 'Europe/Stockholm')::date::text as wk,
               round(sum(coalesce(l.received_qty, l.qty) * coalesce(l.unit_cost, i.unit_cost)), 2) as total
        from purchase_orders o join purchase_order_lines l on l.order_id = o.id join stock_items i on i.id = l.item_id
        where o.status = 'received' and coalesce(l.unit_cost, i.unit_cost) is not null
        group by 1) r), '{}'))
$$;

create or replace function api_budget(p jsonb) returns jsonb
language plpgsql as $$
declare
  a staff := _actor(p, 'admin');
  v_action text := coalesce(p ->> 'action', 'get');
  x jsonb;
  k text;
  v jsonb;
  v_week date;
  v_actuals jsonb := '{}';
begin
  if v_action = 'save_settings' then
    x := p -> 'settings';
    if x is null or jsonb_typeof(x) <> 'object' or length(x::text) > 30000 then perform _fail(400, 'Ogiltiga budgetinställningar.'); end if;
    update budget_settings set data = x, updated_at = now(), updated_by = a.name where id = 1;
    perform _audit(_local_date(now()), a.name, 'budget_settings', 'budget', '{}');

  elsif v_action = 'save_week' then
    x := p -> 'week';
    if x is null or jsonb_typeof(x) <> 'object' then perform _fail(400, 'Ingen vecka att spara.'); end if;
    v_week := _date(x ->> 'weekStart');
    if extract(isodow from v_week) <> 1 then perform _fail(400, 'Veckan ska börja på en måndag.'); end if;
    if x -> 'actuals' is not null and jsonb_typeof(x -> 'actuals') = 'object' then
      for k, v in select * from jsonb_each(x -> 'actuals') loop
        if k !~ '^[a-z0-9_]{1,60}$' then perform _fail(400, 'Ogiltig kostnadspost.'); end if;
        if _amount(v, 'Ogiltigt utfall.') is not null then v_actuals := v_actuals || jsonb_build_object(k, _amount(v, 'Ogiltigt utfall.')); end if;
      end loop;
    end if;
    insert into budget_weeks (week_start, kind, revenue, sales_vat, card_amount, card_count, note, actuals, source, updated_at, updated_by)
    values (v_week,
            case when x ->> 'kind' = 'example' then 'example' else 'actual' end,
            _amount(x -> 'revenue', 'Ogiltig omsättning.'),
            _amount(x -> 'salesVat', 'Ogiltig moms.'),
            _amount(x -> 'cardAmount', 'Ogiltigt kortbelopp.'),
            case when x -> 'cardCount' is null or jsonb_typeof(x -> 'cardCount') = 'null' then null else _int(x -> 'cardCount', 0, 1000000, 'Ogiltigt antal kortköp.') end,
            left(coalesce(btrim(x ->> 'note'), ''), 300),
            v_actuals, '{"manual": true}', now(), a.name)
    on conflict (week_start) do update set
      kind = excluded.kind, revenue = excluded.revenue, sales_vat = excluded.sales_vat, card_amount = excluded.card_amount,
      card_count = excluded.card_count, note = excluded.note, actuals = excluded.actuals, updated_at = now(), updated_by = a.name;
    perform _audit(_local_date(now()), a.name, 'budget_week', v_week::text, jsonb_build_object('revenue', x -> 'revenue'));

  elsif v_action <> 'get' then
    perform _fail(400, 'Okänd åtgärd.');
  end if;
  return _budget_json();
end $$;

-- Samma behörighet som tidigare: bara servern får anropa funktionerna.
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
