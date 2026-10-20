import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, sql } from './helpers.mjs';

// Låtsas-Fortnox: svarar som Fortnox API men med påhittade siffror.
const calls = [];
let refreshCount = 0;
async function fakeFortnox(url, init = {}) {
  calls.push(url);
  const ok = body => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  if (url === 'https://apps.fortnox.se/oauth-v1/token') {
    const form = new URLSearchParams(init.body);
    assert.match(init.headers.Authorization, /^Basic /);
    if (form.get('grant_type') === 'authorization_code') {
      assert.equal(form.get('code'), 'kod-123');
      return ok({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, scope: 'bookkeeping supplierinvoice' });
    }
    refreshCount++;
    return ok({ access_token: 'at-' + (refreshCount + 1), refresh_token: 'rt-' + (refreshCount + 1), expires_in: 3600 });
  }
  assert.match(init.headers.Authorization, /^Bearer at-/);
  if (url.endsWith('/companyinformation')) return ok({ CompanyInformation: { CompanyName: 'Test AB' } });
  if (url.includes('/financialyears')) return ok({ FinancialYears: [{ Id: 4, FromDate: '2026-01-01', ToDate: '2026-12-31' }] });
  if (url.includes('/accounts/1930')) return ok({ Account: { Number: 1930, BalanceCarriedForward: 123456.5 } });
  // Som i verkligheten: Fortnox avvisar datumfiltret med 400 – hämtningen ska då prova utan.
  if (url.includes('/supplierinvoices') && url.includes('fromdate')) return new Response(JSON.stringify({ ErrorInformation: { error: 1, message: 'Ogiltig parameter i anropet.', code: 2000588 } }), { status: 400 });
  if (url.includes('/financialyears')) return ok({ FinancialYears: [{ Id: 3, FromDate: '2025-01-01', ToDate: '2025-12-31' }, { Id: 4, FromDate: '2026-01-01', ToDate: '2026-12-31' }] });
  if (url.includes('/accounts/1930')) { assert.match(url, /financialyear=4/); return ok({ Account: { Number: 1930, BalanceCarriedForward: 123456.5 } }); }
  if (url.includes('/supplierinvoices')) return ok({ MetaInformation: { '@TotalPages': 1 }, SupplierInvoices: [
    { GivenNumber: 1, SupplierNumber: '10', SupplierName: 'Vedbolaget', InvoiceDate: '2026-10-13', Total: '1250.00', Booked: true, Cancelled: false },
    { GivenNumber: 2, SupplierNumber: '10', SupplierName: 'Vedbolaget', InvoiceDate: '2026-10-15', Total: '750', Booked: false, Cancelled: false },
    { GivenNumber: 3, SupplierNumber: '20', SupplierName: 'Grossisten', InvoiceDate: '2026-10-14', Total: '9999', Booked: true, Cancelled: true },
    { GivenNumber: 4, SupplierNumber: '30', SupplierName: 'Gammal', InvoiceDate: '2025-01-14', Total: '500', Booked: true, Cancelled: false },
  ] });
  return new Response('{}', { status: 404 });
}

let t, owner, staff;
before(async () => {
  t = setup({ env: { FORTNOX_CLIENT_ID: 'klient', FORTNOX_CLIENT_SECRET: 'hemlis', SUPABASE_SERVICE_ROLE_KEY: 'test-nyckel-som-ar-lang-nog', CRON_SECRET: 'cron-hemlis' }, fetcher: fakeFortnox });
  t.auth.addUser('albert@albertno485.com', 'hemligt-losen-1', 'Albert');
  owner = t.auth.tokenFor('albert@albertno485.com');
  await t.call('GET', '/api/admin/day', undefined, { token: owner });
  await t.call('POST', '/api/admin/staff', { action: 'create', name: 'Marco', email: 'marco@example.se', role: 'staff', password: 'tillfalligt-123' }, { token: owner });
  staff = t.auth.tokenFor('marco@example.se');
});
after(() => t.close());

test('koppla Fortnox, hämta saldo och fakturor, nycklar sparas krypterat', async () => {
  assert.equal((await t.call('POST', '/api/admin/fortnox', { action: 'connect' }, { token: staff })).status, 403);
  const start = await t.call('POST', '/api/admin/fortnox', { action: 'connect' }, { token: owner });
  assert.equal(start.status, 200, JSON.stringify(start.body));
  const auth = new URL(start.body.url);
  assert.equal(auth.origin + auth.pathname, 'https://apps.fortnox.se/oauth-v1/auth');
  assert.equal(auth.searchParams.get('redirect_uri'), 'https://albertno485.com/api/fortnox/callback');
  assert.equal(auth.searchParams.get('access_type'), 'offline');
  const state = auth.searchParams.get('state');

  // Fel state avvisas
  const wrong = await t.app(new Request('https://albertno485.com/api/fortnox/callback?code=kod-123&state=' + 'x'.repeat(64)));
  assert.equal(wrong.status, 302); assert.match(wrong.headers.get('location'), /fortnox=fel/);

  const back = await t.app(new Request('https://albertno485.com/api/fortnox/callback?code=kod-123&state=' + state));
  assert.equal(back.status, 302); assert.equal(back.headers.get('location'), '/admin/?fortnox=kopplat');
  // Samma state kan inte användas två gånger
  const again = await t.app(new Request('https://albertno485.com/api/fortnox/callback?code=kod-123&state=' + state));
  assert.match(again.headers.get('location'), /fortnox=fel/);

  const enc = sql(t.db, "select data_enc from integration_tokens where provider = 'fortnox'");
  assert.match(enc, /^v1\./); assert.ok(!enc.includes('rt-1'), 'nyckeln får inte ligga okrypterad');

  const status = await t.call('GET', '/api/admin/fortnox', undefined, { token: owner });
  assert.equal(status.body.connected, true); assert.equal(status.body.companyName, 'Test AB');
  assert.equal(status.body.bankBalance, 123456.5);
  assert.equal(status.body.suppliers.length, 1); // makulerad faktura räknas inte
  assert.equal(status.body.suppliers[0].total, 2000);

  // Koppla leverantör till budgetpost → förslag per vecka
  const mapped = await t.call('POST', '/api/admin/fortnox', { action: 'save_map', supplierMap: { 10: 'wood' } }, { token: owner });
  assert.equal(mapped.status, 200, JSON.stringify(mapped.body));
  assert.deepEqual(mapped.body.suggestions, { '2026-10-12': { wood: 2000 } });
  const budget = await t.call('GET', '/api/admin/budget', undefined, { token: owner });
  assert.equal(budget.body.fortnox.bankBalance, 123456.5);
});

test('token förnyas när den gått ut, nattjobbet kräver hemlig nyckel', async () => {
  t.clock.now = '2026-10-19T14:00:00+02:00'; // mer än en timme senare
  const before = refreshCount;
  const r = await t.call('POST', '/api/admin/fortnox', { action: 'sync' }, { token: owner });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(refreshCount, before + 1);
  assert.equal((await t.app(new Request('https://albertno485.com/api/cron/fortnox'))).status, 401);
  const cron = await t.app(new Request('https://albertno485.com/api/cron/fortnox', { headers: { Authorization: 'Bearer cron-hemlis' } }));
  assert.equal(cron.status, 200);
  const off = await t.call('POST', '/api/admin/fortnox', { action: 'disconnect' }, { token: owner });
  assert.equal(off.body.connected, false); assert.equal(off.body.bankBalance, 123456.5); // hämtad data finns kvar
  assert.equal((await t.call('POST', '/api/admin/fortnox', { action: 'sync' }, { token: owner })).status, 409);
});
