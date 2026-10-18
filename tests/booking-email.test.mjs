import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D1Mock } from './d1-fixture.mjs';
import { createBooking, adminDay, changeBooking } from '../lib/restaurant.ts';
import { confirmationEmail, emailConfiguration, retryBookingEmail, sendBookingEmail } from '../lib/booking-email.ts';
const date = '2026-10-23', now = new Date('2026-10-21T08:00:00Z');
const actor = { user_id: 'owner-1', email: 'owner@example.test', name: 'Albert', role: 'owner' };
const env = { RESEND_API_KEY: 'test-only-key', BOOKING_EMAIL_FROM: 'Albert NO.485 <bokning@example.test>', BOOKING_EMAIL_REPLY_TO: 'info@example.test' };
const payload = extra => ({ date, time: '12:15', count: 2, mode: 'here', guests: 3, contact: { name: 'Test Guest', email: 'guest@example.test', phone: '0701234567' }, ...extra });
const book = (db, extra, key = crypto.randomUUID()) => createBooking(db, payload(extra), key, now);
const accepted = () => Promise.resolve(Response.json({ id: 'mail-accepted-123' }));
const outbox = (db, id) => db.raw.prepare('SELECT * FROM booking_emails WHERE booking_id=?').get(id);
const later = ms => new Date(now.getTime() + ms);

test('booking and mail are saved together; duplicate submissions and rejected bookings cannot create extra emails', async () => {
  const db = new D1Mock(), key = crypto.randomUUID();
  const booking = await book(db, {}, key); await book(db, {}, key);
  assert.equal(outbox(db, booking.id).status, 'pending');
  assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM booking_emails').get().n, 1);
  await assert.rejects(book(db, { count: 8 }));
  assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM booking_emails').get().n, 1);
  assert.equal((await adminDay(db, date, actor)).bookings[0].confirmationEmail.status, 'pending');
});
test('a successful email uses the saved guest and reservation details, and stores acceptance without exposing the key', async () => {
  const db = new D1Mock(), booking = await book(db); const requests = [];
  const result = await sendBookingEmail(db, booking.id, env, { now, fetcher: async (url, init) => { requests.push({ url, init }); return accepted(); } });
  assert.equal(result.status, 'sent'); assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://api.resend.com/emails');
  const sent = JSON.parse(requests[0].init.body);
  assert.deepEqual(sent.to, ['guest@example.test']); assert.equal(sent.from, env.BOOKING_EMAIL_FROM); assert.equal(sent.reply_to, env.BOOKING_EMAIL_REPLY_TO);
  assert.ok(sent.text.includes('12:15')); assert.ok(sent.text.includes('12:05')); assert.ok(sent.text.includes('13:05')); assert.ok(sent.text.includes('3 gäster')); assert.ok(sent.text.includes(booking.id));
  assert.equal(outbox(db, booking.id).status, 'sent'); assert.equal(outbox(db, booking.id).provider_id, 'mail-accepted-123');
  assert.ok(!outbox(db, booking.id).payload.includes(env.RESEND_API_KEY));
  assert.ok(!JSON.stringify(await adminDay(db, date, actor)).includes(env.RESEND_API_KEY));
  assert.ok(!JSON.stringify((await adminDay(db, date, actor)).bookings).includes('<!doctype'));
});
test('concurrent calls and retries of the same booking dispatch once', async () => {
  const db = new D1Mock(), booking = await book(db); let calls = 0;
  const options = { now, fetcher: async () => { calls++; return accepted(); } };
  await Promise.all(Array.from({ length: 12 }, () => sendBookingEmail(db, booking.id, env, options)));
  assert.equal(calls, 1); assert.equal(outbox(db, booking.id).status, 'sent');
  assert.equal((await sendBookingEmail(db, booking.id, env, options)).status, 'sent'); assert.equal(calls, 1);
});
test('missing or unsafe sender settings never call the mail provider and do not lose the booking', async () => {
  const db = new D1Mock(), booking = await book(db); let calls = 0;
  const options = { now, fetcher: async () => { calls++; return accepted(); } };
  assert.equal((await sendBookingEmail(db, booking.id, {}, options)).status, 'not_configured');
  assert.equal(outbox(db, booking.id).attempts, 0); assert.equal(outbox(db, booking.id).payload, null);
  assert.equal(emailConfiguration({ ...env, BOOKING_EMAIL_FROM: 'hello@example.test\r\nBcc: other@example.test' }).configured, false);
  assert.equal(emailConfiguration({ ...env, BOOKING_EMAIL_REPLY_TO: 'invalid' }).configured, false);
  assert.equal((await sendBookingEmail(db, booking.id, { ...env, BOOKING_EMAIL_FROM: 'invalid' }, options)).status, 'not_configured');
  assert.equal(calls, 0); assert.equal(db.raw.prepare('SELECT status FROM bookings WHERE id=?').get(booking.id).status, 'confirmed');
  assert.equal((await sendBookingEmail(db, booking.id, env, options)).status, 'sent'); assert.equal(calls, 1);
});
test('provider rejection is recorded and later retries preserve the exact payload and idempotency key', async () => {
  const db = new D1Mock(), booking = await book(db), requests = [];
  const failed = await sendBookingEmail(db, booking.id, env, { now, fetcher: async (url, init) => { requests.push(init); return Response.json({ message: 'Sensitive provider message should never be saved' }, { status: 403 }); } });
  assert.equal(failed.status, 'failed'); assert.equal(outbox(db, booking.id).last_error, 'provider_http_403');
  assert.equal(db.raw.prepare('SELECT status FROM bookings WHERE id=?').get(booking.id).status, 'confirmed');
  await sendBookingEmail(db, booking.id, { ...env, BOOKING_EMAIL_FROM: 'changed@example.test' }, { now: later(61000), fetcher: async (url, init) => { requests.push(init); return accepted(); } });
  assert.equal(requests.length, 2); assert.equal(requests[0].body, requests[1].body); assert.equal(requests[0].headers['Idempotency-Key'], requests[1].headers['Idempotency-Key']);
  assert.equal(outbox(db, booking.id).status, 'sent');
});
test('a lost provider response is uncertain, respects retry delay, and retries with the same email identity', async () => {
  const db = new D1Mock(), booking = await book(db), requests = [];
  const failed = await sendBookingEmail(db, booking.id, env, { now, fetcher: async (url, init) => { requests.push(init); throw new Error('network response lost'); } });
  assert.equal(failed.status, 'uncertain');
  assert.equal((await sendBookingEmail(db, booking.id, env, { now: later(10000), fetcher: accepted })).status, 'uncertain');
  await sendBookingEmail(db, booking.id, env, { now: later(61000), fetcher: async (url, init) => { requests.push(init); return accepted(); } });
  assert.equal(requests.length, 2); assert.equal(requests[0].body, requests[1].body); assert.equal(requests[0].headers['Idempotency-Key'], requests[1].headers['Idempotency-Key']);
});
test('expired uncertain attempts require review before provider deduplication expires', async () => {
  const db = new D1Mock(), booking = await book(db); let calls = 0;
  await sendBookingEmail(db, booking.id, env, { now, fetcher: async () => { throw new Error('lost'); } });
  const result = await sendBookingEmail(db, booking.id, env, { now: later(23 * 60 * 60 * 1000), fetcher: async () => { calls++; return accepted(); } });
  assert.equal(result.status, 'review'); assert.equal(calls, 0); assert.equal(outbox(db, booking.id).status, 'review');
});
test('cancelled or past bookings cannot trigger a confirmation email', async () => {
  const db = new D1Mock(), booking = await book(db); let calls = 0;
  await changeBooking(db, actor, { id: booking.id, action: 'cancel', reason: 'Test cancellation' });
  const fetcher = async () => { calls++; return accepted(); };
  assert.equal((await sendBookingEmail(db, booking.id, env, { now, fetcher })).status, 'skipped');
  await assert.rejects(retryBookingEmail(db, actor.name, booking.id, env, { now, fetcher }), e => e.status === 409);
  const past = await book(db, { mode: 'away' });
  assert.equal((await sendBookingEmail(db, past.id, env, { now: new Date('2026-10-24T08:00:00Z'), fetcher })).status, 'skipped');
  assert.equal(calls, 0);
});
test('mail templates escape guest HTML, keep text readable, and omit seating for takeaway', async () => {
  const db = new D1Mock(), booking = await book(db, { mode: 'away', contact: { name: '<img src=x onerror=alert(1)>', email: 'guest@example.test', phone: '0701234567' } });
  const row = db.raw.prepare('SELECT * FROM bookings WHERE id=?').get(booking.id);
  const email = confirmationEmail(row, env.BOOKING_EMAIL_FROM);
  assert.ok(!email.html.includes('<img src=x')); assert.ok(email.html.includes('&lt;img src=x')); assert.ok(email.text.includes(row.name));
  assert.ok(!email.text.includes('Sittning')); assert.ok(email.text.includes('Ta med')); assert.ok(email.text.includes('Pilgatan 3'));
});
test('old future bookings are not backfilled on reads, but an explicit admin retry can queue one', async () => {
  const db = new D1Mock(), booking = await book(db);
  db.raw.prepare('DELETE FROM booking_emails WHERE booking_id=?').run(booking.id);
  assert.equal((await sendBookingEmail(db, booking.id, env, { now, fetcher: accepted })).status, 'not_queued');
  assert.equal((await adminDay(db, date, actor)).bookings[0].confirmationEmail, null);
  assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM booking_emails').get().n, 0);
  assert.equal((await retryBookingEmail(db, actor.name, booking.id, env, { now, fetcher: accepted })).status, 'sent');
  await assert.rejects(retryBookingEmail(db, actor.name, crypto.randomUUID(), env, { now, fetcher: accepted }), e => e.status === 404);
});
test('a crashed sender lease can be recovered without changing the persisted email identity', async () => {
  const db = new D1Mock(), booking = await book(db), row = db.raw.prepare('SELECT * FROM bookings WHERE id=?').get(booking.id);
  const body = JSON.stringify(confirmationEmail(row, env.BOOKING_EMAIL_FROM));
  db.raw.prepare("UPDATE booking_emails SET status='sending',payload=?,first_attempt_at=?,lease_token='old-worker',lease_until=? WHERE booking_id=?").run(body, now.getTime(), now.getTime() + 30000, booking.id);
  let calls = 0;
  const fetcher = async (url, init) => { calls++; assert.equal(init.body, body); assert.equal(init.headers['Idempotency-Key'], 'booking-confirmation/' + booking.id); return accepted(); };
  assert.equal((await sendBookingEmail(db, booking.id, env, { now, fetcher })).status, 'sending');
  assert.equal((await sendBookingEmail(db, booking.id, env, { now: later(31000), fetcher })).status, 'sent'); assert.equal(calls, 1);
});
test('rate limits are respected and malformed successful responses are never marked as sent', async () => {
  const db = new D1Mock(), booking = await book(db); let calls = 0;
  const result = await sendBookingEmail(db, booking.id, env, { now, fetcher: async () => Response.json({}, { status: 429, headers: { 'Retry-After': '120' } }) });
  assert.equal(result.status, 'failed'); assert.equal(result.retryAt, now.getTime() + 120000);
  await sendBookingEmail(db, booking.id, env, { now: later(70000), fetcher: async () => { calls++; return accepted(); } }); assert.equal(calls, 0);
  const bad = await sendBookingEmail(db, booking.id, env, { now: later(121000), fetcher: async () => Response.json({ success: true }) });
  assert.equal(bad.status, 'uncertain'); assert.equal(outbox(db, booking.id).sent_at, null);
});
test('email header injection and multiple-recipient syntax cannot be submitted as a booking contact', async () => {
  const db = new D1Mock();
  for (const email of ['first@example.test,other@example.test', 'first@example.test\r\nBcc:other@example.test', 'Name <first@example.test>']) {
    await assert.rejects(book(db, { contact: { name: 'Guest', email, phone: '0701234567' } }), e => e.status === 400);
  }
  assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM booking_emails').get().n, 0);
});
