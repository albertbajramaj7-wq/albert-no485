-- =====================================================================
-- Albert NO.485 – ekonomiöversikt från Fortnox (körs efter 0006)
-- Sparar en sammanställning: saldon (bank, skattekonto, moms, skatter,
-- skulder), resultat hittills i år och obetalda fakturor.
-- =====================================================================

alter table fortnox_data add column if not exists overview jsonb;
alter table fortnox_data add column if not exists overview_at timestamptz;

create or replace function _fortnox_status() returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'connected', exists (select 1 from integration_tokens where provider = 'fortnox' and data_enc is not null),
    'companyName', (select company_name from integration_tokens where provider = 'fortnox'),
    'connectedBy', (select connected_by from integration_tokens where provider = 'fortnox'),
    'connectedAt', (select connected_at from integration_tokens where provider = 'fortnox'),
    'scope', (select scope from integration_tokens where provider = 'fortnox'),
    'bankAccount', d.bank_account, 'supplierMap', d.supplier_map,
    'bankBalance', d.bank_balance, 'bankAsOf', d.bank_as_of,
    'supplierInvoices', d.supplier_invoices,
    'overview', d.overview, 'overviewAt', d.overview_at,
    'syncedAt', d.synced_at, 'syncedBy', d.synced_by,
    'lastError', d.last_error, 'lastErrorAt', d.last_error_at)
  from fortnox_data d where d.id = 1
$$;

-- Bara servern anropar denna (efter hämtning från Fortnox).
create or replace function api_fortnox_overview(p jsonb) returns jsonb
language plpgsql as $$
begin
  if jsonb_typeof(p -> 'overview') <> 'object' or length((p -> 'overview')::text) > 200000 then perform _fail(400, 'Ogiltig översikt.'); end if;
  update fortnox_data set overview = p -> 'overview', overview_at = now() where id = 1;
  return _fortnox_status();
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
end $$;
