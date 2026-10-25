// Ekonomi & Bank – STRIKT ENDAST LÄSNING.
//
// Säkerhet i flera lager (inte bara instruktioner till AI):
//  1. Banken: OAuth-scope "accounts" (kontoinformation). Betalningsscopes begärs aldrig.
//  2. Den här koden: alla anrop går genom readOnlyRequest(), som bara släpper igenom
//     GET mot en uttrycklig tillåtelselista (lista konton, saldo, transaktioner) på bankens
//     egen värd – plus POST till bankens token-adress. Allt annat stoppas innan det skickas.
//  3. Servern: bara inloggad ägare/behörig admin, kontrolleras igen i databasen.
// Modulärt: fler banker läggs till i PROVIDERS med samma gränssnitt.
import https from 'node:https';
import { createHash } from 'node:crypto';
import { AppError } from './supabase.js';

export class BankReadOnlyError extends Error {}

// ---------- Danske Bank: Account Transaction & Balance API ----------
// Källa: developers.danskebank.com/premium-apis/account-transaction--and--balance-api
const DANSKE = {
  mock: {
    // Mönster enligt bankens Mock Service-sida. Exakt adress bekräftas mot API-specifikationen.
    api: 'https://mock-api.danskebank.com/mock/sandbox/v1/account-transaction-service',
    token: null,
  },
  sandbox: {
    api: 'https://sandbox-api.danskebank.com/sandbox-corporate/api/v1/account-transaction-service',
    token: 'https://sandbox-api.danskebank.com/sandbox-corporate/api/dk/business/oauth2/token',
  },
  live: {
    api: 'https://api.danskebank.com/corporate/api/v1/account-transaction-service',
    token: 'https://api.danskebank.com/corporate/api/dk/business/oauth2/token',
  },
};
// De enda läsoperationer som någonsin får anropas.
const READ_ONLY_PATHS = [
  /^\/accounts\/list$/,
  /^\/accounts\/[A-Za-z0-9._~-]{1,120}\/balances$/,
  /^\/accounts\/[A-Za-z0-9._~-]{1,120}\/transactions$/,
];
const READ_ONLY_QUERY = new Set(['offset', 'limit', 'bookingDateFrom', 'bookingDateTo']);
export const EARLIEST_BOOKING_DATE = '2025-03-01'; // enligt bankens dokumentation

const pem = v => { const s = String(v || '').trim(); if (!s) return ''; return s.includes('-----BEGIN') ? s.replace(/\\n/g, '\n') : Buffer.from(s, 'base64').toString('utf8'); };

// Vilken miljö gäller? Förhandsvisning = bankens testdata (mock) om inget annat är satt.
// Riktiga bankdata kräver BÅDE DANSKE_ENV=live OCH DANSKE_LIVE_ENABLED=ja.
export function bankConfig(env = {}) {
  let mode = String(env.DANSKE_ENV || '').trim().toLowerCase();
  if (!mode) mode = env.VERCEL_ENV === 'preview' ? 'mock' : 'off';
  if (!['mock', 'sandbox', 'live', 'off'].includes(mode)) mode = 'off';
  const liveBlocked = mode === 'live' && String(env.DANSKE_LIVE_ENABLED || '').trim().toLowerCase() !== 'ja';
  const clientId = String(env.DANSKE_CLIENT_ID || '').trim();
  const cert = pem(env.DANSKE_CLIENT_CERT_PEM), key = pem(env.DANSKE_CLIENT_KEY_PEM);
  const needsCert = mode === 'sandbox' || mode === 'live';
  const missing = [];
  if (needsCert) { if (!clientId) missing.push('DANSKE_CLIENT_ID'); if (!cert) missing.push('DANSKE_CLIENT_CERT_PEM'); if (!key) missing.push('DANSKE_CLIENT_KEY_PEM'); }
  if (liveBlocked) missing.push('DANSKE_LIVE_ENABLED=ja');
  const hosts = mode === 'off' ? null : { ...DANSKE[mode], api: mode === 'mock' && env.DANSKE_MOCK_BASE ? String(env.DANSKE_MOCK_BASE).replace(/\/+$/, '') : DANSKE[mode].api };
  return {
    provider: 'danske', mode, env: mode === 'off' ? null : mode, hosts, clientId, cert, key,
    passphrase: String(env.DANSKE_CLIENT_KEY_PASSPHRASE || ''), needsCert,
    configured: mode !== 'off' && missing.length === 0, missing,
  };
}

// Allt som går till banken passerar här. Stoppar allt som inte är en tillåten läsning.
export function assertReadOnly(cfg, method, urlText) {
  let url;
  try { url = new URL(urlText); } catch { throw new BankReadOnlyError('Ogiltig adress.'); }
  if (url.protocol !== 'https:') throw new BankReadOnlyError('Bara HTTPS är tillåtet.');
  if (cfg.hosts.token && urlText === cfg.hosts.token) {
    if (method !== 'POST') throw new BankReadOnlyError('Token-adressen tar bara emot POST.');
    return 'token';
  }
  if (method !== 'GET') throw new BankReadOnlyError('Bankintegrationen är endast läsning: ' + method + ' är spärrat.');
  const base = new URL(cfg.hosts.api);
  if (url.host !== base.host || !url.pathname.startsWith(base.pathname + '/')) throw new BankReadOnlyError('Adressen ligger utanför bankens kontoinformation.');
  const rest = url.pathname.slice(base.pathname.length);
  if (!READ_ONLY_PATHS.some(r => r.test(rest))) throw new BankReadOnlyError('Operationen finns inte på listan över tillåtna läsningar: ' + rest);
  for (const k of url.searchParams.keys()) if (!READ_ONLY_QUERY.has(k)) throw new BankReadOnlyError('Parametern ' + k + ' är inte tillåten.');
  return 'read';
}

// Anrop med klientcertifikat (mTLS) för sandbox/live. Används bara efter assertReadOnly.
function mtlsTransport(cfg) {
  return (urlText, init = {}) => new Promise((resolve, reject) => {
    const u = new URL(urlText);
    const req = https.request({ method: init.method || 'GET', hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search,
      headers: init.headers || {}, cert: cfg.cert, key: cfg.key, passphrase: cfg.passphrase || undefined, timeout: 20000 }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json: async () => JSON.parse(text || '{}'), text: async () => text });
      });
    });
    req.on('timeout', () => req.destroy(new Error('Banken svarade inte i tid.')));
    req.on('error', reject);
    if (init.body) req.write(init.body);
    req.end();
  });
}

function makeClient(cfg, { fetcher, transport }) {
  const send = transport || (cfg.needsCert ? mtlsTransport(cfg) : fetcher);
  let token = null;
  async function readOnlyRequest(method, urlText, init = {}) {
    assertReadOnly(cfg, method, urlText);
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await send(urlText, { ...init, method });
      if ((res.status === 429 || res.status >= 500) && attempt < 2) { await new Promise(r => setTimeout(r, 400 * (attempt + 1))); continue; }
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = new AppError(502, 'Banken svarade med fel ' + res.status + (body?.error_description || body?.message ? ': ' + String(body.error_description || body.message).slice(0, 120) : '') + '.');
        err.bankStatus = res.status; throw err;
      }
      return body;
    }
  }
  async function auth() {
    if (!cfg.hosts.token) return {};
    if (!token) {
      const form = new URLSearchParams({ grant_type: 'client_credentials', client_id: cfg.clientId, scope: 'accounts' });
      const t = await readOnlyRequest('POST', cfg.hosts.token, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() });
      if (!t.access_token) throw new AppError(502, 'Banken gav ingen åtkomsttoken.');
      token = t.access_token;
    }
    return { Authorization: 'Bearer ' + token };
  }
  const get = async (path, query) => {
    const q = query ? '?' + new URLSearchParams(query).toString() : '';
    return readOnlyRequest('GET', cfg.hosts.api + path + q, { headers: { Accept: 'application/json', 'X-Request-ID': crypto.randomUUID(), ...await auth() } });
  };
  return { get };
}

const num = v => { const n = Number(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? Math.round(n * 100) / 100 : null; };
const str = (v, n = 200) => (v === null || v === undefined ? '' : String(v)).replace(/\s+/g, ' ').trim().slice(0, n);
const date = v => /^\d{4}-\d{2}-\d{2}/.test(String(v || '')) ? String(v).slice(0, 10) : null;
const offsetOf = href => { try { return new URL(String(href), 'https://x.invalid').searchParams.get('offset'); } catch { return null; } };

// ---------- Kategorier (regler; kan ändras per transaktion i admin) ----------
const RULES = [
  ['Kortintäkter', /nets|bambora|worldline|adyen|swedbank pay|viva wallet|zettle|izettle|stripe|klarna|kortinl|card settlement/i, 'in'],
  ['Swish', /swish/i, 'any'],
  ['Skatt & moms', /skatteverket|skattekonto|skv\b|moms|preliminärskatt/i, 'any'],
  ['Lön', /\blön|salary|löner|lönekörning/i, 'out'],
  ['Hyra & lokal', /hyra|fastighet|lokal/i, 'out'],
  ['El & energi', /vattenfall|e\.?on|ellevio|elbolag|energi|göteborg energi|varberg energi/i, 'out'],
  ['Råvaror', /martin ?& ?servera|menigo|servera|grossist|axfood|dagab|ica |coop|willys|lidl|mozzarella|caputo|mjöl|livsmedel/i, 'out'],
  ['Programvara & system', /fortnox|caspeco|microsoft|google|adobe|wix|vercel|supabase|anthropic|resend|apple\.com|spotify/i, 'out'],
  ['Bank & avgifter', /avgift|fee|ränta|danske bank|bankavg/i, 'out'],
  ['Försäkring', /försäkring|insurance|\bif skade|trygg-hansa|länsförsäkr/i, 'out'],
];
export function categorize(t) {
  const text = (t.counterparty + ' ' + t.reference + ' ' + t.type).toLowerCase();
  for (const [name, re, dir] of RULES) {
    if ((dir === 'in' && t.amount <= 0) || (dir === 'out' && t.amount >= 0)) continue;
    if (re.test(text)) return name;
  }
  return t.amount > 0 ? 'Övriga intäkter' : 'Övriga kostnader';
}

export function normalizeTransaction(raw, accountId) {
  const amount = num(raw?.transactionAmount?.amount ?? raw?.amount);
  const bookingDate = date(raw?.bookingDate) || date(raw?.valueDate);
  if (amount === null || !bookingDate) return null;
  const rem = raw?.remittanceInformationUnstructured;
  const code = raw?.bankTransactionCode;
  const t = {
    account: accountId, date: bookingDate, valueDate: date(raw?.valueDate),
    amount, currency: str(raw?.transactionAmount?.currency || raw?.currency || 'SEK', 3).toUpperCase(),
    counterparty: str(raw?.creditor?.name || raw?.debtor?.name || raw?.creditorName || raw?.debtorName || raw?.counterpartyName),
    reference: str(Array.isArray(rem) ? rem.join(' ') : rem || raw?.remittanceInformationStructured || raw?.reference, 300),
    type: str(typeof code === 'string' ? code : code ? [code.domain, code.family, code.subFamily, code.code].filter(Boolean).join(' / ') : '', 80) || (amount < 0 ? 'Utbetalning' : 'Insättning'),
    transactionId: str(raw?.transactionId, 150),
  };
  t.category = categorize(t);
  return t;
}

// Unik nyckel: bankens transaktions-id, annars hash av innehållet (+ löpnummer för identiska rader).
function withKeys(list) {
  const seen = new Map();
  return list.map(t => {
    if (t.transactionId) return { ...t, key: 'id:' + t.account + ':' + t.transactionId };
    const base = createHash('sha256').update([t.account, t.date, t.amount, t.currency, t.counterparty, t.reference].join('|')).digest('hex').slice(0, 40);
    const n = (seen.get(base) || 0) + 1; seen.set(base, n);
    return { ...t, key: 'h:' + base + ':' + n };
  });
}

function pickBalance(body) {
  const list = Array.isArray(body?.balances) ? body.balances : [];
  const find = types => list.find(b => types.includes(String(b?.balanceType || '')));
  const booked = find(['interimBooked', 'closingBooked', 'expected']) || list[0];
  const avail = find(['interimAvailable', 'closingAvailable', 'available', 'forwardAvailable']);
  return {
    balance: num(booked?.balanceAmount?.amount), available: avail ? num(avail.balanceAmount?.amount) : null,
    balanceAt: booked?.referenceDate ? new Date(booked.referenceDate).toISOString() : null,
  };
}

const iso = d => d.toISOString().slice(0, 10);

// Hämtar konton, saldon och transaktioner och sparar dem. Skriver aldrig till banken.
export async function syncBank({ rpc, env, fetcher, transport, now = () => new Date(), by = '' }) {
  const cfg = bankConfig(env);
  if (cfg.mode === 'off') throw new AppError(409, 'Bankkopplingen är avstängd i den här miljön.');
  if (!cfg.configured) throw new AppError(409, 'Bankkopplingen saknar inställningar i Vercel: ' + cfg.missing.join(', ') + '.');
  const client = makeClient(cfg, { fetcher, transport });
  try {
    const accounts = [];
    let offset = null;
    for (let page = 0; page < 10; page++) {
      const body = await client.get('/accounts/list', offset ? { offset } : null);
      const list = Array.isArray(body?.accounts) ? body.accounts : Array.isArray(body) ? body : [];
      for (const a of list) {
        const id = str(a?.other || a?.resourceId || a?.id || a?.accountId, 120);
        if (!id || !/^[A-Za-z0-9._~-]{1,120}$/.test(id)) continue;
        accounts.push({ id, name: str(a?.name || a?.product || a?.ownerName || '', 120), iban: str(a?.iban, 40), bban: str(a?.bban, 40), currency: str(a?.currency || 'SEK', 3).toUpperCase() });
      }
      offset = body?.next?.href ? offsetOf(body.next.href) : null;
      if (!offset) break;
    }
    const last = (await rpc('api_bank_system', { env: cfg.env, action: 'last_date' }))?.lastDate;
    const today = now();
    let from = last ? iso(new Date(new Date(last + 'T12:00:00Z').getTime() - 7 * 864e5)) : iso(new Date(today.getTime() - 120 * 864e5));
    if (from < EARLIEST_BOOKING_DATE) from = EARLIEST_BOOKING_DATE;
    const transactions = [];
    for (const a of accounts) {
      Object.assign(a, pickBalance(await client.get('/accounts/' + a.id + '/balances')));
      const limit = 1000;
      let off = null;
      const rows = [];
      for (let page = 0; page < 20; page++) {
        const q = { bookingDateFrom: from, limit: String(limit) };
        if (off) q.offset = off;
        const body = await client.get('/accounts/' + a.id + '/transactions', q);
        const list = Array.isArray(body?.transactions) ? body.transactions : Array.isArray(body?.transactions?.booked) ? body.transactions.booked : [];
        for (const r of list) { const t = normalizeTransaction(r, a.id); if (t) rows.push({ ...t, raw: r }); }
        off = body?.next?.href ? offsetOf(body.next.href) : null;
        if (!off || list.length < limit) break;
      }
      transactions.push(...withKeys(rows));
    }
    const saved = await rpc('api_bank_system', { env: cfg.env, action: 'save_sync', provider: cfg.provider, by, accounts, transactions });
    return { env: cfg.env, accounts: accounts.length, received: transactions.length, added: saved.added };
  } catch (error) {
    const message = error instanceof BankReadOnlyError ? 'Spärrad: ' + error.message : (error instanceof AppError ? error.message : 'Kunde inte nå banken.');
    try { await rpc('api_bank_system', { env: cfg.env, action: 'save_error', provider: cfg.provider, by, error: message }); } catch { /* loggas ändå nedan */ }
    if (error instanceof BankReadOnlyError) throw new AppError(500, message);
    throw error instanceof AppError ? error : new AppError(502, message);
  }
}

// Visas i admin. Inga nycklar eller certifikat lämnar servern – bara om de finns.
export function bankStatus(env) {
  const cfg = bankConfig(env);
  return {
    provider: 'Danske Bank', mode: cfg.mode, env: cfg.env, configured: cfg.configured, missing: cfg.missing,
    hasClientId: !!cfg.clientId, hasCertificate: !!cfg.cert, hasKey: !!cfg.key, readOnly: true,
    label: { off: 'Avstängd', mock: 'Testdata (Danske Bank mock)', sandbox: 'Testmiljö (Danske Bank sandbox)', live: 'Riktiga bankdata' }[cfg.mode],
  };
}

// ---------- Prognos 7/14/30 dagar ----------
// Faktiska belopp: saldo nu och kända obetalda fakturor från Fortnox.
// Uppskattningar: återkommande kostnader och snittintäkt per dag, tydligt markerade.
const norm = s => String(s || '').toLowerCase().replace(/[^a-zåäö0-9 ]/g, ' ').replace(/\b(ab|hb|kb|aps|as|oy)\b/g, '').replace(/\s+/g, ' ').trim();
const addDays = (d, n) => iso(new Date(new Date(d + 'T12:00:00Z').getTime() + n * 864e5));
const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const r2 = n => Math.round(n * 100) / 100;

export function findRecurring(transactions, today) {
  const groups = new Map();
  for (const t of transactions) {
    if (t.amount >= 0 || !t.counterparty) continue;
    const k = norm(t.counterparty); if (!k) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  const out = [];
  for (const [k, list] of groups) {
    const months = new Set(list.map(t => t.date.slice(0, 7)));
    if (months.size < 2) continue;
    const amounts = list.map(t => -t.amount), med = median(amounts);
    if (amounts.filter(a => Math.abs(a - med) <= med * 0.15).length < 2) continue;
    const lastT = list.reduce((a, b) => (a.date > b.date ? a : b));
    const day = Number(median(list.map(t => Number(t.date.slice(8, 10)))));
    let next = lastT.date.slice(0, 8) + String(Math.min(day, 28)).padStart(2, '0');
    while (next <= lastT.date || next <= today) { const [y, m] = next.split('-').map(Number); const nm = m === 12 ? [y + 1, 1] : [y, m + 1]; next = nm[0] + '-' + String(nm[1]).padStart(2, '0') + '-' + String(Math.min(day, 28)).padStart(2, '0'); }
    out.push({ key: k, counterparty: lastT.counterparty, category: lastT.category, amount: r2(med), nextDate: next, lastDate: lastT.date });
  }
  return out.sort((a, b) => b.amount - a.amount);
}

export function forecast({ overview, transactions = [], today, payables = null }) {
  const start = overview?.balanceSek ?? null;
  const recurring = findRecurring(transactions, today);
  const since = addDays(today, -28);
  const recentIn = transactions.filter(t => t.amount > 0 && t.date > since && t.date <= today);
  const perDay = recentIn.length ? r2(recentIn.reduce((s, t) => s + t.amount, 0) / 28) : 0;
  const invoices = (payables?.list || []).filter(p => p.amount > 0);
  const horizons = [7, 14, 30].map(days => {
    const end = addDays(today, days);
    const known = invoices.filter(p => (p.due || today) <= end).map(p => ({ label: p.name || 'Leverantörsfaktura', date: p.due || today, amount: p.amount, kind: 'känd', source: 'Fortnox (obetald faktura)' }));
    const knownNames = new Set(known.map(k => norm(k.label)));
    const rec = recurring.filter(r => r.nextDate <= end && !knownNames.has(r.key)).map(r => ({ label: r.counterparty, date: r.nextDate, amount: r.amount, kind: 'uppskattning', source: 'Återkommande (' + r.category + ')' }));
    const income = r2(perDay * days);
    const out = r2(known.reduce((s, x) => s + x.amount, 0) + rec.reduce((s, x) => s + x.amount, 0));
    return {
      days, end, startBalance: start, expectedIncome: income, knownOut: r2(known.reduce((s, x) => s + x.amount, 0)), estimatedOut: r2(rec.reduce((s, x) => s + x.amount, 0)),
      projected: start === null ? null : r2(start + income - out), items: [...known, ...rec].sort((a, b) => a.date.localeCompare(b.date)),
    };
  });
  return {
    today, startBalance: start, startIsActual: start !== null, incomePerDay: perDay, incomeBasis: 'Snitt av insättningar senaste 28 dagarna (uppskattning)',
    recurring: recurring.slice(0, 15), horizons, fortnoxIncluded: !!payables,
    disclaimer: 'Saldo och Fortnox-fakturor är faktiska uppgifter. Intäkter och återkommande kostnader är uppskattningar baserade på historiken – inte bankuppgifter.',
  };
}

// ---------- Matchning mot Fortnox (bara läsning, ändrar inget) ----------
export function matchFortnox({ transactions = [], payables = null, today }) {
  if (!payables) return { available: false, note: 'Fortnox är inte kopplat eller har inte hämtats ännu.' };
  const debits = transactions.filter(t => t.amount < 0);
  const items = (payables.list || []).map(p => {
    const hit = debits.find(t => Math.abs(-t.amount - p.amount) <= 0.5 && (!p.due || t.date >= addDays(p.due, -45)));
    const nameHit = hit && norm(hit.counterparty) && norm(p.name).split(' ').some(w => w.length > 3 && norm(hit.counterparty).includes(w));
    return { supplier: p.name, due: p.due, amount: p.amount, overdue: !!p.due && p.due < today,
      status: hit ? (nameHit ? 'troligen_betald' : 'mojlig_match') : 'obetald',
      bank: hit ? { date: hit.date, amount: hit.amount, counterparty: hit.counterparty } : null };
  });
  return {
    available: true, unpaidCount: items.length,
    deviations: items.filter(i => i.status !== 'obetald').length,
    overdueCount: items.filter(i => i.overdue && i.status === 'obetald').length,
    items,
    note: 'Matchar obetalda leverantörsfakturor i Fortnox mot utbetalningar i banken (samma belopp). Inget ändras i Fortnox.',
  };
}
