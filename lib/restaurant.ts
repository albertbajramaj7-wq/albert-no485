export type DB = D1Database;
export type Identity = { userId: string; email: string; displayName?: string } | null;
export type Actor = { user_id: string; email: string; name: string; role: string };
export type Day = { date: string; prepared: number | null; dropin: number; waste: number; paused: number; allow_after_closing: number; version: number };
export type Booking = { id: string; request_key: string; date: string; ready_min: number; count: number; guests: number; mode: string; name: string; email: string; phone: string; status: string; cancel_reason: string | null; created_at: string; updated_at: string };
export type Task = { id: string; date: string; title: string; category: string; area: string; template_key: string | null; done: number; archived: number; updated_by: string; updated_at: string };
const TASK_PHASES = ['opening', 'general', 'closing'];
const TASK_AREAS = ['kitchen', 'service', 'hygiene', 'other'];
export const TASK_CHECKLIST = [
  { key: 'open-dough', category: 'opening', area: 'kitchen', title: 'Kontrollera dagens degbollar och pizzantal' },
  { key: 'open-tomato', category: 'opening', area: 'kitchen', title: 'Förbered tomatsås' },
  { key: 'open-topping', category: 'opening', area: 'kitchen', title: 'Förbered mozzarella och övrig topping' },
  { key: 'open-stations', category: 'opening', area: 'kitchen', title: 'Gör pizzastationerna redo' },
  { key: 'open-tables', category: 'opening', area: 'service', title: 'Duka bord och gör serveringen redo' },
  { key: 'open-bookings', category: 'opening', area: 'service', title: 'Gå igenom dagens bokningar' },
  { key: 'open-surfaces', category: 'opening', area: 'hygiene', title: 'Kontrollera rena arbetsytor och handfat' },
  { key: 'open-toilet', category: 'opening', area: 'hygiene', title: 'Kontrollera toalett, papper och tvål' },
  { key: 'day-topping', category: 'general', area: 'kitchen', title: 'Fyll på råvaror vid pizzastationerna' },
  { key: 'day-tables', category: 'general', area: 'service', title: 'Torka bord och håll serveringen i ordning' },
  { key: 'day-toilet', category: 'general', area: 'hygiene', title: 'Se över toaletten och fyll på vid behov' },
  { key: 'day-surfaces', category: 'general', area: 'hygiene', title: 'Håll handfat och arbetsytor rena' },
  { key: 'close-stock', category: 'closing', area: 'kitchen', title: 'Ställ in och märk råvaror i kylen' },
  { key: 'close-stations', category: 'closing', area: 'kitchen', title: 'Rengör pizzastationer och redskap' },
  { key: 'close-tables', category: 'closing', area: 'service', title: 'Städa lokalen och ställ i ordning borden' },
  { key: 'close-counts', category: 'closing', area: 'service', title: 'Stäm av bokningar, drop-in och svinn' },
  { key: 'close-waste', category: 'closing', area: 'hygiene', title: 'Töm sopor och byt påsar' },
  { key: 'close-toilet', category: 'closing', area: 'hygiene', title: 'Städa toalett och handfat' },
];
export class AppError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
export const LIMITS = { slot: 8, hour: 31, seats: 31, sitting: 60, arrival: 10, horizon: 30 };
export function stockholm(now = new Date()) {
  const p = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const get = (name: string) => p.find(x => x.type === name)?.value || '';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, minute: Number(get('hour')) * 60 + Number(get('minute')) };
}
export function validDate(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new AppError(400, 'Välj ett giltigt datum.');
  const date = new Date(value + 'T12:00:00Z');
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new AppError(400, 'Välj ett giltigt datum.');
  return value;
}
export function number(value: unknown, min: number, max: number, message = 'Skriv ett giltigt antal.'): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new AppError(400, message);
  return value;
}
export function cleanText(value: unknown, min: number, max: number, message: string): string {
  if (typeof value !== 'string') throw new AppError(400, message);
  const text = value.trim();
  if (text.length < min || text.length > max || /[\u0000-\u0008\u000b-\u001f]/.test(text)) throw new AppError(400, message);
  return text;
}
export function timeText(minute: number) { return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`; }
export function defaultDay(date: string): Day { return { date, prepared: null, dropin: 0, waste: 0, paused: 0, allow_after_closing: 0, version: 0 }; }
const active = (row: Booking) => row.status !== 'cancelled';
const seatsActive = (row: Booking) => row.mode === 'here' && ['confirmed', 'checked_in'].includes(row.status);
const isOpen = (date: string) => [0, 3, 4, 5, 6].includes(new Date(date + 'T12:00:00Z').getUTCDay());
export function timeSlots(): number[] {
  const slots: number[] = [];
  for (const [start, end] of [[735, 870], [1005, 1260]]) for (let t = start; t <= end; t += 15) slots.push(t);
  return slots;
}
function publicDate(date: string, now: Date) {
  const current = stockholm(now);
  const end = new Date(current.date + 'T12:00:00Z'); end.setUTCDate(end.getUTCDate() + LIMITS.horizon);
  if (date < current.date || date > end.toISOString().slice(0, 10)) throw new AppError(400, 'Du kan boka från i dag och 30 dagar framåt.');
  return current;
}
export function calculateAvailability(day: Day, rows: Booking[], count: number, mode: string, guests: number, now = new Date()) {
  const current = publicDate(day.date, now);
  const booked = rows.filter(active).reduce((n, b) => n + b.count, 0);
  const dailyRemaining = day.prepared === null ? null : Math.max(0, day.prepared - booked - day.dropin - day.waste);
  if (!isOpen(day.date)) return { date: day.date, closed: true, paused: !!day.paused, dailyRemaining, slots: [] };
  const slots = timeSlots().map(t => {
    let remaining = LIMITS.slot - rows.filter(b => active(b) && b.ready_min === t).reduce((n, b) => n + b.count, 0);
    for (const start of [t - 45, t - 30, t - 15, t]) remaining = Math.min(remaining, LIMITS.hour - rows.filter(b => active(b) && b.ready_min >= start && b.ready_min <= start + 45).reduce((n, b) => n + b.count, 0));
    if (dailyRemaining !== null) remaining = Math.min(remaining, dailyRemaining);
    const arrival = t - LIMITS.arrival, end = arrival + LIMITS.sitting;
    const overlapping = rows.filter(b => seatsActive(b) && b.ready_min - 10 < end && b.ready_min + 50 > arrival);
    const points = [arrival, ...overlapping.map(b => b.ready_min - 10).filter(v => v >= arrival && v < end)];
    const usedSeats = Math.max(0, ...points.map(point => overlapping.filter(b => b.ready_min - 10 <= point && b.ready_min + 50 > point).reduce((n, b) => n + b.guests, 0)));
    const seats = Math.max(0, LIMITS.seats - usedSeats);
    const close = t < 900 ? 870 : 1260;
    const future = day.date > current.date || arrival >= current.minute;
    const sittingAllowed = mode === 'away' || !!day.allow_after_closing || end <= close;
    return { time: timeText(t), minute: t, remaining: Math.max(0, remaining), seats: mode === 'here' ? seats : null, bookable: !day.paused && future && sittingAllowed && remaining >= count && (mode === 'away' || seats >= guests) };
  });
  return { date: day.date, closed: false, paused: !!day.paused, dailyRemaining, slots };
}
export async function dayRows(db: DB, date: string) {
  const results = await db.batch([db.prepare('SELECT * FROM days WHERE date=?').bind(date), db.prepare('SELECT * FROM bookings WHERE date=? ORDER BY ready_min, created_at').bind(date)]);
  return { day: (results[0].results[0] as Day | undefined) || defaultDay(date), bookings: results[1].results as Booking[] };
}
export async function getAvailability(db: DB, input: Record<string, unknown>, now = new Date()) {
  const date = validDate(input.date), count = number(input.count, 1, 8), mode = input.mode === 'away' ? 'away' : input.mode === 'here' ? 'here' : '';
  if (!mode) throw new AppError(400, 'Välj äta här eller ta med.');
  const guests = mode === 'here' ? number(input.guests, 1, 31) : 0;
  const data = await dayRows(db, date);
  return calculateAvailability(data.day, data.bookings, count, mode, guests, now);
}
export async function authorize(db: DB, identity: Identity, ownerEmail: string): Promise<Actor> {
  if (!identity?.userId || !identity.email) throw new AppError(401, 'Logga in för att öppna admin.');
  const actor = await db.prepare('SELECT * FROM operators WHERE user_id=?').bind(identity.userId).first<Actor>();
  if (actor) return actor;
  if (!ownerEmail || identity.email.toLowerCase() !== ownerEmail.toLowerCase()) throw new AppError(403, 'Ditt konto har inte behörighet till admin.');
  await db.prepare('INSERT OR IGNORE INTO operators(user_id,email,name,role,created_at) VALUES(?,?,?,?,?)').bind(identity.userId, identity.email.toLowerCase(), identity.displayName || identity.email, 'owner', new Date().toISOString()).run();
  return { user_id: identity.userId, email: identity.email, name: identity.displayName || identity.email, role: 'owner' };
}
function auditStatement(db: DB, date: string, actor: string, action: string, target: string, detail: unknown) {
  return db.prepare('INSERT INTO audit(id,date,actor,action,target,detail,created_at) SELECT ?,?,?,?,?,?,? WHERE changes()>0').bind(crypto.randomUUID(), date, actor, action, target, JSON.stringify(detail), new Date().toISOString());
}
function publicConfirmation(b: Booking) {
  return { id: b.id, date: b.date, time: timeText(b.ready_min), arrival: timeText(b.ready_min - 10), sittingEnd: b.mode === 'here' ? timeText(b.ready_min + 50) : null, count: b.count, mode: b.mode, guests: b.guests };
}
export async function createBooking(db: DB, input: Record<string, unknown>, key: string, now = new Date()) {
  if (!/^[a-f0-9-]{36}$/i.test(key)) throw new AppError(400, 'Bokningen behöver en giltig referens. Ladda om sidan.');
  const date = validDate(input.date), count = number(input.count, 1, 8), mode = input.mode === 'here' ? 'here' : input.mode === 'away' ? 'away' : '';
  if (!mode) throw new AppError(400, 'Välj äta här eller ta med.');
  const guests = mode === 'here' ? number(input.guests, 1, 31) : 0;
  const contact = input.contact as Record<string, unknown> | undefined;
  const name = cleanText(contact?.name, 2, 100, 'Skriv ditt namn.');
  const email = cleanText(contact?.email, 5, 180, 'Skriv en giltig e-postadress.').toLowerCase();
  const phone = cleanText(contact?.phone, 8, 30, 'Skriv ett giltigt telefonnummer.');
  if (!/^[^\s@<>,;:"\\]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/i.test(email) || email.includes('..')) throw new AppError(400, 'Skriv en giltig e-postadress.');
  if (!/^(?:\+|00)?[0-9\s().-]{8,24}$/.test(phone)) throw new AppError(400, 'Skriv ett giltigt telefonnummer.');
  const old = await db.prepare('SELECT * FROM bookings WHERE request_key=?').bind(key).first<Booking>();
  if (old) {
    if (old.date !== date || old.count !== count || old.mode !== mode || old.guests !== guests || old.email !== email || old.phone !== phone || timeText(old.ready_min) !== input.time) throw new AppError(409, 'Referensen hör redan till en annan bokning.');
    return publicConfirmation(old);
  }
  const availability = await getAvailability(db, { date, count, mode, guests }, now);
  const selected = availability.slots.find(s => s.time === input.time && s.bookable);
  if (!selected) throw new AppError(409, 'Tiden är inte längre ledig. Välj en annan tid.');
  const t = selected.minute, id = crypto.randomUUID(), timestamp = now.toISOString();
  await db.prepare('INSERT OR IGNORE INTO days(date) VALUES(?)').bind(date).run();
  const args: unknown[] = [id, key, date, t, count, guests, mode, name, email, phone, timestamp, timestamp, date, date, count, t, date, t, LIMITS.slot - count];
  let conditions = '';
  for (const start of [t - 45, t - 30, t - 15, t]) { conditions += ' AND (SELECT COALESCE(SUM(count),0) FROM bookings WHERE date=? AND status!=\'cancelled\' AND ready_min BETWEEN ? AND ?) <= ?'; args.push(date, start, start + 45, LIMITS.hour - count); }
  if (mode === 'here') {
    conditions += ` AND (allow_after_closing=1 OR ?<=?) AND (SELECT COALESCE(MAX((SELECT COALESCE(SUM(b.guests),0) FROM bookings b WHERE b.date=? AND b.mode='here' AND b.status IN ('confirmed','checked_in') AND b.ready_min-10<=p.point AND b.ready_min+50>p.point)),0) FROM (SELECT ? AS point UNION SELECT ready_min-10 FROM bookings WHERE date=? AND mode='here' AND status IN ('confirmed','checked_in') AND ready_min-10>=? AND ready_min-10<?) p) <= ?`;
    args.push(t + 50, t < 900 ? 870 : 1260, date, t - 10, date, t - 10, t + 50, LIMITS.seats - guests);
  }
  const sql = `INSERT OR IGNORE INTO bookings(id,request_key,date,ready_min,count,guests,mode,name,email,phone,status,created_at,updated_at) SELECT ?,?,?,?,?,?,?,?,?,?,'confirmed',?,? FROM days WHERE date=? AND paused=0 AND (prepared IS NULL OR prepared-dropin-waste-(SELECT COALESCE(SUM(count),0) FROM bookings WHERE date=? AND status!='cancelled')>=?) AND ? IN (${timeSlots().join(',')}) AND (SELECT COALESCE(SUM(count),0) FROM bookings WHERE date=? AND status!='cancelled' AND ready_min=?)<=? ${conditions}`;
  await db.batch([
    db.prepare(sql).bind(...args),
    auditStatement(db, date, 'guest', 'booking_created', id, { count, mode, time: input.time }),
    db.prepare("INSERT OR IGNORE INTO booking_emails(booking_id,status,created_at,updated_at) SELECT id,'pending',?,? FROM bookings WHERE id=?").bind(timestamp, timestamp, id),
  ]);
  const saved = await db.prepare('SELECT * FROM bookings WHERE request_key=?').bind(key).first<Booking>();
  if (!saved) throw new AppError(409, 'Tiden hann bli fullbokad. Välj en annan tid.');
  if (saved.date !== date || saved.count !== count || saved.mode !== mode || saved.guests !== guests || saved.email !== email || saved.phone !== phone || timeText(saved.ready_min) !== input.time) throw new AppError(409, 'Referensen hör redan till en annan bokning.');
  return publicConfirmation(saved);
}
export async function adminDay(db: DB, date: string, actor: Actor) {
  validDate(date);
  const data = await dayRows(db, date);
  const result = await db.batch([
    db.prepare('SELECT * FROM tasks WHERE date=? ORDER BY category,created_at,id').bind(date),
    db.prepare('SELECT * FROM audit WHERE date=? ORDER BY created_at DESC LIMIT 100').bind(date),
    db.prepare('SELECT booking_id,status,sent_at,next_attempt_at,last_error FROM booking_emails WHERE booking_id IN (SELECT id FROM bookings WHERE date=?)').bind(date),
  ]);
  const emails = new Map((result[2].results as { booking_id: string; status: string; sent_at: string | null; next_attempt_at: number; last_error: string | null }[]).map(row => [row.booking_id, row]));
  const taskOrder = new Map(TASK_CHECKLIST.map((t, i) => [t.key, i]));
  const tasks = (result[0].results as Task[]).sort((a, b) => (taskOrder.get(a.template_key || '') ?? 100) - (taskOrder.get(b.template_key || '') ?? 100));
  const booked = data.bookings.filter(active).reduce((s, b) => s + b.count, 0);
  const guestsPresent = data.bookings.filter(b => b.status === 'checked_in' && b.mode === 'here').reduce((s, b) => s + b.guests, 0);
  return { ...data, bookings: data.bookings.map(b => ({ ...b, confirmationEmail: emails.get(b.id) || null })), actor: { name: actor.name, email: actor.email }, limits: LIMITS, tasks: tasks.filter(t => !t.archived), checklistStarted: tasks.some(t => !!t.template_key), history: result[1].results, stats: { booked, guestsPresent, cancelled: data.bookings.filter(b => b.status === 'cancelled').length, remaining: data.day.prepared === null ? null : Math.max(0, data.day.prepared - booked - data.day.dropin - data.day.waste) } };
}
export async function changeCounter(db: DB, actor: Actor, input: Record<string, unknown>) {
  const date = validDate(input.date), field = input.field === 'dropin' ? 'dropin' : input.field === 'waste' ? 'waste' : '';
  if (!field) throw new AppError(400, 'Välj en giltig räknare.');
  await db.prepare('INSERT OR IGNORE INTO days(date) VALUES(?)').bind(date).run();
  let sql: string, args: unknown[];
  if (input.mode === 'set') {
    const value = number(input.value, 0, 10000), version = number(input.version, 0, Number.MAX_SAFE_INTEGER);
    sql = `UPDATE days SET ${field}=?,version=version+1 WHERE date=? AND version=?`; args = [value, date, version];
  } else {
    const delta = number(input.delta, -1, 1); if (!delta) throw new AppError(400, 'Välj en ändring.');
    sql = `UPDATE days SET ${field}=${field}+?,version=version+1 WHERE date=? AND ${field}+?>=0`; args = [delta, date, delta];
  }
  const results = await db.batch([db.prepare(sql).bind(...args), auditStatement(db, date, actor.name, field === 'dropin' ? 'dropin_changed' : 'waste_changed', date, { mode: input.mode || 'delta', value: input.value, delta: input.delta })]);
  if (!results[0].meta.changes) throw new AppError(409, 'Antalet ändrades eller är redan noll. Uppdatera och försök igen.');
  return adminDay(db, date, actor);
}
export async function saveDay(db: DB, actor: Actor, input: Record<string, unknown>) {
  const date = validDate(input.date), version = number(input.version, 0, Number.MAX_SAFE_INTEGER);
  const prepared = input.prepared === null ? null : number(input.prepared, 0, 10000);
  if (typeof input.paused !== 'boolean' || typeof input.allowAfterClosing !== 'boolean') throw new AppError(400, 'Välj giltiga dagsinställningar.');
  await db.prepare('INSERT OR IGNORE INTO days(date) VALUES(?)').bind(date).run();
  const result = await db.batch([db.prepare('UPDATE days SET prepared=?,paused=?,allow_after_closing=?,version=version+1 WHERE date=? AND version=?').bind(prepared, input.paused ? 1 : 0, input.allowAfterClosing ? 1 : 0, date, version), auditStatement(db, date, actor.name, 'day_settings', date, { prepared, paused: input.paused, allowAfterClosing: input.allowAfterClosing })]);
  if (!result[0].meta.changes) throw new AppError(409, 'Dagen har ändrats. Uppdatera innan du sparar igen.');
  return adminDay(db, date, actor);
}
export async function changeBooking(db: DB, actor: Actor, input: Record<string, unknown>) {
  const id = cleanText(input.id, 36, 36, 'Välj en giltig bokning.');
  const row = await db.prepare('SELECT * FROM bookings WHERE id=?').bind(id).first<Booking>();
  if (!row) throw new AppError(404, 'Bokningen finns inte.');
  const transitions: Record<string, [string[], string]> = { checkin: [['confirmed'], 'checked_in'], finish: [['checked_in'], 'completed'], cancel: [['confirmed', 'checked_in'], 'cancelled'] };
  const action = String(input.action), transition = transitions[action];
  if (!transition) throw new AppError(400, 'Välj en giltig åtgärd.');
  if (!transition[0].includes(row.status)) throw new AppError(409, 'Bokningen har redan ändrats. Uppdatera listan.');
  const reason = action === 'cancel' ? cleanText(input.reason, 2, 250, 'Skriv en anledning till avbokningen.') : null;
  const changed = await db.batch([db.prepare('UPDATE bookings SET status=?,cancel_reason=?,updated_at=? WHERE id=? AND status=?').bind(transition[1], reason, new Date().toISOString(), id, row.status), auditStatement(db, row.date, actor.name, 'booking_' + action, id, { time: timeText(row.ready_min), count: row.count, reason })]);
  if (!changed[0].meta.changes) throw new AppError(409, 'Bokningen har redan ändrats. Uppdatera listan.');
  return adminDay(db, row.date, actor);
}
export async function mutateTask(db: DB, actor: Actor, input: Record<string, unknown>) {
  const date = validDate(input.date), action = String(input.action), timestamp = new Date().toISOString();
  if (action === 'start_checklist') {
    const statements: D1PreparedStatement[] = [];
    for (const task of TASK_CHECKLIST) {
      const id = crypto.randomUUID();
      statements.push(db.prepare('INSERT OR IGNORE INTO tasks(id,date,title,category,area,template_key,done,archived,updated_by,created_at,updated_at) VALUES(?,?,?,?,?,?,0,0,?,?,?)').bind(id, date, task.title, task.category, task.area, task.key, actor.name, timestamp, timestamp));
      statements.push(auditStatement(db, date, actor.name, 'task_create', id, { title: task.title, category: task.category, area: task.area, preset: true }));
    }
    await db.batch(statements);
    return adminDay(db, date, actor);
  }
  let statement: D1PreparedStatement, id: string;
  if (action === 'create' || action === 'update') {
    const title = cleanText(input.title, 2, 180, 'Skriv en uppgift.');
    const category = input.category === undefined ? 'general' : String(input.category), area = input.area === undefined ? 'other' : String(input.area);
    if (!TASK_PHASES.includes(category) || !TASK_AREAS.includes(area)) throw new AppError(400, 'Välj en giltig del av dagen och ett område.');
    if (action === 'create') {
      id = crypto.randomUUID();
      statement = db.prepare('INSERT INTO tasks(id,date,title,category,area,done,archived,updated_by,created_at,updated_at) VALUES(?,?,?,?,?,0,0,?,?,?)').bind(id, date, title, category, area, actor.name, timestamp, timestamp);
    } else {
      id = cleanText(input.id, 36, 36, 'Välj en giltig uppgift.');
      statement = db.prepare('UPDATE tasks SET title=?,category=?,area=?,updated_by=?,updated_at=? WHERE id=? AND date=? AND archived=0').bind(title, category, area, actor.name, timestamp, id, date);
    }
  } else {
    id = cleanText(input.id, 36, 36, 'Välj en giltig uppgift.');
    if (action === 'done' && typeof input.done === 'boolean') statement = db.prepare('UPDATE tasks SET done=?,updated_by=?,updated_at=? WHERE id=? AND date=? AND archived=0').bind(input.done ? 1 : 0, actor.name, timestamp, id, date);
    else if (action === 'archive') statement = db.prepare('UPDATE tasks SET archived=1,updated_by=?,updated_at=? WHERE id=? AND date=? AND archived=0').bind(actor.name, timestamp, id, date);
    else throw new AppError(400, 'Välj en giltig åtgärd.');
  }
  const result = await db.batch([statement, auditStatement(db, date, actor.name, 'task_' + action, id, { title: input.title, done: input.done, category: input.category, area: input.area })]);
  if (!result[0].meta.changes) throw new AppError(409, 'Uppgiften har ändrats. Uppdatera listan.');
  return adminDay(db, date, actor);
}
