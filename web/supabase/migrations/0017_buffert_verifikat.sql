-- =====================================================================
-- Albert NO.485 – koppla uttag ur bufferten till verifikat i Fortnox
-- (körs efter 0016_buffert.sql)
--
-- Ett uttag kan få en hänvisning till ett verifikat (serie, nummer,
-- räkenskapsår, datum, text, belopp). Ingen ny kolumn, inget tas bort.
-- =====================================================================

create or replace function _budget_buffer_uses(p jsonb, p_week date) returns jsonb
language plpgsql as $$
declare x jsonb; vr jsonb; v_out jsonb := '[]'; v_item jsonb; v_amt numeric; v_date date; v_note text;
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
    v_item := jsonb_build_object('date', v_date, 'amount', v_amt, 'to', x ->> 'to', 'note', v_note);
    vr := x -> 'voucher';
    if vr is not null and jsonb_typeof(vr) = 'object' then
      if coalesce(vr ->> 'series', '') !~ '^[A-Za-z0-9]{1,5}$' or coalesce(vr ->> 'number', '') !~ '^[0-9]{1,9}$' or coalesce(vr ->> 'year', '') !~ '^[0-9]{1,9}$' then
        perform _fail(400, 'Ogiltigt verifikat.');
      end if;
      v_item := v_item || jsonb_build_object('voucher', jsonb_build_object(
        'series', vr ->> 'series', 'number', (vr ->> 'number')::int, 'year', (vr ->> 'year')::int,
        'date', case when coalesce(vr ->> 'date', '') ~ '^\d{4}-\d{2}-\d{2}$' then vr ->> 'date' end,
        'text', left(coalesce(vr ->> 'text', ''), 100),
        'total', case when jsonb_typeof(vr -> 'total') = 'number' then round((vr ->> 'total')::numeric, 2) end));
    end if;
    v_out := v_out || v_item;
  end loop;
  return v_out;
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
