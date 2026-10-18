import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adminDay, authorize, changeBooking, changeCounter, createBooking, getAvailability, mutateTask, saveDay, validDate, TASK_CHECKLIST } from '../lib/restaurant.ts';

import { D1Mock } from './d1-fixture.mjs';

const date = '2026-10-21', now = new Date('2026-10-21T08:00:00Z');
const actor = { user_id: 'owner-1', email: 'owner@example.test', name: 'Albert', role: 'owner' };
const payload = (time = '12:15', count = 1, extra = {}) => ({ date, time, count, mode: 'away', guests: 0, contact: { name: 'Test Guest', email: 'guest@example.test', phone: '0701234567' }, ...extra });
const book = (db, value = payload(), key = crypto.randomUUID()) => createBooking(db, value, key, now);
const rejectStatus = status => e => e.status === status;

test('admin denies anonymous users and unrelated authenticated accounts; owner binds stable user ID', async () => {
  const db = new D1Mock();
  await assert.rejects(authorize(db, null, actor.email), rejectStatus(401));
  await assert.rejects(authorize(db, { userId: 'other', email: 'other@example.test' }, actor.email), rejectStatus(403));
  const owner = await authorize(db, { userId: actor.user_id, email: actor.email, displayName: 'Albert' }, actor.email);
  assert.equal(owner.role, 'owner');
  assert.equal((await authorize(db, { userId: actor.user_id, email: 'changed@example.test' }, actor.email)).user_id, actor.user_id);
});
test('slot capacity remains at eight under simultaneous booking requests', async () => {
  const db = new D1Mock();
  const results = await Promise.allSettled(Array.from({ length: 20 }, () => book(db)));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 8);
  assert.equal(db.raw.prepare('SELECT SUM(count) total FROM bookings').get().total, 8);
});
test('every rolling hour remains at most 31 pizzas', async () => {
  const db = new D1Mock();
  for (const t of ['12:15', '12:30', '12:45']) await book(db, payload(t, 8));
  await assert.rejects(book(db, payload('13:00', 8)), rejectStatus(409));
  await book(db, payload('13:00', 7));
  assert.equal(db.raw.prepare('SELECT SUM(count) total FROM bookings').get().total, 31);
});
test('seat overlap is enforced by both availability and booking insertion', async () => {
  const db = new D1Mock();
  await book(db, payload('12:15', 1, { mode: 'here', guests: 31 }));
  const value = await getAvailability(db, { date, count: 1, mode: 'here', guests: 1 }, now);
  assert.equal(value.slots.find(s => s.time === '12:30').bookable, false);
  await assert.rejects(book(db, payload('12:30', 1, { mode: 'here', guests: 1 })), rejectStatus(409));
  await book(db, payload('13:15', 1, { mode: 'here', guests: 31 }));
});
test('same request key returns the saved confirmation without creating a duplicate', async () => {
  const db = new D1Mock(), key = crypto.randomUUID();
  const first = await book(db, payload(), key), again = await book(db, payload(), key);
  assert.equal(first.id, again.id); assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM bookings').get().n, 1);
  await assert.rejects(book(db, payload('12:30'), key), rejectStatus(409));
});
test('daily stock includes bookings, drop-in and waste; cancellation releases capacity', async () => {
  const db = new D1Mock();
  await saveDay(db, actor, { date, prepared: 5, paused: false, allowAfterClosing: false, version: 0 });
  await changeCounter(db, actor, { date, field: 'dropin', delta: 1 });
  await changeCounter(db, actor, { date, field: 'waste', delta: 1 });
  const booking = await book(db, payload('12:15', 3));
  await assert.rejects(book(db), rejectStatus(409));
  await assert.rejects(changeBooking(db, actor, { id: booking.id, action: 'cancel', reason: '' }), rejectStatus(400));
  await changeBooking(db, actor, { id: booking.id, action: 'cancel', reason: 'Test cancellation' });
  await book(db, payload('12:15', 3));
});
test('counters never go negative and manual corrections reject stale versions', async () => {
  const db = new D1Mock();
  await assert.rejects(changeCounter(db, actor, { date, field: 'dropin', delta: -1 }), rejectStatus(409));
  const day = await changeCounter(db, actor, { date, field: 'dropin', delta: 1 });
  await assert.rejects(changeCounter(db, actor, { date, field: 'dropin', mode: 'set', value: 50, version: 0 }), rejectStatus(409));
  await changeCounter(db, actor, { date, field: 'dropin', mode: 'set', value: 4, version: day.day.version });
  assert.equal((await adminDay(db, date, actor)).day.dropin, 4);
});
test('paused days, closed Mondays and past dates cannot be booked', async () => {
  const db = new D1Mock();
  await saveDay(db, actor, { date, prepared: null, paused: true, allowAfterClosing: false, version: 0 });
  await assert.rejects(book(db), rejectStatus(409));
  assert.equal((await getAvailability(db, { date: '2026-10-26', count: 1, mode: 'away', guests: 0 }, now)).closed, true);
  await assert.rejects(getAvailability(db, { date: '2026-10-20', count: 1, mode: 'away', guests: 0 }, now), rejectStatus(400));
  assert.throws(() => validDate('2026-02-30'), rejectStatus(400));
});
test('check-in and finish follow valid transitions, and tasks keep an audit history', async () => {
  const db = new D1Mock(), booking = await book(db);
  await assert.rejects(changeBooking(db, actor, { id: booking.id, action: 'finish' }), rejectStatus(409));
  await changeBooking(db, actor, { id: booking.id, action: 'checkin' });
  await changeBooking(db, actor, { id: booking.id, action: 'finish' });
  let result = await mutateTask(db, actor, { date, action: 'create', title: 'Kontrollera toaletten', category: 'opening' });
  const id = result.tasks[0].id;
  result = await mutateTask(db, actor, { date, id, action: 'done', done: true }); assert.equal(result.tasks[0].done, 1);
  result = await mutateTask(db, actor, { date, id, action: 'archive' }); assert.equal(result.tasks.length, 0);
  assert.ok(result.history.some(item => item.action === 'task_archive'));
});
test('public availability never returns customer contact details', async () => {
  const db = new D1Mock(); await book(db);
  const json = JSON.stringify(await getAvailability(db, { date, count: 1, mode: 'away', guests: 0 }, now));
  assert.ok(!json.includes('guest@example.test')); assert.ok(!json.includes('Test Guest')); assert.ok(!json.includes('0701234567'));
});
test('simultaneous seat requests cannot exceed 31 guests', async () => {
  const db = new D1Mock();
  const results = await Promise.allSettled(Array.from({ length: 12 }, () => book(db, payload('12:15', 1, { mode: 'here', guests: 5 }))));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 6);
  assert.equal(db.raw.prepare('SELECT SUM(guests) n FROM bookings').get().n, 30);
});
test('simultaneous requests cannot exceed daily stock', async () => {
  const db = new D1Mock();
  await saveDay(db, actor, { date, prepared: 5, paused: false, allowAfterClosing: false, version: 0 });
  const results = await Promise.allSettled(Array.from({ length: 12 }, () => book(db)));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 5);
});
test('concurrent reuse of an idempotency key with another payload is rejected', async () => {
  const db = new D1Mock(), key = crypto.randomUUID();
  const results = await Promise.allSettled([book(db, payload('12:15'), key), book(db, payload('12:30'), key)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM bookings').get().n, 1);
});
test('parallel counter increments are preserved and after-closing seating needs explicit permission', async () => {
  const db = new D1Mock();
  await Promise.all(Array.from({ length: 20 }, () => changeCounter(db, actor, { date, field: 'dropin', delta: 1 })));
  let data = await adminDay(db, date, actor); assert.equal(data.day.dropin, 20);
  await assert.rejects(book(db, payload('20:45', 1, { mode: 'here', guests: 2 })), rejectStatus(409));
  await saveDay(db, actor, { date, prepared: null, paused: false, allowAfterClosing: true, version: data.day.version });
  await book(db, payload('20:45', 1, { mode: 'here', guests: 2 }));
});

test('daily checklist starts only on request, and concurrent starts create one categorized list', async () => {
  const db = new D1Mock();
  assert.equal((await adminDay(db, date, actor)).tasks.length, 0);
  assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM audit').get().n, 0);
  await Promise.all(Array.from({ length: 3 }, () => mutateTask(db, actor, { date, action: 'start_checklist' })));
  const result = await adminDay(db, date, actor);
  assert.equal(result.tasks.length, TASK_CHECKLIST.length);
  assert.equal(result.checklistStarted, true);
  assert.deepEqual(new Set(result.tasks.map(t => t.category)), new Set(['opening', 'general', 'closing']));
  assert.deepEqual(new Set(result.tasks.map(t => t.area)), new Set(['kitchen', 'service', 'hygiene']));
  assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM audit').get().n, TASK_CHECKLIST.length);
});
test('restarting a checklist preserves completed, edited, archived and custom tasks; days are independent', async () => {
  const db = new D1Mock();
  let day = await mutateTask(db, actor, { date, action: 'start_checklist' });
  const [done, archived, edited] = day.tasks;
  await mutateTask(db, actor, { date, action: 'done', id: done.id, done: true });
  await mutateTask(db, actor, { date, action: 'archive', id: archived.id });
  await mutateTask(db, actor, { date, action: 'update', id: edited.id, title: 'Vår egen rutin', category: 'closing', area: 'service' });
  await mutateTask(db, actor, { date, action: 'create', title: 'Ring leverantören', category: 'general', area: 'other' });
  const before = db.raw.prepare('SELECT COUNT(*) n FROM audit').get().n;
  day = await mutateTask(db, actor, { date, action: 'start_checklist' });
  assert.equal(day.tasks.find(t => t.id === done.id).done, 1);
  assert.equal(day.tasks.some(t => t.id === archived.id), false);
  assert.equal(day.tasks.find(t => t.id === edited.id).title, 'Vår egen rutin');
  assert.equal(day.tasks.find(t => t.id === edited.id).area, 'service');
  assert.ok(day.tasks.some(t => t.title === 'Ring leverantören'));
  assert.equal(day.tasks.length, TASK_CHECKLIST.length);
  assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM audit').get().n, before);
  assert.equal((await adminDay(db, '2026-10-22', actor)).checklistStarted, false);
  const next = await mutateTask(db, actor, { date: '2026-10-22', action: 'start_checklist' });
  assert.equal(next.tasks.length, TASK_CHECKLIST.length);
  assert.equal(next.tasks.filter(t => t.done).length, 0);
});
test('task edits move category and area without resetting completion; invalid and cross-day edits are rejected', async () => {
  const db = new D1Mock();
  let day = await mutateTask(db, actor, { date, action: 'create', title: 'Fyll på tvål', category: 'opening', area: 'hygiene' });
  const id = day.tasks[0].id;
  await mutateTask(db, actor, { date, action: 'done', id, done: true });
  day = await mutateTask(db, actor, { date, action: 'update', id, title: 'Kontrollera och fyll på tvål', category: 'closing', area: 'hygiene' });
  assert.equal(day.tasks[0].done, 1); assert.equal(day.tasks[0].category, 'closing');
  const before = db.raw.prepare('SELECT COUNT(*) n FROM audit').get().n;
  await assert.rejects(mutateTask(db, actor, { date, action: 'update', id, title: 'Fel kategori', category: 'invalid', area: 'hygiene' }), rejectStatus(400));
  await assert.rejects(mutateTask(db, actor, { date, action: 'create', title: 'Fel område', category: 'opening', area: 'invalid' }), rejectStatus(400));
  await assert.rejects(mutateTask(db, actor, { date: '2026-10-22', action: 'update', id, title: 'Fel dag', category: 'opening', area: 'kitchen' }), rejectStatus(409));
  assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM audit').get().n, before);
  assert.equal((await adminDay(db, date, actor)).tasks[0].title, 'Kontrollera och fyll på tvål');
});
test('the added categorization migration preserves legacy tasks, completion and history', () => {
  const raw = new DatabaseSync(':memory:');
  const migrations = readdirSync(new URL('../drizzle/', import.meta.url)).filter(p => p.endsWith('.sql')).sort();
  const apply = file => raw.exec(readFileSync(new URL('../drizzle/' + file, import.meta.url), 'utf8').replaceAll('--> statement-breakpoint', ''));
  apply(migrations[0]);
  raw.prepare('INSERT INTO tasks(id,date,title,category,done,archived,updated_by,created_at,updated_at) VALUES(?,?,?,?,1,0,?,?,?)').run('legacy-task', date, 'Kontrollera toaletten', 'opening', actor.name, now.toISOString(), now.toISOString());
  migrations.slice(1).forEach(apply);
  const task = raw.prepare('SELECT * FROM tasks WHERE id=?').get('legacy-task');
  assert.equal(task.title, 'Kontrollera toaletten'); assert.equal(task.done, 1); assert.equal(task.area, 'other'); assert.equal(task.template_key, null);
  raw.close();
});
