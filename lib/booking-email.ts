import { AppError, cleanText, stockholm, timeText, type Booking, type DB } from './restaurant.ts';

export type EmailEnvironment = { RESEND_API_KEY?: string; BOOKING_EMAIL_FROM?: string; BOOKING_EMAIL_REPLY_TO?: string };
export type EmailState = 'sent' | 'pending' | 'sending' | 'failed' | 'uncertain' | 'not_configured' | 'review' | 'skipped' | 'not_queued';
export type EmailResult = { status: EmailState; retryAt?: number };
type Outbox = { booking_id: string; status: string; attempts: number; payload: string | null; first_attempt_at: number | null; lease_token: string | null; lease_until: number; next_attempt_at: number; provider_id: string | null; last_error: string | null };
type MailPayload = { from: string; to: string[]; subject: string; html: string; text: string; reply_to?: string; tags: { name: string; value: string }[] };
const RETRY_WINDOW = 23 * 60 * 60 * 1000;
const addressPattern = /^[^\s@<>,;:"\\]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/i;
function mailbox(value: string | undefined) {
  const text = value?.trim() || '';
  if (!text || text.length > 250 || /[\r\n\u0000]/.test(text)) return null;
  const match = text.match(/^[^<>]+\s<([^<>]+)>$/), address = match ? match[1] : text;
  return addressPattern.test(address) && !address.includes('..') ? text : null;
}
export function emailConfiguration(env: EmailEnvironment) {
  const from = mailbox(env.BOOKING_EMAIL_FROM), replyTo = env.BOOKING_EMAIL_REPLY_TO ? mailbox(env.BOOKING_EMAIL_REPLY_TO) : null;
  return { configured: !!env.RESEND_API_KEY?.trim() && !!from && (!env.BOOKING_EMAIL_REPLY_TO || !!replyTo), from, replyTo };
}
const escape = (value: string | number) => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] || c);
export function confirmationEmail(booking: Booking, from: string, replyTo: string | null = null): MailPayload {
  const date = new Intl.DateTimeFormat('sv-SE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(booking.date + 'T12:00:00Z'));
  const details: [string, string | number][] = [
    ['Datum', date], ['Pizzorna är färdiga', timeText(booking.ready_min)], ['Kom senast', timeText(booking.ready_min - 10)], ['Antal pizzor', booking.count],
    ['Äta här eller ta med', booking.mode === 'here' ? 'Äta här · ' + booking.guests + ' gäster' : 'Ta med'],
    ...(booking.mode === 'here' ? [['Sittning', timeText(booking.ready_min - 10) + '–' + timeText(booking.ready_min + 50) + ' (60 minuter)'] as [string, string]] : []),
  ];
  const text = ['Albert NO.485', 'Din bokning är bekräftad.', '', 'Hej ' + booking.name + '!', 'Vi ser fram emot att träffa dig hos Albert.', '', ...details.map(([label, value]) => label + ': ' + value), '', 'Du väljer pizza och betalar på plats.', 'Pilgatan 3, Varberg', '', 'Behöver du ändra eller avboka? Ring 0340–827 75.', 'Bokningsnummer: ' + booking.id, '', 'Vi ses hos Albert!'].join('\n');
  const rows = details.map(([label, value]) => '<tr><td style="padding:13px 0;border-bottom:1px solid #dddccf;color:#68715e;font-size:13px;vertical-align:top;width:43%">' + escape(label) + '</td><td style="padding:13px 0 13px 15px;border-bottom:1px solid #dddccf;color:#23261f;font-size:14px;vertical-align:top;font-weight:bold">' + escape(value) + '</td></tr>').join('');
  const html = '<!doctype html><html lang="sv"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Din bokning hos Albert</title></head><body style="margin:0;padding:24px 12px;background:#f1eee4;font-family:Arial,Helvetica,sans-serif;color:#23261f"><div style="display:none;max-height:0;overflow:hidden">Din bokning är bekräftad. Vi ses ' + escape(date) + '.</div><table role="presentation" style="width:100%;max-width:580px;margin:0 auto;border-collapse:collapse"><tr><td style="padding:30px;background:#23261f;color:#f1eee4;font-family:Georgia,serif;font-size:29px">Albert <span style="font-size:15px">NO.485</span></td></tr><tr><td style="padding:30px;background:#fffefa"><p style="font-size:11px;letter-spacing:1px;color:#7d563f">BOKNINGSBEKRÄFTELSE</p><h1 style="margin:18px 0 22px;font-size:31px;line-height:1.2;font-weight:normal;font-family:Georgia,serif">Du har en tid i ugnen.</h1><p style="font-size:14px;line-height:1.8">Hej ' + escape(booking.name) + '!<br>Din bokning är bekräftad. Vi ser fram emot att träffa dig.</p><table role="presentation" style="width:100%;border-collapse:collapse;margin:22px 0">' + rows + '</table><p style="font-size:14px;line-height:1.8">Du väljer pizza och betalar på plats.<br><strong>Pilgatan 3, Varberg</strong></p><p style="font-size:13px;line-height:1.8">Behöver du ändra eller avboka? Ring <a href="tel:+4634082775" style="color:#23261f">0340–827 75</a>.</p><p style="margin-top:24px;font-family:Georgia,serif;font-size:23px">Vi ses hos Albert!</p><p style="font-size:11px;color:#737b68;overflow-wrap:anywhere;word-break:break-all">Bokningsnummer: ' + escape(booking.id) + '</p></td></tr></table></body></html>';
  return { from, to: [booking.email], subject: 'Din bokning hos Albert NO.485 är bekräftad', html, text, ...(replyTo ? { reply_to: replyTo } : {}), tags: [{ name: 'booking_id', value: booking.id }, { name: 'kind', value: 'booking_confirmation' }] };
}
function isCurrent(booking: Booking, now: Date) {
  const current = stockholm(now);
  return ['confirmed', 'checked_in'].includes(booking.status) && (booking.date > current.date || (booking.date === current.date && booking.ready_min >= current.minute));
}
async function finish(db: DB, booking: Booking, token: string, status: string, error: string | null, providerId: string | null, retryAt: number, now: Date) {
  const timestamp = now.toISOString();
  await db.batch([
    db.prepare('UPDATE booking_emails SET status=?,last_error=?,provider_id=COALESCE(?,provider_id),sent_at=CASE WHEN ?=\'sent\' THEN ? ELSE sent_at END,lease_token=NULL,lease_until=0,next_attempt_at=?,updated_at=? WHERE booking_id=? AND lease_token=?').bind(status, error, providerId, status, timestamp, retryAt, timestamp, booking.id, token),
    db.prepare('INSERT INTO audit(id,date,actor,action,target,detail,created_at) SELECT ?,?,\'system\',\'booking_email\',?,?,? WHERE changes()>0').bind(crypto.randomUUID(), booking.date, booking.id, JSON.stringify({ status, error }), timestamp),
  ]);
}

// The booking and pending mail record are committed together by createBooking.
// Call only after that successful write, or from the authenticated retry route.
export async function sendBookingEmail(db: DB, id: string, env: EmailEnvironment, options: { now?: Date; fetcher?: typeof fetch } = {}): Promise<EmailResult> {
  const now = options.now || new Date(), ms = now.getTime(), timestamp = now.toISOString();
  const booking = await db.prepare('SELECT * FROM bookings WHERE id=?').bind(id).first<Booking>();
  const email = await db.prepare('SELECT * FROM booking_emails WHERE booking_id=?').bind(id).first<Outbox>();
  if (!booking || !email) return { status: 'not_queued' };
  if (email.status === 'sent') return { status: 'sent' };
  if (email.status === 'review') return { status: 'review' };
  if (!isCurrent(booking, now)) {
    await db.prepare("UPDATE booking_emails SET status='skipped',last_error='booking_no_longer_current',updated_at=? WHERE booking_id=? AND status!='sent' AND lease_until<=?").bind(timestamp, id, ms).run();
    return { status: 'skipped' };
  }
  if (email.lease_until > ms) return { status: 'sending', retryAt: email.lease_until };
  if (email.first_attempt_at !== null && ms - email.first_attempt_at >= RETRY_WINDOW) {
    await db.prepare("UPDATE booking_emails SET status='review',last_error='retry_window_expired',updated_at=? WHERE booking_id=? AND status!='sent' AND lease_until<=?").bind(timestamp, id, ms).run();
    return { status: 'review' };
  }
  const config = emailConfiguration(env);
  if (!config.configured) {
    await db.prepare("UPDATE booking_emails SET status='blocked',last_error='configuration_missing',updated_at=? WHERE booking_id=? AND status NOT IN ('sent','review') AND lease_until<=?").bind(timestamp, id, ms).run();
    return { status: 'not_configured' };
  }
  if (email.next_attempt_at > ms) return { status: email.status === 'uncertain' ? 'uncertain' : 'pending', retryAt: email.next_attempt_at };
  if (!addressPattern.test(booking.email) || booking.email.includes('..')) return { status: 'failed' };
  const token = crypto.randomUUID(), payload = email.payload || JSON.stringify(confirmationEmail(booking, config.from!, config.replyTo));
  const acquired = await db.prepare("UPDATE booking_emails SET status='sending',attempts=attempts+1,payload=COALESCE(payload,?),first_attempt_at=COALESCE(first_attempt_at,?),lease_token=?,lease_until=?,updated_at=? WHERE booking_id=? AND status NOT IN ('sent','review','skipped') AND lease_until<=? AND next_attempt_at<=? AND (first_attempt_at IS NULL OR first_attempt_at>?) AND EXISTS(SELECT 1 FROM bookings WHERE id=? AND status IN ('confirmed','checked_in'))").bind(payload, ms, token, ms + 30000, timestamp, id, ms, ms, ms - RETRY_WINDOW, id).run();
  if (!acquired.meta.changes) return { status: 'pending' };
  // Read the persisted snapshot after claiming so all retries use identical bytes.
  const claimed = await db.prepare('SELECT * FROM booking_emails WHERE booking_id=? AND lease_token=?').bind(id, token).first<Outbox>();
  if (!claimed?.payload) return { status: 'pending' };
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 8000);
  let result: EmailResult;
  const retryAt = ms + Math.min(60 * 60 * 1000, 60000 * 2 ** Math.min(email.attempts, 5));
  try {
    const response = await (options.fetcher || fetch)('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY!.trim(), 'Content-Type': 'application/json', 'Idempotency-Key': 'booking-confirmation/' + id }, body: claimed.payload, signal: controller.signal, redirect: 'error' });
    const value = await response.json().catch(() => null) as { id?: unknown } | null;
    if (response.ok && typeof value?.id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value.id)) {
      await finish(db, booking, token, 'sent', null, value.id, 0, now); result = { status: 'sent' };
    } else {
      const uncertain = response.status >= 500 || response.status === 409 || response.ok;
      const status = uncertain ? 'uncertain' : 'failed';
      const headerWait = Number(response.headers.get('retry-after'));
      const next = Math.max(retryAt, ms + (Number.isFinite(headerWait) && headerWait > 0 ? Math.min(headerWait, 86400) * 1000 : 0));
      await finish(db, booking, token, status, 'provider_http_' + response.status, null, next, now); result = { status, retryAt: next };
    }
  } catch {
    // A lost HTTP response can still mean the provider accepted the email.
    await finish(db, booking, token, 'uncertain', 'provider_result_unknown', null, retryAt, now); result = { status: 'uncertain', retryAt };
  } finally { clearTimeout(timer); }
  return result;
}

export async function retryBookingEmail(db: DB, actor: string, value: unknown, env: EmailEnvironment, options: { now?: Date; fetcher?: typeof fetch } = {}) {
  const id = cleanText(value, 36, 36, 'Välj en giltig bokning.'), now = options.now || new Date();
  const booking = await db.prepare('SELECT * FROM bookings WHERE id=?').bind(id).first<Booking>();
  if (!booking) throw new AppError(404, 'Bokningen finns inte.');
  if (!isCurrent(booking, now)) throw new AppError(409, 'Bekräftelse skickas bara för en aktuell bokning som inte är avbokad.');
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO booking_emails(booking_id,status,created_at,updated_at) VALUES(?,'pending',?,?)").bind(id, now.toISOString(), now.toISOString()),
    db.prepare('INSERT INTO audit(id,date,actor,action,target,detail,created_at) VALUES(?,?,?,\'booking_email_requested\',?,\'{}\',?)').bind(crypto.randomUUID(), booking.date, actor, id, now.toISOString()),
  ]);
  const result = await sendBookingEmail(db, id, env, options);
  return { date: booking.date, ...result };
}
