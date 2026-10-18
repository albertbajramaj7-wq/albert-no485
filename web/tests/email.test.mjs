import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, bookingBody, sql } from './helpers.mjs';

let t, calls = [], reply = { status: 200, body: { id: 'resend_123' } };
before(() => {
  t = setup({
    env: { RESEND_API_KEY: 're_test', BOOKING_EMAIL_FROM: 'Albert NO.485 <boka@albertno485.com>' },
    fetcher: async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify(reply.body), { status: reply.status }); },
  });
});
after(() => t.close());

test('bekräftelse skickas en gång med idempotensnyckel', async () => {
  const res = await t.call('POST', '/api/bookings', bookingBody({ date: '2026-10-21', time: '12:30' }), { headers: { 'Idempotency-Key': crypto.randomUUID() } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.email.status, 'sent');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.headers['Idempotency-Key'], 'booking-confirmation/' + res.body.id);
  const payload = JSON.parse(calls[0].init.body);
  assert.deepEqual(payload.to, ['anna@example.se']);
  assert.match(payload.text, /Kom senast: 12:20/);
  assert.equal(sql(t.db, `select status from booking_emails where booking_id='${res.body.id}'`), 'sent');
});

test('fel hos Resend stoppar inte bokningen', async () => {
  reply = { status: 500, body: {} };
  const res = await t.call('POST', '/api/bookings', bookingBody({ date: '2026-10-21', time: '12:45' }), { headers: { 'Idempotency-Key': crypto.randomUUID() } });
  assert.equal(res.status, 201);
  assert.equal(res.body.email.status, 'uncertain');
});
