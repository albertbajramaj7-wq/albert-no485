import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, sql, bookingBody } from './helpers.mjs';

// Drop-in får första lediga ugnstid och tar plats precis som en bokning.
let t, owner;
before(async () => {
  t = setup();
  sql(t.db, 'update settings set slot_min = 8, slot_cap = 4, sit_after_close = true, pizza_min = null where id = 1');
  t.auth.addUser('albert@albertno485.com', 'hemligt-losen-1', 'Albert');
  owner = t.auth.tokenFor('albert@albertno485.com');
  await t.call('GET', '/api/admin/day', undefined, { token: owner });
});
after(() => t.close());

const slot = async (time, count) => (await t.call('GET', `/api/availability?date=2026-10-21&count=${count}&mode=away&guests=0`)).body.slots.find(s => s.time === time);

test('drop-in får tid efter bokningen och minskar lediga tider på hemsidan', async () => {
  const b = await t.call('POST', '/api/bookings', bookingBody({ time: '18:13', count: 4, mode: 'away', guests: 0 }), { headers: { 'Idempotency-Key': crypto.randomUUID() } });
  assert.equal(b.status, 201, JSON.stringify(b.body));
  t.clock.now = '2026-10-21T18:06:00+02:00';

  const s = await t.call('POST', '/api/admin/dropin', { date: '2026-10-21', action: 'suggest', count: 2, mode: 'here', guests: 2 }, { token: owner });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  assert.equal(s.body.time, '18:21'); // 18:13 är fullbokad
  assert.equal(s.body.waitMin, 15);
  assert.equal(s.body.seatsOk, true);

  assert.equal((await slot('18:21', 3)).remaining, 4);
  const add = await t.call('POST', '/api/admin/dropin', { date: '2026-10-21', action: 'add', count: 2, mode: 'here', guests: 2 }, { token: owner });
  assert.equal(add.status, 200, JSON.stringify(add.body));
  assert.equal(add.body.dropins.length, 1);
  assert.equal(add.body.dropins[0].time, '18:21');
  assert.equal(add.body.day.dropin, 2); // räknaren följer med
  assert.equal((await slot('18:21', 3)).remaining, 2); // hemsidan ser bara 2 kvar

  // Nästa drop-in med 3 pizzor får inte plats 18:21 → 18:29
  const next = await t.call('POST', '/api/admin/dropin', { date: '2026-10-21', action: 'add', count: 3, mode: 'away' }, { token: owner });
  assert.equal(next.body.dropins.find(d => d.count === 3).time, '18:29');

  // Ångra den första → platsen blir ledig igen
  const id = add.body.dropins[0].id;
  const voided = await t.call('POST', '/api/admin/dropin', { date: '2026-10-21', action: 'void', id }, { token: owner });
  assert.equal(voided.status, 200, JSON.stringify(voided.body));
  assert.equal(voided.body.day.dropin, 3);
  assert.equal((await slot('18:21', 3)).remaining, 4);
  assert.equal((await t.call('POST', '/api/admin/dropin', { date: '2026-10-21', action: 'void', id }, { token: owner })).status, 409);
});

test('bokning på hemsidan kan inte ta en lucka som drop-in redan fyllt', async () => {
  t.clock.now = '2026-10-21T19:00:00+02:00';
  const add = await t.call('POST', '/api/admin/dropin', { date: '2026-10-21', action: 'add', count: 4, mode: 'away' }, { token: owner });
  const time = add.body.dropins.find(d => d.count === 4 && d.time > '19:00').time;
  t.clock.now = '2026-10-21T10:00:00+02:00';
  const b = await t.call('POST', '/api/bookings', bookingBody({ time, count: 1, mode: 'away', guests: 0 }), { headers: { 'Idempotency-Key': crypto.randomUUID() } });
  assert.equal(b.status, 409);
});
