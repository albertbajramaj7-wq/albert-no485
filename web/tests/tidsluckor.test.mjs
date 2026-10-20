import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, sql, bookingBody } from './helpers.mjs';

// Ugnen: 4 pizzor var 8:e minut, gäster får sitta kvar efter stängning (inställningen från 0005).
let t;
before(() => {
  t = setup();
  sql(t.db, 'update settings set slot_min = 8, slot_cap = 4, sit_after_close = true where id = 1');
});
after(() => t.close());

const slots = async (count, mode = 'away', guests = 0) => (await t.call('GET', `/api/availability?date=2026-10-21&count=${count}&mode=${mode}&guests=${guests}`)).body;

test('tider var 8:e minut, sista tiden får bokas för att äta här', async () => {
  const av = await slots(2, 'here', 2);
  assert.equal(av.slotMin, 8);
  const times = av.slots.map(s => s.time);
  assert.deepEqual(times.slice(0, 3), ['12:15', '12:23', '12:31']);
  assert.ok(times.includes('16:53') && times.includes('20:53'));
  assert.equal(av.slots.find(s => s.time === '20:53').bookable, true); // sittningen går förbi stängning
});

test('4 pizzor per lucka, större beställning bakas i luckan före', async () => {
  const four = await t.call('POST', '/api/bookings', bookingBody({ time: '18:13', count: 4, mode: 'away', guests: 0 }), { headers: { 'Idempotency-Key': crypto.randomUUID() } });
  assert.equal(four.status, 201, JSON.stringify(four.body));
  let av = await slots(1);
  assert.equal(av.slots.find(s => s.time === '18:13').bookable, false); // luckan full
  assert.equal(av.slots.find(s => s.time === '18:21').bookable, true);
  // 6 pizzor kl 18:29 → 4 i 18:29 och 2 i 18:21
  const six = await t.call('POST', '/api/bookings', bookingBody({ time: '18:29', count: 6, mode: 'away', guests: 0, contact: { name: 'Bo Ek', email: 'bo@example.se', phone: '070-111 22 33' } }), { headers: { 'Idempotency-Key': crypto.randomUUID() } });
  assert.equal(six.status, 201, JSON.stringify(six.body));
  av = await slots(3);
  assert.equal(av.slots.find(s => s.time === '18:21').bookable, false); // bara 2 kvar i 18:21
  assert.equal((await slots(2)).slots.find(s => s.time === '18:21').bookable, true);
  // 5 pizzor kl 18:21 skulle behöva 18:13 som är full
  assert.equal((await slots(5)).slots.find(s => s.time === '18:21').bookable, false);
});
