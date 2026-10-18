import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, bookingBody, sql } from './helpers.mjs';

let t;
before(() => { t = setup(); });
after(() => t.close());

const key = () => ({ headers: { 'Idempotency-Key': crypto.randomUUID() } });
async function book(over, opts = key()) { return t.call('POST', '/api/bookings', bookingBody(over), opts); }
function owner() {
  if (!t.auth.users.has('albert@albertno485.com')) t.auth.addUser('albert@albertno485.com', 'hemligt-losen-1', 'Albert');
  return t.auth.tokenFor('albert@albertno485.com');
}

test('stängt måndag och tisdag, öppet onsdag', async () => {
  const mon = await t.call('GET', '/api/availability?date=2026-10-19&count=1&mode=away');
  assert.equal(mon.body.closed, true);
  const wed = await t.call('GET', '/api/availability?date=2026-10-21&count=1&mode=away');
  assert.equal(wed.body.closed, false);
  assert.equal(wed.body.slots[0].time, '12:15');
  assert.equal(wed.body.slots.at(-1).time, '21:00');
});

test('bokning sparas och samma referens ger samma bokning', async () => {
  const opts = key();
  const first = await book({}, opts);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.body.arrival, '17:50');
  assert.equal(first.body.sittingEnd, '18:50');
  const again = await book({}, opts);
  assert.equal(again.body.id, first.body.id);
  const other = await book({ count: 3 }, opts);
  assert.equal(other.status, 409);
});

test('ogiltiga uppgifter stoppas', async () => {
  assert.equal((await book({ contact: { name: 'A', email: 'a@b.se', phone: '0701234567' } })).status, 400);
  assert.equal((await book({ contact: { name: 'Anna', email: 'inte-en-adress', phone: '0701234567' } })).status, 400);
  assert.equal((await book({ count: 9 })).status, 400);
  assert.equal((await book({ accepted: false })).status, 400);
  assert.equal((await book({ date: '2026-12-31' })).status, 400); // mer än 30 dagar fram
});

test('högst 8 pizzor per kvart, även vid samtidiga bokningar', async () => {
  const results = await Promise.all(Array.from({ length: 5 }, () => book({ date: '2026-10-22', time: '12:30', count: 3, mode: 'away', guests: 0 })));
  const ok = results.filter(r => r.status === 201).length;
  assert.equal(ok, 2, results.map(r => r.status).join(','));
  assert.ok(results.filter(r => r.status === 409).length === 3);
});

test('sittplatser räcker inte för överlappande sällskap', async () => {
  // 31 platser: fyra bokningar med 8 gäster överlappar, den fjärde ska nekas.
  const results = [];
  for (const time of ['17:00', '17:15', '17:30', '17:45']) results.push(await book({ date: '2026-10-23', time, count: 1, guests: 8 }));
  assert.deepEqual(results.map(r => r.status), [201, 201, 201, 409]);
});

test('högst 31 pizzor per rullande timme', async () => {
  const statuses = [];
  for (const time of ['19:00', '19:15', '19:30', '19:45']) statuses.push((await book({ date: '2026-10-24', time, count: 8, mode: 'away', guests: 0 })).status);
  assert.deepEqual(statuses, [201, 201, 201, 409]);
});

test('passerade tider kan inte bokas i dag', async () => {
  t.clock.now = '2026-10-18T13:00:00+02:00';
  const av = await t.call('GET', '/api/availability?date=2026-10-18&count=1&mode=away');
  assert.equal(av.body.slots.find(s => s.time === '12:45').bookable, false);
  assert.equal(av.body.slots.find(s => s.time === '13:15').bookable, true);
  t.clock.now = '2026-10-18T10:00:00+02:00';
});

test('admin kräver inloggning och rätt konto', async () => {
  assert.equal((await t.call('GET', '/api/admin/day')).status, 401);
  t.auth.addUser('okand@example.se', 'losenord-123', 'Okänd');
  assert.equal((await t.call('GET', '/api/admin/day', undefined, { token: t.auth.tokenFor('okand@example.se') })).status, 403);
  const day = await t.call('GET', '/api/admin/day?date=2026-10-21', undefined, { token: owner() });
  assert.equal(day.status, 200);
  assert.equal(day.body.actor.role, 'owner');
  assert.ok(day.body.bookings.length >= 1);
});

test('inloggning sätter säkra cookies', async () => {
  owner();
  const res = await t.call('POST', '/api/auth/login', { email: 'albert@albertno485.com', password: 'hemligt-losen-1' });
  assert.equal(res.status, 200);
  const set = res.headers.get('set-cookie');
  assert.match(set, /alb_at=.*HttpOnly; SameSite=Strict/);
  assert.match(set, /Secure/);
  const bad = await t.call('POST', '/api/auth/login', { email: 'albert@albertno485.com', password: 'fel' });
  assert.equal(bad.status, 401);
});

test('anrop från annan webbplats stoppas', async () => {
  const res = await t.call('POST', '/api/bookings', bookingBody(), { headers: { Origin: 'https://evil.example', 'Idempotency-Key': crypto.randomUUID() } });
  assert.equal(res.status, 403);
});

test('check-in, avslut och avbokning följer rätt ordning och frigör plats', async () => {
  const token = owner();
  const b = await book({ date: '2026-10-25', time: '12:15', count: 8, mode: 'away', guests: 0 });
  assert.equal(b.status, 201);
  const full = await t.call('GET', '/api/availability?date=2026-10-25&count=1&mode=away');
  assert.equal(full.body.slots[0].bookable, false);
  assert.equal((await t.call('POST', '/api/admin/booking', { id: b.body.id, action: 'finish' }, { token })).status, 409);
  assert.equal((await t.call('POST', '/api/admin/booking', { id: b.body.id, action: 'cancel' }, { token })).status, 400); // anledning krävs
  const cancelled = await t.call('POST', '/api/admin/booking', { id: b.body.id, action: 'cancel', reason: 'Gästen ringde' }, { token });
  assert.equal(cancelled.status, 200);
  const free = await t.call('GET', '/api/availability?date=2026-10-25&count=1&mode=away');
  assert.equal(free.body.slots[0].bookable, true);
});

test('dagens pizzantal begränsar bokningar och drop-in räknas av', async () => {
  const token = owner();
  const day = await t.call('GET', '/api/admin/day?date=2026-10-28', undefined, { token });
  const saved = await t.call('POST', '/api/admin/settings', { date: '2026-10-28', prepared: 5, paused: false, allowAfterClosing: false, version: day.body.day.version }, { token });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  await t.call('POST', '/api/admin/counter', { date: '2026-10-28', field: 'dropin', delta: 1 }, { token });
  const av = await t.call('GET', '/api/availability?date=2026-10-28&count=4&mode=away');
  assert.equal(av.body.dailyRemaining, 4);
  assert.equal((await book({ date: '2026-10-28', time: '12:15', count: 5, mode: 'away', guests: 0 })).status, 409);
  assert.equal((await book({ date: '2026-10-28', time: '12:15', count: 4, mode: 'away', guests: 0 })).status, 201);
  const stale = await t.call('POST', '/api/admin/settings', { date: '2026-10-28', prepared: 50, paused: false, allowAfterClosing: false, version: day.body.day.version }, { token });
  assert.equal(stale.status, 409);
});

test('svinn med orsak räknas, kan makuleras och syns i statistiken', async () => {
  const token = owner();
  const reg = await t.call('POST', '/api/admin/waste', { date: '2026-10-18', item: 'Margherita', qty: 2, reason: 'burnt', note: 'För het ugn' }, { token });
  assert.equal(reg.status, 200, JSON.stringify(reg.body));
  assert.equal(reg.body.day.waste, 2);
  await t.call('POST', '/api/admin/waste', { date: '2026-10-18', item: 'Diavola', qty: 1, reason: 'dropped' }, { token });
  const id = reg.body.waste[0].id;
  const voided = await t.call('POST', '/api/admin/waste', { date: '2026-10-18', action: 'void', id }, { token });
  assert.equal(voided.body.day.waste, 1);
  assert.equal((await t.call('POST', '/api/admin/waste', { date: '2026-10-18', action: 'void', id }, { token })).status, 409);
  assert.equal((await t.call('POST', '/api/admin/waste', { date: '2026-10-18', item: 'X', qty: 1, reason: 'ufo' }, { token })).status, 400);
  const stats = await t.call('GET', '/api/admin/stats?from=2026-10-12&to=2026-10-18', undefined, { token });
  assert.equal(stats.status, 200);
  assert.equal(stats.body.days.length, 7);
  assert.deepEqual(stats.body.wasteByReason, { dropped: 1 });
});

test('stängt datum stoppar bokning', async () => {
  const token = owner();
  const res = await t.call('POST', '/api/admin/config', { action: 'close_date', date: '2026-11-01', reason: 'Privat evenemang' }, { token });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const av = await t.call('GET', '/api/availability?date=2026-11-01&count=1&mode=away');
  assert.equal(av.body.closed, true);
  assert.equal((await book({ date: '2026-11-01', time: '12:15', mode: 'away', guests: 0 })).status, 409);
  await t.call('POST', '/api/admin/config', { action: 'reopen_date', date: '2026-11-01' }, { token });
  assert.equal((await t.call('GET', '/api/availability?date=2026-11-01&count=1&mode=away')).body.closed, false);
});

test('inställningar ändrar kapaciteten och skyddas mot samtidiga ändringar', async () => {
  const token = owner();
  const cfg = await t.call('GET', '/api/admin/config', undefined, { token });
  const v = cfg.body;
  const settings = { version: v.version, slotCap: 4, hourCap: v.hour_cap, seats: v.seats, sittingMin: v.sitting_min, arrivalMin: v.arrival_min,
    horizonDays: v.horizon_days, maxCount: v.max_count, maxGuests: v.max_guests, openWeekdays: v.open_weekdays, lunchFirst: v.lunch_first,
    lunchLast: v.lunch_last, dinnerFirst: v.dinner_first, dinnerLast: v.dinner_last, avgPizzaPrice: v.avg_pizza_price, wasteCost: v.waste_cost };
  const saved = await t.call('POST', '/api/admin/config', { action: 'save', settings }, { token });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const av = await t.call('GET', '/api/availability?date=2026-11-04&count=1&mode=away');
  assert.equal(av.body.slots[0].remaining, 4);
  assert.equal((await t.call('POST', '/api/admin/config', { action: 'save', settings }, { token })).status, 409);
  const bad = await t.call('POST', '/api/admin/config', { action: 'save', settings: { ...settings, version: saved.body.version, lunchLast: 1100 } }, { token });
  assert.equal(bad.status, 400);
  // Återställ till 8 för övriga tester.
  await t.call('POST', '/api/admin/config', { action: 'save', settings: { ...settings, version: saved.body.version, slotCap: 8 } }, { token });
});

test('menyn: bara synliga rätter visas publikt och admin kan ändra', async () => {
  const token = owner();
  const menu = await t.call('GET', '/api/admin/menu', undefined, { token });
  const marinara = menu.body.find(m => m.name === 'Marinara');
  const saved = await t.call('POST', '/api/admin/menu', { item: { id: marinara.id, name: 'Marinara', description: marinara.description, price: 149, active: false } }, { token });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const pub = await t.call('GET', '/api/menu');
  assert.ok(!pub.body.some(m => m.name === 'Marinara'));
  assert.equal(pub.body.length, 6);
});

test('roller: personal ser dagen men inte statistik, meny, inställningar eller personal', async () => {
  const token = owner();
  const created = await t.call('POST', '/api/admin/staff', { action: 'create', name: 'Marco Ricci', email: 'marco@example.se', title: 'Pizzaiolo', role: 'staff', password: 'tillfalligt-123' }, { token });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const staffToken = t.auth.tokenFor('marco@example.se');
  assert.equal((await t.call('GET', '/api/admin/day?date=2026-10-21', undefined, { token: staffToken })).status, 200);
  for (const path of ['/api/admin/stats', '/api/admin/staff']) assert.equal((await t.call('GET', path, undefined, { token: staffToken })).status, 403, path);
  assert.equal((await t.call('POST', '/api/admin/menu', { item: { name: 'Ny', price: 100, active: true } }, { token: staffToken })).status, 403);
  assert.equal((await t.call('POST', '/api/admin/config', { action: 'close_date', date: '2026-11-08' }, { token: staffToken })).status, 403);
  const day = await t.call('GET', '/api/admin/day?date=2026-10-29', undefined, { token: staffToken });
  assert.equal((await t.call('POST', '/api/admin/settings', { date: '2026-10-29', prepared: null, paused: true, allowAfterClosing: false, version: day.body.day.version }, { token: staffToken })).status, 403);
  assert.equal((await t.call('POST', '/api/admin/settings', { date: '2026-10-29', prepared: 40, paused: false, allowAfterClosing: false, version: day.body.day.version }, { token: staffToken })).status, 200);
});

test('personal: admin kan inte skapa admin, ingen kan ändra ägaren, inaktiverad stängs ute', async () => {
  const token = owner();
  await t.call('POST', '/api/admin/staff', { action: 'create', name: 'Sara Lind', email: 'sara@example.se', role: 'admin', password: 'tillfalligt-123' }, { token });
  const sara = t.auth.tokenFor('sara@example.se');
  assert.equal((await t.call('POST', '/api/admin/staff', { action: 'create', name: 'Ny Admin', email: 'ny@example.se', role: 'admin', password: 'tillfalligt-123' }, { token: sara })).status, 403);
  const list = (await t.call('GET', '/api/admin/staff', undefined, { token: sara })).body;
  const albert = list.find(s => s.role === 'owner'), marco = list.find(s => s.email === 'marco@example.se');
  assert.equal((await t.call('POST', '/api/admin/staff', { action: 'set_active', userId: albert.userId, active: false }, { token: sara })).status, 403);
  assert.equal((await t.call('POST', '/api/admin/staff', { action: 'set_active', userId: marco.userId, active: false }, { token: sara })).status, 200);
  assert.equal((await t.call('GET', '/api/admin/day', undefined, { token: t.auth.tokenFor('marco@example.se') })).status, 403);
});

test('arbetsuppgifter: standardlistan läggs bara till en gång', async () => {
  const token = owner();
  const a = await t.call('POST', '/api/admin/task', { date: '2026-10-21', action: 'start_checklist' }, { token });
  const b = await t.call('POST', '/api/admin/task', { date: '2026-10-21', action: 'start_checklist' }, { token });
  assert.equal(a.body.tasks.length, 18);
  assert.equal(b.body.tasks.length, 18);
  const task = a.body.tasks[0];
  const done = await t.call('POST', '/api/admin/task', { date: '2026-10-21', action: 'done', id: task.id, done: true }, { token });
  assert.equal(done.body.tasks.find(x => x.id === task.id).done, true);
});

test('mejl: bokningen sparas även när mejl inte är inställt', async () => {
  const res = await book({ date: '2026-10-30', time: '12:15', mode: 'away', guests: 0 });
  assert.equal(res.status, 201);
  assert.equal(res.body.email.status, 'not_configured');
  assert.equal(sql(t.db, `select status from booking_emails where booking_id='${res.body.id}'`), 'blocked');
});

test('ändringar loggas i historiken', async () => {
  const token = owner();
  const day = await t.call('GET', '/api/admin/day?date=2026-10-18', undefined, { token });
  const actions = day.body.history.map(h => h.action);
  assert.ok(actions.includes('waste_registered'));
  assert.ok(actions.includes('waste_voided'));
});

test('högst 3 webbokningar per gäst och dag', async () => {
  const guest = { contact: { name: 'Bo Berg', email: 'bo@example.se', phone: '0709999999' }, date: '2026-11-05', mode: 'away', guests: 0, count: 1 };
  const statuses = [];
  for (const time of ['12:15', '12:30', '12:45', '13:00']) statuses.push((await book({ ...guest, time })).status);
  assert.deepEqual(statuses, [201, 201, 201, 409]);
});

test('klienten kan inte sätta actor eller now själv', async () => {
  const token = owner();
  t.auth.addUser('lisa@example.se', 'losenord-123', 'Lisa');
  await t.call('POST', '/api/admin/staff', { action: 'create', name: 'Lisa', email: 'lisa2@example.se', role: 'staff', password: 'tillfalligt-123' }, { token });
  const lisa = t.auth.tokenFor('lisa2@example.se');
  const list = (await t.call('GET', '/api/admin/staff', undefined, { token })).body;
  const albertId = list.find(s => s.role === 'owner').userId;
  // Personal försöker utge sig för att vara ägaren.
  assert.equal((await t.call('GET', '/api/admin/stats', undefined, { token: lisa })).status, 403);
  assert.equal((await t.call('POST', '/api/admin/config', { action: 'close_date', date: '2026-11-09', actor: albertId }, { token: lisa })).status, 403);
});

test('ägarkontot skapas bara för bekräftad e-post', async () => {
  const s = setup();
  try {
    const u = s.auth.addUser('albert@albertno485.com', 'hemligt-losen-1', 'Falsk');
    u.email_confirmed_at = null;
    assert.equal((await s.call('GET', '/api/admin/day', undefined, { token: s.auth.tokenFor('albert@albertno485.com') })).status, 403);
    u.email_confirmed_at = '2026-10-01T00:00:00Z';
    assert.equal((await s.call('GET', '/api/admin/day', undefined, { token: s.auth.tokenFor('albert@albertno485.com') })).status, 200);
  } finally { s.close(); }
});

test('personal: ogiltig roll ger 400 och inget konto blir kvar', async () => {
  const token = owner();
  const res = await t.call('POST', '/api/admin/staff', { action: 'create', name: 'Ägare Två', email: 'agare2@example.se', role: 'owner', password: 'tillfalligt-123' }, { token });
  assert.equal(res.status, 400);
  assert.equal(t.auth.users.has('agare2@example.se'), false);
});

test('telefonbokning: personal ser lediga tider och bokar utan e-post, taket gäller', async () => {
  const token = owner();
  const av = await t.call('GET', '/api/admin/availability?date=2026-11-06&count=2&mode=here&guests=2', undefined, { token });
  assert.equal(av.status, 200);
  assert.ok(av.body.slots.length > 10);
  const res = await t.call('POST', '/api/admin/phone-booking', { key: crypto.randomUUID(), date: '2026-11-06', time: '18:00', count: 8, mode: 'away', guests: 0, contact: { name: 'Ringde in', phone: '0701112233' } }, { token });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const full = await t.call('POST', '/api/admin/phone-booking', { key: crypto.randomUUID(), date: '2026-11-06', time: '18:00', count: 1, mode: 'away', guests: 0, contact: { name: 'En till', phone: '0701112244' } }, { token });
  assert.equal(full.status, 409);
  assert.equal((await t.call('POST', '/api/admin/phone-booking', { key: crypto.randomUUID(), date: '2026-11-06', time: '18:15', count: 1, mode: 'away', guests: 0, contact: { name: 'X', phone: '0701112255' } })).status, 401);
  const day = await t.call('GET', '/api/admin/day?date=2026-11-06', undefined, { token });
  const b = day.body.bookings.find(x => x.name === 'Ringde in');
  assert.equal(b.source, 'staff');
  assert.equal(b.email, '');
});
