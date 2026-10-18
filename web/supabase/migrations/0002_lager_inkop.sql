-- =====================================================================
-- Albert NO.485 – lager och inköp (körs efter 0001_albert_core.sql)
--
-- Lager räknas för hand (inventering). Under miniminivån hamnar varan på
-- inköpslistan. Beställningar skapas per leverantör, skickas och tas emot;
-- mottagen mängd läggs till i lagret. Inget raderas: varor och leverantörer
-- inaktiveras, beställningar makuleras.
--
-- Behörighet: all personal kan se lagret, räkna och ta emot leveranser.
-- Priser, leverantörsuppgifter och beställningar hanteras av admin.
-- =====================================================================

create table suppliers (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  contact    text not null default '',
  email      text not null default '',
  phone      text not null default '',
  notes      text not null default '',
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table stock_items (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  category    text not null default 'Råvaror',
  unit        text not null default 'st',
  supplier_id uuid references suppliers(id),
  min_level   numeric(10,2) not null default 0 check (min_level >= 0),
  order_qty   numeric(10,2) not null default 0 check (order_qty >= 0),   -- förslag på beställd mängd
  unit_cost   numeric(10,2) check (unit_cost >= 0),                       -- inköpspris per enhet (admin)
  on_hand     numeric(10,2) not null default 0 check (on_hand >= 0),
  counted_at  timestamptz,
  counted_by  text,
  active      boolean not null default true,
  sort_order  int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Varje ändring av lagret sparas: inventering, leverans eller rättelse.
create table stock_movements (
  id         uuid primary key default gen_random_uuid(),
  item_id    uuid not null references stock_items(id),
  kind       text not null check (kind in ('count', 'delivery')),
  before_qty numeric(10,2) not null,
  after_qty  numeric(10,2) not null,
  order_id   uuid,
  actor      text not null,
  created_at timestamptz not null default now()
);
create index stock_movements_item on stock_movements (item_id, created_at desc);

create sequence purchase_order_no start 1001;
create table purchase_orders (
  id          uuid primary key default gen_random_uuid(),
  number      int not null unique default nextval('purchase_order_no'),
  supplier_id uuid references suppliers(id),
  status      text not null default 'draft' check (status in ('draft', 'sent', 'received', 'cancelled')),
  note        text not null default '',
  created_by  text not null,
  created_at  timestamptz not null default now(),
  sent_at     timestamptz,
  sent_by     text,
  received_at timestamptz,
  received_by text,
  updated_at  timestamptz not null default now()
);

create table purchase_order_lines (
  id           uuid primary key default gen_random_uuid(),
  order_id     uuid not null references purchase_orders(id),
  item_id      uuid not null references stock_items(id),
  qty          numeric(10,2) not null check (qty > 0),
  unit_cost    numeric(10,2),
  received_qty numeric(10,2),
  unique (order_id, item_id)
);

alter table suppliers            enable row level security;
alter table stock_items          enable row level security;
alter table stock_movements      enable row level security;
alter table purchase_orders      enable row level security;
alter table purchase_order_lines enable row level security;

-- ---------------------------------------------------------------------
-- Hjälp
-- ---------------------------------------------------------------------
create or replace function _qty(p_value jsonb, p_message text default 'Skriv ett giltigt antal.') returns numeric
language plpgsql as $$
declare v numeric;
begin
  if p_value is null or jsonb_typeof(p_value) <> 'number' then perform _fail(400, p_message); end if;
  v := p_value::text::numeric;
  if v < 0 or v > 1000000 then perform _fail(400, p_message); end if;
  return round(v, 2);
end $$;

create or replace function _is_admin(a staff) returns boolean
language sql immutable as $$ select a.role in ('owner', 'admin') $$;

-- Lagret som JSON. Personal ser inte priser eller leverantörens kontaktuppgifter.
create or replace function _stock_json(a staff) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(jsonb_build_object(
        'id', i.id, 'name', i.name, 'category', i.category, 'unit', i.unit,
        'supplierId', i.supplier_id, 'supplierName', s.name,
        'minLevel', i.min_level, 'orderQty', i.order_qty, 'onHand', i.on_hand,
        'unitCost', case when _is_admin(a) then i.unit_cost end,
        'countedAt', i.counted_at, 'countedBy', i.counted_by, 'active', i.active,
        'low', i.active and i.on_hand <= i.min_level and i.min_level > 0,
        'onOrder', coalesce((select sum(l.qty) from purchase_order_lines l join purchase_orders o on o.id = l.order_id
                             where l.item_id = i.id and o.status in ('draft', 'sent')), 0))
        order by i.category, i.sort_order, i.name)
      from stock_items i left join suppliers s on s.id = i.supplier_id
      where i.active or _is_admin(a)), '[]'),
    'suppliers', coalesce((select jsonb_agg(case when _is_admin(a) then to_jsonb(x) else jsonb_build_object('id', x.id, 'name', x.name, 'active', x.active) end order by x.name)
      from suppliers x where x.active or _is_admin(a)), '[]'),
    'isAdmin', _is_admin(a))
$$;

-- ---------------------------------------------------------------------
-- Lager
-- ---------------------------------------------------------------------
create or replace function api_stock(p jsonb) returns jsonb
language plpgsql as $$
declare
  a staff;
  v_action text := coalesce(p ->> 'action', 'list');
  x jsonb;
  i stock_items;
  v_qty numeric;
  v_id uuid;
  v_sup uuid;
  v_changed int := 0;
begin
  if v_action in ('list', 'count') then a := _actor(p, 'staff'); else a := _actor(p, 'admin'); end if;

  if v_action = 'count' then
    -- Inventering: sätt nytt antal för en eller flera varor.
    if jsonb_typeof(p -> 'counts') <> 'array' or jsonb_array_length(p -> 'counts') = 0 then perform _fail(400, 'Inget att spara.'); end if;
    perform pg_advisory_xact_lock(hashtext('albert-stock'));
    for x in select * from jsonb_array_elements(p -> 'counts') loop
      select * into i from stock_items where id = _uuid(x -> 'id', 'Välj en giltig vara.') and active;
      if not found then perform _fail(404, 'Varan finns inte.'); end if;
      v_qty := _qty(x -> 'qty');
      update stock_items set on_hand = v_qty, counted_at = now(), counted_by = a.name, updated_at = now() where id = i.id;
      insert into stock_movements (item_id, kind, before_qty, after_qty, actor) values (i.id, 'count', i.on_hand, v_qty, a.name);
      v_changed := v_changed + 1;
    end loop;
    perform _audit(_local_date(now()), a.name, 'stock_counted', 'stock', jsonb_build_object('count', v_changed));

  elsif v_action = 'save_item' then
    x := p -> 'item';
    v_sup := case when x -> 'supplierId' is null or jsonb_typeof(x -> 'supplierId') = 'null' or x ->> 'supplierId' = '' then null
                  else _uuid(x -> 'supplierId', 'Välj en giltig leverantör.') end;
    if x -> 'id' is not null and jsonb_typeof(x -> 'id') <> 'null' then
      v_id := _uuid(x -> 'id', 'Välj en giltig vara.');
      update stock_items set
        name = _text(x -> 'name', 2, 80, 'Skriv ett namn på varan.'),
        category = _text(coalesce(x -> 'category', '"Råvaror"'), 1, 40, 'Ogiltig kategori.'),
        unit = _text(coalesce(x -> 'unit', '"st"'), 1, 12, 'Ogiltig enhet.'),
        supplier_id = v_sup,
        min_level = _qty(coalesce(x -> 'minLevel', '0'), 'Ogiltig miniminivå.'),
        order_qty = _qty(coalesce(x -> 'orderQty', '0'), 'Ogiltig beställningsmängd.'),
        unit_cost = case when x -> 'unitCost' is null or jsonb_typeof(x -> 'unitCost') = 'null' then null else _qty(x -> 'unitCost', 'Ogiltigt pris.') end,
        active = case when x -> 'active' is null then active else _bool(x -> 'active', 'Välj aktiv eller inte.') end,
        updated_at = now()
      where id = v_id returning * into i;
      if not found then perform _fail(404, 'Varan finns inte.'); end if;
    else
      insert into stock_items (name, category, unit, supplier_id, min_level, order_qty, unit_cost, on_hand, counted_at, counted_by, sort_order)
      values (_text(x -> 'name', 2, 80, 'Skriv ett namn på varan.'),
              _text(coalesce(x -> 'category', '"Råvaror"'), 1, 40, 'Ogiltig kategori.'),
              _text(coalesce(x -> 'unit', '"st"'), 1, 12, 'Ogiltig enhet.'),
              v_sup,
              _qty(coalesce(x -> 'minLevel', '0'), 'Ogiltig miniminivå.'),
              _qty(coalesce(x -> 'orderQty', '0'), 'Ogiltig beställningsmängd.'),
              case when x -> 'unitCost' is null or jsonb_typeof(x -> 'unitCost') = 'null' then null else _qty(x -> 'unitCost', 'Ogiltigt pris.') end,
              _qty(coalesce(x -> 'onHand', '0'), 'Ogiltigt antal i lager.'), now(), a.name,
              coalesce((select max(sort_order) + 10 from stock_items), 10))
      returning * into i;
    end if;
    perform _audit(_local_date(now()), a.name, 'stock_item_saved', i.id::text, jsonb_build_object('name', i.name, 'active', i.active));

  elsif v_action = 'save_supplier' then
    x := p -> 'supplier';
    if x ->> 'email' is not null and btrim(x ->> 'email') <> '' and x ->> 'email' !~* '^[^\s@]+@[^\s@]+\.[a-z]{2,}$' then
      perform _fail(400, 'Skriv en giltig e-postadress till leverantören.');
    end if;
    if x -> 'id' is not null and jsonb_typeof(x -> 'id') <> 'null' then
      update suppliers set name = _text(x -> 'name', 2, 80, 'Skriv leverantörens namn.'),
        contact = coalesce(btrim(x ->> 'contact'), ''), email = lower(coalesce(btrim(x ->> 'email'), '')),
        phone = coalesce(btrim(x ->> 'phone'), ''), notes = left(coalesce(btrim(x ->> 'notes'), ''), 500),
        active = case when x -> 'active' is null then active else _bool(x -> 'active', 'Välj aktiv eller inte.') end, updated_at = now()
      where id = _uuid(x -> 'id', 'Välj en giltig leverantör.');
      if not found then perform _fail(404, 'Leverantören finns inte.'); end if;
    else
      insert into suppliers (name, contact, email, phone, notes) values (_text(x -> 'name', 2, 80, 'Skriv leverantörens namn.'),
        coalesce(btrim(x ->> 'contact'), ''), lower(coalesce(btrim(x ->> 'email'), '')), coalesce(btrim(x ->> 'phone'), ''), left(coalesce(btrim(x ->> 'notes'), ''), 500));
    end if;
    perform _audit(_local_date(now()), a.name, 'supplier_saved', 'suppliers', jsonb_build_object('name', x ->> 'name'));
  elsif v_action <> 'list' then
    perform _fail(400, 'Välj en giltig åtgärd.');
  end if;
  return _stock_json(a);
end $$;

-- ---------------------------------------------------------------------
-- Inköp
-- ---------------------------------------------------------------------
create or replace function _orders_json(a staff) returns jsonb
language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', o.id, 'number', o.number, 'status', o.status, 'note', o.note,
      'supplierId', o.supplier_id, 'supplierName', coalesce(s.name, 'Utan leverantör'),
      'supplierEmail', case when _is_admin(a) then s.email end,
      'supplierContact', case when _is_admin(a) then s.contact end,
      'createdAt', o.created_at, 'createdBy', o.created_by, 'sentAt', o.sent_at, 'sentBy', o.sent_by,
      'receivedAt', o.received_at, 'receivedBy', o.received_by,
      'lines', (select coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'itemId', l.item_id, 'name', i.name, 'unit', i.unit,
                  'qty', l.qty, 'receivedQty', l.received_qty, 'unitCost', case when _is_admin(a) then l.unit_cost end) order by i.name), '[]')
                from purchase_order_lines l join stock_items i on i.id = l.item_id where l.order_id = o.id))
    order by case o.status when 'draft' then 0 when 'sent' then 1 else 2 end, o.created_at desc), '[]')
  from purchase_orders o left join suppliers s on s.id = o.supplier_id
  where (o.status in ('draft', 'sent') or o.created_at > now() - interval '60 days')
    and (_is_admin(a) or o.status in ('sent', 'received'))
$$;

create or replace function api_purchase(p jsonb) returns jsonb
language plpgsql as $$
declare
  a staff;
  v_action text := coalesce(p ->> 'action', 'list');
  o purchase_orders;
  r record;
  x jsonb;
  v_rec numeric;
  v_line purchase_order_lines;
  v_item stock_items;
  v_n int := 0;
begin
  if v_action in ('list', 'receive') then a := _actor(p, 'staff'); else a := _actor(p, 'admin'); end if;
  perform pg_advisory_xact_lock(hashtext('albert-stock'));

  if v_action = 'create_from_low' then
    -- En utkastbeställning per leverantör med allt som ligger under miniminivån och inte redan är beställt.
    for r in
      select i.supplier_id, array_agg(i.id) ids from stock_items i
      where i.active and i.min_level > 0 and i.on_hand <= i.min_level
        and not exists (select 1 from purchase_order_lines l join purchase_orders po on po.id = l.order_id
                        where l.item_id = i.id and po.status in ('draft', 'sent'))
      group by i.supplier_id
    loop
      insert into purchase_orders (supplier_id, created_by) values (r.supplier_id, a.name) returning * into o;
      insert into purchase_order_lines (order_id, item_id, qty, unit_cost)
        select o.id, i.id, greatest(case when i.order_qty > 0 then i.order_qty else i.min_level * 2 - i.on_hand end, 1), i.unit_cost
        from stock_items i where i.id = any (r.ids);
      v_n := v_n + 1;
    end loop;
    if v_n = 0 then perform _fail(409, 'Inget behöver beställas just nu, eller så är det redan beställt.'); end if;
    perform _audit(_local_date(now()), a.name, 'purchase_created', 'purchase', jsonb_build_object('orders', v_n));

  elsif v_action in ('save_lines', 'send', 'cancel', 'receive') then
    select * into o from purchase_orders where id = _uuid(p -> 'id', 'Välj en giltig beställning.');
    if not found then perform _fail(404, 'Beställningen finns inte.'); end if;

    if v_action = 'save_lines' then
      if o.status <> 'draft' then perform _fail(409, 'Bara utkast kan ändras.'); end if;
      for x in select * from jsonb_array_elements(coalesce(p -> 'lines', '[]')) loop
        if _qty(x -> 'qty') = 0 then
          perform _fail(400, 'Antal måste vara större än noll. Ta bort raden genom att makulera beställningen och skapa en ny.');
        end if;
        update purchase_order_lines set qty = _qty(x -> 'qty') where id = _uuid(x -> 'id', 'Ogiltig rad.') and order_id = o.id;
      end loop;
      update purchase_orders set note = left(coalesce(p ->> 'note', o.note), 500), updated_at = now() where id = o.id;

    elsif v_action = 'send' then
      if o.status <> 'draft' then perform _fail(409, 'Beställningen är redan skickad.'); end if;
      update purchase_orders set status = 'sent', sent_at = now(), sent_by = a.name, updated_at = now() where id = o.id;
      perform _audit(_local_date(now()), a.name, 'purchase_sent', o.id::text, jsonb_build_object('number', o.number));

    elsif v_action = 'cancel' then
      if o.status not in ('draft', 'sent') then perform _fail(409, 'Beställningen kan inte makuleras.'); end if;
      update purchase_orders set status = 'cancelled', updated_at = now() where id = o.id;
      perform _audit(_local_date(now()), a.name, 'purchase_cancelled', o.id::text, jsonb_build_object('number', o.number));

    else -- receive
      if o.status <> 'sent' then perform _fail(409, 'Bara skickade beställningar kan tas emot.'); end if;
      for v_line in select * from purchase_order_lines where order_id = o.id loop
        x := null;
        select value into x from jsonb_array_elements(coalesce(p -> 'lines', '[]')) value where value ->> 'id' = v_line.id::text;
        v_rec := case when x is null then v_line.qty else _qty(x -> 'receivedQty', 'Skriv hur mycket som kom.') end;
        update purchase_order_lines set received_qty = v_rec where id = v_line.id;
        if v_rec > 0 then
          select * into v_item from stock_items where id = v_line.item_id;
          update stock_items set on_hand = on_hand + v_rec, updated_at = now() where id = v_item.id;
          insert into stock_movements (item_id, kind, before_qty, after_qty, order_id, actor)
            values (v_item.id, 'delivery', v_item.on_hand, v_item.on_hand + v_rec, o.id, a.name);
        end if;
      end loop;
      update purchase_orders set status = 'received', received_at = now(), received_by = a.name, updated_at = now() where id = o.id;
      perform _audit(_local_date(now()), a.name, 'purchase_received', o.id::text, jsonb_build_object('number', o.number));
    end if;

  elsif v_action <> 'list' then
    perform _fail(400, 'Välj en giltig åtgärd.');
  end if;

  return jsonb_build_object('orders', _orders_json(a), 'stock', _stock_json(a));
end $$;

-- Exempelvaror så att listan inte är tom första gången. Ändra eller inaktivera fritt.
insert into stock_items (category, name, unit, min_level, order_qty, sort_order) values
  ('Råvaror', 'Vetemjöl tipo 00', 'kg', 25, 50, 10),
  ('Råvaror', 'San Marzano-tomater', 'burk', 6, 12, 20),
  ('Råvaror', 'Fior di latte', 'kg', 5, 10, 30),
  ('Råvaror', 'Pecorino', 'kg', 1, 2, 40),
  ('Råvaror', 'Basilika', 'kruka', 3, 6, 50),
  ('Råvaror', 'Olivolja extra vergine', 'l', 3, 6, 60),
  ('Råvaror', 'Salami piccante', 'kg', 1, 2, 70),
  ('Råvaror', 'Färsk jäst', 'förp', 2, 4, 80),
  ('Råvaror', 'Salt', 'kg', 2, 5, 90),
  ('Förbrukning', 'Pizzakartonger', 'st', 50, 200, 100),
  ('Förbrukning', 'Ved', 'säck', 5, 15, 110),
  ('Förbrukning', 'Servetter', 'förp', 2, 6, 120);

-- Samma behörighet som i 0001: bara servern får anropa funktionerna.
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
