-- =====================================================================
-- Albert NO.485 – dricks i veckobudgeten (körs efter 0013_bokning_ko.sql)
--
-- Veckans dricks kan fyllas i under Veckans försäljning. Den är inte
-- restaurangens intäkt utan ska betalas ut till personalen, så den sätts
-- undan och visas som en egen avsättning. Inget befintligt tas bort.
-- =====================================================================

alter table budget_weeks add column if not exists tips numeric(14,2) check (tips >= 0);

create or replace function _budget_json() returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'settings', (select data from budget_settings where id = 1),
    'settingsUpdatedAt', (select updated_at from budget_settings where id = 1),
    'weeks', coalesce((select jsonb_agg(jsonb_build_object(
        'weekStart', w.week_start, 'kind', w.kind, 'revenue', w.revenue, 'salesVat', w.sales_vat,
        'cardAmount', w.card_amount, 'cardCount', w.card_count, 'tips', w.tips, 'note', w.note, 'actuals', w.actuals,
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
    insert into budget_weeks (week_start, kind, revenue, sales_vat, card_amount, card_count, tips, note, actuals, source, updated_at, updated_by)
    values (v_week,
            case when x ->> 'kind' = 'example' then 'example' else 'actual' end,
            _amount(x -> 'revenue', 'Ogiltig omsättning.'),
            _amount(x -> 'salesVat', 'Ogiltig moms.'),
            _amount(x -> 'cardAmount', 'Ogiltigt kortbelopp.'),
            case when x -> 'cardCount' is null or jsonb_typeof(x -> 'cardCount') = 'null' then null else _int(x -> 'cardCount', 0, 1000000, 'Ogiltigt antal kortköp.') end,
            _amount(x -> 'tips', 'Ogiltig dricks.'),
            left(coalesce(btrim(x ->> 'note'), ''), 300),
            v_actuals, '{"manual": true}', now(), a.name)
    on conflict (week_start) do update set
      kind = excluded.kind, revenue = excluded.revenue, sales_vat = excluded.sales_vat, card_amount = excluded.card_amount,
      card_count = excluded.card_count, tips = excluded.tips, note = excluded.note, actuals = excluded.actuals, updated_at = now(), updated_by = a.name;
    perform _audit(_local_date(now()), a.name, 'budget_week', v_week::text, jsonb_build_object('revenue', x -> 'revenue'));

  elsif v_action <> 'get' then
    perform _fail(400, 'Okänd åtgärd.');
  end if;
  return _budget_json();
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
