import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, sql } from './helpers.mjs';

// Tävlingslistan: publik läsning, ändringar i admin och den automatiska uppdateringen.
let t, owner, staff;
before(async () => {
  t = setup();
  t.auth.addUser('albert@albertno485.com', 'hemligt-losen-1', 'Albert');
  owner = t.auth.tokenFor('albert@albertno485.com');
  await t.call('GET', '/api/admin/day', undefined, { token: owner });
  const created = await t.call('POST', '/api/admin/staff', { action: 'create', email: 'personal@albertno485.com', name: 'Personal', role: 'staff', password: 'tillfalligt-123' }, { token: owner });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  staff = t.auth.tokenFor('personal@albertno485.com');
});
after(() => t.close());

const sync = entries => t.rpc('api_giveaway_sync', { entries });
const admin = (body, token = owner) => t.call('POST', '/api/admin/giveaway', body, { token });
const publicList = async () => (await t.call('GET', '/api/giveaway')).body;

test('listan är dold tills den slås på, och visar då bara namn och status', async () => {
  const added = await sync([{ u: 'Anna.A', ok: true }, { u: '@bertil_b', ok: false }]);
  assert.deepEqual({ added: added.added, total: added.total }, { added: 2, total: 2 });

  let list = await publicList();
  assert.equal(list.published, false);
  assert.deepEqual(list.entries, []);

  const on = await admin({ action: 'publish', published: true });
  assert.equal(on.status, 200, JSON.stringify(on.body));
  const response = await t.call('GET', '/api/giveaway');
  assert.equal(response.headers.get('cache-control'), 'public, max-age=60');
  list = response.body;
  assert.equal(list.published, true);
  assert.deepEqual(list.entries, [{ u: 'anna.a', ok: true }, { u: 'bertil_b', ok: false }]);
  assert.ok(list.updatedAt);
});

test('admin kräver inloggning, och bara administratörer får ändra', async () => {
  assert.equal((await t.call('GET', '/api/admin/giveaway')).status, 401);
  assert.equal((await t.call('POST', '/api/admin/giveaway', { action: 'set', username: 'anna.a', approved: false })).status, 401);

  const read = await t.call('GET', '/api/admin/giveaway', undefined, { token: staff });
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.equal(read.body.entries.length, 2);
  assert.equal((await admin({ action: 'set', username: 'anna.a', approved: false }, staff)).status, 403);
  assert.equal((await admin({ action: 'publish', published: false }, staff)).status, 403);
  assert.equal((await publicList()).entries[0].ok, true); // inget ändrades
});

test('ändringar för hand skrivs inte över av den automatiska uppdateringen', async () => {
  const set = await admin({ action: 'set', username: '@Bertil_B', approved: true });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  const row = set.body.entries.find(e => e.u === 'bertil_b');
  assert.deepEqual({ ok: row.ok, manual: row.manual, by: row.updatedBy }, { ok: true, manual: true, by: 'Albert' });

  const result = await sync([{ u: 'bertil_b', ok: false }, { u: 'anna.a', ok: false }, { u: 'cecilia', ok: true }]);
  assert.deepEqual(result, { added: 1, changed: 1, total: 3 });
  assert.deepEqual((await publicList()).entries, [{ u: 'anna.a', ok: false }, { u: 'bertil_b', ok: true }, { u: 'cecilia', ok: true }]);
});

test('ta bort döljer namnet utan att radera, och det läggs inte tillbaka automatiskt', async () => {
  const removed = await admin({ action: 'remove', username: 'cecilia' });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal(removed.body.entries.find(e => e.u === 'cecilia').hidden, true);
  assert.deepEqual((await publicList()).entries.map(e => e.u), ['anna.a', 'bertil_b']);

  const again = await sync([{ u: 'cecilia', ok: true }]);
  assert.deepEqual(again, { added: 0, changed: 0, total: 2 });
  assert.deepEqual((await publicList()).entries.map(e => e.u), ['anna.a', 'bertil_b']);
  assert.equal(sql(t.db, "select count(*) from giveaway_entries where username = 'cecilia'"), '1');

  const back = await admin({ action: 'restore', username: 'cecilia' });
  assert.equal(back.status, 200, JSON.stringify(back.body));
  assert.deepEqual((await publicList()).entries.map(e => e.u), ['anna.a', 'bertil_b', 'cecilia']);
});

test('lägga till för hand, och ogiltiga värden stoppas', async () => {
  const add = await admin({ action: 'add', username: 'david.d', approved: false });
  assert.equal(add.status, 200, JSON.stringify(add.body));
  assert.equal((await admin({ action: 'add', username: 'david.d', approved: true })).status, 409);
  assert.equal((await admin({ action: 'add', username: 'har mellanslag', approved: true })).status, 400);
  assert.equal((await admin({ action: 'add', username: 'x'.repeat(31), approved: true })).status, 400);
  assert.equal((await admin({ action: 'add', username: "a'; drop table giveaway_entries; --", approved: true })).status, 400);
  assert.equal((await admin({ action: 'set', username: 'finns_inte', approved: true })).status, 404);
  assert.equal((await admin({ action: 'set', username: 'david.d', approved: 'ja' })).status, 400);
  assert.equal((await admin({ action: 'radera_allt' })).status, 400);
  await assert.rejects(sync([{ u: 'ok_namn', ok: 'kanske' }]), /Ogiltig status/);
  await assert.rejects(sync('inte en lista'), /Ogiltig lista/);
  assert.equal(sql(t.db, 'select count(*) from giveaway_entries'), '4');
});

test('publika roller kommer inte åt tabellerna eller funktionerna', async () => {
  assert.equal(sql(t.db, "select bool_and(relrowsecurity) from pg_class where relname in ('giveaway_entries', 'giveaway_state')"), 't');
  assert.equal(sql(t.db, "select has_function_privilege('anon', 'api_giveaway_sync(jsonb)', 'execute') or has_function_privilege('anon', 'api_admin_giveaway(jsonb)', 'execute') or has_function_privilege('anon', 'api_giveaway(jsonb)', 'execute')"), 'f');
  assert.equal(sql(t.db, "select has_table_privilege('anon', 'giveaway_entries', 'select')"), 'f');
});
