import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, bookingBody } from './helpers.mjs';

// Låtsas-Claude: första svaret ber om verktyg, andra svaret är text.
const requests = [];
async function fakeClaude(url, init = {}) {
  assert.equal(url, 'https://api.anthropic.com/v1/messages');
  assert.equal(init.headers['x-api-key'], 'sk-ant-test-nyckel-1234567890');
  const body = JSON.parse(init.body);
  requests.push(body);
  const last = body.messages[body.messages.length - 1];
  const ok = b => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (typeof last.content === 'string') {
    return ok({ stop_reason: 'tool_use', content: [
      { type: 'text', text: 'Jag kollar.' },
      { type: 'tool_use', id: 't1', name: 'dagens_lage', input: { date: '2026-10-21' } },
      { type: 'tool_use', id: 't2', name: 'dagsstatistik', input: { from: '2026-10-15', to: '2026-10-21' } },
    ] });
  }
  return ok({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Onsdag har 2 bokade pizzor.' }] });
}

let t, owner, staff;
before(async () => {
  t = setup({ env: { ANTHROPIC_API_KEY: 'sk-ant-test-nyckel-1234567890' }, fetcher: fakeClaude });
  t.auth.addUser('albert@albertno485.com', 'hemligt-losen-1', 'Albert');
  owner = t.auth.tokenFor('albert@albertno485.com');
  await t.call('GET', '/api/admin/day', undefined, { token: owner });
  await t.call('POST', '/api/admin/staff', { action: 'create', name: 'Marco', email: 'marco@example.se', role: 'staff', password: 'tillfalligt-123' }, { token: owner });
  staff = t.auth.tokenFor('marco@example.se');
  const b = await t.call('POST', '/api/bookings', bookingBody(), { headers: { 'Idempotency-Key': crypto.randomUUID() } });
  assert.equal(b.status, 201, JSON.stringify(b.body));
});
after(() => t.close());

test('AI svarar med hjälp av verktyg och får inga personuppgifter', async () => {
  assert.equal((await t.call('POST', '/api/admin/ai', { messages: [{ role: 'user', content: 'Hur ser onsdag ut?' }] }, { token: staff })).status, 403);
  const r = await t.call('POST', '/api/admin/ai', { messages: [{ role: 'user', content: 'Hur ser onsdag ut?' }] }, { token: owner });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.reply, 'Onsdag har 2 bokade pizzor.');
  assert.deepEqual(r.body.tools, ['dagens_lage', 'dagsstatistik']);
  const sent = JSON.stringify(requests[1]);
  assert.ok(sent.includes('18:00'), 'bokningen per färdigtid ska finnas med');
  for (const secret of ['Anna Andersson', 'anna@example.se', '070-123 45 67', 'albert@albertno485.com']) assert.ok(!sent.includes(secret), 'personuppgift läckte: ' + secret);
  assert.equal(requests[0].tools.length, 8);
});

test('utan nyckel visas tydligt meddelande', async () => {
  const t2 = setup();
  try {
    t2.auth.addUser('albert@albertno485.com', 'x-losen-12345', 'Albert');
    const tok = t2.auth.tokenFor('albert@albertno485.com');
    await t2.call('GET', '/api/admin/day', undefined, { token: tok });
    assert.equal((await t2.call('GET', '/api/admin/ai', undefined, { token: tok })).body.configured, false);
    const r = await t2.call('POST', '/api/admin/ai', { messages: [{ role: 'user', content: 'Hej' }] }, { token: tok });
    assert.equal(r.status, 409); assert.match(r.body.error, /ANTHROPIC_API_KEY/);
  } finally { t2.close(); }
});
