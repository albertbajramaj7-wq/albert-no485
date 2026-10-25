// Serverns alla API-anrop. Samma adresser som ChatGPT:s version, plus nya adminfunktioner.
// Ren JavaScript utan externa paket, så den körs som en Vercel-funktion och i testerna.
import { AppError } from './supabase.js';
import { emailConfiguration, sendBookingEmail } from './email.js';
import { BudgetError, computeBudget, normalizeSettings, normalizeWeek } from './budget.js';
import { askAi, aiConfig } from './ai.js';
import { authorizeUrl, completeConnect, fortnoxConfig, fortnoxSummary, randomState, syncFortnox } from './fortnox.js';
import { bankConfig, bankStatus, forecast, matchFortnox, syncBank } from './bank.js';

const AT = 'alb_at', RT = 'alb_rt';
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/;

function json(value, status = 200, cookies = []) {
  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);
  return new Response(JSON.stringify(value), { status, headers });
}

function parseCookies(header) {
  const out = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) { try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignorera trasig cookie */ } }
  }
  return out;
}

function cookie(name, value, maxAge, secure) {
  return `${name}=${encodeURIComponent(value)}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

function stockholmToday(now) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm' }).format(now);
}

/**
 * deps: { rpc, auth, env, now?: () => Date, fetcher? }
 * Returnerar en funktion (Request) => Promise<Response>.
 */
export function createApp({ rpc, auth, env = {}, now = () => new Date(), fetcher = fetch, diagnose, bankTransport }) {
  const ownerEmail = (env.ADMIN_OWNER_EMAIL || '').trim().toLowerCase();

  // Spärr mot för många försök. Bara en hash av IP-adressen används. Saknas funktionen
  // i databasen (migrering 0006 ej körd) släpps anropet igenom i stället för att stoppa bokningar.
  async function clientHash(request) {
    const ip = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || request.headers.get('x-real-ip') || 'okand';
    const salt = String(env.RATE_LIMIT_SALT || env.SUPABASE_SERVICE_ROLE_KEY || 'albert').slice(-24);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(salt + '|' + ip));
    return Buffer.from(digest).toString('hex').slice(0, 32);
  }
  async function limit(key, max, seconds) {
    if (env.DISABLE_RATE_LIMIT === '1') return; // bara i automatiska tester
    try { await rpc('api_rate_limit', { key, max, seconds }); }
    catch (error) { if (error instanceof AppError && error.status === 429) throw error; console.error('Rate limit check skipped'); }
  }
  async function maintenance(force = false) {
    try { return await rpc('api_maintenance', force ? { force: true } : {}); } catch { return null; }
  }

  async function session(request, url) {
    const secure = !LOCAL.test(url.hostname);
    const jar = parseCookies(request.headers.get('cookie'));
    let token = jar[AT], user = token ? await auth.user(token) : null;
    const setCookies = [];
    if (!user && jar[RT]) {
      const refreshed = await auth.refresh(jar[RT]);
      if (refreshed?.access_token) {
        token = refreshed.access_token; user = refreshed.user || await auth.user(token);
        setCookies.push(cookie(AT, refreshed.access_token, refreshed.expires_in || 3600, secure), cookie(RT, refreshed.refresh_token, 60 * 60 * 24 * 30, secure));
      }
    }
    if (!user?.id) throw Object.assign(new AppError(401, 'Logga in för att öppna admin.'), { clearCookies: !!(jar[AT] || jar[RT]) });
    const actor = await rpc('api_authorize', { userId: user.id, email: user.email || '', emailConfirmed: !!user.email_confirmed_at, ownerEmail, name: user.user_metadata?.name || '' });
    return { actor, token, setCookies };
  }

  async function handle(request) {
    const url = new URL(request.url);
    const secure = !LOCAL.test(url.hostname);
    const forwarded = request.headers.get('x-forwarded-host');
    const allowedOrigins = new Set([url.origin, env.APP_ORIGIN, forwarded && `https://${forwarded}`].filter(Boolean));
    let path = url.pathname.replace(/\/+$/, '');
    if (!path.startsWith('/api/') || path === '/api/router') path = '/api/' + (url.searchParams.get('path') || '').replace(/^\/+|\/+$/g, '');
    const method = request.method;
    let cookies = [];
    try {
      if (method !== 'GET' && method !== 'POST') throw new AppError(405, 'Metoden stöds inte.');
      if (method === 'POST') {
        const origin = request.headers.get('origin');
        if ((origin && !allowedOrigins.has(origin)) || request.headers.get('sec-fetch-site') === 'cross-site') throw new AppError(403, 'Åtgärden måste skickas från hemsidan.');
        if (!request.headers.get('content-type')?.includes('application/json')) throw new AppError(415, 'Använd JSON för den här åtgärden.');
        if (Number(request.headers.get('content-length') || 0) > (path === '/api/admin/ai' ? 60000 : 10000)) throw new AppError(413, 'För mycket information skickades.');
      }
      const bodyText = method === 'GET' ? '' : await request.text();
      if (bodyText.length > (path === '/api/admin/ai' ? 60000 : 10000)) throw new AppError(413, 'För mycket information skickades.');
      let input = {};
      if (bodyText) { try { input = JSON.parse(bodyText); } catch { throw new AppError(400, 'Informationen kunde inte läsas.'); } }
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AppError(400, 'Informationen kunde inte läsas.');
      // Fält som bara servern får sätta.
      delete input.actor; delete input.now; delete input.emailConfirmed;
      const q = name => url.searchParams.get(name);

      // ---------- Publikt ----------
      if (path === '/api/availability' && method === 'GET') {
        return json(await rpc('api_availability', { date: q('date'), count: Number(q('count')), mode: q('mode'), guests: Number(q('guests')) }));
      }
      if (path === '/api/health' && method === 'GET' && diagnose) return json(await diagnose());
      if (path === '/api/menu' && method === 'GET') {
        const response = json(await rpc('api_menu', {}));
        response.headers.set('Cache-Control', 'public, max-age=60');
        return response;
      }
      if (path === '/api/bookings' && method === 'POST') {
        const who = await clientHash(request);
        await limit('book:' + who, 8, 600);      // högst 8 bokningsförsök per 10 min från samma avsändare
        await limit('book:alla', 150, 600);       // och högst 150 totalt per 10 min
        if (input.website) throw new AppError(400, 'Bokningen kunde inte skickas.');
        if (input.accepted !== true) throw new AppError(400, 'Bekräfta bokningsvillkoren.');
        const key = request.headers.get('idempotency-key') || '';
        const booking = await rpc('api_create_booking', { key, date: input.date, time: input.time, count: input.count, mode: input.mode, guests: input.guests,
          contact: { name: input.contact?.name, email: input.contact?.email, phone: input.contact?.phone } });
        let email = { status: 'pending' };
        try { email = await sendBookingEmail(rpc, booking.id, env, { now: now(), fetcher }); }
        catch { console.error('Booking confirmation email remains unverified'); }
        return json({ ...booking, email: { status: email.status } }, 201);
      }

      // ---------- Inloggning ----------
      if (path === '/api/auth/login' && method === 'POST') {
        await limit('login:' + await clientHash(request), 10, 600);
        const email = String(input.email || '').trim().toLowerCase(), password = String(input.password || '');
        if (!email || !password) throw new AppError(400, 'Skriv e-post och lösenord.');
        const result = await auth.login(email, password);
        const actor = await rpc('api_authorize', { userId: result.user?.id, email: result.user?.email || email, emailConfirmed: !!result.user?.email_confirmed_at, ownerEmail, name: result.user?.user_metadata?.name || '' });
        return json({ ok: true, actor: { name: actor.name, role: actor.role } }, 200, [
          cookie(AT, result.access_token, result.expires_in || 3600, secure), cookie(RT, result.refresh_token, 60 * 60 * 24 * 30, secure)]);
      }
      if (path === '/api/auth/logout' && method === 'POST') {
        const jar = parseCookies(request.headers.get('cookie'));
        await auth.logout(jar[AT]);
        return json({ ok: true }, 200, [cookie(AT, '', 0, secure), cookie(RT, '', 0, secure)]);
      }

      // ---------- Fortnox: tillbaka efter godkännande, och nattlig hämtning ----------
      if (path === '/api/fortnox/callback' && method === 'GET') {
        const go = target => new Response(null, { status: 302, headers: { Location: target, 'Cache-Control': 'no-store' } });
        if (q('error')) return go('/admin/?fortnox=avbrutet');
        try {
          await completeConnect({ rpc, env, fetcher, now, code: q('code'), state: q('state') });
          try { await syncFortnox({ rpc, env, fetcher, now, by: 'Vid koppling' }); } catch { /* visas i admin */ }
          return go('/admin/?fortnox=kopplat');
        } catch (error) {
          return go('/admin/?fortnox=fel&info=' + encodeURIComponent(error instanceof AppError ? error.message : 'Kopplingen misslyckades.'));
        }
      }
      if (path === '/api/cron/nightly' && method === 'GET') {
        const secret = String(env.CRON_SECRET || '');
        if (!secret || request.headers.get('authorization') !== 'Bearer ' + secret) throw new AppError(401, 'Ej behörig.');
        const result = { maintenance: await maintenance(true) };
        if (fortnoxConfig(env).configured) {
          try { result.fortnox = (await syncFortnox({ rpc, env, fetcher, now, by: 'Automatiskt (natt)' })).syncedAt; } catch (error) { result.fortnox = 'fel'; }
        }
        if (bankConfig(env).configured) {
          try { result.bank = (await syncBank({ rpc, env, fetcher, transport: bankTransport, now, by: 'Automatiskt (natt)' })).added; } catch (error) { result.bank = 'fel'; }
        }
        return json({ ok: true, ...result });
      }
      if (path === '/api/cron/fortnox' && method === 'GET') {
        const secret = String(env.CRON_SECRET || '');
        if (!secret || request.headers.get('authorization') !== 'Bearer ' + secret) throw new AppError(401, 'Ej behörig.');
        // Körs var 15:e minut (vercel.json). Hoppar över det som inte är kopplat.
        const result = {};
        if (fortnoxConfig(env).configured) {
          try { result.fortnox = (await syncFortnox({ rpc, env, fetcher, now, by: 'Automatiskt' })).syncedAt; } catch (error) { result.fortnox = error.status === 409 ? 'ej kopplat' : 'fel'; }
        }
        if (bankConfig(env).configured) {
          try { result.bank = (await syncBank({ rpc, env, fetcher, transport: bankTransport, now, by: 'Automatiskt' })).added; } catch { result.bank = 'fel'; }
        }
        return json({ ok: true, ...result });
      }

      if (!path.startsWith('/api/admin/') && path !== '/api/auth/password') throw new AppError(404, 'Sidan finns inte.');

      // ---------- Kräver inloggning ----------
      const s = await session(request, url);
      cookies = s.setCookies;
      const actor = s.actor.user_id;
      const reply = (value, status = 200) => json(value, status, cookies);
      const withEmail = async value => ({ ...value, emailSetup: { configured: emailConfiguration(env).configured } });

      if (path === '/api/auth/password' && method === 'POST') {
        const password = String(input.password || '');
        if (password.length < 10) throw new AppError(400, 'Välj ett lösenord med minst 10 tecken.');
        await auth.changeOwnPassword(s.token, password);
        return reply({ ok: true });
      }
      if (path === '/api/admin/day' && method === 'GET') { await maintenance(); }
      if (path === '/api/admin/day' && method === 'GET') return reply(await withEmail(await rpc('api_admin_day', { actor, date: q('date') || stockholmToday(now()) })));
      if (path === '/api/admin/availability' && method === 'GET') {
        return reply(await rpc('api_availability', { date: q('date'), count: Number(q('count')), mode: q('mode'), guests: Number(q('guests')) }));
      }
      if (path === '/api/admin/phone-booking' && method === 'POST') {
        // Bokning som personalen lägger in, t.ex. när en kund ringer. Samma kapacitetsregler som på hemsidan.
        const booking = await rpc('api_create_booking', { actor, key: input.key, date: input.date, time: input.time, count: input.count, mode: input.mode, guests: input.guests,
          contact: { name: input.contact?.name, email: input.contact?.email || '', phone: input.contact?.phone } });
        let email = { status: 'none' };
        if (input.contact?.email) { try { email = await sendBookingEmail(rpc, booking.id, env, { now: now(), fetcher }); } catch { email = { status: 'pending' }; } }
        return reply({ booking, email: { status: email.status } });
      }
      if (path === '/api/admin/counter' && method === 'POST') return reply(await withEmail(await rpc('api_admin_counter', { ...input, actor })));
      if (path === '/api/admin/dropin' && method === 'POST') {
        const out = await rpc('api_admin_dropin', { ...input, actor });
        return reply(input?.action === 'suggest' || !input?.action ? out : await withEmail(out));
      }
      if (path === '/api/admin/settings' && method === 'POST') return reply(await withEmail(await rpc('api_admin_save_day', { ...input, actor })));
      if (path === '/api/admin/booking' && method === 'POST') return reply(await withEmail(await rpc('api_admin_booking', { ...input, actor })));
      if (path === '/api/admin/task' && method === 'POST') return reply(await withEmail(await rpc('api_admin_task', { ...input, actor })));
      if (path === '/api/admin/waste' && method === 'POST') return reply(await withEmail(await rpc('api_admin_waste', { ...input, actor })));
      if (path === '/api/admin/email' && method === 'POST') {
        const { date } = await rpc('api_email_request', { actor, id: input.id });
        const emailAction = await sendBookingEmail(rpc, input.id, env, { now: now(), fetcher });
        return reply({ ...await withEmail(await rpc('api_admin_day', { actor, date })), emailAction });
      }
      if (path === '/api/admin/stats' && method === 'GET') {
        const to = q('to') || stockholmToday(now());
        if (!DAY.test(to) || Number.isNaN(Date.parse(to + 'T12:00:00Z'))) throw new AppError(400, 'Välj ett giltigt datum.');
        const from = q('from') || new Date(Date.parse(to + 'T12:00:00Z') - 6 * 864e5).toISOString().slice(0, 10);
        if (!DAY.test(from) || !DAY.test(to)) throw new AppError(400, 'Välj ett giltigt datum.');
        return reply(await rpc('api_admin_stats', { actor, from, to }));
      }
      if (path === '/api/admin/stock') return reply(await rpc('api_stock', method === 'GET' ? { actor, action: 'list' } : { ...input, actor }));
      if (path === '/api/admin/purchase') return reply(await rpc('api_purchase', method === 'GET' ? { actor, action: 'list' } : { ...input, actor }));
      if (path === '/api/admin/budget') {
        // Veckobudget: databasen sparar, lib/budget.js räknar (samma som Google-arket).
        const clean = fn => { try { return fn(); } catch (error) { if (error instanceof BudgetError) throw new AppError(400, error.message); throw error; } };
        let body = { actor, action: 'get' };
        if (method === 'POST' && input.action === 'save_settings') body = { actor, action: 'save_settings', settings: clean(() => normalizeSettings(input.settings)) };
        else if (method === 'POST' && input.action === 'save_week') {
          const current = await rpc('api_budget', { actor, action: 'get' });
          body = { actor, action: 'save_week', week: clean(() => normalizeWeek(input.week, normalizeSettings(current.settings))) };
        } else if (method === 'POST') throw new AppError(400, 'Okänd åtgärd.');
        const result = await rpc('api_budget', body);
        const fortnox = fortnoxSummary(await rpc('api_fortnox', { actor, action: 'status' }), env);
        return reply({ ...clean(() => computeBudget(result.settings, result.weeks, result.received)), settingsUpdatedAt: result.settingsUpdatedAt, fortnox });
      }
      if (path === '/api/admin/ai') {
        // Bara ägare och admin. Behörigheten kontrolleras också i varje verktyg (databasen).
        if (!['owner', 'admin'].includes(s.actor.role)) throw new AppError(403, 'Din roll har inte behörighet till den här funktionen.');
        if (method === 'GET') return reply({ configured: aiConfig(env).configured });
        return reply(await askAi({ rpc, actor, actorName: s.actor.name, env, fetcher, now, messages: input.messages }));
      }
      if (path === '/api/admin/fortnox') {
        const summary = async status => fortnoxSummary(status || await rpc('api_fortnox', { actor, action: 'status' }), env);
        if (method === 'GET') return reply(await summary());
        if (input.action === 'connect') {
          const cfg = fortnoxConfig(env);
          if (!cfg.configured) throw new AppError(409, 'Lägg först in FORTNOX_CLIENT_ID och FORTNOX_CLIENT_SECRET i Vercel och gör en ny deploy.');
          const origin = request.headers.get('origin');
          const base = env.FORTNOX_REDIRECT_URI || ((origin && allowedOrigins.has(origin) ? origin : (env.APP_ORIGIN || url.origin)) + '/api/fortnox/callback');
          const state = randomState();
          await rpc('api_fortnox', { actor, action: 'start', state, redirectUri: base });
          return reply({ url: authorizeUrl(cfg, base, state, env), redirectUri: base });
        }
        if (input.action === 'sync') { await rpc('api_fortnox', { actor, action: 'status' }); return reply(await summary(await syncFortnox({ rpc, env, fetcher, now, by: s.actor.name }))); }
        if (input.action === 'save_map') return reply(await summary(await rpc('api_fortnox', { actor, action: 'save_map', supplierMap: input.supplierMap, bankAccount: input.bankAccount })));
        if (input.action === 'disconnect') return reply(await summary(await rpc('api_fortnox', { actor, action: 'disconnect' })));
        throw new AppError(400, 'Okänd åtgärd.');
      }
      if (path === '/api/admin/bank') {
        // Ekonomi & Bank: ENDAST LÄSNING. Behörighet (ägare / admin med bankbehörighet) kontrolleras i databasen.
        const cfg = bankConfig(env), status = bankStatus(env);
        const access = await rpc('api_bank', { actor, action: 'access' }); // 403 för personal och admin utan bankbehörighet
        const act = method === 'GET' ? (q('view') || 'overview') : String(input.action || '');
        if (method === 'GET' && !['overview', 'transactions', 'log'].includes(act)) throw new AppError(400, 'Okänd vy.');
        if (method === 'POST' && !['sync', 'set_category', 'access'].includes(act)) throw new AppError(400, 'Okänd åtgärd.');
        if (act === 'access') { if (input.userId != null && typeof input.allow !== 'boolean') throw new AppError(400, 'Välj ja eller nej.'); return reply(await rpc('api_bank', { actor, action: 'access', userId: input.userId ?? null, allow: input.allow })); }
        if (!cfg.env) {
          if (act === 'overview') return reply({ status, overview: null, access: access?.admins ? { admins: access.admins } : null });
          throw new AppError(409, 'Bankkopplingen är avstängd i den här miljön.');
        }
        const e = cfg.env;
        if (act === 'sync') { await limit('banksync:' + actor, 6, 600); const r = await syncBank({ rpc, env, fetcher, transport: bankTransport, now, by: s.actor.name }); return reply({ status, sync: r }); }
        if (act === 'set_category') return reply(await rpc('api_bank', { actor, action: 'set_category', env: e, id: input.id, category: input.category }));
        if (act === 'log') return reply(await rpc('api_bank', { actor, action: 'log', env: e }));
        if (act === 'transactions') {
          // Kontrollera filtren här så att felaktiga värden ger 400 och aldrig når databasen.
          const raw = k => String(q(k) ?? '').trim();
          const day = k => { const v = raw(k); if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new AppError(400, 'Ogiltigt datum.'); return v || null; };
          const amount = k => { const v = raw(k).replace(',', '.'); if (!v) return null; if (!/^\d{1,12}(\.\d{1,2})?$/.test(v)) throw new AppError(400, 'Ogiltigt belopp.'); return v; };
          const whole = (k, max) => { const v = raw(k); if (!v) return null; if (!/^\d{1,6}$/.test(v) || Number(v) > max) throw new AppError(400, 'Ogiltigt antal.'); return Number(v); };
          const direction = raw('direction'); if (direction && !['in', 'out'].includes(direction)) throw new AppError(400, 'Ogiltig typ.');
          const text = raw('q').replace(/[%_\\]/g, ' ').slice(0, 80), category = raw('category').slice(0, 40);
          return reply(await rpc('api_bank', { actor, action: 'transactions', env: e, from: day('from'), to: day('to'), q: text, category, min: amount('min'), max: amount('max'), direction, limit: whole('limit', 500), offset: whole('offset', 100000) }));
        }
        if (act === 'overview') {
          const data = await rpc('api_bank', { actor, action: 'analysis_data', env: e });
          let payables = null;
          try { payables = (await rpc('api_fortnox', { actor, action: 'status' }))?.overview?.payables || null; } catch { payables = null; }
          return reply({ status, overview: data.overview, forecast: forecast({ overview: data.overview, transactions: data.transactions, today: data.today, payables }),
            fortnox: matchFortnox({ transactions: data.transactions, payables, today: data.today }), access: access?.admins ? { admins: access.admins } : null });
        }
        throw new AppError(400, 'Okänd åtgärd.');
      }
      if (path === '/api/admin/menu') return reply(await rpc('api_admin_menu', method === 'GET' ? { actor } : { actor, action: 'save', item: input.item }));
      if (path === '/api/admin/config') return reply(await rpc('api_admin_settings', method === 'GET' ? { actor, action: 'get' } : { ...input, actor }));
      if (path === '/api/admin/staff' && method === 'GET') return reply(await rpc('api_admin_staff', { actor, action: 'list' }));
      if (path === '/api/admin/staff' && method === 'POST') {
        if (input.action === 'create') {
          // Behörigheten kontrolleras i databasen innan något konto skapas.
          if (!['owner', 'admin'].includes(s.actor.role)) throw new AppError(403, 'Din roll har inte behörighet till den här funktionen.');
          if (!['admin', 'staff'].includes(input.role)) throw new AppError(400, 'Välj en giltig roll.');
          if (input.role === 'admin' && s.actor.role !== 'owner') throw new AppError(403, 'Bara ägaren kan lägga till administratörer.');
          if (input.title !== undefined && typeof input.title !== 'string') throw new AppError(400, 'Titeln är ogiltig.');
          const email = String(input.email || '').trim().toLowerCase(), name = String(input.name || '').trim();
          if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email) || name.length < 2) throw new AppError(400, 'Skriv namn och en giltig e-postadress.');
          const password = String(input.password || '');
          if (password.length < 10) throw new AppError(400, 'Det tillfälliga lösenordet behöver minst 10 tecken.');
          const user = await auth.createUser(email, password, name), userId = user.id || user.user?.id;
          try { return reply(await rpc('api_admin_staff', { actor, action: 'create', userId, email, name, title: input.title || '', role: input.role })); }
          catch (error) { await auth.deleteUser(userId); throw error; } // inget halvfärdigt konto blir kvar
        }
        if (input.action === 'password_reset') {
          const password = String(input.password || '');
          if (password.length < 10) throw new AppError(400, 'Det tillfälliga lösenordet behöver minst 10 tecken.');
          const list = await rpc('api_admin_staff', { actor, action: 'password_reset', userId: input.userId });
          await auth.setPassword(input.userId, password);
          return reply(list);
        }
        return reply(await rpc('api_admin_staff', { actor, action: input.action, userId: input.userId, role: input.role, active: input.active }));
      }
      throw new AppError(404, 'Åtgärden finns inte.');
    } catch (error) {
      if (error instanceof AppError) {
        if (error.clearCookies) cookies = [cookie(AT, '', 0, secure), cookie(RT, '', 0, secure)];
        return json({ error: error.message }, error.status, cookies);
      }
      console.error('Restaurant API failed', error instanceof Error ? error.name : 'UnknownError');
      return json({ error: 'Något gick fel. Uppdatera innan du försöker igen.' }, 500, cookies);
    }
  }
  return handle;
}
