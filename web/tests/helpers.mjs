// Testmiljö: en riktig Postgres-databas (lokalt) med migreringen, och en låtsas-inloggning.
// Kör: PGHOST=... PGPORT=... PGUSER=... npm test
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApp } from '../lib/app.js';
import { AppError } from '../lib/supabase.js';

const migrationsDir = fileURLToPath(new URL('../supabase/migrations/', import.meta.url));
const migrations = readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort().map(f => migrationsDir + f);
const migration = migrations[0];
const psqlArgs = db => ['-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-d', db];

export function createDatabase() {
  const name = 'albert_test_' + process.pid + '_' + Math.random().toString(36).slice(2, 8);
  execFileSync('psql', [...psqlArgs('postgres'), '-c', `create database ${name}`]);
  for (const role of ['anon', 'authenticated', 'service_role']) {
    try { execFileSync('psql', [...psqlArgs('postgres'), '-c', `create role ${role}`], { stdio: 'ignore' }); } catch { /* finns redan */ }
  }
  for (const file of migrations) execFileSync('psql', [...psqlArgs(name), '-f', file]);
  // De äldre testerna utgår från kvartar (8 pizzor per 15 min) utan löpande kö (0010, egna tester i pizzako.test.mjs). 0005 ställer in 4 per 8 min; egna tester för det finns i tidsluckor.test.mjs.
  execFileSync('psql', [...psqlArgs(name), '-c', 'update settings set slot_min = 15, slot_cap = 8, sit_after_close = false, pizza_min = null, pizza_sec = null where id = 1']);
  return name;
}

export function dropDatabase(name) {
  execFileSync('psql', [...psqlArgs('postgres'), '-c', `drop database if exists ${name} with (force)`]);
}

export function sql(db, statement) {
  return execFileSync('psql', [...psqlArgs(db), '-c', statement], { encoding: 'utf8' }).trim();
}

/** RPC mot lokala databasen, med samma felöversättning som Supabase gör. */
export function createTestRpc(db, clock) {
  return function rpc(name, p = {}) {
    const payload = JSON.stringify(clock.now ? { ...p, now: clock.now } : p);
    return new Promise((resolve, reject) => {
      const child = spawn('psql', [...psqlArgs(db), '-v', 'p=' + payload]);
      let out = '', err = '';
      child.stdout.on('data', d => { out += d; });
      child.stderr.on('data', d => { err += d; });
      child.on('close', code => {
        if (code === 0) { const text = out.trim(); resolve(text ? JSON.parse(text) : null); return; }
        const match = /ERROR:\s+PT(\d{3}):\s+(.*)/.exec(err);
        if (match) reject(new AppError(Number(match[1]), match[2].trim()));
        else reject(new Error(err));
      });
      child.stdin.end(`\\set VERBOSITY verbose\nselect ${name}(:'p'::jsonb);\n`);
    });
  };
}

export function createFakeAuth() {
  const users = new Map(), tokens = new Map();
  let n = 0;
  const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  return {
    users,
    addUser(email, password, name = '') { const user = { id: uuid(), email, password, email_confirmed_at: '2026-10-01T00:00:00Z', user_metadata: { name } }; users.set(email, user); return user; },
    tokenFor(email) { const token = 'tok-' + email; tokens.set(token, users.get(email)); return token; },
    async login(email, password) {
      const user = users.get(email);
      if (!user || user.password !== password) throw new AppError(401, 'Fel e-post eller lösenord.');
      const token = 'tok-' + email; tokens.set(token, user);
      return { access_token: token, refresh_token: 'ref-' + email, expires_in: 3600, user };
    },
    async refresh() { return null; },
    async user(token) { return tokens.get(token) || null; },
    async logout() {},
    async changeOwnPassword(token, password) { tokens.get(token).password = password; },
    async createUser(email, password, name) {
      if (users.has(email)) throw new AppError(409, 'Det finns redan ett konto med den e-postadressen.');
      return this.addUser(email, password, name);
    },
    async deleteUser(id) { for (const [k, u] of users) if (u.id === id) users.delete(k); },
    async setPassword(id, password) { for (const u of users.values()) if (u.id === id) u.password = password; },
  };
}

export function setup({ env = {}, fetcher, bankTransport } = {}) {
  const db = createDatabase();
  const clock = { now: '2026-10-18T10:00:00+02:00' }; // söndag förmiddag
  const auth = createFakeAuth();
  const rpc = createTestRpc(db, clock);
  const app = createApp({ rpc, auth, env: { ADMIN_OWNER_EMAIL: 'albert@albertno485.com', DISABLE_RATE_LIMIT: '1', ...env }, now: () => new Date(clock.now), fetcher: fetcher || (async () => { throw new Error('no network in tests'); }), bankTransport });
  const base = 'https://albertno485.com';
  async function call(method, path, body, { token, headers = {} } = {}) {
    const h = { ...headers };
    if (body !== undefined) { h['Content-Type'] = 'application/json'; h.Origin ??= base; }
    if (token) h.Cookie = 'alb_at=' + token;
    const response = await app(new Request(base + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }));
    return { status: response.status, body: await response.json(), headers: response.headers };
  }
  return { db, clock, auth, rpc, app, call, close: () => dropDatabase(db) };
}

export function bookingBody(over = {}) {
  return { date: '2026-10-21', time: '18:00', count: 2, mode: 'here', guests: 2, accepted: true,
    contact: { name: 'Anna Andersson', email: 'anna@example.se', phone: '070-123 45 67' }, ...over };
}

export const readMigration = () => readFileSync(migration, 'utf8');
