import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.mjs';

let t, owner, staff;
before(async () => {
  t = setup();
  t.auth.addUser('albert@albertno485.com', 'hemligt-losen-1', 'Albert');
  owner = t.auth.tokenFor('albert@albertno485.com');
  await t.call('GET', '/api/admin/day', undefined, { token: owner });
  await t.call('POST', '/api/admin/staff', { action: 'create', name: 'Marco', email: 'marco@example.se', role: 'staff', password: 'tillfalligt-123' }, { token: owner });
  staff = t.auth.tokenFor('marco@example.se');
});
after(() => t.close());

test('lagret har exempelvaror och personal ser inga priser', async () => {
  const res = await t.call('GET', '/api/admin/stock', undefined, { token: staff });
  assert.equal(res.status, 200);
  assert.ok(res.body.items.length >= 10);
  assert.equal(res.body.isAdmin, false);
  assert.ok(res.body.items.every(i => i.unitCost === null));
});

test('admin lägger till leverantör och vara med pris, personal kan inte', async () => {
  const sup = await t.call('POST', '/api/admin/stock', { action: 'save_supplier', supplier: { name: 'Italgross', email: 'order@italgross.se', phone: '031-123' } }, { token: owner });
  assert.equal(sup.status, 200, JSON.stringify(sup.body));
  const supplierId = sup.body.suppliers.find(s => s.name === 'Italgross').id;
  const item = await t.call('POST', '/api/admin/stock', { action: 'save_item', item: { name: 'Mozzarella di bufala', unit: 'kg', category: 'Råvaror', supplierId, minLevel: 4, orderQty: 8, unitCost: 129.5, onHand: 2 } }, { token: owner });
  assert.equal(item.status, 200, JSON.stringify(item.body));
  const bufala = item.body.items.find(i => i.name === 'Mozzarella di bufala');
  assert.equal(bufala.low, true);
  assert.equal(bufala.unitCost, 129.5);
  assert.equal((await t.call('POST', '/api/admin/stock', { action: 'save_item', item: { name: 'Fusk', unit: 'st' } }, { token: staff })).status, 403);
});

test('inventering: personal räknar, varor under miniminivå markeras', async () => {
  const list = (await t.call('GET', '/api/admin/stock', undefined, { token: staff })).body.items;
  const flour = list.find(i => i.name === 'Vetemjöl tipo 00'), salt = list.find(i => i.name === 'Salt');
  const res = await t.call('POST', '/api/admin/stock', { action: 'count', counts: [{ id: flour.id, qty: 10 }, { id: salt.id, qty: 8 }] }, { token: staff });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.items.find(i => i.id === flour.id).low, true);
  assert.equal(res.body.items.find(i => i.id === salt.id).low, false);
  assert.equal(res.body.items.find(i => i.id === flour.id).countedBy, 'Marco');
  assert.equal((await t.call('POST', '/api/admin/stock', { action: 'count', counts: [{ id: flour.id, qty: -1 }] }, { token: staff })).status, 400);
});

test('inköp: beställningar skapas per leverantör, skickas och tas emot', async () => {
  assert.equal((await t.call('POST', '/api/admin/purchase', { action: 'create_from_low' }, { token: staff })).status, 403);
  const created = await t.call('POST', '/api/admin/purchase', { action: 'create_from_low' }, { token: owner });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const ital = created.body.orders.find(o => o.supplierName === 'Italgross');
  assert.ok(ital);
  assert.equal(ital.lines.length, 1);
  assert.equal(ital.lines[0].qty, 8);
  // En andra gång skapas inget nytt för samma varor.
  const again = await t.call('POST', '/api/admin/purchase', { action: 'create_from_low' }, { token: owner });
  assert.equal(again.status, 409);
  // Personal ser inte utkast.
  const staffView = await t.call('GET', '/api/admin/purchase', undefined, { token: staff });
  assert.ok(!staffView.body.orders.some(o => o.status === 'draft'));
  await t.call('POST', '/api/admin/purchase', { action: 'save_lines', id: ital.id, lines: [{ id: ital.lines[0].id, qty: 10 }] }, { token: owner });
  const sent = await t.call('POST', '/api/admin/purchase', { action: 'send', id: ital.id }, { token: owner });
  assert.equal(sent.body.orders.find(o => o.id === ital.id).status, 'sent');
  const received = await t.call('POST', '/api/admin/purchase', { action: 'receive', id: ital.id, lines: [{ id: ital.lines[0].id, receivedQty: 9 }] }, { token: staff });
  assert.equal(received.status, 200, JSON.stringify(received.body));
  const bufala = received.body.stock.items.find(i => i.name === 'Mozzarella di bufala');
  assert.equal(bufala.onHand, 11);
  assert.equal(bufala.low, false);
  assert.equal((await t.call('POST', '/api/admin/purchase', { action: 'receive', id: ital.id }, { token: staff })).status, 409);
});
