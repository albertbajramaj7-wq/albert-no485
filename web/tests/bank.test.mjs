import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, sql } from './helpers.mjs';
import { assertReadOnly, bankConfig, BankReadOnlyError, forecast, matchFortnox } from '../lib/bank.js';

// Låtsas-Danske Bank (sandbox). Fält enligt bankens dokumentation för Account Transaction & Balance API.
const API = 'https://sandbox-api.danskebank.com/sandbox-corporate/api/v1/account-transaction-service';
const TOKEN = 'https://sandbox-api.danskebank.com/sandbox-corporate/api/dk/business/oauth2/token';
const calls = [];
let failNext = 0;
const tx = (id, date, amount, name, text) => ({ transactionId: id, bookingDate: date, valueDate: date, transactionAmount: { currency: 'SEK', amount: String(amount) },
  debtor: { name }, remittanceInformationUnstructured: [text], bankTransactionCode: 'PMNT' });
async function fakeDanske(url, init = {}) {
  calls.push({ url, method: init.method, headers: init.headers, body: init.body });
  const ok = b => ({ ok: true, status: 200, json: async () => b });
  if (failNext > 0) { failNext--; return { ok: false, status: 503, json: async () => ({ message: 'Tillfälligt fel' }) }; }
  if (url === TOKEN) {
    const f = new URLSearchParams(init.body);
    assert.equal(f.get('grant_type'), 'client_credentials'); assert.equal(f.get('scope'), 'accounts');
    return ok({ access_token: 'tok-1', expires_in: 3600 });
  }
  assert.equal(init.headers.Authorization, 'Bearer tok-1');
  if (url === API + '/accounts/list') return ok({ accounts: [{ iban: 'SE1212345678901234567890', bban: '12345678901', other: 'acc-sek-1', country: 'SE', currency: 'SEK' }, { other: 'acc-nok', currency: 'NOK' }] });
  if (url.startsWith(API + '/accounts/acc-sek-1/balances')) return ok({ balances: [{ balanceType: 'interimBooked', balanceAmount: { currency: 'SEK', amount: '125000.50' }, referenceDate: '2026-10-20' }] });
  if (url.startsWith(API + '/accounts/acc-nok/balances')) return ok({ balances: [{ balanceType: 'interimBooked', balanceAmount: { currency: 'NOK', amount: '1000' } }] });
  if (url.startsWith(API + '/accounts/acc-sek-1/transactions')) return ok({ transactions: [
    tx('t1', '2026-08-25', -26813, 'Varbergs Fastighets AB', 'Hyra augusti'),
    tx('t2', '2026-09-25', -26813, 'Varbergs Fastighets AB', 'Hyra september'),
    tx('t3', '2026-10-01', -4800.00, 'Martin & Servera', 'Faktura 8812'),
    tx('t4', '2026-10-05', 15400, 'Nets Sweden', 'Kortinlösen'),
    tx('t5', '2026-10-12', 18200, 'Nets Sweden', 'Kortinlösen'),
    tx('t6', '2026-10-15', -3120, 'Skatteverket', 'Skattekonto'),
    { bookingDate: '2026-10-16', transactionAmount: { currency: 'SEK', amount: '-250' }, remittanceInformationUnstructured: ['Kontoavgift'] },
  ] });
  if (url.startsWith(API + '/accounts/acc-nok/transactions')) return ok({ transactions: [] });
  return { ok: false, status: 404, json: async () => ({}) };
}

const ENV = { DANSKE_ENV: 'sandbox', DANSKE_CLIENT_ID: 'klient-123', DANSKE_CLIENT_CERT_PEM: '-----BEGIN CERTIFICATE-----\\nTEST\\n-----END CERTIFICATE-----', DANSKE_CLIENT_KEY_PEM: '-----BEGIN PRIVATE KEY-----\\nHEMLIG-NYCKEL-123\\n-----END PRIVATE KEY-----', CRON_SECRET: 'cron-hemlis' };
let t, owner, admin, staff, adminId;
before(async () => {
  t = setup({ env: ENV, bankTransport: fakeDanske });
  t.clock.now = '2026-10-20T12:00:00+02:00';
  t.auth.addUser('albert@albertno485.com', 'hemligt-losen-1', 'Albert');
  owner = t.auth.tokenFor('albert@albertno485.com');
  await t.call('GET', '/api/admin/day', undefined, { token: owner });
  await t.call('POST', '/api/admin/staff', { action: 'create', name: 'Sara', email: 'sara@example.se', role: 'admin', password: 'tillfalligt-123' }, { token: owner });
  await t.call('POST', '/api/admin/staff', { action: 'create', name: 'Marco', email: 'marco@example.se', role: 'staff', password: 'tillfalligt-123' }, { token: owner });
  admin = t.auth.tokenFor('sara@example.se'); staff = t.auth.tokenFor('marco@example.se');
  adminId = sql(t.db, "select user_id from staff where email = 'sara@example.se'");
});
after(() => t.close());

test('endast läsning: tillåtelselistan stoppar betalningar och allt annat', () => {
  const cfg = bankConfig(ENV);
  assert.equal(assertReadOnly(cfg, 'GET', API + '/accounts/list'), 'read');
  assert.equal(assertReadOnly(cfg, 'GET', API + '/accounts/abc/transactions?bookingDateFrom=2026-01-01&limit=1000'), 'read');
  assert.equal(assertReadOnly(cfg, 'POST', TOKEN), 'token');
  const blocked = [
    ['POST', API + '/accounts/abc/transactions'],
    ['PUT', API + '/accounts/list'],
    ['DELETE', API + '/accounts/abc/balances'],
    ['GET', 'https://sandbox-api.danskebank.com/sandbox-corporate/api/v1/payment-initiation-service/payments'],
    ['POST', 'https://sandbox-api.danskebank.com/sandbox-corporate/api/v1/payment-initiation-service/payments'],
    ['GET', API + '/accounts/abc/transactions/../../payments'],
    ['GET', API + '/accounts/abc/transactions?creditorAccount=SE123'],
    ['GET', 'https://evil.example/corporate/api/v1/account-transaction-service/accounts/list'],
    ['GET', TOKEN],
    ['GET', 'http://sandbox-api.danskebank.com/sandbox-corporate/api/v1/account-transaction-service/accounts/list'],
  ];
  for (const [m, u] of blocked) assert.throws(() => assertReadOnly(cfg, m, u), BankReadOnlyError, m + ' ' + u);
  // Riktiga data kräver ett extra uttryckligt godkännande.
  assert.equal(bankConfig({ ...ENV, DANSKE_ENV: 'live' }).configured, false);
  assert.deepEqual(bankConfig({ ...ENV, DANSKE_ENV: 'live' }).missing, ['DANSKE_LIVE_ENABLED=ja']);
  assert.equal(bankConfig({ ...ENV, DANSKE_ENV: 'live', DANSKE_LIVE_ENABLED: 'ja' }).configured, true);
  assert.equal(bankConfig({}).mode, 'off');
  assert.equal(bankConfig({ VERCEL_ENV: 'preview' }).mode, 'mock');
});

test('personal och admin utan behörighet nekas, ägaren kan ge behörighet', async () => {
  assert.equal((await t.call('GET', '/api/admin/bank', undefined, { token: staff })).status, 403);
  assert.equal((await t.call('GET', '/api/admin/bank', undefined, { token: admin })).status, 403);
  assert.equal((await t.call('POST', '/api/admin/bank', { action: 'sync' }, { token: staff })).status, 403);
  assert.equal((await t.call('GET', '/api/admin/bank')).status, 401);
  const grant = await t.call('POST', '/api/admin/bank', { action: 'access', userId: adminId, allow: true }, { token: owner });
  assert.equal(grant.status, 200, JSON.stringify(grant.body));
  assert.equal(grant.body.admins[0].bankAccess, true);
  assert.equal((await t.call('GET', '/api/admin/bank', undefined, { token: admin })).status, 200);
  // Admin kan inte själv dela ut behörighet
  assert.equal((await t.call('POST', '/api/admin/bank', { action: 'access', userId: adminId, allow: true }, { token: admin })).status, 403);
  // Publika vägar ger aldrig bankdata
  assert.equal((await t.call('GET', '/api/bank')).status, 404);
});

test('synk hämtar saldo och transaktioner, kategoriserar och dubblerar aldrig', async () => {
  calls.length = 0;
  const r = await t.call('POST', '/api/admin/bank', { action: 'sync' }, { token: owner });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.sync.accounts, 2); assert.equal(r.body.sync.added, 7);
  assert.ok(calls.every(c => c.url === TOKEN ? c.method === 'POST' : c.method === 'GET'), 'bara GET mot banken');
  assert.equal(calls.filter(c => c.url === TOKEN).length, 1);
  const again = await t.call('POST', '/api/admin/bank', { action: 'sync' }, { token: owner });
  assert.equal(again.body.sync.added, 0); // inga dubbletter
  assert.equal(sql(t.db, "select count(*) from bank_transactions"), '7');

  const o = await t.call('GET', '/api/admin/bank', undefined, { token: owner });
  assert.equal(o.status, 200, JSON.stringify(o.body));
  assert.equal(o.body.overview.balanceSek, 125000.5);
  assert.equal(o.body.overview.availableSek, null);     // banken skickar inte tillgängligt saldo
  assert.equal(o.body.overview.monthIn, 33600);
  assert.equal(o.body.overview.monthOut, 8170);
  assert.equal(o.body.overview.sync.status, 'ok');
  assert.equal(o.body.status.readOnly, true);
  const cats = Object.fromEntries(o.body.overview.categories.map(c => [c.category, c]));
  assert.equal(cats['Kortintäkter'].in, 33600); assert.equal(cats['Råvaror'].out, 4800); assert.equal(cats['Skatt & moms'].out, 3120);
  // Inga nycklar eller certifikat i svaret
  const text = JSON.stringify(o.body);
  for (const secret of ['HEMLIG-NYCKEL-123', 'tok-1', 'klient-123', 'BEGIN PRIVATE']) assert.ok(!text.includes(secret), 'läckte: ' + secret);
  // Prognos: faktiskt saldo + uppskattningar, tydligt märkt
  const f = o.body.forecast;
  assert.equal(f.startIsActual, true);
  assert.deepEqual(f.horizons.map(h => h.days), [7, 14, 30]);
  const h30 = f.horizons[2];
  assert.ok(h30.items.some(i => i.kind === 'uppskattning' && /Fastighets/.test(i.label) && i.date === '2026-10-25'), JSON.stringify(h30.items));
  assert.match(f.disclaimer, /uppskattningar/);
});

test('transaktionslistan kan filtreras och kategori kan ändras', async () => {
  const all = await t.call('GET', '/api/admin/bank?view=transactions&from=2026-08-01&to=2026-10-31', undefined, { token: owner });
  assert.equal(all.body.total, 7);
  const out = await t.call('GET', '/api/admin/bank?view=transactions&from=2026-08-01&to=2026-10-31&direction=out&min=1000', undefined, { token: owner });
  assert.equal(out.body.total, 4);
  const q = await t.call('GET', '/api/admin/bank?view=transactions&from=2026-08-01&to=2026-10-31&q=nets', undefined, { token: owner });
  assert.equal(q.body.total, 2);
  const id = q.body.items[0].id;
  const set = await t.call('POST', '/api/admin/bank', { action: 'set_category', id, category: 'Kassa' }, { token: owner });
  assert.equal(set.status, 200);
  await t.call('POST', '/api/admin/bank', { action: 'sync' }, { token: owner });
  assert.equal(sql(t.db, `select category from bank_transactions where id = '${id}'`), 'Kassa'); // synk skriver inte över
});

test('bankfel loggas och visas, åtkomst och synk loggas utan hemligheter', async () => {
  failNext = 3;
  const r = await t.call('POST', '/api/admin/bank', { action: 'sync' }, { token: owner });
  assert.equal(r.status, 502);
  const o = await t.call('GET', '/api/admin/bank', undefined, { token: owner });
  assert.equal(o.body.overview.sync.status, 'error');
  const log = sql(t.db, "select string_agg(action || ':' || detail::text, ' ') from bank_access_log");
  assert.match(log, /sync_ok/); assert.match(log, /sync_error/); assert.match(log, /view_analysis/);
  for (const secret of ['HEMLIG', 'tok-1', 'klient-123']) assert.ok(!log.includes(secret));
});

test('testdata och riktiga data hålls isär', async () => {
  const t2 = setup({ env: { ...ENV, DANSKE_ENV: 'live', DANSKE_LIVE_ENABLED: 'ja' }, bankTransport: fakeDanske });
  try {
    sql(t2.db, "insert into bank_transactions (env, provider, account_id, tx_key, booking_date, amount) values ('sandbox', 'danske', 'a', 'k1', '2026-10-01', 100)");
    t2.auth.addUser('albert@albertno485.com', 'x-losen-12345', 'Albert');
    const tok = t2.auth.tokenFor('albert@albertno485.com');
    await t2.call('GET', '/api/admin/day', undefined, { token: tok });
    const o = await t2.call('GET', '/api/admin/bank', undefined, { token: tok });
    assert.equal(o.body.overview.transactionCount, 0); // sandbox-raden syns inte i live
    // Live anropar bankens produktionsadress, inte sandbox
    calls.length = 0;
    await t2.call('POST', '/api/admin/bank', { action: 'sync' }, { token: tok });
    assert.ok(calls[0].url.startsWith('https://api.danskebank.com/corporate/'));
  } finally { t2.close(); }
});

test('prognos och Fortnox-matchning skiljer faktiskt från uppskattat', () => {
  const transactions = [
    { date: '2026-09-25', amount: -26813, counterparty: 'Hyresvärden', category: 'Hyra & lokal' },
    { date: '2026-08-25', amount: -26813, counterparty: 'Hyresvärden', category: 'Hyra & lokal' },
    { date: '2026-10-10', amount: 28000, counterparty: 'Nets', category: 'Kortintäkter' },
    { date: '2026-10-14', amount: -4800, counterparty: 'Martin & Servera AB', category: 'Råvaror' },
  ];
  const payables = { list: [{ name: 'Martin & Servera', due: '2026-10-12', amount: 4800 }, { name: 'Vedbolaget', due: '2026-10-28', amount: 7100 }] };
  const f = forecast({ overview: { balanceSek: 100000 }, transactions, today: '2026-10-20', payables });
  const h14 = f.horizons[1];
  assert.equal(h14.knownOut, 11900);                 // Fortnox-fakturor = faktiska
  assert.equal(h14.estimatedOut, 26813);              // hyran = uppskattning
  assert.equal(h14.expectedIncome, 14000);            // 28000/28 dagar * 14
  assert.equal(h14.projected, 100000 + 14000 - 11900 - 26813);
  const m = matchFortnox({ transactions, payables, today: '2026-10-20' });
  assert.equal(m.items[0].status, 'troligen_betald');  // betald i banken men obetald i Fortnox → avvikelse
  assert.equal(m.items[1].status, 'obetald');
  assert.equal(m.deviations, 1);
});

test('granskning: felaktiga filter ger 400, synk bara via POST, behörighet försvinner vid rollbyte', async () => {
  for (const qs of ['from=abc', 'limit=1e3', 'limit=99999999999', 'min=abc', 'direction=all', 'offset=-1'])
    assert.equal((await t.call('GET', '/api/admin/bank?view=transactions&' + qs, undefined, { token: owner })).status, 400, qs);
  const pct = await t.call('GET', '/api/admin/bank?view=transactions&from=2026-01-01&q=%25', undefined, { token: owner });
  assert.equal(pct.status, 200); // % söks inte som jokertecken
  assert.equal((await t.call('GET', '/api/admin/bank?view=sync', undefined, { token: owner })).status, 400);
  assert.equal((await t.call('POST', '/api/admin/bank', { action: 'access', userId: adminId, allow: 'kanske' }, { token: owner })).status, 400);
  // Sara har behörighet sedan tidigare test. Byt till personal och tillbaka → behörigheten är borta.
  assert.equal((await t.call('GET', '/api/admin/bank', undefined, { token: admin })).status, 200);
  sql(t.db, `update staff set role = 'staff' where user_id = '${adminId}'`);
  sql(t.db, `update staff set role = 'admin' where user_id = '${adminId}'`);
  assert.equal((await t.call('GET', '/api/admin/bank', undefined, { token: admin })).status, 403);
});
