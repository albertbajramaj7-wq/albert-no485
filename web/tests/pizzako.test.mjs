import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, sql, bookingBody } from './helpers.mjs';

// Löpande kö: 2 minuter per pizza för både bokningar och drop-in.
let t, owner;
before(async () => {
  t = setup();
  sql(t.db, 'update settings set slot_min = 8, slot_cap = 4, sit_after_close = true, pizza_min = 2 where id = 1');
  t.auth.addUser('albert@albertno485.com', 'hemligt-losen-1', 'Albert');
  owner = t.auth.tokenFor('albert@albertno485.com');
  await t.call('GET', '/api/admin/day', undefined, { token: owner });
});
after(() => t.close());

const D = '2026-10-21';
const suggest = async (count) => (await t.call('POST', '/api/admin/dropin', { date: D, action: 'suggest', count, mode: 'away' }, { token: owner })).body;
const dropin = async (count) => (await t.call('POST', '/api/admin/dropin', { date: D, action: 'add', count, mode: 'away' }, { token: owner })).body;
const slot = async (time, count = 1) => (await t.call('GET', `/api/availability?date=${D}&count=${count}&mode=away&guests=0`)).body.slots.find(s => s.time === time);

test('tom kö: 3 pizzor klara om 6 minuter, 5 pizzor om 10', async () => {
  t.clock.now = D + 'T17:25:00+02:00';
  assert.equal((await suggest(3)).time, '17:31');
  assert.equal((await suggest(3)).waitMin, 6);
  assert.equal((await suggest(5)).time, '17:35');
});

test('drop-in läggs efter pizzorna som redan ligger i kön', async () => {
  t.clock.now = D + 'T17:25:00+02:00';
  const first = await dropin(3);           // 17:25–17:31
  assert.equal(first.dropins.at(-1).time, '17:31');
  const second = await dropin(5);          // 17:31–17:41
  assert.equal(second.dropins.find(d => d.count === 5).time, '17:41');
  assert.equal((await suggest(1)).time, '17:43');
});

test('bokning på hemsidan: kön före färdigtiden avgör hur många som ryms', async () => {
  // Färdigtid 17:49: kön är upptagen till 17:41 → 8 minuter = 4 pizzor
  t.clock.now = D + 'T10:00:00+02:00';
  assert.equal((await slot('17:49')).remaining, 4);
  const b = await t.call('POST', '/api/bookings', bookingBody({ time: '17:49', count: 5, mode: 'away', guests: 0 }), { headers: { 'Idempotency-Key': crypto.randomUUID() } });
  assert.equal(b.status, 409);
  const ok = await t.call('POST', '/api/bookings', bookingBody({ time: '17:49', count: 4, mode: 'away', guests: 0 }), { headers: { 'Idempotency-Key': crypto.randomUUID() } });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
});

test('drop-in får tid efter en bokning som ligger i vägen', async () => {
  t.clock.now = D + 'T10:00:00+02:00';
  // Bokning 18:05 med 4 pizzor → kön 17:57–18:05
  const b = await t.call('POST', '/api/bookings', bookingBody({ time: '18:05', count: 4, mode: 'away', guests: 0 }), { headers: { 'Idempotency-Key': crypto.randomUUID() } });
  assert.equal(b.status, 201, JSON.stringify(b.body));
  t.clock.now = D + 'T17:50:00+02:00';
  assert.equal((await suggest(3)).time, '17:56');   // 17:50–17:56 ryms före bokningen
  assert.equal((await suggest(4)).time, '18:13');   // 8 min ryms inte → direkt efter bokningen
});

test('i dag räknas bara tid från och med nu', async () => {
  t.clock.now = D + 'T18:20:00+02:00';
  // 18:29 som färdigtid, ankomst 18:24 > nu. Från 18:20 till 18:29 = 9 min → 4 pizzor
  assert.equal((await slot('18:29')).remaining, 4);
});

test('inställningen 0 går tillbaka till tidsluckor', async () => {
  sql(t.db, 'update settings set pizza_min = null where id = 1');
  t.clock.now = D + 'T10:00:00+02:00';
  assert.equal((await slot('20:53')).remaining, 8);   // tidsluckor: 4 + 4 i luckan före
  sql(t.db, 'update settings set pizza_min = 2 where id = 1');
});
