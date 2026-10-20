import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.mjs';
import { computeBudget, isoWeek } from '../lib/budget.js';

// Påhittade siffror – inga riktiga belopp i koden.
const settings = {
  pct: { goods: 0.25, fuel: 0.04, staff: 0.30, other: 0.02, buffer: 0.10 },
  purchaseVat: { goods: 0.06, fuel: 0.25, other: 0.25 },
  salesMix: [{ name: 'Hämtmat', share: 0.4, rate: 0.06 }, { name: 'På plats', share: 0.6, rate: 0.12 }],
  cardMix: [{ name: 'Debit', share: 1, rate: 0.002, fee: 0.2 }],
  cardShare: 0.9, avgCard: 250, startBalance: 1000,
  fixed: [
    { key: 'rent', name: 'Hyra', amount: 13000, basis: 'inkl', vat: 0.25 },
    { key: 'phone', name: 'Telefon', amount: 400, basis: 'exkl', vat: 0.25 },
  ],
};

test('uträkningen följer arkets regler', () => {
  const r = computeBudget(settings, [
    { weekStart: '2026-10-05', kind: 'actual', revenue: 40000, actuals: {} },
    { weekStart: '2026-10-12', kind: 'actual', revenue: 30000, actuals: { goods: 7000, rent: 3000 } },
    { weekStart: '2026-09-28', kind: 'example', revenue: 99999, actuals: {} },
  ]);
  const [ex, w1, w2] = r.weeks;
  assert.equal(ex.kind, 'example'); assert.equal(ex.balanceOut, 1000); // exempel förs inte vidare
  // Moms: 40 000 × (0,4×6 % + 0,6×12 %) = 3 840
  assert.equal(w1.salesVat, 3840); assert.equal(w1.salesInkl, 43840);
  const post = (w, k) => w.posts.find(p => p.key === k);
  assert.equal(post(w1, 'goods').budget, 10600);           // 40 000 × 25 % × 1,06
  assert.equal(post(w1, 'staff').budget, 12000);
  assert.equal(post(w1, 'rent').budget, 3000);             // 13 000 × 12 / 52
  assert.equal(post(w1, 'phone').budget, 115.38);          // 400 × 1,25 × 12 / 52
  assert.equal(w1.cardAmount, 39456); assert.equal(w1.cardCount, 158);
  assert.equal(post(w1, 'card').budget, Math.round((39456 * 0.002 + 158 * 0.2) * 100) / 100);
  assert.equal(w1.left, Math.round((w1.salesInkl - w1.reserve) * 100) / 100);
  assert.equal(w1.plusMinus, w1.left);                     // inget utfall = budget används
  assert.equal(w1.balanceOut, Math.round((1000 + w1.left) * 100) / 100);
  // Vecka 2: varuinköp 7 000 mot 7 950 budget → 950 kvar i potten
  assert.equal(post(w2, 'goods').budget, 7950);
  assert.equal(post(w2, 'goods').out, 950); assert.equal(post(w2, 'goods').status, 'Inom budget');
  assert.equal(post(w2, 'rent').out, 0);
  assert.equal(w2.goodsPct, Math.round(7000 / 1.06 / 30000 * 10000) / 100);
  assert.equal(w2.plusMinus, Math.round((w2.left + 950) * 100) / 100);
  assert.equal(w2.free, Math.round((w2.balanceOut - 950) * 100) / 100); // plus i potten räknas bort
  assert.equal(isoWeek('2026-10-05'), 41);
});

let t, owner, staff;
before(async () => {
  t = setup();
  t.auth.addUser('albert@albertno485.com', 'hemligt-losen-1', 'Albert');
  owner = t.auth.tokenFor('albert@albertno485.com');
  await t.call('GET', '/api/admin/day', undefined, { token: owner });
  await t.call('POST', '/api/admin/staff', { action: 'create', name: 'Marco', email: 'marco@example.se', role: 'staff', password: 'tillfalligt-123' }, { token: owner });
  staff = t.auth.tokenFor('marco@example.se');
});
after(() => t.close());

test('admin sparar inställningar och veckor, personal har inte åtkomst', async () => {
  assert.equal((await t.call('GET', '/api/admin/budget', undefined, { token: staff })).status, 403);
  const empty = await t.call('GET', '/api/admin/budget', undefined, { token: owner });
  assert.equal(empty.status, 200, JSON.stringify(empty.body));
  assert.equal(empty.body.weeks.length, 0);
  assert.ok(empty.body.warnings.some(w => w.includes('Belopp saknas')));

  const saved = await t.call('POST', '/api/admin/budget', { action: 'save_settings', settings }, { token: owner });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.settings.fixed.length, 2);

  const bad = await t.call('POST', '/api/admin/budget', { action: 'save_week', week: { weekStart: '2026-10-06', revenue: 1 } }, { token: owner });
  assert.equal(bad.status, 400);
  const week = await t.call('POST', '/api/admin/budget', { action: 'save_week', week: { weekStart: '2026-10-05', revenue: 40000, actuals: { goods: 9000, okand: 5 } } }, { token: owner });
  assert.equal(week.status, 200, JSON.stringify(week.body));
  assert.deepEqual(week.body.weeks[0].actuals, { goods: 9000 });
  assert.equal(week.body.weeks[0].salesInkl, 43840);
  // Samma vecka sparas om, inget dubbleras
  const again = await t.call('POST', '/api/admin/budget', { action: 'save_week', week: { weekStart: '2026-10-05', revenue: 41000, actuals: {} } }, { token: owner });
  assert.equal(again.body.weeks.length, 1); assert.equal(again.body.weeks[0].revenue, 41000);
  assert.equal((await t.call('POST', '/api/admin/budget', { action: 'save_week', week: { weekStart: '2026-10-12', revenue: 5 } }, { token: staff })).status, 403);
});
