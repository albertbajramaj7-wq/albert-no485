// Serverns alla API-anrop. Samma adresser som ChatGPT:s version, plus nya adminfunktioner.
// Ren JavaScript utan externa paket, så den körs som en Vercel-funktion och i testerna.
import { AppError } from './supabase.js';
import { emailConfiguration, sendBookingEmail } from './email.js';

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
export function createApp({ rpc, auth, env = {}, now = () => new Date(), fetcher = fetch }) {
  const ownerEmail = (env.ADMIN_OWNER_EMAIL || '').trim().toLowerCase();

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
        if (Number(request.headers.get('content-length') || 0) > 10000) throw new AppError(413, 'För mycket information skickades.');
      }
      const bodyText = method === 'GET' ? '' : await request.text();
      if (bodyText.length > 10000) throw new AppError(413, 'För mycket information skickades.');
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
      if (path === '/api/menu' && method === 'GET') {
        const response = json(await rpc('api_menu', {}));
        response.headers.set('Cache-Control', 'public, max-age=60');
        return response;
      }
      if (path === '/api/bookings' && method === 'POST') {
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
      if (path === '/api/admin/day' && method === 'GET') return reply(await withEmail(await rpc('api_admin_day', { actor, date: q('date') || stockholmToday(now()) })));
      if (path === '/api/admin/counter' && method === 'POST') return reply(await withEmail(await rpc('api_admin_counter', { ...input, actor })));
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
