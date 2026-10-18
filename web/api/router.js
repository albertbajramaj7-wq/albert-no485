// Vercel-funktion som tar emot alla anrop till /api/*.
import { createApp } from '../lib/app.js';
import { createAuth, createRpc } from '../lib/supabase.js';

const env = process.env;
const url = (env.SUPABASE_URL || '').replace(/\/+$/, '');
const app = createApp({
  rpc: createRpc({ url, serviceKey: env.SUPABASE_SERVICE_ROLE_KEY }),
  auth: createAuth({ url, anonKey: env.SUPABASE_ANON_KEY, serviceKey: env.SUPABASE_SERVICE_ROLE_KEY }),
  env,
});

export function GET(request) { return app(request); }
export function POST(request) { return app(request); }
