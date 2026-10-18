import home from '../../public/index.html?raw';
import menu from '../../public/meny/index.html?raw';
import story from '../../public/historien/index.html?raw';
import avpn from '../../public/avpn/index.html?raw';
import booking from '../../public/boka-pizza/index.html?raw';
import admin from '../../public/admin/index.html?raw';
export const dynamic = 'force-dynamic';
const pages: Record<string, string> = { '/': home, '/meny': menu, '/historien': story, '/avpn': avpn, '/boka-pizza': booking, '/admin': admin };
export function GET(request: Request) {
  const path = new URL(request.url).pathname.replace(/\/+$/, '') || '/';
  const body = pages[path];
  if (!body) return new Response('<!doctype html><html lang="sv"><title>Sidan finns inte</title><body><h1>Sidan finns inte.</h1><a href="/">Till startsidan</a></body></html>', { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  return new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': path === '/admin' ? 'private, no-store' : 'public, max-age=0, must-revalidate', 'X-Content-Type-Options': 'nosniff' } });
}
