// Fortnox: koppla (OAuth), hämta banksaldo och leverantörsfakturor.
// Läser bara från Fortnox – skickar eller bokför aldrig något.
import { AppError } from './supabase.js';

const AUTH_URL = 'https://apps.fortnox.se/oauth-v1/auth';
const TOKEN_URL = 'https://apps.fortnox.se/oauth-v1/token';
const API = 'https://api.fortnox.se/3';
export const FORTNOX_SCOPES = ['bookkeeping', 'supplier', 'supplierinvoice', 'article', 'companyinformation'];

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

export function authorizeUrl(cfg, redirectUri, state) {
  const q = new URLSearchParams({ client_id: cfg.clientId, redirect_uri: redirectUri, scope: FORTNOX_SCOPES.join(' '), state, access_type: 'offline', response_type: 'code' });
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
    throw new AppError(502, 'Fortnox svarade ' + response.status + (msg ? ': ' + msg : '') + '.');
  }
  return body;
}

const day = d => d.toISOString().slice(0, 10);
const money = v => { const n = Number(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? Math.round(n * 100) / 100 : null; };

/** Hämtar data från Fortnox och sparar en sammanställning. */
export async function syncFortnox({ rpc, env, fetcher, now = () => new Date(), by = 'Automatiskt' }) {
  try {
    const { token, bankAccount } = await accessToken({ rpc, env, fetcher, now });
    const today = day(now());
    const years = await api(fetcher, token, '/financialyears?date=' + today);
    const year = years?.FinancialYears?.[0]?.Id;
    if (!year) throw new AppError(502, 'Hittar inget räkenskapsår i Fortnox för i dag.');
    const account = await api(fetcher, token, '/accounts/' + bankAccount + '?financialyear=' + year);
    const bankBalance = money(account?.Account?.BalanceCarriedForward);
    const from = day(new Date(now().getTime() - 120 * 864e5));
    const invoices = [];
    for (let page = 1; page <= 10; page++) {
      const r = await api(fetcher, token, '/supplierinvoices?fromdate=' + from + '&todate=' + today + '&limit=500&page=' + page);
      for (const i of r?.SupplierInvoices || []) {
        if (i.Cancelled === true || i.Cancelled === 'true') continue;
        invoices.push({ no: String(i.GivenNumber ?? ''), supplier: String(i.SupplierNumber ?? ''), name: String(i.SupplierName ?? '').slice(0, 80),
          date: String(i.InvoiceDate ?? '').slice(0, 10), total: money(i.Total), booked: i.Booked === true || i.Booked === 'true' });
      }
      if (page >= Number(r?.MetaInformation?.['@TotalPages'] || 1)) break;
    }
    return await rpc('api_fortnox_system', { action: 'save_sync', bankBalance, supplierInvoices: invoices.filter(i => /^\d{4}-\d{2}-\d{2}$/.test(i.date) && i.total !== null), by });
  } catch (error) {
    const message = error instanceof AppError ? error.message : 'Hämtningen från Fortnox misslyckades.';
    await rpc('api_fortnox_system', { action: 'save_error', error: message }).catch(() => {});
    throw error instanceof AppError ? error : new AppError(502, message);
  }
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
  };
}
