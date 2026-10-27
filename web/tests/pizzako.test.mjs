import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, sql, bookingBody } from './helpers.mjs';

// Löpande kö: 2 minuter per pizza för både bokningar och drop-in.
let t, owner;
before(async () => {
  t = setup();
  sql(t.db, 'update settings set slot_min = 8, slot_cap = 4, sit_after_close = true, pizza_min = 2, pizza_sec = 120 where id = 1');
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
  sql(t.db, 'update settings set pizza_min = null, pizza_sec = null where id = 1');
  t.clock.now = D + 'T10:00:00+02:00';
  assert.equal((await slot('20:53')).remaining, 8);   // tidsluckor: 4 + 4 i luckan före
  sql(t.db, 'update settings set pizza_min = 2, pizza_sec = 120 where id = 1');
});

test('2,5 minuter per pizza: färdigtiden avrundas uppåt till hel minut', async () => {
  const day = '2026-10-28';
  const r = await t.call('POST', '/api/admin/config', { action: 'save', settings: { ...(await cfg()), pizzaMin: '2,5' } }, { token: owner });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.pizza_sec, 150);
  t.clock.now = day + 'T17:25:00+01:00'; // vintertid
  const sg = async n => (await t.call('POST', '/api/admin/dropin', { date: day, action: 'suggest', count: n, mode: 'away' }, { token: owner })).body.time;
  assert.equal(await sg(2), '17:30');   // 5 min
  assert.equal(await sg(3), '17:33');   // 7,5 min → 17:33
  assert.equal((await t.call('POST', '/api/admin/config', { action: 'save', settings: { ...(await cfg()), pizzaMin: 0.2 } }, { token: owner })).status, 400);
});

async function cfg() {
  const c = (await t.call('GET', '/api/admin/config', undefined, { token: owner })).body;
  return { version: c.version, openWeekdays: c.open_weekdays, slotCap: c.slot_cap, slotMin: c.slot_min, hourCap: c.hour_cap, seats: c.seats, sittingMin: c.sitting_min,
    arrivalMin: c.arrival_min, horizonDays: c.horizon_days, maxCount: c.max_count, maxGuests: c.max_guests, lunchFirst: c.lunch_first, lunchLast: c.lunch_last,
    dinnerFirst: c.dinner_first, dinnerLast: c.dinner_last, avgPizzaPrice: c.avg_pizza_price, wasteCost: c.waste_cost };
}

test('bokning: kunden får tiden när sista pizzan är klar, flyttas fram om kön är upptagen', async () => {
  const day = '2026-11-04'; // onsdag, vintertid
  sql(t.db, 'update settings set pizza_min = 3, pizza_sec = 150, arrival_min = 10 where id = 1');
  t.clock.now = '2026-11-01T10:00:00+01:00';
  const slots = async n => (await t.call('GET', `/api/availability?date=${day}&count=${n}&mode=away&guests=0`)).body.slots;
  // Ledig kö: samma tider som förut, t.ex. 18:13
  assert.ok((await slots(4)).some(s => s.time === '18:13' && s.bookable));
  const a = await t.call('POST', '/api/bookings', bookingBody({ date: day, time: '18:13', count: 4, mode: 'away', guests: 0 }), { headers: { 'Idempotency-Key': crypto.randomUUID() } });
  assert.equal(a.status, 201, JSON.stringify(a.body));        // kön 18:03–18:13
  assert.equal(a.body.arrival, '18:03');                       // kom 10 min före
  // Nästa kund vill också ha 4 pizzor runt 18:13 → får 18:23 (4 × 2,5 min efter förra)
  const s2 = await slots(4);
  assert.ok(!s2.some(s => s.time === '18:13' && s.bookable));
  assert.ok(s2.some(s => s.time === '18:23' && s.bookable), JSON.stringify(s2.filter(s => s.time > '18:00' && s.time < '18:40')));
  const b = await t.call('POST', '/api/bookings', bookingBody({ date: day, time: '18:23', count: 4, mode: 'away', guests: 0 }), { headers: { 'Idempotency-Key': crypto.randomUUID() } });
  assert.equal(b.status, 201, JSON.stringify(b.body));
  sql(t.db, 'update settings set pizza_min = 2, pizza_sec = 120 where id = 1');
});
