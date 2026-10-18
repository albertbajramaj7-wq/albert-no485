// Veckobudget – samma uträkning som Albert_NO485_Veckobudget (Google-arket).
//
// Omsättning per vecka fördelas på kostnadsposter i procent, fasta månadskostnader
// läggs undan per vecka (× 12 / 52), kortavgiften uppskattas och hela
// försäljningsmomsen reserveras. Faktiska kostnader (utfall) jämförs med
// budgeten; över- och underskott förs vidare per post till nästa vecka.
// Exempelveckor visas men förs inte vidare.
//
// Inga egna siffror ligger här – beloppen sparas i databasen via admin.

export const PERCENT_POSTS = [
  { key: 'goods', name: 'Varuinköp', vatKey: 'goods' },
  { key: 'fuel', name: 'Drivmedel', vatKey: 'fuel' },
  { key: 'staff', name: 'Personal, total kostnad', vatKey: null },
  { key: 'other', name: 'Övrig löpande drift', vatKey: 'other' },
];

export const DEFAULT_SETTINGS = Object.freeze({
  reportBasis: 'ex',          // kassarapportens belopp: 'ex' eller 'inkl' moms
  openDays: 5,
  cardShare: 0.95,
  avgCard: 300,
  startBalance: 0,
  pct: { goods: 0.30, fuel: 0.05, staff: 0.30, other: 0, buffer: 0.10 },
  purchaseVat: { goods: 0.06, fuel: 0.25, other: 0.25 },
  salesMix: [
    { name: 'Hämtmat', share: 0.5, rate: 0.06 },
    { name: 'Servering på plats', share: 0.5, rate: 0.12 },
    { name: 'Försäljning med 25 % moms', share: 0, rate: 0.25 },
  ],
  cardMix: [
    { name: 'Debitkort inom SEPA', share: 0.85, rate: 0, fee: 0 },
    { name: 'Kreditkort inom SEPA', share: 0.10, rate: 0, fee: 0 },
    { name: 'Företagskort / internationella', share: 0.05, rate: 0, fee: 0 },
  ],
  cardFeeVat: 0,
  fixed: [
    { key: 'rent', name: 'Hyra, el och vatten', amount: null, basis: 'inkl', vat: 0.25 },
    { key: 'wood', name: 'Ved', amount: null, basis: 'inkl', vat: 0.25 },
    { key: 'pos', name: 'Kassa och terminal', amount: null, basis: 'exkl', vat: 0.25 },
    { key: 'phone', name: 'Telefon och växel', amount: null, basis: 'exkl', vat: 0.25 },
    { key: 'accounting', name: 'Bokföring', amount: null, basis: 'exkl', vat: 0.25 },
    { key: 'bank', name: 'Bank', amount: null, basis: 'inkl', vat: 0 },
    { key: 'other_fixed', name: 'Övriga fasta kostnader', amount: null, basis: 'inkl', vat: 0.25 },
    { key: 'tax', name: 'Preliminärskatt', amount: null, basis: 'inkl', vat: 0 },
  ],
});

export class BudgetError extends Error { constructor(message) { super(message); this.status = 400; } }

const isNum = v => typeof v === 'number' && Number.isFinite(v);
function num(v, min, max, message, { nullable = false, fallback } = {}) {
  if (v === undefined) { if (fallback !== undefined) return fallback; if (nullable) return null; throw new BudgetError(message); }
  if (v === null || v === '') { if (nullable) return null; if (fallback !== undefined) return fallback; throw new BudgetError(message); }
  const n = typeof v === 'string' ? Number(v.replace(',', '.')) : v;
  if (!isNum(n) || n < min || n > max) throw new BudgetError(message);
  return Math.round(n * 1e6) / 1e6;
}
function text(v, max, fallback = '') { return typeof v === 'string' ? v.trim().slice(0, max) : fallback; }
const pct = (v, label, fallback) => num(v, 0, 1, 'Ogiltig procentsats för ' + label + '.', { fallback });

/** Tvättar och kontrollerar inställningar. Saknade fält får standardvärden. */
export function normalizeSettings(input) {
  const s = input && typeof input === 'object' ? input : {};
  const d = DEFAULT_SETTINGS;
  const out = {
    reportBasis: s.reportBasis === 'inkl' ? 'inkl' : 'ex',
    openDays: num(s.openDays, 1, 7, 'Öppetdagar ska vara 1–7.', { fallback: d.openDays }),
    cardShare: pct(s.cardShare, 'kortbetalning', d.cardShare),
    avgCard: num(s.avgCard, 1, 100000, 'Ogiltigt snitt per kortköp.', { fallback: d.avgCard }),
    startBalance: num(s.startBalance, -100000000, 100000000, 'Ogiltigt startsaldo.', { fallback: 0 }),
    pct: {}, purchaseVat: {},
    cardFeeVat: pct(s.cardFeeVat, 'moms på kortavgift', d.cardFeeVat),
  };
  for (const k of ['goods', 'fuel', 'staff', 'other', 'buffer']) out.pct[k] = pct(s.pct?.[k], k, d.pct[k]);
  for (const k of ['goods', 'fuel', 'other']) out.purchaseVat[k] = pct(s.purchaseVat?.[k], 'inköpsmoms', d.purchaseVat[k]);
  const list = (arr, def, max, map) => {
    const src = Array.isArray(arr) ? arr : def;
    if (src.length > max) throw new BudgetError('För många rader.');
    return src.map(map);
  };
  out.salesMix = list(s.salesMix, d.salesMix, 6, (r, i) => ({ name: text(r?.name, 60, 'Försäljning ' + (i + 1)) || 'Försäljning ' + (i + 1), share: pct(r?.share, 'försäljningsmix', 0), rate: pct(r?.rate, 'momssats', 0) }));
  out.cardMix = list(s.cardMix, d.cardMix, 6, (r, i) => ({ name: text(r?.name, 60, 'Korttyp ' + (i + 1)) || 'Korttyp ' + (i + 1), share: pct(r?.share, 'kortmix', 0), rate: pct(r?.rate, 'kortavgift', 0), fee: num(r?.fee, 0, 100, 'Ogiltig avgift per kortköp.', { fallback: 0 }) }));
  const keys = new Set();
  out.fixed = list(s.fixed, d.fixed, 30, (r, i) => {
    let key = text(r?.key, 40).replace(/[^a-z0-9_]/gi, '').toLowerCase() || 'custom_' + (i + 1);
    while (keys.has(key) || PERCENT_POSTS.some(p => p.key === key) || ['card', 'buffer', 'vat'].includes(key)) key += '_x';
    keys.add(key);
    const name = text(r?.name, 60);
    if (name.length < 2) throw new BudgetError('Skriv ett namn på varje fast kostnad.');
    return { key, name, amount: num(r?.amount, 0, 10000000, 'Ogiltigt belopp för ' + name + '.', { nullable: true }), basis: r?.basis === 'exkl' ? 'exkl' : 'inkl', vat: pct(r?.vat, name, 0.25) };
  });
  return out;
}

const isoDate = /^\d{4}-\d{2}-\d{2}$/;
/** Tvättar en vecka från formuläret. */
export function normalizeWeek(w, settings) {
  if (!w || typeof w !== 'object') throw new BudgetError('Ingen vecka att spara.');
  if (!isoDate.test(w.weekStart || '')) throw new BudgetError('Välj en giltig vecka.');
  const day = new Date(w.weekStart + 'T12:00:00Z');
  if (Number.isNaN(day.getTime()) || day.getUTCDay() !== 1) throw new BudgetError('Veckan ska börja på en måndag.');
  const amount = (v, label) => num(v, 0, 100000000, 'Ogiltigt belopp: ' + label + '.', { nullable: true });
  const keys = new Set(['goods', 'fuel', 'staff', 'other', 'card', ...settings.fixed.map(f => f.key)]);
  const actuals = {};
  for (const [k, v] of Object.entries(w.actuals && typeof w.actuals === 'object' ? w.actuals : {})) {
    if (!keys.has(k)) continue;
    const n = amount(v, 'utfall');
    if (n !== null) actuals[k] = n;
  }
  return {
    weekStart: w.weekStart,
    kind: w.kind === 'example' ? 'example' : 'actual',
    revenue: amount(w.revenue, 'omsättning'),
    salesVat: amount(w.salesVat, 'moms'),
    cardAmount: amount(w.cardAmount, 'kortbelopp'),
    cardCount: w.cardCount === null || w.cardCount === undefined || w.cardCount === '' ? null : Math.round(num(w.cardCount, 0, 1000000, 'Ogiltigt antal kortköp.')),
    note: text(w.note, 300),
    actuals,
  };
}

export function isoWeek(dateText) {
  const d = new Date(dateText + 'T12:00:00Z');
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  return 1 + Math.round(((d - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
}

const r2 = n => Math.round(n * 100) / 100;

/** Fasta kostnader: belopp att betala per månad och per vecka. */
export function fixedCosts(settings) {
  return settings.fixed.map(f => {
    if (f.amount === null) return { ...f, monthly: null, weekly: null, weeklyEx: null, missing: true };
    const monthly = f.basis === 'inkl' ? f.amount : f.amount * (1 + f.vat);
    const weekly = monthly * 12 / 52;
    return { ...f, monthly: r2(monthly), weekly, weeklyEx: weekly / (1 + f.vat), missing: false };
  });
}

/**
 * Räknar fram alla veckor i datumordning.
 * received: { 'YYYY-MM-DD' (måndag): kronor ex moms } – mottagna leveranser i admin.
 */
export function computeBudget(settingsInput, weeksInput, received = {}) {
  const s = normalizeSettings(settingsInput);
  const mixRate = s.salesMix.reduce((n, m) => n + m.share * m.rate, 0);
  const cardRate = s.cardMix.reduce((n, m) => n + m.share * m.rate, 0);
  const cardFee = s.cardMix.reduce((n, m) => n + m.share * m.fee, 0);
  const fixed = fixedCosts(s);
  const warnings = [];
  const pctSum = ['goods', 'fuel', 'staff', 'other', 'buffer'].reduce((n, k) => n + s.pct[k], 0);
  if (Math.abs(s.salesMix.reduce((n, m) => n + m.share, 0) - 1) > 0.001) warnings.push('Försäljningsmixen summerar inte till 100 %.');
  if (Math.abs(s.cardMix.reduce((n, m) => n + m.share, 0) - 1) > 0.001) warnings.push('Kortmixen summerar inte till 100 %.');
  const missing = fixed.filter(f => f.missing).map(f => f.name);
  if (missing.length) warnings.push('Belopp saknas för ' + missing.join(', ') + '. Skriv 0 om posten inte kostar något.');

  const carry = {};
  let balance = s.startBalance;
  const weeks = [...weeksInput].sort((a, b) => a.weekStart.localeCompare(b.weekStart)).map(w => {
    const base = { ...w, input: { revenue: w.revenue ?? null, salesVat: w.salesVat ?? null, cardAmount: w.cardAmount ?? null, cardCount: w.cardCount ?? null }, week: isoWeek(w.weekStart), received: received[w.weekStart] ?? null, balanceIn: r2(balance) };
    if (w.revenue === null || w.revenue === undefined) {
      return { ...base, computed: false, status: 'Fyll i omsättning', balanceOut: r2(balance), free: r2(balance - positivePots(carry)) };
    }
    let revEx, salesVat;
    if (s.reportBasis === 'inkl') {
      salesVat = w.salesVat ?? w.revenue - w.revenue / (1 + mixRate);
      revEx = w.revenue - salesVat;
    } else {
      revEx = w.revenue;
      salesVat = w.salesVat ?? revEx * mixRate;
    }
    const salesInkl = revEx + salesVat;
    const cardAmount = w.cardAmount ?? salesInkl * s.cardShare;
    const cardCount = w.cardCount ?? Math.round(cardAmount / s.avgCard);
    const posts = [];
    for (const p of PERCENT_POSTS) {
      const ex = revEx * s.pct[p.key];
      const vat = p.vatKey ? ex * s.purchaseVat[p.vatKey] : 0;
      posts.push({ key: p.key, name: p.name, basis: Math.round(s.pct[p.key] * 1000) / 10 + ' %', ex, vat, budget: ex + vat });
    }
    for (const f of fixed) posts.push({ key: f.key, name: f.name, basis: f.missing ? 'Belopp saknas' : 'Månadsbelopp', ex: f.weeklyEx ?? 0, vat: f.missing ? 0 : f.weekly - f.weeklyEx, budget: f.weekly ?? 0, missing: f.missing });
    const feeEx = cardAmount * cardRate + cardCount * cardFee;
    posts.push({ key: 'card', name: 'Kortavgift, uppskattad', basis: 'Kortmix', ex: feeEx, vat: feeEx * s.cardFeeVat, budget: feeEx * (1 + s.cardFeeVat) });
    const example = w.kind === 'example';
    let used = 0;
    for (const p of posts) {
      p.actual = w.actuals?.[p.key] ?? null;
      p.in = example ? 0 : carry[p.key] || 0;
      p.available = p.in + p.budget;
      if (p.actual === null) { p.out = p.in; p.status = 'Utfall saknas'; used += p.budget; }
      else { p.out = p.available - p.actual; p.status = p.out >= 0 ? 'Inom budget' : 'Över budget'; used += p.actual; }
      if (!example) carry[p.key] = p.out;
    }
    const buffer = revEx * s.pct.buffer;
    const reserve = posts.reduce((n, p) => n + p.budget, 0) + buffer + salesVat;
    const left = salesInkl - reserve;
    const plusMinus = salesInkl - used - buffer - salesVat;
    const balanceOut = example ? balance : balance + plusMinus;
    if (!example) balance = balanceOut;
    const goodsActual = w.actuals?.goods;
    const round = p => ({ ...p, ex: r2(p.ex), vat: r2(p.vat), budget: r2(p.budget), in: r2(p.in), available: r2(p.available), out: r2(p.out) });
    return {
      ...base, computed: true,
      status: example ? 'Exempel, förs inte vidare' : posts.some(p => p.actual === null) ? 'Utfall saknas för vissa poster' : 'Klar',
      revenueEx: r2(revEx), salesVat: r2(salesVat), salesInkl: r2(salesInkl),
      perOpenDay: r2(revEx / s.openDays), cardAmount: r2(cardAmount), cardCount,
      posts: posts.map(round), buffer: r2(buffer), vatReserve: r2(salesVat),
      purchaseVat: r2(posts.reduce((n, p) => n + (p.key === 'staff' ? 0 : p.vat), 0)),
      reserve: r2(reserve), left: r2(left), plusMinus: r2(plusMinus),
      goodsPct: goodsActual === undefined || !revEx ? null : r2(goodsActual / (1 + s.purchaseVat.goods) / revEx * 100),
      balanceOut: r2(balanceOut), free: r2(balanceOut - positivePots(carry)),
    };
  });
  return { settings: s, fixed: fixed.map(f => ({ ...f, weekly: f.weekly === null ? null : r2(f.weekly), weeklyEx: f.weeklyEx === null ? null : r2(f.weeklyEx) })), mixRate: r2(mixRate * 10000) / 10000, pctSum: r2(pctSum * 10000) / 10000, warnings, weeks };
}

function positivePots(carry) { return Object.values(carry).reduce((n, v) => n + (v > 0 ? v : 0), 0); }
