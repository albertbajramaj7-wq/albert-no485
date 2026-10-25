// Fortnox: koppla (OAuth), hämta banksaldo och leverantörsfakturor.
// Läser bara från Fortnox – skickar eller bokför aldrig något.
import { AppError } from './supabase.js';

const AUTH_URL = 'https://apps.fortnox.se/oauth-v1/auth';
const TOKEN_URL = 'https://apps.fortnox.se/oauth-v1/token';
const API = 'https://api.fortnox.se/3';
// Grundbehörigheter. Kundfakturor (invoice) läggs till via FORTNOX_EXTRA_SCOPES=invoice i Vercel
// när behörigheten "Faktura" är ibockad i utvecklarportalen – annars nekar Fortnox inloggningen.
export const FORTNOX_SCOPES = ['bookkeeping', 'supplier', 'supplierinvoice', 'article', 'companyinformation'];
const scopesFor = env => [...new Set([...FORTNOX_SCOPES, ...String(env?.FORTNOX_EXTRA_SCOPES || '').split(/[\s,]+/).filter(x => /^[a-z]{3,40}$/.test(x))])];

export function fortnoxConfig(env) {
  const clientId = String(env.FORTNOX_CLIENT_ID || '').trim(), clientSecret = String(env.FORTNOX_CLIENT_SECRET || '').trim();
  return { clientId, clientSecret, configured: !!(clientId && clientSecret) };
}

// ---------- Kryptering av nycklarna (AES-256-GCM) ----------
async function cryptoKey(env) {
  const secret = String(env.FORTNOX_TOKEN_KEY || env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (secret.length < 20) throw new AppError(500, 'Servern saknar nyckel för att spara Fortnox-kopplingen.');
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('albert-fortnox:' + secret));
  return crypto.subtle.importKey('raw', hash, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
const b64 = bytes => Buffer.from(bytes).toString('base64');
export async function encryptTokens(env, tokens) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await cryptoKey(env), new TextEncoder().encode(JSON.stringify(tokens)));
  return 'v1.' + b64(iv) + '.' + b64(new Uint8Array(data));
}
export async function decryptTokens(env, text) {
  if (!text) return null;
  const [v, iv, data] = text.split('.');
  if (v !== 'v1') return null;
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(iv, 'base64') }, await cryptoKey(env), Buffer.from(data, 'base64'));
    return JSON.parse(new TextDecoder().decode(plain));
  } catch { return null; }
}

export function randomState() { return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex'); }

export function authorizeUrl(cfg, redirectUri, state, env) {
  const q = new URLSearchParams({ client_id: cfg.clientId, redirect_uri: redirectUri, scope: scopesFor(env).join(' '), state, access_type: 'offline', response_type: 'code' });
  return AUTH_URL + '?' + q.toString();
}

async function tokenRequest(cfg, fetcher, form) {
  const response = await fetcher(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Basic ' + Buffer.from(cfg.clientId + ':' + cfg.clientSecret).toString('base64') },
    body: new URLSearchParams(form).toString(),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) {
    const reason = body.error === 'invalid_grant' ? 'Fortnox-kopplingen har gått ut. Koppla Fortnox igen i admin.' : 'Fortnox svarade inte som väntat (' + response.status + ').';
    throw new AppError(502, reason);
  }
  return body;
}

export const exchangeCode = (cfg, fetcher, code, redirectUri) => tokenRequest(cfg, fetcher, { grant_type: 'authorization_code', code, redirect_uri: redirectUri });

/** Hämtar giltig access-token, förnyar vid behov och sparar de nya nycklarna. */
async function accessToken({ rpc, env, fetcher, now }) {
  const cfg = fortnoxConfig(env);
  if (!cfg.configured) throw new AppError(409, 'Fortnox-nycklarna saknas i Vercel (FORTNOX_CLIENT_ID och FORTNOX_CLIENT_SECRET).');
  const stored = await rpc('api_fortnox_system', { action: 'get_tokens' });
  const tokens = await decryptTokens(env, stored.dataEnc);
  if (!tokens?.refresh_token) throw new AppError(409, 'Fortnox är inte kopplat. Tryck "Koppla Fortnox".');
  if (tokens.access_token && tokens.expires_at > now().getTime() + 60000) return { token: tokens.access_token, bankAccount: stored.bankAccount };
  const fresh = await tokenRequest(cfg, fetcher, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
  // Fortnox byter refresh-token vid varje förnyelse – spara direkt.
  await rpc('api_fortnox_system', { action: 'save_tokens', dataEnc: await encryptTokens(env, {
    access_token: fresh.access_token, refresh_token: fresh.refresh_token || tokens.refresh_token, expires_at: now().getTime() + (fresh.expires_in || 3600) * 1000 }) });
  return { token: fresh.access_token, bankAccount: stored.bankAccount };
}

async function api(fetcher, token, path) {
  const response = await fetcher(API + path, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const msg = body?.ErrorInformation?.message || body?.ErrorInformation?.Message || '';
    if (response.status === 401) throw new AppError(502, 'Fortnox nekade åtkomst. Koppla Fortnox igen i admin.');
    if (response.status === 403) throw new AppError(502, 'Fortnox saknar behörighet för ' + path.split('?')[0].replace('/', '') + '. Kontrollera behörigheterna i utvecklarportalen och licenserna i Fortnox.');
    const step = path.split('?')[0].replace(/^\//, '').split('/')[0];
    throw Object.assign(new AppError(502, 'Fortnox svarade ' + response.status + ' på ' + step + (msg ? ': ' + msg.replace(/\.+$/, '') : '') + '.'), { fortnoxStatus: response.status });
  }
  return body;
}

// Text-svar (SIE-export). Samma felhantering som api().
async function apiText(fetcher, token, path) {
  const response = await fetcher(API + path, { headers: { Authorization: 'Bearer ' + token, Accept: 'text/plain, */*' } });
  if (!response.ok) {
    const step = path.split('?')[0].replace(/^\//, '').split('/')[0];
    throw Object.assign(new AppError(502, 'Fortnox svarade ' + response.status + ' på ' + step + '.'), { fortnoxStatus: response.status });
  }
  return response.text();
}

// SIE typ 1 (årssaldon): #UB = utgående saldo för balanskonton, #RES = årets resultat per resultatkonto.
// Till skillnad från kontolistan räknas allt som är bokfört i år med, även ett företags första år.
export function parseSie(text) {
  const out = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/^#(UB|RES)\s+0\s+(\d{4})\s+(-?\d+(?:[.,]\d+)?)/);
    if (m) out.set(Number(m[2]), Math.round(Number(m[3].replace(',', '.')) * 100) / 100);
  }
  return out;
}

const day = d => d.toISOString().slice(0, 10);
const money = v => { const n = Number(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? Math.round(n * 100) / 100 : null; };

/** Hämtar data från Fortnox och sparar en sammanställning. Varje del hämtas för sig,
 *  så att ett fel i en del (t.ex. fakturorna) inte stoppar resten (t.ex. banksaldot). */
export async function syncFortnox({ rpc, env, fetcher, now = () => new Date(), by = 'Automatiskt' }) {
  let token, bankAccount;
  try { ({ token, bankAccount } = await accessToken({ rpc, env, fetcher, now })); }
  catch (error) {
    const message = error instanceof AppError ? error.message : 'Hämtningen från Fortnox misslyckades.';
    await rpc('api_fortnox_system', { action: 'save_error', error: message }).catch(() => {});
    throw error instanceof AppError ? error : new AppError(502, message);
  }
  const today = day(now()), from = day(new Date(now().getTime() - 120 * 864e5));
  const errors = [];
  // Försök med flera varianter av samma anrop; Fortnox är noga med parametrar.
  const tryPaths = async paths => { let last; for (const p of paths) { try { return await api(fetcher, token, p); } catch (e) { last = e; if (e.fortnoxStatus !== 400 && e.fortnoxStatus !== 404) throw e; } } throw last; };

  // 1) Banksaldo
  let bankBalance = null;
  try {
    const years = await tryPaths(['/financialyears', '/financialyears?date=' + today]);
    const list = years?.FinancialYears || [];
    const year = (list.find(y => y.FromDate <= today && y.ToDate >= today) || list[list.length - 1])?.Id;
    const account = await tryPaths([...(year ? ['/accounts/' + bankAccount + '?financialyear=' + year] : []), '/accounts/' + bankAccount]);
    bankBalance = money(account?.Account?.BalanceCarriedForward);
  } catch (e) { errors.push('Banksaldo: ' + (e instanceof AppError ? e.message : 'kunde inte hämtas.')); }

  // 2) Leverantörsfakturor senaste 120 dagarna
  const invoices = [];
  try {
    for (let page = 1; page <= 10; page++) {
      const r = await tryPaths([
        '/supplierinvoices?fromdate=' + from + '&todate=' + today + '&limit=500&page=' + page,
        '/supplierinvoices?limit=500&page=' + page,
        ...(page === 1 ? ['/supplierinvoices'] : []),
      ]);
      for (const i of r?.SupplierInvoices || []) {
        if (i.Cancelled === true || i.Cancelled === 'true') continue;
        const date = String(i.InvoiceDate ?? '').slice(0, 10);
        if (date < from || date > today) continue;
        invoices.push({ no: String(i.GivenNumber ?? ''), supplier: String(i.SupplierNumber ?? ''), name: String(i.SupplierName ?? '').slice(0, 80),
          date, total: money(i.Total), booked: i.Booked === true || i.Booked === 'true' });
      }
      if (page >= Number(r?.MetaInformation?.['@TotalPages'] || 1)) break;
    }
  } catch (e) { errors.push('Fakturor: ' + (e instanceof AppError ? e.message : 'kunde inte hämtas.')); }

  // 3) Ekonomiöversikt: alla konton med saldo, obetalda leverantörs- och kundfakturor
  let overview = null;
  try { overview = await buildOverview({ fetcher, token, today, tryPaths, bankAccount }); }
  catch (e) { errors.push('Översikt: ' + (e instanceof AppError ? e.message : 'kunde inte hämtas.')); }

  if (errors.length >= 2 && bankBalance === null && !invoices.length && !overview) {
    const message = errors.join(' ');
    await rpc('api_fortnox_system', { action: 'save_error', error: message }).catch(() => {});
    throw new AppError(502, message);
  }
  // Banksaldot från SIE (bokfört i år) är mer rätt än kontolistans ingående balans.
  if (overview?.source === 'SIE') bankBalance = overview.balances.bankAccount;
  if (overview) { try { await rpc('api_fortnox_overview', { overview }); } catch { errors.push('Översikten sparades inte (kör 0007_fortnox_ekonomi.sql i Supabase).'); } }
  const status = await rpc('api_fortnox_system', { action: 'save_sync', bankBalance, supplierInvoices: invoices.filter(i => /^\d{4}-\d{2}-\d{2}$/.test(i.date) && i.total !== null), by });
  if (errors.length) return await rpc('api_fortnox_system', { action: 'save_error', error: errors.join(' ') });
  return status;
}

// Kontointervall enligt BAS-kontoplanen.
const inRange = (n, a, b) => n >= a && n <= b;
const sumAcc = (accounts, a, b) => Math.round(accounts.filter(x => inRange(x.n, a, b)).reduce((s, x) => s + x.v, 0) * 100) / 100;

async function buildOverview({ fetcher, token, today, tryPaths, bankAccount }) {
  const notes = [];
  // Räkenskapsår
  const years = (await tryPaths(['/financialyears', '/financialyears?date=' + today]))?.FinancialYears || [];
  const fy = years.find(y => y.FromDate <= today && y.ToDate >= today) || years[years.length - 1] || null;
  // Alla konton med utgående saldo (bokfört hittills i år)
  const accounts = [], names = new Map(), carried = new Map();
  for (let page = 1; page <= 10; page++) {
    const r = await tryPaths([...(fy ? ['/accounts?financialyear=' + fy.Id + '&limit=500&page=' + page] : []), '/accounts?limit=500&page=' + page]);
    for (const a of r?.Accounts || []) {
      const n = Number(a.Number), v = money(a.BalanceCarriedForward);
      if (!Number.isInteger(n)) continue;
      names.set(n, String(a.Description || '').slice(0, 60));
      if (v !== null && v !== 0) carried.set(n, v);
    }
    if (page >= Number(r?.MetaInformation?.['@TotalPages'] || 1)) break;
  }
  // Saldon: helst från SIE-exporten (räknar med allt bokfört i år). Annars kontolistans värden.
  let values = null, source = 'kontolistan';
  try { values = parseSie(await apiText(fetcher, token, '/sie/1' + (fy ? '?financialyear=' + fy.Id : ''))); source = 'SIE'; }
  catch (e) { notes.push('Årets bokföring kunde inte läsas via SIE-export, saldona kan vara ofullständiga.'); }
  for (const [n, v] of (values && values.size ? values : carried)) if (v) accounts.push({ n, name: names.get(n) || 'Konto ' + n, v });
  const neg = x => Math.round(-x * 100) / 100;
  const revenue = neg(sumAcc(accounts, 3000, 3999));
  const goods = sumAcc(accounts, 4000, 4999), external = sumAcc(accounts, 5000, 6999), staff = sumAcc(accounts, 7000, 7699), depreciation = sumAcc(accounts, 7700, 7899);
  const financial = neg(sumAcc(accounts, 8000, 8799)), result = neg(sumAcc(accounts, 3000, 8999));
  const pct = x => revenue > 0 ? Math.round(x / revenue * 1000) / 10 : null;
  const balances = {
    bank: sumAcc(accounts, 1900, 1989), bankAccount: sumAcc(accounts, bankAccount, bankAccount),
    taxAccount: sumAcc(accounts, 1630, 1630), receivables: sumAcc(accounts, 1510, 1519),
    payables: neg(sumAcc(accounts, 2440, 2449)), vatToPay: neg(sumAcc(accounts, 2610, 2650)),
    payrollTax: neg(sumAcc(accounts, 2710, 2710)), employerFees: neg(sumAcc(accounts, 2730, 2739)), taxDebt: neg(sumAcc(accounts, 2510, 2518)),
  };
  // Obetalda leverantörsfakturor (kommande betalningar)
  let payables = null;
  try {
    const list = [];
    for (let page = 1; page <= 5; page++) {
      const r = await tryPaths(['/supplierinvoices?filter=unpaid&limit=500&page=' + page]);
      for (const i of r?.SupplierInvoices || []) list.push({ name: String(i.SupplierName || '').slice(0, 60), due: String(i.DueDate || '').slice(0, 10), amount: money(i.Balance ?? i.Total) ?? 0, total: money(i.Total) ?? 0 });
      if (page >= Number(r?.MetaInformation?.['@TotalPages'] || 1)) break;
    }
    list.sort((a, b) => a.due.localeCompare(b.due));
    const in7 = new Date(new Date(today + 'T12:00:00Z').getTime() + 7 * 864e5).toISOString().slice(0, 10);
    payables = { count: list.length, total: Math.round(list.reduce((s, x) => s + x.amount, 0) * 100) / 100,
      overdue: list.filter(x => x.due && x.due < today).reduce((s, x) => s + x.amount, 0),
      next7: list.filter(x => x.due >= today && x.due <= in7).reduce((s, x) => s + x.amount, 0), list: list.slice(0, 25) };
  } catch (e) { notes.push('Obetalda leverantörsfakturor kunde inte hämtas.'); }
  // Obetalda kundfakturor (kräver behörigheten Faktura)
  let receivables = null;
  try {
    const r = await api(fetcher, token, '/invoices?filter=unpaid&limit=500');
    const list = (r?.Invoices || []).map(i => ({ name: String(i.CustomerName || '').slice(0, 60), due: String(i.DueDate || '').slice(0, 10), amount: money(i.Balance ?? i.Total) ?? 0 }));
    list.sort((a, b) => a.due.localeCompare(b.due));
    receivables = { count: list.length, total: Math.round(list.reduce((s, x) => s + x.amount, 0) * 100) / 100, overdue: list.filter(x => x.due && x.due < today).reduce((s, x) => s + x.amount, 0), list: list.slice(0, 25) };
  } catch (e) { notes.push(e.fortnoxStatus === 403 || /behörighet/.test(e.message) ? 'Kundfakturor: lägg till behörigheten Faktura i Fortnox utvecklarportal för att se dem.' : 'Kundfakturor kunde inte hämtas.'); }
  const top = (a, b, n) => accounts.filter(x => inRange(x.n, a, b)).sort((x, y) => Math.abs(y.v) - Math.abs(x.v)).slice(0, n).map(x => ({ account: x.n, name: x.name, amount: Math.round(Math.abs(x.v) * 100) / 100 }));
  return {
    asOf: today, source, financialYear: fy ? { from: fy.FromDate, to: fy.ToDate } : null, balances,
    result: { revenue, goods, external, staff, depreciation, financial, result, goodsPct: pct(goods), staffPct: pct(staff), externalPct: pct(external) },
    topCosts: top(4000, 7999, 8), topRevenue: top(3000, 3999, 5), payables, receivables, notes,
  };
}

/** Efter godkännande i Fortnox: byt kod mot nycklar och spara krypterat. */
export async function completeConnect({ rpc, env, fetcher, now = () => new Date(), code, state }) {
  const cfg = fortnoxConfig(env);
  if (!cfg.configured) throw new AppError(409, 'Fortnox-nycklarna saknas i Vercel.');
  if (!code || !state) throw new AppError(400, 'Fortnox skickade ingen kod.');
  const s = await rpc('api_fortnox_system', { action: 'take_state', state });
  const t = await exchangeCode(cfg, fetcher, code, s.redirectUri);
  let companyName = '';
  try { companyName = String((await api(fetcher, t.access_token, '/companyinformation'))?.CompanyInformation?.CompanyName || ''); } catch { /* namnet är bara för visning */ }
  await rpc('api_fortnox_system', { action: 'save_tokens', actor: s.actor, scope: t.scope || '', companyName,
    dataEnc: await encryptTokens(env, { access_token: t.access_token, refresh_token: t.refresh_token, expires_at: now().getTime() + (t.expires_in || 3600) * 1000 }) });
  return { actor: s.actor };
}

/** Förslag per vecka och budgetpost från leverantörsfakturor (kronor inkl moms). */
export function fortnoxSuggestions(status) {
  const map = status?.supplierMap || {}, out = {};
  for (const i of status?.supplierInvoices || []) {
    const post = map[i.supplier];
    if (!post) continue;
    const d = new Date(i.date + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    const week = d.toISOString().slice(0, 10);
    out[week] ??= {}; out[week][post] = Math.round(((out[week][post] || 0) + i.total) * 100) / 100;
  }
  return out;
}

/** Kort sammanfattning till admin (utan fakturalistan i sin helhet). */
export function fortnoxSummary(status, env) {
  const suppliers = {};
  for (const i of status?.supplierInvoices || []) {
    const s = suppliers[i.supplier] ??= { number: i.supplier, name: i.name, count: 0, total: 0 };
    s.count++; s.total = Math.round((s.total + i.total) * 100) / 100;
  }
  return {
    configured: fortnoxConfig(env).configured, connected: !!status?.connected, companyName: status?.companyName || '',
    connectedBy: status?.connectedBy || null, connectedAt: status?.connectedAt || null,
    bankAccount: status?.bankAccount ?? 1930, bankBalance: status?.bankBalance ?? null, bankAsOf: status?.bankAsOf || null,
    syncedAt: status?.syncedAt || null, syncedBy: status?.syncedBy || null, lastError: status?.lastError || null,
    supplierMap: status?.supplierMap || {}, suppliers: Object.values(suppliers).sort((a, b) => b.total - a.total),
    suggestions: fortnoxSuggestions(status),
    overview: status?.overview || null, overviewAt: status?.overviewAt || null, scope: status?.scope || '',
  };
}
