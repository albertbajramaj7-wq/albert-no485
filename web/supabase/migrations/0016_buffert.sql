-- =====================================================================
-- Albert NO.485 – uttag ur bufferten i veckobudgeten (körs efter 0015_omfordela.sql)
--
-- Pengar ur den sparade bufferten kan användas för att täcka en post som
-- gått över budget, eller föras till fritt saldo. Varje uttag har datum
-- och en beskrivning av vad pengarna användes till. Inget befintligt tas bort.
-- =====================================================================

alter table budget_weeks add column if not exists buffer_uses jsonb not null default '[]';

-- Kontrollerar uttag: högst 30 st, datum i veckan, mål = postnyckel eller 'free', belopp > 0, beskrivning krävs.
create or replace function _budget_buffer_uses(p jsonb, p_week date) returns jsonb
language plpgsql as $$
declare x jsonb; v_out jsonb := '[]'; v_amt numeric; v_date date; v_note text;
begin
  if p is null or jsonb_typeof(p) = 'null' then return '[]'; end if;
  if jsonb_typeof(p) <> 'array' or jsonb_array_length(p) > 30 then perform _fail(400, 'Ogiltiga uttag ur bufferten.'); end if;
  for x in select * from jsonb_array_elements(p) loop
    v_date := _date(x ->> 'date');
    if v_date < p_week or v_date > p_week + 6 then perform _fail(400, 'Datumet för uttaget ska ligga i den valda veckan.'); end if;
    if coalesce(x ->> 'to', '') !~ '^[a-z0-9_]{1,40}$' or x ->> 'to' = 'buffer' then perform _fail(400, 'Ogiltigt mål för uttaget ur bufferten.'); end if;
    v_note := left(btrim(coalesce(x ->> 'note', '')), 200);
    if length(v_note) < 3 then perform _fail(400, 'Beskriv vad pengarna ur bufferten användes till.'); end if;
    v_amt := _amount(x -> 'amount', 'Ogiltigt belopp ur bufferten.');
    if v_amt is null or v_amt <= 0 then perform _fail(400, 'Beloppet ur bufferten måste vara större än 0.'); end if;
    v_out := v_out || jsonb_build_object('date', v_date, 'amount', v_amt, 'to', x ->> 'to', 'note', v_note);
  end loop;
  return v_out;
end $$;

create or replace function _budget_json() returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'settings', (select data from budget_settings where id = 1),
    'settingsUpdatedAt', (select updated_at from budget_settings where id = 1),
    'weeks', coalesce((select jsonb_agg(jsonb_build_object(
        'weekStart', w.week_start, 'kind', w.kind, 'revenue', w.revenue, 'salesVat', w.sales_vat,
        'cardAmount', w.card_amount, 'cardCount', w.card_count, 'tips', w.tips, 'transfers', w.transfers, 'bufferUses', w.buffer_uses, 'note', w.note, 'actuals', w.actuals,
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
    insert into budget_weeks (week_start, kind, revenue, sales_vat, card_amount, card_count, tips, transfers, buffer_uses, note, actuals, source, updated_at, updated_by)
    values (v_week,
            case when x ->> 'kind' = 'example' then 'example' else 'actual' end,
            _amount(x -> 'revenue', 'Ogiltig omsättning.'),
            _amount(x -> 'salesVat', 'Ogiltig moms.'),
            _amount(x -> 'cardAmount', 'Ogiltigt kortbelopp.'),
            case when x -> 'cardCount' is null or jsonb_typeof(x -> 'cardCount') = 'null' then null else _int(x -> 'cardCount', 0, 1000000, 'Ogiltigt antal kortköp.') end,
            _amount(x -> 'tips', 'Ogiltig dricks.'),
            _budget_transfers(x -> 'transfers'),
            _budget_buffer_uses(x -> 'bufferUses', v_week),
            left(coalesce(btrim(x ->> 'note'), ''), 300),
            v_actuals, '{"manual": true}', now(), a.name)
    on conflict (week_start) do update set
      kind = excluded.kind, revenue = excluded.revenue, sales_vat = excluded.sales_vat, card_amount = excluded.card_amount,
      card_count = excluded.card_count, tips = excluded.tips, transfers = excluded.transfers, buffer_uses = excluded.buffer_uses, note = excluded.note, actuals = excluded.actuals, updated_at = now(), updated_by = a.name;
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
