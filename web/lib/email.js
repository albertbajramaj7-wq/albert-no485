// Bokningsbekräftelser via Resend. Flyttad från ChatGPT:s version (lib/booking-email.ts)
// med samma regler: ett sparat meddelande per bokning, lås under utskick, idempotensnyckel
// hos Resend och manuella omförsök från admin. En misslyckad mejlning stoppar aldrig bokningen.

const RETRY_WINDOW = 23 * 60 * 60 * 1000;
const addressPattern = /^[^\s@<>,;:"\\]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/i;

function mailbox(value) {
  const text = value?.trim() || '';
  if (!text || text.length > 250 || /[\r\n\u0000]/.test(text)) return null;
  const match = text.match(/^[^<>]+\s<([^<>]+)>$/), address = match ? match[1] : text;
  return addressPattern.test(address) && !address.includes('..') ? text : null;
}

export function emailConfiguration(env) {
  const from = mailbox(env.BOOKING_EMAIL_FROM), replyTo = env.BOOKING_EMAIL_REPLY_TO ? mailbox(env.BOOKING_EMAIL_REPLY_TO) : null;
  return { configured: !!env.RESEND_API_KEY?.trim() && !!from && (!env.BOOKING_EMAIL_REPLY_TO || !!replyTo), from, replyTo };
}

const time = minute => String(Math.floor(minute / 60)).padStart(2, '0') + ':' + String(minute % 60).padStart(2, '0');
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] || c);

function stockholm(now) {
  const p = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const get = name => p.find(x => x.type === name)?.value || '';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, minute: Number(get('hour')) * 60 + Number(get('minute')) };
}

export function confirmationEmail(booking, timing, from, replyTo = null) {
  const date = new Intl.DateTimeFormat('sv-SE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(booking.date + 'T12:00:00Z'));
  const arrival = booking.ready_min - timing.arrival;
  const details = [
    ['Datum', date], ['Pizzorna är färdiga', time(booking.ready_min)], ['Kom senast', time(arrival)], ['Antal pizzor', booking.count],
    ['Äta här eller ta med', booking.mode === 'here' ? 'Äta här · ' + booking.guests + ' gäster' : 'Ta med'],
    ...(booking.mode === 'here' ? [['Sittning', time(arrival) + '–' + time(arrival + timing.sitting) + ' (' + timing.sitting + ' minuter)']] : []),
  ];
  const text = ['Albert NO.485', 'Din bokning är bekräftad.', '', 'Hej ' + booking.name + '!', 'Vi ser fram emot att träffa dig hos Albert.', '', ...details.map(([label, value]) => label + ': ' + value), '', 'Du väljer pizza och betalar på plats.', 'Pilgatan 3, Varberg', '', 'Behöver du ändra eller avboka? Ring 0340–827 75.', 'Bokningsnummer: ' + booking.id, '', 'Vi ses hos Albert!'].join('\n');
  const rows = details.map(([label, value]) => '<tr><td style="padding:13px 0;border-bottom:1px solid #dddccf;color:#68715e;font-size:13px;vertical-align:top;width:43%">' + escape(label) + '</td><td style="padding:13px 0 13px 15px;border-bottom:1px solid #dddccf;color:#23261f;font-size:14px;vertical-align:top;font-weight:bold">' + escape(value) + '</td></tr>').join('');
  const html = '<!doctype html><html lang="sv"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Din bokning hos Albert</title></head><body style="margin:0;padding:24px 12px;background:#f1eee4;font-family:Arial,Helvetica,sans-serif;color:#23261f"><div style="display:none;max-height:0;overflow:hidden">Din bokning är bekräftad. Vi ses ' + escape(date) + '.</div><table role="presentation" style="width:100%;max-width:580px;margin:0 auto;border-collapse:collapse"><tr><td style="padding:30px;background:#23261f;color:#f1eee4;font-family:Georgia,serif;font-size:29px">Albert <span style="font-size:15px">NO.485</span></td></tr><tr><td style="padding:30px;background:#fffefa"><p style="font-size:11px;letter-spacing:1px;color:#7d563f">BOKNINGSBEKRÄFTELSE</p><h1 style="margin:18px 0 22px;font-size:31px;line-height:1.2;font-weight:normal;font-family:Georgia,serif">Du har en tid i ugnen.</h1><p style="font-size:14px;line-height:1.8">Hej ' + escape(booking.name) + '!<br>Din bokning är bekräftad. Vi ser fram emot att träffa dig.</p><table role="presentation" style="width:100%;border-collapse:collapse;margin:22px 0">' + rows + '</table><p style="font-size:14px;line-height:1.8">Du väljer pizza och betalar på plats.<br><strong>Pilgatan 3, Varberg</strong></p><p style="font-size:13px;line-height:1.8">Behöver du ändra eller avboka? Ring <a href="tel:+4634082775" style="color:#23261f">0340–827 75</a>.</p><p style="margin-top:24px;font-family:Georgia,serif;font-size:23px">Vi ses hos Albert!</p><p style="font-size:11px;color:#737b68;overflow-wrap:anywhere;word-break:break-all">Bokningsnummer: ' + escape(booking.id) + '</p></td></tr></table></body></html>';
  return { from, to: [booking.email], subject: 'Din bokning hos Albert NO.485 är bekräftad', html, text, ...(replyTo ? { reply_to: replyTo } : {}), tags: [{ name: 'booking_id', value: booking.id }, { name: 'kind', value: 'booking_confirmation' }] };
}

function isCurrent(booking, now) {
  const current = stockholm(now);
  return ['confirmed', 'checked_in'].includes(booking.status) && (booking.date > current.date || (booking.date === current.date && booking.ready_min >= current.minute));
}

/** Skickar bekräftelsen för en sparad bokning. Returnerar bara en status. */
export async function sendBookingEmail(rpc, id, env, { now = new Date(), fetcher = fetch } = {}) {
  const ms = now.getTime();
  const state = await rpc('api_email_state', { id });
  const booking = state?.booking, email = state?.outbox;
  if (!booking || !email) return { status: 'not_queued' };
  if (email.status === 'sent') return { status: 'sent' };
  if (email.status === 'review') return { status: 'review' };
  if (!isCurrent(booking, now)) {
    await rpc('api_email_mark', { id, status: 'skipped', error: 'booking_no_longer_current', nowMs: ms });
    return { status: 'skipped' };
  }
  if (email.lease_until > ms) return { status: 'sending', retryAt: email.lease_until };
  if (email.first_attempt_at !== null && ms - email.first_attempt_at >= RETRY_WINDOW) {
    await rpc('api_email_mark', { id, status: 'review', error: 'retry_window_expired', nowMs: ms });
    return { status: 'review' };
  }
  const config = emailConfiguration(env);
  if (!config.configured) {
    await rpc('api_email_mark', { id, status: 'blocked', error: 'configuration_missing', nowMs: ms });
    return { status: 'not_configured' };
  }
  if (email.next_attempt_at > ms) return { status: email.status === 'uncertain' ? 'uncertain' : 'pending', retryAt: email.next_attempt_at };
  if (!addressPattern.test(booking.email) || booking.email.includes('..')) return { status: 'failed' };
  const token = crypto.randomUUID();
  const claimed = await rpc('api_email_claim', { id, token, nowMs: ms, retryWindow: RETRY_WINDOW,
    payload: JSON.stringify(confirmationEmail(booking, state.settings, config.from, config.replyTo)) });
  if (!claimed?.payload) return { status: 'pending' };
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 8000);
  const retryAt = ms + Math.min(60 * 60 * 1000, 60000 * 2 ** Math.min(email.attempts, 5));
  const finish = (status, error, providerId, next) => rpc('api_email_finish', { id, token, status, error, providerId, retryAt: next });
  try {
    const response = await fetcher('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY.trim(), 'Content-Type': 'application/json', 'Idempotency-Key': 'booking-confirmation/' + id }, body: claimed.payload, signal: controller.signal, redirect: 'error' });
    const value = await response.json().catch(() => null);
    if (response.ok && typeof value?.id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value.id)) {
      await finish('sent', null, value.id, 0); return { status: 'sent' };
    }
    const uncertain = response.status >= 500 || response.status === 409 || response.ok;
    const status = uncertain ? 'uncertain' : 'failed';
    const headerWait = Number(response.headers.get('retry-after'));
    const next = Math.max(retryAt, ms + (Number.isFinite(headerWait) && headerWait > 0 ? Math.min(headerWait, 86400) * 1000 : 0));
    await finish(status, 'provider_http_' + response.status, null, next);
    return { status, retryAt: next };
  } catch {
    // Ett förlorat svar kan ändå betyda att Resend tog emot mejlet.
    await finish('uncertain', 'provider_result_unknown', null, retryAt);
    return { status: 'uncertain', retryAt };
  } finally { clearTimeout(timer); }
}
