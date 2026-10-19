// AI-assistenten i admin ("AI-restaurangchefen").
// Claude får bara LÄSA sammanställd data via verktygen nedan – inga namn, telefonnummer
// eller e-postadresser till gäster skickas, och assistenten kan inte ändra något.
import { AppError } from './supabase.js';
import { computeBudget } from './budget.js';
import { fortnoxSummary } from './fortnox.js';

const API = 'https://api.anthropic.com/v1/messages';
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_TURNS = 6;

export function aiConfig(env) {
  const key = String(env.ANTHROPIC_API_KEY || '').trim();
  return { key, model: String(env.ANTHROPIC_MODEL || 'claude-sonnet-5-5').trim(), configured: key.length > 20 };
}

const dateProp = description => ({ type: 'string', description: description + ' (ÅÅÅÅ-MM-DD)' });
export const TOOLS = [
  { name: 'dagsstatistik', description: 'Pizzor per dag för en period: bokade pizzor, antal bokningar, gäster som äter här, take away, avbokningar, drop-in, svinn och förberedda pizzor. Plus svinn per orsak och per pizza. Högst 366 dagar.',
    input_schema: { type: 'object', properties: { from: dateProp('Första dag'), to: dateProp('Sista dag') }, required: ['from', 'to'] } },
  { name: 'dagens_lage', description: 'Läget en viss dag: förberedda pizzor, kvar, drop-in, svinn, öppet/pausat, bokningar per färdigtid (utan personuppgifter) och arbetsuppgifter.',
    input_schema: { type: 'object', properties: { date: dateProp('Dag') }, required: ['date'] } },
  { name: 'veckobudget', description: 'Veckobudgeten: inställningar (procentsatser, fasta kostnader), alla veckor med omsättning, avsättningar per post, faktiskt utfall, saldo, samt banksaldo och leverantörsfakturor från Fortnox om det är kopplat.',
    input_schema: { type: 'object', properties: {} } },
  { name: 'lager', description: 'Lagret: varor, antal i lager, miniminivå, inköpspris, leverantör, och vilka varor som är under miniminivå.',
    input_schema: { type: 'object', properties: {} } },
  { name: 'inkop', description: 'Inköpsordrar: utkast, skickade och mottagna, med rader och belopp.',
    input_schema: { type: 'object', properties: {} } },
  { name: 'meny_och_installningar', description: 'Menyn med priser samt bokningsinställningar (öppettider, ugnskapacitet, sittplatser, snittpris per pizza).',
    input_schema: { type: 'object', properties: {} } },
];

const pick = (o, keys) => Object.fromEntries(keys.filter(k => o?.[k] !== undefined).map(k => [k, o[k]]));
const time = m => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');

export async function runTool(name, input, { rpc, actor, env }) {
  const day = v => { if (!DAY.test(String(v || ''))) throw new AppError(400, 'Ogiltigt datum.'); return v; };
  switch (name) {
    case 'dagsstatistik':
      return rpc('api_admin_stats', { actor, from: day(input.from), to: day(input.to) });
    case 'dagens_lage': {
      const d = await rpc('api_admin_day', { actor, date: day(input.date) });
      const slots = {};
      for (const b of d.bookings || []) {
        if (b.status === 'cancelled') continue;
        const k = time(b.ready_min);
        slots[k] ??= { pizzor: 0, bokningar: 0, gaster: 0, takeAway: 0 };
        slots[k].pizzor += b.count; slots[k].bokningar++;
        if (b.mode === 'here') slots[k].gaster += b.guests; else slots[k].takeAway += b.count;
      }
      return {
        datum: d.day?.date, stangt: !!d.closed, pausad: !!d.day?.paused, forberedda: d.day?.prepared ?? null,
        dropin: d.day?.dropin, svinn: d.day?.waste, nyckeltal: d.stats, granser: d.limits,
        bokningarPerFardigtid: slots,
        avbokade: (d.bookings || []).filter(b => b.status === 'cancelled').length,
        incheckade: (d.bookings || []).filter(b => ['checked_in', 'completed'].includes(b.status)).length,
        arbetsuppgifter: (d.tasks || []).map(t => ({ uppgift: t.title, del: t.category, klar: t.done })),
        svinnposter: (d.waste || []).filter(w => !w.voided_at).map(w => pick(w, ['item', 'qty', 'reason'])),
      };
    }
    case 'veckobudget': {
      const r = await rpc('api_budget', { actor, action: 'get' });
      const b = computeBudget(r.settings, r.weeks, r.received);
      let fortnox = null;
      try { fortnox = fortnoxSummary(await rpc('api_fortnox', { actor, action: 'status' }), env); } catch { /* Fortnox ej installerat */ }
      return {
        installningar: b.settings, varningar: b.warnings,
        veckor: b.weeks.map(w => ({ ...pick(w, ['weekStart', 'week', 'kind', 'status', 'revenueEx', 'salesVat', 'salesInkl', 'reserve', 'left', 'plusMinus', 'balanceIn', 'balanceOut', 'free', 'goodsPct', 'buffer', 'vatReserve', 'note', 'received']),
          poster: (w.posts || []).map(p => pick(p, ['name', 'budget', 'actual', 'in', 'out', 'status'])) })),
        fortnox: fortnox && pick(fortnox, ['connected', 'bankBalance', 'bankAsOf', 'syncedAt', 'suppliers']),
      };
    }
    case 'lager': {
      const s = await rpc('api_stock', { actor, action: 'list' });
      return { varor: (s.items || []).map(i => pick(i, ['name', 'category', 'unit', 'onHand', 'minLevel', 'orderQty', 'unitCost', 'supplierName', 'low', 'onOrder', 'countedAt', 'active'])) };
    }
    case 'inkop': {
      const p = await rpc('api_purchase', { actor, action: 'list' });
      return { ordrar: (p.orders || []).slice(0, 40).map(o => ({ ...pick(o, ['number', 'status', 'supplierName', 'createdAt', 'sentAt', 'receivedAt']),
        rader: (o.lines || []).map(l => pick(l, ['name', 'unit', 'qty', 'unitCost', 'receivedQty'])) })) };
    }
    case 'meny_och_installningar': {
      const [menu, cfg] = await Promise.all([rpc('api_menu', {}), rpc('api_admin_settings', { actor, action: 'get' })]);
      return { meny: (menu || []).map(m => pick(m, ['category', 'name', 'price'])),
        installningar: pick(cfg, ['slot_cap', 'slot_min', 'hour_cap', 'seats', 'sitting_min', 'arrival_min', 'max_count', 'open_weekdays', 'lunch_first', 'lunch_last', 'dinner_first', 'dinner_last', 'avg_pizza_price', 'waste_cost', 'sit_after_close']),
        stangdaDatum: (cfg.closedDates || []).map(c => pick(c, ['date', 'reason'])) };
    }
    default:
      throw new AppError(400, 'Okänt verktyg.');
  }
}

function systemPrompt(today, name) {
  return `Du är AI-restaurangchefen för Albert NO.485, en AVPN-certifierad napolitansk pizzeria med vedeldad Stefano Ferrara-ugn på Pilgatan 3 i Varberg. Du hjälper ägaren ${name} att förstå verksamheten: försäljning, bokningar, svinn, lager, inköp och veckobudget.

Dagens datum är ${today} (Europe/Stockholm). Veckor börjar på måndag. Öppet normalt onsdag–söndag.

Regler:
- Svara alltid på svenska, kort och konkret. Använd siffror från verktygen och säg vilken period de gäller.
- Hämta data med verktygen innan du svarar på frågor om verksamheten. Gissa aldrig siffror; saknas data, säg det.
- Du kan bara läsa. Du kan inte ändra bokningar, lager, budget eller skicka något. Föreslå i stället vad ägaren kan göra i admin.
- Försäljningen i statistiken är pizzor (bokade + drop-in), inte kronor, om inte veckobudgeten har omsättning ifylld.
- Ge gärna 1–3 konkreta förslag när det passar, men håll dig till det som datan stödjer.
- Du får inga personuppgifter om gäster och ska inte be om dem.`;
}

function cleanMessages(messages) {
  if (!Array.isArray(messages) || !messages.length || messages.length > 30) throw new AppError(400, 'Skriv en fråga.');
  const out = messages.slice(-20).map(m => {
    if (!m || !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string') throw new AppError(400, 'Ogiltig konversation.');
    const content = m.content.trim().slice(0, 4000);
    if (!content) throw new AppError(400, 'Skriv en fråga.');
    return { role: m.role, content };
  });
  while (out.length && out[0].role !== 'user') out.shift();
  if (!out.length || out[out.length - 1].role !== 'user') throw new AppError(400, 'Skriv en fråga.');
  return out;
}

/** Kör en fråga mot Claude med verktyg. Returnerar svaret som text. */
export async function askAi({ rpc, actor, actorName, env, fetcher, now = () => new Date(), messages }) {
  const cfg = aiConfig(env);
  if (!cfg.configured) throw new AppError(409, 'AI-assistenten är inte aktiverad ännu. Lägg in ANTHROPIC_API_KEY i Vercel.');
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm' }).format(now());
  const convo = cleanMessages(messages);
  const used = [];
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await fetcher(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': cfg.key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: cfg.model, max_tokens: 1500, system: systemPrompt(today, actorName || 'Albert'), tools: TOOLS, messages: convo }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const kind = body?.error?.type || '';
      if (response.status === 401) throw new AppError(502, 'AI-nyckeln godtas inte. Kontrollera ANTHROPIC_API_KEY i Vercel.');
      if (response.status === 429) throw new AppError(503, 'AI-assistenten är upptagen eller har nått månadsgränsen. Försök igen om en stund.');
      if (kind === 'not_found_error') throw new AppError(502, 'AI-modellen hittades inte. Kontrollera ANTHROPIC_MODEL i Vercel.');
      throw new AppError(502, 'AI-tjänsten svarade inte som väntat (' + response.status + ').');
    }
    const content = Array.isArray(body.content) ? body.content : [];
    if (body.stop_reason !== 'tool_use') {
      const text = content.filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
      return { reply: text || 'Jag fick inget svar. Försök formulera frågan på ett annat sätt.', tools: used };
    }
    convo.push({ role: 'assistant', content });
    const results = [];
    for (const c of content.filter(x => x.type === 'tool_use')) {
      used.push(c.name);
      let result, isError = false;
      try { result = await runTool(c.name, c.input || {}, { rpc, actor, env }); }
      catch (error) { result = { fel: error instanceof AppError ? error.message : 'Kunde inte hämta data.' }; isError = true; }
      results.push({ type: 'tool_result', tool_use_id: c.id, content: JSON.stringify(result).slice(0, 60000), is_error: isError });
    }
    convo.push({ role: 'user', content: results });
  }
  return { reply: 'Frågan krävde för många steg. Försök dela upp den i mindre frågor.', tools: used };
}
