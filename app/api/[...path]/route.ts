import { env } from 'cloudflare:workers';
import { getChatGPTUser } from '../../chatgpt-auth';
import { AppError, adminDay, authorize, changeBooking, changeCounter, createBooking, getAvailability, mutateTask, saveDay, stockholm } from '../../../lib/restaurant';
import { emailConfiguration, retryBookingEmail, sendBookingEmail } from '../../../lib/booking-email';

export const dynamic = 'force-dynamic';
function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Vary': 'Cookie' } });
}
async function adminJson(day: ReturnType<typeof adminDay>) { return json({ ...await day, emailSetup: emailConfiguration(env) }); }
async function handle(request: Request) {
  try {
    if (!env.DB) throw new AppError(503, 'Databasen är inte tillgänglig. Försök igen senare.');
    const url = new URL(request.url), path = url.pathname.replace(/\/+$/, ''), method = request.method;
    if (method !== 'GET') {
      const origin = request.headers.get('origin');
      if ((origin && origin !== url.origin) || request.headers.get('sec-fetch-site') === 'cross-site') throw new AppError(403, 'Åtgärden måste skickas från hemsidan.');
      if (!request.headers.get('content-type')?.includes('application/json')) throw new AppError(415, 'Använd JSON för den här åtgärden.');
      if (Number(request.headers.get('content-length') || 0) > 10000) throw new AppError(413, 'För mycket information skickades.');
    }
    const bodyText = method === 'GET' ? '' : await request.text();
    if (bodyText.length > 10000) throw new AppError(413, 'För mycket information skickades.');
    let input: Record<string, unknown> = {};
    if (bodyText) { try { input = JSON.parse(bodyText); } catch { throw new AppError(400, 'Informationen kunde inte läsas.'); } }
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AppError(400, 'Informationen kunde inte läsas.');
    if (path === '/api/availability' && method === 'GET') {
      return json(await getAvailability(env.DB, { date: url.searchParams.get('date'), count: Number(url.searchParams.get('count')), mode: url.searchParams.get('mode'), guests: Number(url.searchParams.get('guests')) }));
    }
    if (path === '/api/bookings' && method === 'POST') {
      if (input.website) throw new AppError(400, 'Bokningen kunde inte skickas.');
      if (input.accepted !== true) throw new AppError(400, 'Bekräfta bokningsvillkoren.');
      const booking = await createBooking(env.DB, input, request.headers.get('idempotency-key') || '');
      let email: Awaited<ReturnType<typeof sendBookingEmail>> = { status: 'pending' };
      try { email = await sendBookingEmail(env.DB, booking.id, env); }
      catch { console.error('Booking confirmation email remains unverified'); }
      return json({ ...booking, email: { status: email.status } }, 201);
    }
    if (!path.startsWith('/api/admin/')) throw new AppError(404, 'Sidan finns inte.');
    const user = await getChatGPTUser();
    const actor = await authorize(env.DB, user, env.ADMIN_OWNER_EMAIL || '');
    if (path === '/api/admin/day' && method === 'GET') return await adminJson(adminDay(env.DB, url.searchParams.get('date') || stockholm().date, actor));
    if (path === '/api/admin/counter' && method === 'POST') return await adminJson(changeCounter(env.DB, actor, input));
    if (path === '/api/admin/settings' && method === 'POST') return await adminJson(saveDay(env.DB, actor, input));
    if (path === '/api/admin/booking' && method === 'POST') return await adminJson(changeBooking(env.DB, actor, input));
    if (path === '/api/admin/task' && method === 'POST') return await adminJson(mutateTask(env.DB, actor, input));
    if (path === '/api/admin/email' && method === 'POST') {
      const emailAction = await retryBookingEmail(env.DB, actor.name, input.id, env);
      return json({ ...await adminDay(env.DB, emailAction.date, actor), emailSetup: emailConfiguration(env), emailAction });
    }
    throw new AppError(404, 'Åtgärden finns inte.');
  } catch (error) {
    if (error instanceof AppError) return json({ error: error.message }, error.status);
    console.error('Restaurant API failed', error instanceof Error ? error.name : 'UnknownError');
    return json({ error: 'Något gick fel. Uppdatera innan du försöker igen.' }, 500);
  }
}
export const GET = handle;
export const POST = handle;
