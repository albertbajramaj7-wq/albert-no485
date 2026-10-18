// Tunn klient mot Supabase utan externa paket: databasfunktioner (PostgREST RPC)
// och inloggning (Supabase Auth). Används bara på servern. Nycklarna når aldrig webbläsaren.

export class AppError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

/** Anropar databasfunktionen `name` med ett JSON-argument. */
export function createRpc({ url, serviceKey, fetcher = fetch }) {
  return async function rpc(name, p = {}) {
    if (!url || !serviceKey) throw new AppError(503, 'Databasen är inte konfigurerad ännu.');
    const response = await fetcher(`${url}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ p }),
    });
    const body = await readJson(response);
    if (response.ok) return body;
    const code = typeof body?.code === 'string' ? body.code : '';
    const match = /^PT(\d{3})$/.exec(code);
    if (match) throw new AppError(Number(match[1]), body.message || 'Åtgärden kunde inte genomföras.');
    console.error('Database call failed', name, response.status, code);
    throw new AppError(500, 'Något gick fel. Uppdatera innan du försöker igen.');
  };
}

/** Supabase Auth via dess REST-API. */
export function createAuth({ url, anonKey, serviceKey, fetcher = fetch }) {
  const base = `${url}/auth/v1`;
  const headers = key => ({ apikey: key, 'Content-Type': 'application/json' });
  function ensure() { if (!url || !anonKey) throw new AppError(503, 'Inloggningen är inte konfigurerad ännu.'); }
  return {
    async login(email, password) {
      ensure();
      const response = await fetcher(`${base}/token?grant_type=password`, { method: 'POST', headers: headers(anonKey), body: JSON.stringify({ email, password }) });
      const body = await readJson(response);
      if (!response.ok) {
        if (response.status === 429) throw new AppError(429, 'För många försök. Vänta en stund och försök igen.');
        throw new AppError(401, 'Fel e-post eller lösenord.');
      }
      return body;
    },
    async refresh(refreshToken) {
      ensure();
      const response = await fetcher(`${base}/token?grant_type=refresh_token`, { method: 'POST', headers: headers(anonKey), body: JSON.stringify({ refresh_token: refreshToken }) });
      return response.ok ? readJson(response) : null;
    },
    async user(accessToken) {
      ensure();
      const response = await fetcher(`${base}/user`, { headers: { apikey: anonKey, Authorization: `Bearer ${accessToken}` } });
      return response.ok ? readJson(response) : null;
    },
    async logout(accessToken) {
      if (!url || !anonKey || !accessToken) return;
      await fetcher(`${base}/logout`, { method: 'POST', headers: { apikey: anonKey, Authorization: `Bearer ${accessToken}` } }).catch(() => {});
    },
    async changeOwnPassword(accessToken, password) {
      ensure();
      const response = await fetcher(`${base}/user`, { method: 'PUT', headers: { ...headers(anonKey), Authorization: `Bearer ${accessToken}` }, body: JSON.stringify({ password }) });
      if (!response.ok) throw new AppError(400, 'Lösenordet kunde inte bytas. Välj ett längre lösenord.');
    },
    async createUser(email, password, name) {
      if (!serviceKey) throw new AppError(503, 'Personalkonton kan inte skapas förrän servernyckeln är inlagd.');
      const response = await fetcher(`${base}/admin/users`, { method: 'POST', headers: { ...headers(serviceKey), Authorization: `Bearer ${serviceKey}` },
        body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { name } }) });
      const body = await readJson(response);
      if (!response.ok) {
        const text = String(body?.msg || body?.message || '');
        if (/already|registered|exists/i.test(text)) throw new AppError(409, 'Det finns redan ett konto med den e-postadressen.');
        throw new AppError(400, 'Kontot kunde inte skapas. Kontrollera e-postadressen.');
      }
      return body;
    },
    async setPassword(userId, password) {
      if (!serviceKey) throw new AppError(503, 'Servernyckeln saknas.');
      const response = await fetcher(`${base}/admin/users/${encodeURIComponent(userId)}`, { method: 'PUT', headers: { ...headers(serviceKey), Authorization: `Bearer ${serviceKey}` }, body: JSON.stringify({ password }) });
      if (!response.ok) throw new AppError(400, 'Lösenordet kunde inte bytas.');
    },
  };
}
