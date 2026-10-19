import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, sql, bookingBody } from './helpers.mjs';

let t, owner;
before(async () => {
  t = setup({ env: { DISABLE_RATE_LIMIT: '0' } });
  t.auth.addUser('albert@albertno485.com', 'hemligt-losen-1', 'Albert');
  owner = t.auth.tokenFor('albert@albertno485.com');
});
after(() => t.close());

const book = (over = {}, ip = '10.0.0.1') => t.call('POST', '/api/bookings', bookingBody(over), { headers: { 'Idempotency-Key': crypto.randomUUID(), 'X-Forwarded-For': ip } });

test('högst 8 bokningsförsök per 10 minuter från samma avsändare', async () => {
  const statuses = [];
  for (let i = 0; i < 9; i++) statuses.push((await book({ time: '18:00', count: 1, contact: { name: 'Test ' + i, email: `t${i}@example.se`, phone: '070-000 00 0' + i } })).status);
  assert.equal(statuses[8], 429);
  assert.ok(statuses.slice(0, 8).every(s => s !== 429));
  // En annan avsändare påverkas inte
  assert.equal((await book({ time: '19:00', count: 1, contact: { name: 'Annan', email: 'annan@example.se', phone: '070-999 99 99' } }, '10.0.0.2')).status, 201);
  // IP-adressen sparas inte i klartext
  assert.equal(sql(t.db, "select count(*) from rate_limits where key like '%10.0.0%'"), '0');
});

test('gamla bokningar anonymiseras, statistiken finns kvar', async () => {
  sql(t.db, `insert into bookings (request_key, date, ready_min, count, guests, mode, name, email, phone, cancel_reason, status)
             values (gen_random_uuid(), '2024-01-10', 1080, 3, 2, 'here', 'Gammal Gäst', 'gammal@example.se', '070-111 11 11', 'Sjuk', 'cancelled')`);
  await t.call('GET', '/api/admin/day', undefined, { token: owner }); // kör städningen
  assert.equal(sql(t.db, "select name || '|' || email || '|' || phone || '|' || coalesce(cancel_reason,'') from bookings where date = '2024-01-10'"), 'Anonymiserad|||Anonymiserad');
  assert.equal(sql(t.db, "select count from bookings where date = '2024-01-10'"), '3');
  assert.equal(sql(t.db, "select count(*) from bookings where name = 'Anonymiserad' and date >= '2026-01-01'"), '0'); // nya rörs inte
  assert.equal(sql(t.db, "select count(*) from audit where action = 'privacy_anonymized'"), '1');
});
