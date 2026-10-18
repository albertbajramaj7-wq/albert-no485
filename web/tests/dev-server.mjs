// Lokal förhandsvisning för utvecklare: sidorna + API mot en lokal Postgres och låtsas-inloggning.
// Kör: PGHOST=... PGPORT=... PGUSER=... node tests/dev-server.mjs  (öppna http://localhost:8787)
// Inloggning: albert@albertno485.com / lokal-test-123
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setup } from './helpers.mjs';

const root = fileURLToPath(new URL('../public/', import.meta.url));
const t = setup();
t.clock.now = null; // riktig tid
t.auth.addUser('albert@albertno485.com', 'lokal-test-123', 'Albert');
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
const port = Number(process.env.PORT || 8787);

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  if (url.pathname.startsWith('/api/')) {
    const chunks = []; for await (const c of req) chunks.push(c);
    const response = await t.app(new Request(url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) }));
    const cookies = response.headers.getSetCookie?.() || [];
    if (cookies.length) res.setHeader('Set-Cookie', cookies.map(c => c.replace('; Secure', '')));
    res.writeHead(response.status, Object.fromEntries([...response.headers].filter(([k]) => k !== 'set-cookie')));
    res.end(Buffer.from(await response.arrayBuffer()));
    return;
  }
  let file = normalize(join(root, decodeURIComponent(url.pathname)));
  if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
  try { if ((await stat(file)).isDirectory()) file = join(file, 'index.html'); res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' }); res.end(await readFile(file)); }
  catch { res.writeHead(404).end('Hittades inte'); }
}).listen(port, () => console.log(`Förhandsvisning: http://localhost:${port}`));

process.on('SIGINT', () => { t.close(); process.exit(0); });
process.on('SIGTERM', () => { t.close(); process.exit(0); });
