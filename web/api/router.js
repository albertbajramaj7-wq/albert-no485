// Vercel-funktion som tar emot alla anrop till /api/*.
import { createApp } from '../lib/app.js';
import { createAuth, createRpc, keyKind } from '../lib/supabase.js';

const env = process.env;
const url = (env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const rpc = createRpc({ url, serviceKey: env.SUPABASE_SERVICE_ROLE_KEY });

// Felsökning utan hemligheter: visar bara om inställningarna finns och om Supabase svarar.
async function diagnose() {
  const result = {
    supabaseUrl: /^https:\/\/[a-z0-9]+\.supabase\.co$/.test(url) ? url : (url ? 'ser fel ut: ' + url.slice(0, 60) : 'saknas'),
    anonKey: keyKind(env.SUPABASE_ANON_KEY),
    serviceKey: keyKind(env.SUPABASE_SERVICE_ROLE_KEY),
    ownerEmail: env.ADMIN_OWNER_EMAIL ? 'inlagd' : 'saknas',
  };
  try { await rpc('api_menu', {}); result.database = 'ok'; } catch (e) { result.database = e.message; }
  try {
    const anon = String(env.SUPABASE_ANON_KEY || '').trim();
    const r = await fetch(url + '/auth/v1/settings', { headers: anon.startsWith('eyJ') ? { apikey: anon, Authorization: 'Bearer ' + anon } : { apikey: anon } });
    result.auth = r.ok ? 'ok' : 'svarar ' + r.status;
    if (r.ok) { const s = await r.json(); result.publicSignup = s.disable_signup ? 'avstängd (bra)' : 'PÅ – stäng av i Supabase'; }
  } catch { result.auth = 'nås inte'; }
  return result;
}

const app = createApp({
  rpc,
  auth: createAuth({ url, anonKey: env.SUPABASE_ANON_KEY, serviceKey: env.SUPABASE_SERVICE_ROLE_KEY }),
  env,
  diagnose,
});

export function GET(request) { return app(request); }
export function POST(request) { return app(request); }
