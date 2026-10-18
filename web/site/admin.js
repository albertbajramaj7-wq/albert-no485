(() => {
  'use strict';
  // Grunden (dagsvy, bokningar, arbetsuppgifter, historik) kommer från ChatGPT:s version.
  // Tillagt: inloggning med e-post, roller, svinn med orsak, statistik, meny, personal och inställningar.
  const $ = id => document.getElementById(id);
  const labels = { confirmed: 'Bokad', checked_in: 'Incheckad', completed: 'Avslutad', cancelled: 'Avbokad' };
  const actionNames = { booking_created: 'Ny bokning', booking_checkin: 'Gäst incheckad', booking_undo_checkin: 'Incheckning ångrad', booking_finish: 'Bokning avslutad', booking_cancel: 'Bokning avbokad', dropin_changed: 'Drop-in ändrat', waste_changed: 'Svinn rättat', waste_registered: 'Svinn registrerat', waste_voided: 'Svinn makulerat', day_settings: 'Dagsinställningar sparade', task_create: 'Arbetsuppgift tillagd', task_update: 'Arbetsuppgift flyttad eller redigerad', task_done: 'Arbetsuppgift ändrad', task_archive: 'Arbetsuppgift borttagen', booking_email: 'Bekräftelsemejl', booking_email_requested: 'Bekräftelse begärd', date_closed: 'Datum stängt', date_reopened: 'Datum öppnat igen', settings_saved: 'Inställningar sparade', menu_saved: 'Menyn ändrad', staff_created: 'Personal tillagd', staff_role: 'Roll ändrad', staff_active: 'Personal aktiverad/inaktiverad', staff_password_reset: 'Lösenord återställt', staff_owner_bootstrap: 'Ägarkonto skapat' };
  const phases = { opening: 'Öppning', general: 'Under dagen', closing: 'Stängning' };
  const areas = { kitchen: 'Kök & förberedelser', service: 'Servering & lokal', hygiene: 'Hygien & toalett', other: 'Övrigt' };
  const descriptions = { opening: 'Innan vi öppnar', general: 'Håll ordning under servicen', closing: 'Innan vi går hem' };
  const reasons = { burnt: 'Bränd', dough: 'Degen sprack', dropped: 'Tappad', wrong_order: 'Fel beställning', complaint: 'Reklamation', other: 'Övrigt' };
  const roles = { owner: 'Ägare', admin: 'Administratör', staff: 'Personal' };
  const weekdays = [[1, 'Mån'], [2, 'Tis'], [3, 'Ons'], [4, 'Tor'], [5, 'Fre'], [6, 'Lör'], [0, 'Sön']];
  const mailLabels = { sent: 'Bekräftelsemejl skickat', pending: 'Bekräftelsemejl väntar', sending: 'Mejl behandlas', failed: 'Mejl kunde inte skickas', uncertain: 'Mejlutskicket behöver kontrolleras', blocked: 'Mejl är inte aktiverat', review: 'Kontrollera utskicket i Resend', skipped: 'Mejlutskick stoppat' };
  const mailMessages = { sent: 'Bekräftelsen har skickats till mejltjänsten.', pending: 'Utskicket väntar. Försök igen om en stund.', sending: 'Utskicket behandlas redan. Uppdatera vyn om en stund.', failed: 'Mejltjänsten nekade utskicket. Kontrollera API-nyckel och avsändare.', uncertain: 'Mejltjänstens svar kunde inte bekräftas. Samma utskick kan kontrolleras igen om en stund.', not_configured: 'Mejlutskicken behöver aktiveras med en API-nyckel och avsändare.', review: 'Kontrollera det tidigare utskicket i Resend. Ett nytt mejl skickas inte automatiskt.', skipped: 'Utskicket har stoppats eftersom bokningen inte längre är aktuell.', not_queued: 'Inget mejlutskick finns sparat för bokningen.' };
  let data, fetching = false, busy = false, dirty = false, serial = 0, cancelId, view = 'day', needsRefresh = false, taskPhase = 'all';
  let statsDays = 7, stats, menu, staff, config, resetUserId;
  const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm' }).format(new Date());
  const time = minute => String(Math.floor(minute / 60)).padStart(2, '0') + ':' + String(minute % 60).padStart(2, '0');
  const minutes = value => { const [h, m] = String(value).split(':').map(Number); return h * 60 + m; };
  const readable = date => new Intl.DateTimeFormat('sv-SE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(date + 'T12:00:00Z'));
  const short = date => new Intl.DateTimeFormat('sv-SE', { weekday: 'short', day: 'numeric', month: 'numeric', timeZone: 'UTC' }).format(new Date(date + 'T12:00:00Z'));
  const kr = n => Math.round(n).toLocaleString('sv-SE') + ' kr';
  const isAdmin = () => ['owner', 'admin'].includes(data?.actor?.role);
  function el(tag, text, cls) { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (cls) node.className = cls; return node; }
  function button(text, cls, onClick) { const b = el('button', text, cls); b.type = 'button'; b.addEventListener('click', onClick); return b; }
  function note(message, success = false) { $('notice').textContent = message; $('notice').hidden = !message; $('notice').classList.toggle('success', success); }
  function lock() {
    document.querySelectorAll('[data-mutation]').forEach(b => { b.disabled = busy || fetching || needsRefresh || (b.dataset.email === 'true' && !data?.emailSetup?.configured) || (!!b.dataset.counter && Number(b.dataset.delta) < 0 && (!data || data.day[b.dataset.counter] === 0)); });
    $('work-date').disabled = busy; $('today').disabled = busy; $('prev-day').disabled = busy; $('next-day').disabled = busy; $('refresh').disabled = busy;
  }
  async function http(path, body, method) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(path, { method: method || (body ? 'POST' : 'GET'), headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) { const error = new Error(result.error || 'Åtgärden kunde inte genomföras.'); error.status = response.status; throw error; }
      return result;
    } finally { clearTimeout(timer); }
  }
  const request = (path, body) => http('/api/admin/' + path, body);
  function showLogin(message) {
    data = undefined;
    $('login-panel').hidden = false; $('admin-content').hidden = true; $('admin-tabs').hidden = true; $('day-controls').hidden = true;
    $('logout').hidden = true; $('account-button').hidden = true; $('menu-toggle').hidden = true; drawer(false); $('account-name').textContent = ''; $('day-label').textContent = '';
    $('view-title').textContent = 'Logga in'; $('login-message').textContent = message || 'Logga in för att hantera restaurangen.';
    $('loading').hidden = true; $('login-email').focus();
  }
  async function load(silent = false) {
    const current = ++serial; fetching = true; lock();
    if (!silent) { $('loading').hidden = false; $('loading').textContent = 'Hämtar din arbetsdag.'; $('admin-content').hidden = true; }
    try {
      const result = await request('day?date=' + encodeURIComponent($('work-date').value));
      if (current !== serial) return;
      data = result; needsRefresh = false; dirty = false;
      $('login-panel').hidden = true; $('admin-content').hidden = false; $('admin-tabs').hidden = false; $('day-controls').hidden = ['budget', 'stats', 'menu', 'staff', 'config', 'stock', 'purchase'].includes(view);
      $('logout').hidden = false; $('account-button').hidden = false; $('menu-toggle').hidden = false;
      render();
      if (!silent) note('');
    } catch (error) {
      if (current !== serial) return;
      if ([401, 403].includes(error.status)) showLogin(error.status === 403 ? error.message : '');
      else note('Kunde inte hämta dagen. ' + error.message);
    } finally { if (current === serial) { $('loading').hidden = true; fetching = false; } lock(); }
  }
  async function mutate(path, body, message) {
    if (busy || fetching || needsRefresh || !data) return false;
    const focusId = document.activeElement?.id;
    busy = true; lock(); note('Sparar.');
    try {
      data = { ...await request(path, body) };
      dirty = false; render();
      if (path === 'email') note(mailMessages[data.emailAction?.status] || 'Utskicket kunde inte verifieras.', data.emailAction?.status === 'sent');
      else note(message, true);
      if (path === 'booking' && body.action === 'cancel') $('cancel-dialog').close();
      return true;
    } catch (error) {
      if (error.status === 401) { showLogin('Du har loggats ut. Logga in igen.'); return false; }
      if (error.status) { await load(true); note(error.message); }
      else { needsRefresh = true; note('Ändringen kan ha sparats. Tryck Uppdatera innan du gör fler ändringar.'); }
      return false;
    } finally { busy = false; lock(); if (focusId?.startsWith('task-done-')) $(focusId)?.focus({ preventScroll: true }); }
  }
  // Enklare anrop för admins egna sidor (statistik, meny, personal, inställningar).
  async function adminCall(path, body, message) {
    if (busy) return null;
    busy = true; lock(); if (body) note('Sparar.');
    try { const result = await request(path, body); if (message) note(message, true); else if (body) note(''); return result; }
    catch (error) { if (error.status === 401) showLogin('Du har loggats ut. Logga in igen.'); else note(error.message); return null; }
    finally { busy = false; lock(); }
  }
  function drawer(open) {
    document.body.classList.toggle('drawer-open', open);
    $('menu-toggle').setAttribute('aria-expanded', String(open));
    $('menu-toggle-label').textContent = open ? 'Stäng' : 'Meny';
    $('drawer-backdrop').hidden = !open;
    if (open) document.querySelector('#admin-tabs [aria-current="page"]')?.focus({ preventScroll: true });
  }
  function switchView(value) {
    if (!['day', 'phone', 'stock', 'purchase', 'tasks', 'history', 'budget', 'stats', 'menu', 'staff', 'config'].includes(value) || (['budget', 'stats', 'menu', 'staff', 'config'].includes(value) && !isAdmin())) value = 'day';
    view = value;
    document.querySelectorAll('[data-panel]').forEach(panel => panel.hidden = panel.dataset.panel !== value);
    document.querySelectorAll('[data-view]').forEach(b => { if (b.dataset.view === value) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    $('view-title').textContent = { day: 'Dagsvy', phone: 'Telefonbokning', stock: 'Lager', purchase: 'Inköp', tasks: 'Arbetsuppgifter', history: 'Historik', budget: 'Veckobudget', stats: 'Statistik', menu: 'Meny', staff: 'Personal', config: 'Inställningar' }[value];
    const ownPage = ['budget', 'stats', 'menu', 'staff', 'config', 'stock', 'purchase'].includes(value);
    $('day-controls').hidden = ownPage; $('day-label').hidden = ownPage;
    note('');
    if (value === 'phone') loadPhone();
    if (value === 'stock') loadStock();
    if (value === 'purchase') loadPurchase();
    if (value === 'budget') loadBudget();
    if (value === 'stats') loadStats();
    if (value === 'menu') loadMenu();
    if (value === 'staff') loadStaff();
    if (value === 'config') loadConfig();
  }

  // ---------- Bokningar ----------
  function bookingAction(buttonLabel, action, row, cls) {
    const b = el('button', buttonLabel, cls); b.type = 'button'; b.dataset.mutation = 'true';
    b.addEventListener('click', () => {
      if (action === 'cancel') {
        cancelId = row.id; $('cancel-description').textContent = row.name + ' · ' + time(row.ready_min) + ' · ' + row.count + ' pizzor'; $('cancel-reason').value = ''; $('cancel-dialog').showModal(); $('cancel-reason').focus();
      } else mutate('booking', { id: row.id, action }, { checkin: 'Gästen är incheckad.', finish: 'Bokningen är avslutad.', undo_checkin: 'Incheckningen är ångrad.' }[action]);
    });
    return b;
  }
  function renderBookings() {
    if (!data) return;
    const search = $('search-bookings').value.trim().toLowerCase(), filter = $('status-filter').value, arrival = data.limits.arrival, sitting = data.limits.sitting;
    const rows = data.bookings.filter(b => (filter === 'all' || (filter === 'active' ? ['confirmed', 'checked_in'].includes(b.status) : b.status === filter)) && [b.name, b.phone, b.email, b.id].join(' ').toLowerCase().includes(search));
    $('booking-count').textContent = rows.length + (rows.length === 1 ? ' bokning' : ' bokningar');
    const root = $('booking-list'); root.replaceChildren();
    if (!rows.length) root.append(el('p', 'Inga bokningar att visa för det här urvalet.', 'empty-state'));
    rows.forEach(row => {
      const card = el('article', undefined, 'booking-row'), clock = el('div', undefined, 'booking-time');
      clock.append(el('strong', time(row.ready_min)), el('span', labels[row.status], 'booking-status ' + row.status));
      const person = el('div', undefined, 'booking-person'); person.append(el('strong', row.name));
      const phone = el('a', row.phone); phone.href = 'tel:' + row.phone.replace(/[^+0-9]/g, ''); person.append(phone);
      if (row.email) person.append(el('small', row.email));
      const emailStatus = row.confirmationEmail?.status;
      if (row.email) person.append(el('small', mailLabels[emailStatus] || 'Inget bekräftelsemejl skickat', 'email-status' + (emailStatus === 'sent' ? ' sent' : '')));
      const details = el('div', undefined, 'booking-detail'); details.append(el('span', row.count + ' pizzor · ' + (row.mode === 'here' ? row.guests + ' gäster' : 'Ta med')), el('small', 'Ankomst ' + time(row.ready_min - arrival)));
      if (row.mode === 'here') details.append(el('small', 'Sittning ' + time(row.ready_min - arrival) + '–' + time(row.ready_min - arrival + sitting)));
      const actions = el('div', undefined, 'booking-actions-list');
      if (row.status === 'confirmed') actions.append(bookingAction('Checka in', 'checkin', row, 'admin-primary'));
      if (row.status === 'checked_in') actions.append(bookingAction('Avsluta besöket', 'finish', row, 'admin-primary'), bookingAction('Ångra incheckning', 'undo_checkin', row, 'text-button'));
      if (['confirmed', 'checked_in'].includes(row.status)) actions.append(bookingAction('Avboka', 'cancel', row, 'secondary-button'));
      if (row.email && ['confirmed', 'checked_in'].includes(row.status) && !['sent', 'review', 'skipped'].includes(emailStatus) && row.date >= today()) {
        const retry = el('button', emailStatus === 'uncertain' || emailStatus === 'sending' ? 'Kontrollera mejlet' : 'Skicka bekräftelse', 'text-button'); retry.type = 'button'; retry.dataset.mutation = 'true'; retry.dataset.email = 'true';
        retry.addEventListener('click', () => mutate('email', { id: row.id }, '')); actions.append(retry);
      }
      card.append(clock, person, details, actions);
      if (row.cancel_reason) card.append(el('div', 'Avbokningsorsak: ' + row.cancel_reason, 'cancel-reason'));
      root.append(card);
    }); lock();
  }

  // ---------- Svinn ----------
  function renderWaste() {
    const item = $('waste-item'), keep = item.value;
    item.replaceChildren(...data.menu.map(m => { const o = el('option', m.name); o.value = m.name; return o; }), ...['Deg (ej bakad)', 'Övrigt'].map(n => { const o = el('option', n); o.value = n; return o; }));
    if ([...item.options].some(o => o.value === keep)) item.value = keep;
    if (!$('waste-reason').options.length) $('waste-reason').append(...Object.entries(reasons).map(([k, v]) => { const o = el('option', v); o.value = k; return o; }));
    const root = $('waste-list'); root.replaceChildren();
    const active = data.waste.filter(w => !w.voided_at);
    $('waste-list-count').textContent = data.waste.length ? '(' + active.length + ')' : '';
    if (!data.waste.length) root.append(el('p', 'Inget svinn registrerat i dag.', 'muted'));
    data.waste.forEach(w => {
      const row = el('div', undefined, 'waste-row' + (w.voided_at ? ' voided' : ''));
      const stamp = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', hour: '2-digit', minute: '2-digit' }).format(new Date(w.created_at));
      const text = el('div'); text.append(el('strong', w.qty + ' × ' + w.item), el('small', [stamp, reasons[w.reason] || w.reason, w.actor, w.note, w.voided_at ? 'Makulerad av ' + w.voided_by : ''].filter(Boolean).join(' · ')));
      row.append(text);
      if (!w.voided_at) { const b = button('Makulera', 'text-button', () => mutate('waste', { date: data.day.date, action: 'void', id: w.id }, 'Registreringen är makulerad.')); b.dataset.mutation = 'true'; row.append(b); }
      root.append(row);
    });
  }

  // ---------- Arbetsuppgifter (oförändrat) ----------
  function taskEditor(task) {
    const details = el('details', undefined, 'task-edit'), summary = el('summary', 'Ändra uppgift'), form = el('form');
    const title = el('input'); title.id = 'task-edit-title-' + task.id; title.value = task.title; title.required = true; title.minLength = 2; title.maxLength = 180;
    const titleLabel = el('label', 'Uppgift'); titleLabel.htmlFor = title.id;
    function dropdown(name, labelText, options, selected) {
      const label = el('label', labelText), select = el('select'); select.id = 'task-edit-' + name + '-' + task.id; label.htmlFor = select.id;
      Object.entries(options).forEach(([value, text]) => { const option = el('option', text); option.value = value; option.selected = value === selected; select.append(option); });
      form.append(label, select); return select;
    }
    form.append(titleLabel, title);
    const category = dropdown('phase', 'När?', phases, task.category), area = dropdown('area', 'Område', areas, task.area || 'other');
    const buttons = el('div', undefined, 'task-edit-actions'), save = el('button', 'Spara', 'secondary-button'), remove = el('button', 'Ta bort', 'task-remove');
    save.type = 'submit'; remove.type = 'button'; save.dataset.mutation = remove.dataset.mutation = 'true';
    remove.addEventListener('click', () => mutate('task', { date: data.day.date, action: 'archive', id: task.id }, 'Uppgiften är borttagen.'));
    form.addEventListener('input', () => { dirty = true; });
    form.addEventListener('submit', event => { event.preventDefault(); if (!form.reportValidity()) return; mutate('task', { date: data.day.date, action: 'update', id: task.id, title: title.value, category: category.value, area: area.value }, 'Uppgiften är sparad i rätt kategori.'); });
    buttons.append(save, remove); form.append(buttons); details.append(summary, form); return details;
  }
  function taskRow(task) {
    const row = el('div', undefined, 'task-row' + (task.done ? ' done' : '')), label = el('label', undefined, 'task-check'), check = el('input');
    check.id = 'task-done-' + task.id; check.type = 'checkbox'; check.checked = !!task.done; check.dataset.mutation = 'true';
    check.addEventListener('change', () => mutate('task', { date: data.day.date, action: 'done', id: task.id, done: check.checked }, check.checked ? 'Uppgiften är klar.' : 'Uppgiften är öppnad igen.'));
    label.append(check, el('span', task.title)); row.append(label);
    if (task.done) row.append(el('p', 'Senast ändrad av ' + task.updated_by, 'task-meta'));
    row.append(taskEditor(task)); return row;
  }
  function renderTasks() {
    if (!data) return;
    const root = $('task-list'), onlyOpen = $('only-open-tasks').checked;
    root.replaceChildren(); root.classList.toggle('filtered', taskPhase !== 'all');
    const done = data.tasks.filter(t => t.done).length;
    $('task-count').textContent = done + ' av ' + data.tasks.length + ' klara';
    $('task-tab-count').textContent = data.tasks.length ? done + '/' + data.tasks.length : '';
    $('start-checklist').hidden = data.checklistStarted;
    document.querySelectorAll('[data-phase]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.phase === taskPhase)));
    let shown = 0;
    for (const [category, title] of Object.entries(phases)) {
      if (taskPhase !== 'all' && taskPhase !== category) continue;
      const all = data.tasks.filter(t => t.category === category), rows = all.filter(t => !onlyOpen || !t.done);
      if (!rows.length) continue;
      const group = el('section', undefined, 'task-checklist'), heading = el('div', undefined, 'task-group-heading'), count = all.filter(t => t.done).length;
      heading.append(el('h3', title), el('span', count + ' / ' + all.length + ' klara'));
      const progress = el('progress'); progress.max = all.length; progress.value = count; progress.setAttribute('aria-label', title + ': ' + count + ' av ' + all.length + ' uppgifter klara');
      group.append(heading, el('p', descriptions[category], 'phase-description'), progress);
      for (const [area, areaTitle] of Object.entries(areas)) {
        const tasks = rows.filter(t => (t.area || 'other') === area); if (!tasks.length) continue;
        const section = el('div', undefined, 'task-area'); section.append(el('h4', areaTitle)); tasks.forEach(task => section.append(taskRow(task))); group.append(section);
      }
      root.append(group); shown += rows.length;
    }
    if (!shown) {
      const empty = el('div', undefined, 'empty-state');
      if (!data.tasks.length) empty.append(el('strong', data.checklistStarted ? 'Inga uppgifter kvar i listan.' : 'Gör dagen redo.'), el('p', data.checklistStarted ? 'Lägg till en egen uppgift om något mer behöver göras.' : 'Lägg till standardlistan eller skapa egna uppgifter.'));
      else if (onlyOpen && data.tasks.some(t => taskPhase === 'all' || t.category === taskPhase)) empty.append(el('strong', 'Alla uppgifter i urvalet är klara.'), el('p', 'Avmarkera Visa bara kvarvarande för att se dem.'));
      else empty.append(el('strong', 'Inga uppgifter i det här urvalet.'), el('p', 'Välj en annan del av dagen eller lägg till en uppgift.'));
      root.append(empty);
    }
    lock();
  }
  function renderHistory() {
    const root = $('history-list'); root.replaceChildren();
    if (!data.history.length) root.append(el('p', 'Inga händelser registrerade för dagen.', 'empty-state'));
    data.history.forEach(item => {
      const row = el('div', undefined, 'history-row'), timestamp = el('time', new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', hour: '2-digit', minute: '2-digit' }).format(new Date(item.created_at)));
      timestamp.dateTime = item.created_at; const content = el('div'); content.append(el('strong', actionNames[item.action] || item.action));
      const detail = item.detail || {};
      const parts = [item.actor === 'guest' ? 'Gästbokning' : item.actor === 'system' ? 'Systemet' : item.actor];
      if (detail.time) parts.push(detail.time); if (detail.item) parts.push(detail.item); if (detail.count) parts.push(detail.count + (detail.item ? ' st' : ' pizzor'));
      if (detail.reason) parts.push(reasons[detail.reason] || detail.reason); if (detail.title) parts.push(detail.title); if (detail.name) parts.push(detail.name);
      if (detail.delta) parts.push('Ändring ' + (detail.delta > 0 ? '+' : '') + detail.delta); if (detail.value !== undefined && detail.value !== null) parts.push('Totalt ' + detail.value);
      if (detail.prepared !== undefined) parts.push(detail.prepared === null ? 'Ingen dagsgräns' : detail.prepared + ' förberedda');
      if (phases[detail.category]) parts.push(phases[detail.category]); if (areas[detail.area]) parts.push(areas[detail.area]);
      if (typeof detail.done === 'boolean') parts.push(detail.done ? 'Klar' : 'Öppnad igen');
      if (detail.status && item.action === 'booking_email') parts.push(mailLabels[detail.status] || detail.status);
      content.append(el('p', parts.join(' · '))); row.append(timestamp, content); root.append(row);
    });
  }
  function render() {
    $('account-name').textContent = data.actor.name + ' · ' + roles[data.actor.role];
    document.querySelectorAll('#admin-tabs [data-role="admin"]').forEach(b => { b.hidden = !isAdmin(); });
    $('day-settings').hidden = !isAdmin();
    $('email-setup').hidden = !!data.emailSetup?.configured;
    $('email-setup').textContent = 'Mejlbekräftelser är inte aktiverade ännu. Resend behöver en API-nyckel och en verifierad avsändare. Bokningar sparas som vanligt.';
    $('day-label').textContent = readable(data.day.date);
    $('closed-banner').hidden = !data.closed; $('closed-banner').textContent = data.closed ? 'Stängt för nya bokningar den här dagen' + (data.closedReason ? ': ' + data.closedReason : '.') : '';
    const live = data.bookings.filter(b => b.status !== 'cancelled'), used = data.stats.booked + data.day.dropin + data.day.waste;
    $('kf-remaining').textContent = data.stats.remaining === null ? 'Ej satt' : data.stats.remaining;
    $('kf-remaining-sub').textContent = data.day.prepared === null ? 'Ange dagens pizzor nedan' : 'Av ' + data.day.prepared + ' totalt · ' + data.day.dropin + ' drop-in';
    $('kf-booked').textContent = data.stats.booked; $('kf-dropin').textContent = data.day.dropin; $('kf-waste').textContent = data.day.waste; $('kf-used').textContent = used;
    $('kf-bookings').textContent = live.length;
    $('kf-bookings-sub').textContent = live.filter(b => b.mode === 'here').reduce((n, b) => n + b.guests, 0) + ' gäster som äter här';
    $('kf-checked').textContent = data.bookings.filter(b => ['checked_in', 'completed'].includes(b.status)).length;
    $('kf-open-sub').textContent = data.closed ? 'Stängt den här dagen' : data.day.paused ? 'Pausad för dagen' : 'Gäster kan boka';
    $('stock-explanation').textContent = data.day.prepared === null ? 'Ingen dagsgräns satt. Lämna tomt för att ta bort en gräns.' : 'Av ' + data.day.prepared + ' förberedda dras bokningar, drop-in och svinn av.';
    $('booking-open').textContent = data.closed ? 'Stängt' : data.day.paused ? 'Pausad' : 'Öppen';
    $('booking-open').classList.toggle('paused', !!data.day.paused || data.closed);
    $('dropin-value').textContent = data.day.dropin; $('waste-value').textContent = data.day.waste;
    $('dropin-manual').value = data.day.dropin; $('waste-manual').value = data.day.waste;
    $('prepared').value = data.day.prepared === null ? '' : data.day.prepared; $('paused').checked = !!data.day.paused; $('after-closing').checked = !!data.day.allow_after_closing;
    $('limits-help').textContent = 'Gäller valt datum. ' + data.limits.slot + ' pizzor per kvart, ' + data.limits.hour + ' per timme och ' + data.limits.seats + ' sittplatser.';
    renderBookings(); renderWaste(); renderTasks(); renderHistory(); lock();
    if (!isAdmin() && ['budget', 'stats', 'menu', 'staff', 'config'].includes(view)) switchView('day');
    if (view === 'phone') loadPhone();
  }

  // ---------- Telefonbokning ----------
  let phMode = 'here', phSlot = null, phAvail = null, phSerial = 0;
  function phFill(select, max, unit, keep) {
    const current = Number(select.value) || keep;
    if (select.options.length !== max) select.replaceChildren(...Array.from({ length: max }, (_, i) => { const o = el('option', (i + 1) + ' ' + (i ? unit[1] : unit[0])); o.value = i + 1; return o; }));
    select.value = String(Math.min(current, max));
  }
  async function loadPhone() {
    if (!data) return;
    phFill($('ph-count'), data.limits.maxCount, ['pizza', 'pizzor'], 2);
    phFill($('ph-guests'), Math.min(data.limits.maxGuests, 40), ['gäst', 'gäster'], 2);
    $('ph-guests-wrap').hidden = phMode === 'away';
    document.querySelectorAll('[data-ph-mode]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.phMode === phMode)));
    const current = ++phSerial, q = new URLSearchParams({ date: data.day.date, count: $('ph-count').value, mode: phMode, guests: phMode === 'here' ? $('ph-guests').value : '0' });
    $('ph-status').textContent = 'Hämtar tider.';
    try {
      const result = await request('availability?' + q);
      if (current !== phSerial) return;
      phAvail = result; if (phSlot && !result.slots.some(s => s.time === phSlot.time && s.bookable)) phSlot = null;
      renderPhone();
    } catch (error) { if (current === phSerial) { $('ph-status').textContent = ''; $('ph-slots').replaceChildren(el('p', error.message, 'empty-state')); } }
  }
  function renderPhone() {
    const root = $('ph-slots'); root.replaceChildren();
    const free = phAvail.slots.filter(s => s.bookable).length;
    $('ph-status').textContent = phAvail.closed ? 'Stängt den här dagen' : phAvail.paused ? 'Bokningen är pausad' : free + ' lediga tider · ' + readable(data.day.date);
    if (phAvail.closed || !phAvail.slots.length) root.append(el('p', 'Restaurangen har stängt den här dagen. Välj ett annat datum uppe till höger.', 'empty-state'));
    const live = data.bookings.filter(b => b.status !== 'cancelled');
    for (const [title, rows] of [['Lunch', phAvail.slots.filter(s => s.minute < 900)], ['Kväll', phAvail.slots.filter(s => s.minute >= 900)]]) {
      if (!rows.length) continue;
      root.append(el('h3', title, 'ph-group'));
      const grid = el('div', undefined, 'ph-grid');
      rows.forEach(slot => {
        const here = live.filter(b => b.ready_min === slot.minute), pizzas = here.reduce((n, b) => n + b.count, 0);
        const b = el('button', undefined, 'ph-slot' + (slot.bookable ? '' : ' full')); b.type = 'button'; b.disabled = !slot.bookable;
        b.setAttribute('aria-pressed', String(phSlot?.time === slot.time));
        const nowMin = (() => { const p = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date()).split(':'); return Number(p[0]) * 60 + Number(p[1]); })();
        const why = slot.bookable ? slot.remaining + ' pizzor kvar' : data.day.date === today() && slot.minute - data.limits.arrival < nowMin ? 'Passerad' : slot.remaining < Number($('ph-count').value) ? 'Fullt' : phMode === 'here' && slot.seats < Number($('ph-guests').value) ? 'Inga platser' : 'Ej ledig';
        b.append(el('strong', slot.time), el('span', why, 'ph-left'));
        if (phMode === 'here' && slot.seats !== null) b.append(el('span', slot.seats + ' platser', 'ph-seats'));
        if (here.length) b.append(el('span', here.length + (here.length === 1 ? ' bokning' : ' bokningar') + ' · ' + pizzas + ' st', 'ph-booked'));
        b.addEventListener('click', () => { phSlot = slot; renderPhone(); $('ph-name').focus(); });
        grid.append(b);
      });
      root.append(grid);
    }
    const count = Number($('ph-count').value), guests = Number($('ph-guests').value);
    $('ph-selected').textContent = phSlot ? short(data.day.date) + ' kl. ' + phSlot.time + ' · ' + count + (count === 1 ? ' pizza' : ' pizzor') + ' · ' + (phMode === 'here' ? 'äta här, ' + guests + ' gäster' : 'ta med') + '. Kom ' + time(phSlot.minute - data.limits.arrival) + '.' : 'Välj en tid i listan.';
    $('ph-selected').classList.toggle('chosen', !!phSlot);
    $('ph-submit').disabled = !phSlot || busy;
  }

  // ---------- Lager ----------
  let stock, orders, stockDirty = {};
  const num = v => Number(v).toLocaleString('sv-SE', { maximumFractionDigits: 2 });
  const unitCost = v => v === null || v === undefined ? '' : num(v) + ' kr';
  async function loadStock() { const r = await adminCall('stock'); if (r) { stock = r; stockDirty = {}; renderStock(); } }
  function itemFields(form, item = {}, isNew) {
    form.replaceChildren();
    const field = (label, input, cls) => { const d = el('div', undefined, cls), l = el('label', label); input.id = 'si-' + label.replace(/\W/g, '') + '-' + (item.id || 'new'); l.htmlFor = input.id; d.append(l, input); form.append(d); return input; };
    const inp = (type, value, attrs = {}) => { const i = el('input'); i.type = type; if (value !== undefined && value !== null) i.value = value; Object.assign(i, attrs); return i; };
    const name = field('Vara', inp('text', item.name, { required: true, minLength: 2, maxLength: 80 }), 'task-title-field');
    const category = field('Kategori', inp('text', item.category || 'Råvaror', { maxLength: 40 }));
    const unit = field('Enhet', inp('text', item.unit || 'st', { maxLength: 12, placeholder: 'kg, st, burk' }));
    const sup = el('select'); sup.append(Object.assign(el('option', 'Ingen'), { value: '' }), ...stock.suppliers.filter(x => x.active).map(x => Object.assign(el('option', x.name), { value: x.id, selected: x.id === item.supplierId })));
    field('Leverantör', sup);
    const min = field('Miniminivå', inp('number', item.minLevel ?? 0, { min: 0, step: 'any', required: true }));
    const oq = field('Beställ normalt', inp('number', item.orderQty ?? 0, { min: 0, step: 'any' }));
    const cost = field('Pris per enhet (kr)', inp('number', item.unitCost ?? '', { min: 0, step: 'any' }));
    const onHand = isNew ? field('I lager nu', inp('number', 0, { min: 0, step: 'any' })) : null;
    let active = null;
    if (!isNew) { const l = el('label', undefined, 'admin-checkbox'); active = el('input'); active.type = 'checkbox'; active.checked = item.active !== false; l.append(active, document.createTextNode('Aktiv')); form.append(l); }
    const save = el('button', isNew ? 'Lägg till' : 'Spara', 'admin-primary'); save.type = 'submit'; form.append(save);
    form.onsubmit = async event => {
      event.preventDefault(); if (!form.reportValidity()) return;
      const payload = { id: item.id || null, name: name.value, category: category.value || 'Råvaror', unit: unit.value || 'st', supplierId: sup.value || null, minLevel: Number(min.value), orderQty: Number(oq.value || 0), unitCost: cost.value === '' ? null : Number(cost.value) };
      if (isNew) payload.onHand = Number(onHand.value || 0); else payload.active = active.checked;
      const r = await adminCall('stock', { action: 'save_item', item: payload }, isNew ? name.value + ' är tillagd.' : 'Varan är sparad.');
      if (r) { stock = r; renderStock(); }
    };
  }
  function renderStock() {
    const admin = stock.isAdmin, q = $('stock-search').value.trim().toLowerCase(), only = $('stock-filter').value === 'low';
    $('stock-add-wrap').hidden = !admin;
    if (admin && !$('stock-new-form').children.length) itemFields($('stock-new-form'), {}, true);
    const root = $('stock-list'); root.replaceChildren();
    const rows = stock.items.filter(i => (!only || i.low) && i.name.toLowerCase().includes(q));
    if (!rows.length) root.append(el('p', only ? 'Inget ligger under miniminivån just nu.' : 'Inga varor hittades.', 'empty-state'));
    let cat = null, group;
    rows.forEach(i => {
      if (i.category !== cat) { cat = i.category; root.append(el('h3', cat, 'ph-group')); group = el('div', undefined, 'stock-group'); root.append(group); }
      const row = el('article', undefined, 'stock-row' + (i.low ? ' low' : '') + (i.active ? '' : ' inactive'));
      const info = el('div', undefined, 'stock-info'); info.append(el('strong', i.name));
      info.append(el('small', ['Min ' + num(i.minLevel) + ' ' + i.unit, i.supplierName, admin && i.unitCost !== null ? unitCost(i.unitCost) + '/' + i.unit : '', i.countedAt ? 'Räknad ' + short(new Date(i.countedAt).toISOString().slice(0, 10)) + (i.countedBy ? ' av ' + i.countedBy : '') : 'Aldrig räknad'].filter(Boolean).join(' · ')));
      const status = el('div', undefined, 'stock-status');
      if (!i.active) status.append(el('span', 'Inaktiv', 'pill-tag'));
      else if (i.onOrder > 0) status.append(el('span', 'Beställd ' + num(i.onOrder), 'pill-tag ordered'));
      else if (i.low) status.append(el('span', 'Beställ', 'pill-tag low'));
      const count = el('div', undefined, 'stock-count');
      const now = el('span', num(i.onHand) + ' ' + i.unit, 'stock-now');
      const input = el('input'); input.type = 'number'; input.min = 0; input.step = 'any'; input.inputMode = 'decimal'; input.placeholder = 'Antal'; input.id = 'count-' + i.id; input.setAttribute('aria-label', 'Nytt antal ' + i.name);
      if (stockDirty[i.id] !== undefined) input.value = stockDirty[i.id];
      input.addEventListener('input', () => { if (input.value === '') delete stockDirty[i.id]; else stockDirty[i.id] = input.value; $('stock-save').disabled = !Object.keys(stockDirty).length; $('stock-save').textContent = Object.keys(stockDirty).length ? 'Spara inventering (' + Object.keys(stockDirty).length + ')' : 'Spara inventering'; });
      input.disabled = !i.active;
      count.append(now, input);
      row.append(info, status, count);
      if (admin) { const d = el('details', undefined, 'stock-edit'), sm = el('summary', 'Ändra'), f = el('form', undefined, 'task-form stock-form'); d.append(sm, f); d.addEventListener('toggle', () => { if (d.open && !f.children.length) itemFields(f, i, false); }, { once: false }); row.append(d); }
      group.append(row);
    });
    $('stock-save').disabled = !Object.keys(stockDirty).length;
  }

  // ---------- Inköp ----------
  const poLabels = { draft: 'Utkast', sent: 'Skickad', received: 'Mottagen', cancelled: 'Makulerad' };
  async function loadPurchase() { const r = await adminCall('purchase'); if (r) { orders = r.orders; stock = r.stock; renderPurchase(); } }
  function shopRows() {
    const low = stock.items.filter(i => i.low && i.onOrder <= 0), groups = {};
    low.forEach(i => { const k = i.supplierName || 'Utan leverantör'; (groups[k] = groups[k] || []).push(i); });
    return groups;
  }
  const suggest = i => Math.max(i.orderQty > 0 ? i.orderQty : i.minLevel * 2 - i.onHand, 1);
  function renderPurchase() {
    const admin = stock.isAdmin, groups = shopRows(), shop = $('shop-list'); shop.replaceChildren();
    $('shop-create').hidden = !admin || !Object.keys(groups).length; $('supplier-card').hidden = !admin;
    if (!Object.keys(groups).length) shop.append(el('p', 'Inget behöver beställas just nu.', 'empty-state'));
    for (const [sup, items] of Object.entries(groups)) {
      shop.append(el('h3', sup, 'ph-group'));
      const t = el('table', undefined, 'data-table'), h = el('tr'); ['Vara', 'I lager', 'Min', 'Förslag'].forEach(x => h.append(el('th', x))); t.append(h);
      items.forEach(i => { const r = el('tr'); [i.name, num(i.onHand) + ' ' + i.unit, num(i.minLevel), num(suggest(i)) + ' ' + i.unit].forEach((x, n) => r.append(el('td', x, n ? 'num' : ''))); t.append(r); });
      const w = el('div', undefined, 'table-scroll'); w.append(t); shop.append(w);
    }
    const root = $('po-list'); root.replaceChildren();
    if (!orders.length) root.append(el('p', admin ? 'Inga beställningar ännu. Tryck Skapa beställningar när något ligger på inköpslistan.' : 'Inga beställningar att ta emot just nu.', 'empty-state'));
    orders.forEach(o => root.append(orderCard(o, admin)));
    if (admin) renderSuppliers();
  }
  function orderCard(o, admin) {
    const card = el('article', undefined, 'admin-card po-card ' + o.status);
    const head = el('div', undefined, 'section-heading');
    const title = el('div'); title.append(el('h3', 'Beställning ' + o.number + ' · ' + o.supplierName), el('small', [poLabels[o.status], o.sentAt ? 'skickad ' + short(o.sentAt.slice(0, 10)) + ' av ' + o.sentBy : 'skapad ' + short(o.createdAt.slice(0, 10)), o.receivedAt ? 'mottagen ' + short(o.receivedAt.slice(0, 10)) + ' av ' + o.receivedBy : ''].filter(Boolean).join(' · '), 'muted'));
    head.append(title, el('span', poLabels[o.status], 'pill-tag ' + o.status)); card.append(head);
    const t = el('table', undefined, 'data-table'), h = el('tr');
    const cols = ['Vara', 'Antal'].concat(o.status === 'sent' ? ['Kom'] : o.status === 'received' ? ['Mottaget'] : []).concat(admin ? ['Pris'] : []);
    cols.forEach(x => h.append(el('th', x))); t.append(h);
    const inputs = {};
    o.lines.forEach(l => {
      const r = el('tr'); r.append(el('td', l.name));
      const q = el('td', undefined, 'num');
      if (o.status === 'draft' && admin) { const i = el('input'); i.type = 'number'; i.min = 0.01; i.step = 'any'; i.value = l.qty; i.className = 'qty-input'; i.setAttribute('aria-label', 'Antal ' + l.name); inputs[l.id] = i; q.append(i, document.createTextNode(' ' + l.unit)); }
      else q.textContent = num(l.qty) + ' ' + l.unit;
      r.append(q);
      if (o.status === 'sent') { const c = el('td', undefined, 'num'), i = el('input'); i.type = 'number'; i.min = 0; i.step = 'any'; i.value = l.qty; i.className = 'qty-input'; i.setAttribute('aria-label', 'Mottaget ' + l.name); inputs[l.id] = i; c.append(i); r.append(c); }
      if (o.status === 'received') r.append(el('td', num(l.receivedQty ?? 0) + ' ' + l.unit, 'num'));
      if (admin) r.append(el('td', l.unitCost === null || l.unitCost === undefined ? '–' : unitCost(l.unitCost * l.qty), 'num'));
      t.append(r);
    });
    const w = el('div', undefined, 'table-scroll'); w.append(t); card.append(w);
    if (admin && o.lines.some(l => l.unitCost !== null && l.unitCost !== undefined)) card.append(el('p', 'Uppskattad kostnad: ' + unitCost(o.lines.reduce((n, l) => n + (l.unitCost || 0) * l.qty, 0)), 'muted'));
    const acts = el('div', undefined, 'booking-actions-list po-actions');
    const run = async (body, msg) => { const r = await adminCall('purchase', { id: o.id, ...body }, msg); if (r) { orders = r.orders; stock = r.stock; renderPurchase(); } };
    acts.append(button('Skriv ut / PDF', 'secondary-button', () => printOrder(o)));
    if (o.status === 'draft' && admin) {
      acts.append(button('Spara antal', 'secondary-button', () => run({ action: 'save_lines', lines: Object.entries(inputs).map(([id, i]) => ({ id, qty: Number(i.value) })) }, 'Antalen är sparade.')));
      acts.append(button('Skicka via mejl', 'admin-primary', async () => {
        // Mejlappen öppnas direkt vid trycket (krävs på iPad), med de antal som står i rutorna just nu.
        const lines = Object.entries(inputs).map(([id, i]) => ({ id, qty: Number(i.value) }));
        const current = { ...o, lines: o.lines.map(l => ({ ...l, qty: Number(inputs[l.id]?.value || l.qty) })) };
        location.href = 'mailto:' + encodeURIComponent(o.supplierEmail || '') + '?subject=' + encodeURIComponent('Beställning ' + o.number + ' från Albert NO.485') + '&body=' + encodeURIComponent(orderText(current));
        await run({ action: 'save_lines', lines });
        await run({ action: 'send' }, 'Beställningen är markerad som skickad. Kontrollera att mejlet gick iväg i mejlappen.');
      }));
      acts.append(button('Markera skickad', 'text-button', () => run({ action: 'send' }, 'Beställningen är markerad som skickad.')));
    }
    if (o.status === 'sent') acts.append(button('Registrera leverans', 'admin-primary', () => run({ action: 'receive', lines: Object.entries(inputs).map(([id, i]) => ({ id, receivedQty: Number(i.value || 0) })) }, 'Leveransen är registrerad och lagret uppdaterat.')));
    if (admin && ['draft', 'sent'].includes(o.status)) acts.append(button('Makulera', 'text-button', () => run({ action: 'cancel' }, 'Beställningen är makulerad.')));
    card.append(acts);
    return card;
  }
  function orderText(o) {
    return ['Hej' + (o.supplierContact ? ' ' + o.supplierContact : '') + '!', '', 'Vi vill beställa följande till Albert NO.485:', '', ...o.lines.map(l => '- ' + num(l.qty) + ' ' + l.unit + ' ' + l.name), '', o.note || '', 'Leverans till Pilgatan 3, Varberg.', 'Beställningsnummer: ' + o.number, '', 'Tack!', 'Albert NO.485', '0340-827 75'].join('\n');
  }
  function printDoc(title, body) {
    const w = window.open('', '_blank');
    if (!w) { note('Utskriften blockerades. Tillåt popup-fönster för sidan och försök igen.'); return; }
    w.document.write('<!doctype html><html lang="sv"><head><meta charset="utf-8"><title>' + title + '</title><style>body{font:14px/1.5 system-ui,Arial,sans-serif;color:#2a1f1b;margin:32px}h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:22px 0 8px}p{margin:0 0 12px;color:#6b605a}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:7px 8px;border-bottom:1px solid #ddd}th{font-size:12px;color:#6b605a}td.n,th.n{text-align:right}td:first-child,th:first-child{width:28px}.box{display:inline-block;width:14px;height:14px;border:1px solid #2a1f1b;vertical-align:middle}</style></head><body>' + body + '</body></html>');
    w.document.close(); w.focus(); setTimeout(() => w.print(), 300);
  }
  const esc = v => String(v ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  function printShopping() {
    const groups = shopRows(), when = readable(today());
    let body = '<h1>Inköpslista – Albert NO.485</h1><p>' + esc(when) + '</p>';
    if (!Object.keys(groups).length) body += '<p>Inget behöver beställas.</p>';
    for (const [sup, items] of Object.entries(groups)) body += '<h2>' + esc(sup) + '</h2><table><tr><th></th><th>Vara</th><th class="n">I lager</th><th class="n">Min</th><th class="n">Beställ</th></tr>' + items.map(i => '<tr><td><span class="box"></span></td><td>' + esc(i.name) + '</td><td class="n">' + esc(num(i.onHand)) + ' ' + esc(i.unit) + '</td><td class="n">' + esc(num(i.minLevel)) + '</td><td class="n">' + esc(num(suggest(i))) + ' ' + esc(i.unit) + '</td></tr>').join('') + '</table>';
    printDoc('Inköpslista', body);
  }
  function printOrder(o) {
    printDoc('Beställning ' + o.number, '<h1>Beställning ' + o.number + '</h1><p>Albert NO.485 · Pilgatan 3, Varberg · 0340-827 75</p><p>Leverantör: ' + esc(o.supplierName) + (o.supplierEmail ? ' · ' + esc(o.supplierEmail) : '') + '<br>Status: ' + poLabels[o.status] + ' · ' + esc(readable(o.createdAt.slice(0, 10))) + '</p><table><tr><th>Vara</th><th class="n">Antal</th>' + (o.status === 'received' ? '<th class="n">Mottaget</th>' : '') + '</tr>' + o.lines.map(l => '<tr><td>' + esc(l.name) + '</td><td class="n">' + esc(num(l.qty)) + ' ' + esc(l.unit) + '</td>' + (o.status === 'received' ? '<td class="n">' + esc(num(l.receivedQty ?? 0)) + '</td>' : '') + '</tr>').join('') + '</table>' + (o.note ? '<p>' + esc(o.note) + '</p>' : ''));
  }
  function supplierForm(form, s = {}) {
    form.replaceChildren();
    const f = (label, value, attrs = {}) => { const d = el('div'), l = el('label', label), i = el('input'); Object.assign(i, attrs); i.value = value || ''; i.id = 'sup-' + label.replace(/\W/g, '') + '-' + (s.id || 'new'); l.htmlFor = i.id; d.append(l, i); form.append(d); return i; };
    const name = f('Namn', s.name, { required: true, minLength: 2, maxLength: 80 }), contact = f('Kontaktperson', s.contact), email = f('E-post', s.email, { type: 'email' }), phone = f('Telefon', s.phone, { type: 'tel' });
    let active = null; if (s.id) { const l = el('label', undefined, 'admin-checkbox'); active = el('input'); active.type = 'checkbox'; active.checked = s.active !== false; l.append(active, document.createTextNode('Aktiv')); form.append(l); }
    const b = el('button', s.id ? 'Spara' : 'Lägg till', 'admin-primary'); b.type = 'submit'; form.append(b);
    form.onsubmit = async e => { e.preventDefault(); if (!form.reportValidity()) return; const r = await adminCall('stock', { action: 'save_supplier', supplier: { id: s.id || null, name: name.value, contact: contact.value, email: email.value, phone: phone.value, ...(s.id ? { active: active.checked } : {}) } }, 'Leverantören är sparad.'); if (r) { stock = r; renderPurchase(); } };
  }
  function renderSuppliers() {
    const root = $('supplier-list'); root.replaceChildren();
    if (!stock.suppliers.length) root.append(el('p', 'Inga leverantörer ännu.', 'empty-state'));
    stock.suppliers.forEach(s => {
      const row = el('div', undefined, 'waste-row'), text = el('div'); text.append(el('strong', s.name + (s.active ? '' : ' (inaktiv)')), el('small', [s.contact, s.email, s.phone].filter(Boolean).join(' · ') || 'Inga kontaktuppgifter'));
      const d = el('details', undefined, 'stock-edit'), sm = el('summary', 'Ändra'), f = el('form', undefined, 'task-form'); d.append(sm, f); d.addEventListener('toggle', () => { if (d.open && !f.children.length) supplierForm(f, s); });
      row.append(text, d); root.append(row);
    });
    if (!$('supplier-new-form').children.length) supplierForm($('supplier-new-form'));
  }

  // ---------- Statistik ----------
  async function loadStats() {
    const to = today(), from = new Date(Date.parse(to + 'T12:00:00Z') - (statsDays - 1) * 864e5).toISOString().slice(0, 10);
    $('stats-summary').replaceChildren(el('div', 'Hämtar statistik.'));
    const result = await adminCall('stats?from=' + from + '&to=' + to);
    if (result) { stats = result; renderStats(); }
  }
  function renderStats() {
    const days = stats.days, sum = key => days.reduce((n, d) => n + d[key], 0);
    const pizzas = sum('bookedPizzas') + sum('dropin'), waste = sum('waste');
    const tiles = [['Sålda pizzor', pizzas, 'bokade ' + sum('bookedPizzas') + ' · drop-in ' + sum('dropin')], ['Uppskattad försäljning', kr(pizzas * stats.avgPizzaPrice), 'snittpris ' + stats.avgPizzaPrice + ' kr'],
      ['Svinn', waste, 'ca ' + kr(waste * stats.wasteCost) + ' i råvaror'], ['Gäster som åt här', sum('guests'), sum('cancelled') + ' avbokningar']];
    $('stats-summary').replaceChildren(...tiles.map(([label, value, sub]) => { const d = el('div'); d.append(el('span', label), el('strong', String(value)), el('small', sub)); return d; }));
    // Stapeldiagram: bokade + drop-in per dag, svinn som egen markering.
    const W = 640, H = 220, B = 26, T = 18, max = Math.max(1, ...days.map(d => d.bookedPizzas + d.dropin));
    const step = [1, 2, 5, 10, 20, 25, 50, 100, 200, 500].find(s => max / s <= 4) || 1000, top = Math.ceil(max / step) * step;
    const y = v => T + (H - T - B) * (1 - v / top), bw = W / days.length;
    const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'Pizzor per dag');
    const add = (tag, attrs, text) => { const n = document.createElementNS(ns, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); if (text !== undefined) n.textContent = text; svg.append(n); return n; };
    for (let v = 0; v <= top; v += step) { add('line', { x1: 0, x2: W, y1: y(v), y2: y(v), class: 'grid' }); add('text', { x: W, y: y(v) - 4, 'text-anchor': 'end', class: 'axis' }, v); }
    const every = Math.ceil(days.length / 10);
    days.forEach((d, i) => {
      const x = i * bw + bw * 0.18, w = bw * 0.64, booked = d.bookedPizzas, total = booked + d.dropin;
      if (booked) add('rect', { x, y: y(booked), width: w, height: y(0) - y(booked), class: 'bar-booked' }).append(Object.assign(document.createElementNS(ns, 'title'), { textContent: short(d.date) + ': ' + booked + ' bokade' }));
      if (d.dropin) add('rect', { x, y: y(total), width: w, height: y(booked) - y(total), class: 'bar-dropin' }).append(Object.assign(document.createElementNS(ns, 'title'), { textContent: short(d.date) + ': ' + d.dropin + ' drop-in' }));
      if (d.waste) add('rect', { x: x + w * 0.25, y: y(0) + 3, width: w * 0.5, height: 4, class: 'bar-waste' });
      if (i % every === 0) add('text', { x: x + w / 2, y: H - 6, 'text-anchor': 'middle', class: 'axis' }, short(d.date).replace('.', ''));
    });
    const legend = el('p', undefined, 'chart-legend');
    legend.append(el('span', 'Bokade', 'key booked'), el('span', 'Drop-in', 'key dropin'), el('span', 'Svinn', 'key waste'));
    $('stats-chart').replaceChildren(svg, legend);
    const wasteRoot = $('stats-waste'); wasteRoot.replaceChildren();
    const entries = Object.entries(stats.wasteByReason).sort((a, b) => b[1] - a[1]), total = entries.reduce((n, [, v]) => n + v, 0);
    if (!entries.length) wasteRoot.append(el('p', 'Inget svinn med orsak registrerat under perioden.', 'muted'));
    entries.forEach(([reason, qty]) => { const row = el('div', undefined, 'meter-row'), bar = el('div', undefined, 'meter'), fill = el('i'); fill.style.width = (qty / total * 100) + '%'; bar.append(fill); row.append(el('span', reasons[reason] || reason), bar, el('strong', String(qty))); wasteRoot.append(row); });
    const items = Object.entries(stats.wasteByItem).sort((a, b) => b[1] - a[1]);
    if (items.length) wasteRoot.append(el('p', 'Oftast: ' + items.slice(0, 3).map(([n, q]) => n + ' (' + q + ')').join(', '), 'muted'));
    const table = $('stats-table'); table.replaceChildren();
    const head = el('tr'); ['Dag', 'Bokade pizzor', 'Drop-in', 'Svinn', 'Gäster', 'Avbokade', 'Uppskattad försäljning'].forEach(h => head.append(el('th', h))); table.append(head);
    days.slice().reverse().forEach(d => { const tr = el('tr'); [short(d.date), d.bookedPizzas, d.dropin, d.waste, d.guests, d.cancelled, kr((d.bookedPizzas + d.dropin) * stats.avgPizzaPrice)].forEach((v, i) => tr.append(el('td', String(v), i ? 'num' : ''))); table.append(tr); });
  }

  // ---------- Meny ----------
  async function loadMenu() { const result = await adminCall('menu'); if (result) { menu = result; renderMenu(); } }
  function menuForm(item) {
    const form = el('form', undefined, 'menu-item' + (item.active === false ? ' hidden-item' : ''));
    const field = (label, input) => { const wrap = el('div'), l = el('label', label); input.id = 'menu-' + label.replace(/\W/g, '') + '-' + (item.id || 'new'); l.htmlFor = input.id; wrap.append(l, input); return wrap; };
    const name = el('input'); name.value = item.name || ''; name.required = true; name.minLength = 2; name.maxLength = 80;
    const price = el('input'); price.type = 'number'; price.min = 0; price.max = 10000; price.value = item.price ?? 160; price.required = true;
    const category = el('select'); [['pizza', 'Pizza'], ['dolce', 'Dolce & caffè']].forEach(([v, t]) => { const o = el('option', t); o.value = v; o.selected = item.category === v; category.append(o); });
    const desc = el('textarea'); desc.value = item.description || ''; desc.maxLength = 300; desc.rows = 2;
    const active = el('input'); active.type = 'checkbox'; active.checked = item.active !== false;
    const activeLabel = el('label', undefined, 'admin-checkbox'); activeLabel.append(active, document.createTextNode('Visas på hemsidan'));
    const save = el('button', item.id ? 'Spara' : 'Lägg till', 'admin-primary'); save.type = 'submit';
    const top = el('div', undefined, 'menu-item-top'); top.append(field('Namn', name), field('Pris (kr)', price), field('Kategori', category));
    form.append(top, field('Beskrivning', desc), activeLabel, save);
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (!form.reportValidity()) return;
      const result = await adminCall('menu', { item: { id: item.id || null, name: name.value, price: Number(price.value), category: category.value, description: desc.value, active: active.checked } }, 'Menyn är sparad.');
      if (result) { menu = result; renderMenu(); }
    });
    return form;
  }
  function renderMenu(extra) {
    const root = $('menu-list'); root.replaceChildren();
    if (extra) root.append(extra);
    for (const [cat, title] of [['pizza', 'Pizza'], ['dolce', 'Dolce & caffè']]) {
      const items = menu.filter(m => m.category === cat); if (!items.length) continue;
      root.append(el('h3', title, 'menu-group-title')); items.forEach(m => root.append(menuForm(m)));
    }
  }

  // ---------- Personal ----------
  async function loadStaff() { const result = await adminCall('staff'); if (result) { staff = result; renderStaff(); } }
  function renderStaff() {
    const root = $('staff-list'); root.replaceChildren();
    const me = data.actor.email, owner = data.actor.role === 'owner';
    $('staff-role').querySelector('option[value="admin"]').disabled = !owner;
    staff.forEach(s => {
      const row = el('article', undefined, 'staff-row' + (s.active ? '' : ' inactive'));
      const who = el('div'); who.append(el('strong', s.name), el('small', [s.title, s.email].filter(Boolean).join(' · ')));
      const badge = el('span', roles[s.role] + (s.active ? '' : ' · inaktiv'), 'role-badge ' + s.role);
      const actions = el('div', undefined, 'booking-actions-list');
      const editable = s.email !== me && s.role !== 'owner' && (owner || s.role === 'staff');
      if (editable) {
        if (owner) actions.append(button(s.role === 'admin' ? 'Gör till personal' : 'Gör till admin', 'secondary-button', async () => { const r = await adminCall('staff', { action: 'set_role', userId: s.userId, role: s.role === 'admin' ? 'staff' : 'admin' }, 'Rollen är ändrad.'); if (r) { staff = r; renderStaff(); } }));
        actions.append(button(s.active ? 'Inaktivera' : 'Aktivera', 'secondary-button', async () => { const r = await adminCall('staff', { action: 'set_active', userId: s.userId, active: !s.active }, s.active ? s.name + ' kan inte längre logga in.' : s.name + ' kan logga in igen.'); if (r) { staff = r; renderStaff(); } }));
        actions.append(button('Nytt lösenord', 'text-button', () => { resetUserId = s.userId; $('password-description').textContent = 'För ' + s.name + '. Ge lösenordet till personen, som sedan byter det under Mitt konto.'; $('reset-password').value = ''; $('password-dialog').showModal(); }));
      } else if (s.email === me) actions.append(el('span', 'Du', 'muted'));
      row.append(who, badge, actions); root.append(row);
    });
  }

  // ---------- Inställningar ----------
  const cfgFields = ['slotCap', 'hourCap', 'seats', 'sittingMin', 'arrivalMin', 'horizonDays', 'maxCount', 'maxGuests', 'avgPizzaPrice', 'wasteCost'];
  const cfgColumns = { slotCap: 'slot_cap', hourCap: 'hour_cap', seats: 'seats', sittingMin: 'sitting_min', arrivalMin: 'arrival_min', horizonDays: 'horizon_days', maxCount: 'max_count', maxGuests: 'max_guests', avgPizzaPrice: 'avg_pizza_price', wasteCost: 'waste_cost' };
  async function loadConfig() { const result = await adminCall('config'); if (result) { config = result; renderConfig(); } }
  function renderConfig() {
    cfgFields.forEach(f => { $('cfg-' + f).value = config[cfgColumns[f]]; });
    ['lunchFirst', 'lunchLast', 'dinnerFirst', 'dinnerLast'].forEach(f => { $('cfg-' + f).value = time(config[f.replace(/[A-Z]/, c => '_' + c.toLowerCase())]); });
    const boxes = $('weekday-boxes'); boxes.replaceChildren();
    weekdays.forEach(([n, label]) => { const l = el('label', undefined, 'admin-checkbox'), c = el('input'); c.type = 'checkbox'; c.value = n; c.checked = config.open_weekdays.includes(n); c.id = 'wd-' + n; l.append(c, document.createTextNode(label)); boxes.append(l); });
    $('closed-date').min = today();
    const list = $('closed-list'); list.replaceChildren();
    if (!config.closedDates.length) list.append(el('p', 'Inga extra stängda datum.', 'muted'));
    config.closedDates.forEach(c => { const row = el('div', undefined, 'waste-row'), text = el('div'); text.append(el('strong', readable(c.date)), el('small', [c.reason, 'stängt av ' + c.created_by].filter(Boolean).join(' · '))); row.append(text, button('Öppna igen', 'text-button', async () => { const r = await adminCall('config', { action: 'reopen_date', date: c.date }, 'Datumet är öppet för bokning igen.'); if (r) { config = r; renderConfig(); } })); list.append(row); });
  }


  // ---------- Veckobudget ----------
  let budget, budWeek;
  const krd = n => n === null || n === undefined ? '–' : (Math.round(n * 100) / 100).toLocaleString('sv-SE', { minimumFractionDigits: 0, maximumFractionDigits: 2 }) + ' kr';
  const krw = n => n === null || n === undefined ? '–' : Math.round(n).toLocaleString('sv-SE') + ' kr';
  const parseNum = v => { const t = String(v ?? '').replace(/\s/g, '').replace(',', '.'); if (t === '') return null; const n = Number(t); return Number.isFinite(n) ? n : NaN; };
  const fmtInput = n => n === null || n === undefined ? '' : String(n).replace('.', ',');
  const mondayOf = date => { const d = new Date(date + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); };
  const addDays = (date, n) => { const d = new Date(date + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const weekNo = date => { const d = new Date(date + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 3 - ((d.getUTCDay() + 6) % 7)); const y = new Date(Date.UTC(d.getUTCFullYear(), 0, 4)); return 1 + Math.round(((d - y) / 864e5 - 3 + ((y.getUTCDay() + 6) % 7)) / 7); };
  const weekLabel = date => 'Vecka ' + weekNo(date) + ' · ' + new Intl.DateTimeFormat('sv-SE', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(date + 'T12:00:00Z')) + '–' + new Intl.DateTimeFormat('sv-SE', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(addDays(date, 6) + 'T12:00:00Z'));
  async function loadBudget() { const r = await adminCall('budget'); if (r) { budget = r; budWeek = budWeek || mondayOf(today()); renderBudget(); } }
  const budgetPreview = () => budget.weeks.find(w => w.weekStart === budWeek) || null;
  function figure(label, value, sub, strongClass) { const d = el('div'), s = el('strong', value); if (strongClass) s.className = strongClass; d.append(el('span', label), s, el('small', sub || '')); return d; }
  function renderBudget() {
    if (!budget) return;
    const s = budget.settings, w = budgetPreview();
    // Veckoväljaren: sparade veckor + vald vecka + innevarande.
    const set = new Set(budget.weeks.map(x => x.weekStart)); set.add(budWeek); set.add(mondayOf(today()));
    const sel = $('bud-week'); sel.replaceChildren();
    [...set].sort().forEach(d => { const o = el('option', weekLabel(d) + (budget.weeks.some(x => x.weekStart === d) ? '' : ' (ny)')); o.value = d; o.selected = d === budWeek; sel.append(o); });
    $('bud-title').textContent = weekLabel(budWeek);
    $('bud-sub').textContent = w?.computed ? w.status + (w.updatedBy ? ' · sparad av ' + w.updatedBy : '') : 'Fyll i veckans omsättning för att räkna fram budgeten.';
    const warn = [...budget.warnings]; if (Math.abs(budget.pctSum - 1) > 0.0001 && budget.pctSum > 0.9) warn.push('Procentfördelningen är ' + Math.round(budget.pctSum * 1000) / 10 + ' % av omsättningen.');
    $('bud-warnings').hidden = !warn.length; $('bud-warnings').textContent = warn.join(' ');
    // Huvudsiffror
    const figs = $('bud-figures'); figs.replaceChildren();
    figs.append(
      figure('Omsättning ex moms', w?.computed ? krw(w.revenueEx) : '–', w?.computed ? krw(w.perOpenDay) + ' per öppetdag' : 'Ej ifylld'),
      figure('Försäljning inkl moms', w?.computed ? krw(w.salesInkl) : '–', w?.computed ? 'Varav moms ' + krw(w.salesVat) : ''),
      figure('Kvar efter avsättningar', w?.computed ? krw(w.left) : '–', 'Budgetmarginal för veckan', w?.computed && w.left < 0 ? 'negative' : ''),
      figure('Veckans plus/minus', w?.computed ? krw(w.plusMinus) : '–', 'Med faktiskt utfall där det finns', w?.computed && w.plusMinus < 0 ? 'negative' : ''),
      figure('Saldo efter veckan', w ? krw(w.balanceOut) : krw(lastBalance()), 'Ingående ' + (w ? krw(w.balanceIn) : krw(lastBalance()))),
      figure('Fritt saldo', w ? krw(w.free) : '–', 'Efter pengar kvar i kostnadspotter'),
      figure('Varuinköp av omsättning', w?.goodsPct === null || w?.goodsPct === undefined ? '–' : w.goodsPct.toLocaleString('sv-SE') + ' %', 'Budget ' + Math.round(s.pct.goods * 1000) / 10 + ' %'),
      figure('Momsreserv', w?.computed ? krw(w.vatReserve) : '–', 'Hela försäljningsmomsen'));
    // Formulär
    $('bud-revenue-label').textContent = s.reportBasis === 'inkl' ? 'Omsättning inkl moms (kr)' : 'Omsättning ex moms (kr)';
    $('bud-revenue').value = fmtInput(w?.input.revenue); $('bud-vat').value = fmtInput(w?.input.salesVat);
    $('bud-card').value = fmtInput(w?.input.cardAmount); $('bud-cardcount').value = fmtInput(w?.input.cardCount);
    $('bud-kind').value = w?.kind || 'actual'; $('bud-note').value = w?.note || '';
    $('bud-sources').textContent = 'Fortnox och Caspeco är inte kopplade ännu. Tills dess fyller du i siffrorna här.' + (w?.received ? ' Mottagna leveranser i admin den här veckan: ' + krd(w.received) + ' ex moms.' : '');
    // Tabell
    const table = $('bud-table'); table.replaceChildren();
    const head = el('tr'); ['Post', 'Beräknas på', 'Sätt undan', 'Från förra veckan', 'Att använda', 'Faktiskt använt', 'Till nästa vecka', 'Status'].forEach(h => head.append(el('th', h)));
    table.append(el('thead')); table.tHead.append(head);
    const body = el('tbody');
    const posts = w?.computed ? w.posts : [...['goods', 'fuel', 'staff', 'other'].map((k, i) => ({ key: k, name: ['Varuinköp', 'Drivmedel', 'Personal, total kostnad', 'Övrig löpande drift'][i] })), ...budget.fixed.map(f => ({ key: f.key, name: f.name })), { key: 'card', name: 'Kortavgift, uppskattad' }];
    posts.forEach(p => {
      const tr = el('tr'); if (p.missing) tr.className = 'budget-missing';
      const input = el('input'); input.inputMode = 'decimal'; input.className = 'budget-actual'; input.dataset.key = p.key; input.autocomplete = 'off';
      input.value = fmtInput(w?.actuals?.[p.key]); input.setAttribute('aria-label', 'Faktiskt använt för ' + p.name);
      if (p.key === 'goods' && w?.received) input.placeholder = 'Leveranser ' + Math.round(w.received * (1 + s.purchaseVat.goods));
      const actualCell = el('td'); actualCell.append(input);
      const status = el('td', p.status || ''); if (p.status === 'Över budget') status.className = 'negative'; else if (p.status === 'Inom budget') status.className = 'positive';
      tr.append(el('th', p.name), el('td', p.basis || ''), el('td', p.budget === undefined ? '–' : krd(p.budget)), el('td', p.in === undefined ? '–' : krd(p.in)), el('td', p.available === undefined ? '–' : krd(p.available)), actualCell, el('td', p.out === undefined ? '–' : krd(p.out)), status);
      body.append(tr);
    });
    if (w?.computed) {
      const extra = (label, value) => { const tr = el('tr', undefined, 'budget-sum'); tr.append(el('th', label), el('td', ''), el('td', krd(value)), el('td'), el('td'), el('td'), el('td'), el('td')); body.append(tr); };
      extra('Buffert', w.buffer); extra('Momsreserv', w.vatReserve); extra('Summa avsättningar', w.reserve);
    }
    table.append(body);
    renderBudgetYear(); renderBudgetSettings();
  }
  const lastBalance = () => { const before = budget.weeks.filter(x => x.weekStart < budWeek); return before.length ? before[before.length - 1].balanceOut : budget.settings.startBalance; };
  function renderBudgetYear() {
    const t = $('bud-year'); t.replaceChildren();
    const head = el('tr'); ['Vecka', 'Typ', 'Omsättning ex moms', 'Försäljning inkl moms', 'Kvar efter avsättningar', 'Plus/minus', 'Saldo', 'Fritt saldo', 'Status'].forEach(h => head.append(el('th', h)));
    t.append(el('thead')); t.tHead.append(head);
    const body = el('tbody');
    if (!budget.weeks.length) { const tr = el('tr'), td = el('td', 'Inga veckor sparade ännu.'); td.colSpan = 9; tr.append(td); body.append(tr); }
    budget.weeks.forEach(w => {
      const tr = el('tr'); tr.className = 'clickable-row' + (w.weekStart === budWeek ? ' selected' : '');
      tr.append(el('th', weekLabel(w.weekStart)), el('td', w.kind === 'example' ? 'Exempel' : 'Faktisk'), el('td', w.computed ? krd(w.revenueEx) : '–'), el('td', w.computed ? krd(w.salesInkl) : '–'), el('td', w.computed ? krd(w.left) : '–'), el('td', w.computed ? krd(w.plusMinus) : '–'), el('td', krd(w.balanceOut)), el('td', krd(w.free)), el('td', w.status));
      tr.addEventListener('click', () => { budWeek = w.weekStart; renderBudget(); window.scrollTo(0, 0); });
      body.append(tr);
    });
    t.append(body);
  }
  // Inställningar: genereras från budget.settings.
  function settingsField(parent, label, value, path, { percent = false, help } = {}) {
    const d = el('div'), id = 'bs-' + path.replace(/[^a-z0-9]/gi, '-'), l = el('label', label), i = el('input');
    l.htmlFor = id; i.id = id; i.inputMode = 'decimal'; i.autocomplete = 'off'; i.dataset.path = path; i.dataset.percent = percent ? '1' : '';
    i.value = value === null || value === undefined ? '' : fmtInput(percent ? Math.round(value * 100000) / 1000 : value);
    d.append(l, i); if (help) d.append(el('p', help, 'field-help')); parent.append(d); return i;
  }
  function renderBudgetSettings() {
    const s = budget.settings, root = $('bud-settings-body'); root.replaceChildren();
    const group = (title, help) => { const sec = el('div', undefined, 'budget-group'); sec.append(el('h3', title)); if (help) sec.append(el('p', help, 'muted')); const g = el('div', undefined, 'config-grid'); sec.append(g); root.append(sec); return g; };
    let g = group('Försäljning och kalender');
    const basis = el('div'), bl = el('label', 'Kassarapportens belopp'), bs = el('select'); bl.htmlFor = 'bs-reportBasis'; bs.id = 'bs-reportBasis';
    [['ex', 'Exkl moms'], ['inkl', 'Inkl moms']].forEach(([v, t]) => { const o = el('option', t); o.value = v; o.selected = s.reportBasis === v; bs.append(o); }); basis.append(bl, bs); g.append(basis);
    settingsField(g, 'Öppetdagar per vecka', s.openDays, 'openDays');
    settingsField(g, 'Andel betalning med kort (%)', s.cardShare, 'cardShare', { percent: true });
    settingsField(g, 'Snitt per kortköp inkl moms (kr)', s.avgCard, 'avgCard');
    settingsField(g, 'Startsaldo (kr)', s.startBalance, 'startBalance', { help: 'Pengar kvar före första veckan.' });
    g = group('Fördelning av omsättning ex moms (%)', 'Summa just nu: ' + Math.round(budget.pctSum * 1000) / 10 + ' %. Fasta kostnader, kortavgift och moms avsätts dessutom.');
    [['goods', 'Varuinköp'], ['fuel', 'Drivmedel'], ['staff', 'Personal, total kostnad'], ['buffer', 'Buffert'], ['other', 'Övrig löpande drift']].forEach(([k, t]) => settingsField(g, t, s.pct[k], 'pct.' + k, { percent: true }));
    g = group('Moms på löpande inköp (%)');
    [['goods', 'Varuinköp'], ['fuel', 'Drivmedel'], ['other', 'Övrig löpande drift']].forEach(([k, t]) => settingsField(g, t, s.purchaseVat[k], 'purchaseVat.' + k, { percent: true }));
    // Fasta kostnader
    const fixedSec = el('div', undefined, 'budget-group'); fixedSec.append(el('h3', 'Fasta kostnader per månad'), el('p', 'Tom ruta betyder att beloppet saknas. Skriv 0 om posten inte kostar något.', 'muted'));
    const ft = el('div', undefined, 'table-scroll'), table = el('table', undefined, 'data-table budget-fixed'); ft.append(table); fixedSec.append(ft);
    const fh = el('tr'); ['Kostnad', 'Belopp per månad', 'Beloppet är', 'Moms %', 'Per vecka', ''].forEach(h => fh.append(el('th', h))); table.append(el('thead')); table.tHead.append(fh);
    const fb = el('tbody'); table.append(fb);
    const fixedRow = (f, i) => {
      const tr = el('tr'); tr.dataset.key = f.key || '';
      const name = el('input'); name.value = f.name; name.maxLength = 60; name.className = 'fx-name'; name.setAttribute('aria-label', 'Namn');
      const amount = el('input'); amount.inputMode = 'decimal'; amount.value = fmtInput(f.amount); amount.className = 'fx-amount'; amount.setAttribute('aria-label', 'Belopp per månad för ' + f.name);
      const b = el('select'); b.className = 'fx-basis'; [['inkl', 'Inkl moms'], ['exkl', 'Exkl moms']].forEach(([v, t]) => { const o = el('option', t); o.value = v; o.selected = f.basis === v; b.append(o); });
      const vat = el('input'); vat.inputMode = 'decimal'; vat.value = fmtInput(Math.round((f.vat ?? 0.25) * 1000) / 10); vat.className = 'fx-vat'; vat.setAttribute('aria-label', 'Moms');
      const cells = [name, amount, b, vat].map(x => { const td = el('td'); td.append(x); return td; });
      const fixed = budget.fixed.find(x => x.key === f.key);
      const remove = el('td'); remove.append(button('Ta bort', 'text-button', () => { if (confirm('Ta bort ' + (name.value || 'raden') + ' från budgeten? Sparade utfall finns kvar i databasen.')) tr.remove(); }));
      tr.append(...cells, el('td', fixed?.weekly === null || fixed?.weekly === undefined ? '–' : krd(fixed.weekly)), remove); fb.append(tr);
    };
    s.fixed.forEach(fixedRow);
    fixedSec.append(button('Lägg till kostnad', 'secondary-button', () => fixedRow({ key: '', name: '', amount: null, basis: 'inkl', vat: 0.25 })));
    root.append(fixedSec);
    // Mixar
    const mix = (title, rows, cols, cls) => {
      const sec = el('div', undefined, 'budget-group'); sec.append(el('h3', title));
      const wrap = el('div', undefined, 'table-scroll'), t = el('table', undefined, 'data-table ' + cls); wrap.append(t); sec.append(wrap);
      const h = el('tr'); cols.forEach(c => h.append(el('th', c[1]))); t.append(el('thead')); t.tHead.append(h);
      const b = el('tbody'); rows.forEach(r => { const tr = el('tr'); cols.forEach(([k, , kind]) => { const td = el('td'), i = el('input'); i.dataset.k = k; if (kind === 'text') { i.value = r[k]; i.maxLength = 60; } else { i.inputMode = 'decimal'; i.value = fmtInput(kind === 'pct' ? Math.round(r[k] * 100000) / 1000 : r[k]); i.dataset.kind = kind; } td.append(i); tr.append(td); }); b.append(tr); }); t.append(b);
      root.append(sec);
    };
    mix('Försäljningsmix (används om kassarapportens moms saknas)', s.salesMix, [['name', 'Försäljning', 'text'], ['share', 'Andel %', 'pct'], ['rate', 'Moms %', 'pct']], 'budget-sales-mix');
    mix('Kortavgifter per korttyp', s.cardMix, [['name', 'Korttyp', 'text'], ['share', 'Andel kortköp %', 'pct'], ['rate', 'Rörlig avgift %', 'pct'], ['fee', 'Kr per köp', 'num']], 'budget-card-mix');
    g = group('Moms på kortavgiften');
    settingsField(g, 'Moms på kortavgift (%)', s.cardFeeVat, 'cardFeeVat', { percent: true });
  }
  function collectSettings() {
    const s = structuredClone(budget.settings); let bad = '';
    const val = (input, percent) => { const n = parseNum(input.value); if (Number.isNaN(n)) bad = bad || 'Kontrollera siffran i ' + (input.labels?.[0]?.textContent || input.getAttribute('aria-label') || 'ett fält') + '.'; return n === null || Number.isNaN(n) ? null : percent ? Math.round(n * 1000) / 100000 : n; };
    s.reportBasis = $('bs-reportBasis').value;
    document.querySelectorAll('#bud-settings-body input[data-path]').forEach(i => { const v = val(i, i.dataset.percent === '1'); const [a, b] = i.dataset.path.split('.'); if (b) s[a][b] = v ?? 0; else s[a] = v ?? 0; });
    s.fixed = [...document.querySelectorAll('.budget-fixed tbody tr')].map(tr => ({ key: tr.dataset.key || undefined, name: tr.querySelector('.fx-name').value.trim(), amount: val(tr.querySelector('.fx-amount')), basis: tr.querySelector('.fx-basis').value, vat: (val(tr.querySelector('.fx-vat')) ?? 0) / 100 }));
    const mixRows = cls => [...document.querySelectorAll('.' + cls + ' tbody tr')].map(tr => { const r = {}; tr.querySelectorAll('input').forEach(i => { r[i.dataset.k] = i.dataset.kind ? (val(i, i.dataset.kind === 'pct') ?? 0) : i.value; }); return r; });
    s.salesMix = mixRows('budget-sales-mix'); s.cardMix = mixRows('budget-card-mix');
    if (bad) { note(bad); return null; }
    return s;
  }
  async function saveBudgetWeek() {
    const nums = { revenue: parseNum($('bud-revenue').value), salesVat: parseNum($('bud-vat').value), cardAmount: parseNum($('bud-card').value), cardCount: parseNum($('bud-cardcount').value) };
    if (Object.values(nums).some(Number.isNaN)) { note('Kontrollera siffrorna. Använd bara siffror, gärna med komma för ören.'); return; }
    const actuals = {}; let bad = false;
    document.querySelectorAll('.budget-actual').forEach(i => { const n = parseNum(i.value); if (Number.isNaN(n)) bad = true; else if (n !== null) actuals[i.dataset.key] = n; });
    if (bad) { note('Kontrollera beloppen under Faktiskt använt.'); return; }
    const r = await adminCall('budget', { action: 'save_week', week: { weekStart: budWeek, kind: $('bud-kind').value, note: $('bud-note').value, ...nums, actuals } }, weekLabel(budWeek) + ' är sparad.');
    if (r) { budget = r; renderBudget(); }
  }
  $('bud-save').addEventListener('click', saveBudgetWeek);
  $('bud-week-form').addEventListener('submit', event => { event.preventDefault(); saveBudgetWeek(); });
  $('bud-week').addEventListener('change', () => { budWeek = $('bud-week').value; renderBudget(); });
  $('bud-prev').addEventListener('click', () => { budWeek = addDays(budWeek, -7); renderBudget(); });
  $('bud-next').addEventListener('click', () => { budWeek = addDays(budWeek, 7); renderBudget(); });
  $('bud-settings-form').addEventListener('submit', async event => {
    event.preventDefault(); const settings = collectSettings(); if (!settings) return;
    const r = await adminCall('budget', { action: 'save_settings', settings }, 'Budgetinställningarna är sparade.');
    if (r) { budget = r; renderBudget(); $('bud-settings').open = true; }
  });
  $('bud-export').addEventListener('click', () => {
    if (!budget) return;
    downloadCsv('albert-veckobudget.csv', [['Vecka', 'Måndag', 'Typ', 'Omsättning ex moms', 'Moms', 'Försäljning inkl moms', 'Summa avsättningar', 'Kvar efter avsättningar', 'Plus/minus', 'Saldo', 'Fritt saldo', 'Status'],
      ...budget.weeks.map(w => [w.week, w.weekStart, w.kind === 'example' ? 'Exempel' : 'Faktisk', w.revenueEx ?? '', w.salesVat ?? '', w.salesInkl ?? '', w.reserve ?? '', w.left ?? '', w.plusMinus ?? '', w.balanceOut, w.free, w.status].map(v => typeof v === 'number' ? String(v).replace('.', ',') : v))]);
  });

  // ---------- Händelser ----------
  document.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => { switchView(b.dataset.view); drawer(false); window.scrollTo(0, 0); }));
  $('menu-toggle').addEventListener('click', () => drawer(!document.body.classList.contains('drawer-open')));
  $('drawer-backdrop').addEventListener('click', () => drawer(false));
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && document.body.classList.contains('drawer-open')) { drawer(false); $('menu-toggle').focus(); } });
  document.querySelectorAll('[data-phase]').forEach(b => b.addEventListener('click', () => { taskPhase = b.dataset.phase; renderTasks(); }));
  document.querySelectorAll('[data-period]').forEach(b => b.addEventListener('click', () => { statsDays = Number(b.dataset.period); document.querySelectorAll('[data-period]').forEach(x => x.setAttribute('aria-pressed', String(x === b))); loadStats(); }));
  $('only-open-tasks').addEventListener('change', renderTasks);
  document.querySelectorAll('[data-counter]').forEach(b => b.addEventListener('click', () => mutate('counter', { date: data.day.date, field: b.dataset.counter, delta: Number(b.dataset.delta) }, 'Antalet är sparat.')));
  document.querySelectorAll('[data-counter-form]').forEach(form => form.addEventListener('submit', event => { event.preventDefault(); if (!form.reportValidity()) return; const field = form.dataset.counterForm; mutate('counter', { date: data.day.date, field, mode: 'set', value: Number($(field + '-manual').value), version: data.day.version }, 'Totalsumman är sparad.'); }));
  document.querySelectorAll('form').forEach(form => form.addEventListener('input', () => { dirty = true; }));
  $('waste-form').addEventListener('submit', async event => { event.preventDefault(); if (!event.target.reportValidity() || !data) return; const ok = await mutate('waste', { date: data.day.date, item: $('waste-item').value, qty: Number($('waste-qty').value), reason: $('waste-reason').value, note: $('waste-note').value }, 'Svinnet är registrerat.'); if (ok) { $('waste-qty').value = 1; $('waste-note').value = ''; } });
  $('stock-form').addEventListener('submit', event => { event.preventDefault(); if (!event.target.reportValidity() || !data) return; mutate('settings', { date: data.day.date, prepared: $('prepared').value === '' ? null : Number($('prepared').value), paused: !!data.day.paused, allowAfterClosing: !!data.day.allow_after_closing, version: data.day.version }, 'Dagens pizzantal är sparat.'); });
  $('settings-form').addEventListener('submit', event => { event.preventDefault(); if (!event.target.reportValidity() || !data) return; mutate('settings', { date: data.day.date, prepared: data.day.prepared, paused: $('paused').checked, allowAfterClosing: $('after-closing').checked, version: data.day.version }, 'Dagens inställningar är sparade.'); });
  $('start-checklist').addEventListener('click', () => { if (data) mutate('task', { date: data.day.date, action: 'start_checklist' }, 'Standardlistan är tillagd. Du kan ändra eller ta bort varje uppgift.'); });
  $('task-form').addEventListener('submit', async event => { event.preventDefault(); if (!event.target.reportValidity() || !data) return; const saved = await mutate('task', { date: data.day.date, action: 'create', title: $('task-title').value, category: $('task-category').value, area: $('task-area').value }, 'Uppgiften är tillagd.'); if (saved) { $('task-title').value = ''; taskPhase = 'all'; $('only-open-tasks').checked = false; renderTasks(); } });
  $('cancel-close').addEventListener('click', () => $('cancel-dialog').close());
  $('cancel-form').addEventListener('submit', event => { event.preventDefault(); if (!event.target.reportValidity()) return; mutate('booking', { id: cancelId, action: 'cancel', reason: $('cancel-reason').value }, 'Bokningen är avbokad.'); });
  $('search-bookings').addEventListener('input', renderBookings); $('status-filter').addEventListener('change', renderBookings);
  $('work-date').value = today(); $('work-date').addEventListener('change', () => { if ($('work-date').value) load(); });
  $('today').addEventListener('click', () => { $('work-date').value = today(); load(); });
  const shiftDay = n => { const d = new Date(($('work-date').value || today()) + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); $('work-date').value = d.toISOString().slice(0, 10); load(); };
  $('prev-day').addEventListener('click', () => shiftDay(-1)); $('next-day').addEventListener('click', () => shiftDay(1)); $('refresh').addEventListener('click', () => load());
  function downloadCsv(name, rows) {
    const csv = value => { let text = String(value ?? ''); if (/^[=+@-]/.test(text)) text = "'" + text; return '"' + text.replaceAll('"', '""') + '"'; };
    const url = URL.createObjectURL(new Blob(['﻿' + rows.map(row => row.map(csv).join(';')).join('\r\n')], { type: 'text/csv;charset=utf-8' })); const a = el('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  $('export-bookings').addEventListener('click', () => {
    if (!data) return;
    downloadCsv('albert-bokningar-' + data.day.date + '.csv', [['Datum', 'Färdigtid', 'Namn', 'E-post', 'Telefon', 'Pizzor', 'Gäster', 'Typ', 'Status', 'Avbokningsorsak'], ...data.bookings.map(b => [b.date, time(b.ready_min), b.name, b.email, b.phone, b.count, b.guests, b.mode === 'here' ? 'Äta här' : 'Ta med', labels[b.status], b.cancel_reason])]);
  });
  $('export-stats').addEventListener('click', () => {
    if (!stats) return;
    downloadCsv('albert-statistik-' + stats.from + '-' + stats.to + '.csv', [['Datum', 'Bokade pizzor', 'Drop-in', 'Svinn', 'Gäster', 'Avbokade', 'Förberedda', 'Uppskattad försäljning (kr)'], ...stats.days.map(d => [d.date, d.bookedPizzas, d.dropin, d.waste, d.guests, d.cancelled, d.prepared ?? '', (d.bookedPizzas + d.dropin) * stats.avgPizzaPrice])]);
  });
  document.querySelectorAll('[data-ph-mode]').forEach(b => b.addEventListener('click', () => { phMode = b.dataset.phMode; phSlot = null; loadPhone(); }));
  $('ph-count').addEventListener('change', () => loadPhone()); $('ph-guests').addEventListener('change', () => loadPhone());
  $('ph-form').addEventListener('submit', async event => {
    event.preventDefault(); if (!event.target.reportValidity() || !phSlot || busy) return;
    busy = true; $('ph-submit').disabled = true; note('Sparar bokningen.');
    const body = { key: crypto.randomUUID(), date: data.day.date, time: phSlot.time, count: Number($('ph-count').value), mode: phMode, guests: phMode === 'here' ? Number($('ph-guests').value) : 0,
      contact: { name: $('ph-name').value.trim(), phone: $('ph-phone').value.trim(), email: $('ph-email').value.trim() } };
    try {
      const r = await request('phone-booking', body);
      note('Bokningen är sparad: ' + body.contact.name + ' kl. ' + r.booking.time + ', kom ' + r.booking.arrival + '.' + (body.contact.email ? (r.email.status === 'sent' ? ' Bekräftelse skickad.' : ' Mejlbekräftelsen kunde inte skickas.') : ''), true);
      event.target.reset(); phSlot = null;
    } catch (error) { if (error.status === 401) { showLogin('Du har loggats ut. Logga in igen.'); return; } note(error.message); }
    finally { busy = false; }
    await load(true);
  });
  $('stock-search').addEventListener('input', () => stock && renderStock()); $('stock-filter').addEventListener('change', () => stock && renderStock());
  $('stock-save').addEventListener('click', async () => {
    const counts = Object.entries(stockDirty).map(([id, v]) => ({ id, qty: Number(String(v).replace(',', '.')) }));
    if (!counts.length) return;
    const r = await adminCall('stock', { action: 'count', counts }, 'Inventeringen är sparad (' + counts.length + (counts.length === 1 ? ' vara).' : ' varor).'));
    if (r) { stock = r; stockDirty = {}; $('stock-save').textContent = 'Spara inventering'; renderStock(); }
  });
  $('shop-print').addEventListener('click', () => { if (stock) printShopping(); });
  $('shop-create').addEventListener('click', async () => { const r = await adminCall('purchase', { action: 'create_from_low' }, 'Beställningar är skapade per leverantör. Kontrollera antalen och skicka.'); if (r) { orders = r.orders; stock = r.stock; renderPurchase(); } });
  $('menu-add').addEventListener('click', () => { if (menu) { renderMenu(menuForm({ active: false, category: 'pizza' })); $('menu-list').querySelector('input')?.focus(); } });
  $('staff-form').addEventListener('submit', async event => {
    event.preventDefault(); if (!event.target.reportValidity()) return;
    const result = await adminCall('staff', { action: 'create', name: $('staff-name').value, email: $('staff-email').value, title: $('staff-title').value, role: $('staff-role').value, password: $('staff-password').value }, $('staff-name').value + ' är tillagd och kan logga in.');
    if (result) { staff = result; event.target.reset(); renderStaff(); }
  });
  $('password-close').addEventListener('click', () => $('password-dialog').close());
  $('password-form').addEventListener('submit', async event => { event.preventDefault(); if (!event.target.reportValidity()) return; const r = await adminCall('staff', { action: 'password_reset', userId: resetUserId, password: $('reset-password').value }, 'Det nya lösenordet är sparat.'); if (r) { staff = r; $('password-dialog').close(); renderStaff(); } });
  $('config-form').addEventListener('submit', async event => {
    event.preventDefault(); if (!event.target.reportValidity() || !config) return;
    const settings = { version: config.version, openWeekdays: [...document.querySelectorAll('#weekday-boxes input:checked')].map(c => Number(c.value)) };
    cfgFields.forEach(f => { settings[f] = Number($('cfg-' + f).value); });
    ['lunchFirst', 'lunchLast', 'dinnerFirst', 'dinnerLast'].forEach(f => { settings[f] = minutes($('cfg-' + f).value); });
    const result = await adminCall('config', { action: 'save', settings }, 'Inställningarna är sparade och gäller direkt för nya bokningar.');
    if (result) { config = result; renderConfig(); }
  });
  $('closed-form').addEventListener('submit', async event => {
    event.preventDefault(); if (!event.target.reportValidity()) return;
    const result = await adminCall('config', { action: 'close_date', date: $('closed-date').value, reason: $('closed-reason').value }, 'Datumet är stängt för nya bokningar. Kontrollera om det finns bokningar som behöver kontaktas.');
    if (result) { config = result; event.target.reset(); renderConfig(); }
  });
  $('login-form').addEventListener('submit', async event => {
    event.preventDefault(); if (!event.target.reportValidity()) return;
    const submit = event.target.querySelector('button'); submit.disabled = true; $('login-message').textContent = 'Loggar in.';
    try { await http('/api/auth/login', { email: $('login-email').value, password: $('login-password').value }); $('login-password').value = ''; $('login-message').textContent = ''; await load(); switchView('day'); }
    catch (error) { $('login-message').textContent = error.message; }
    finally { submit.disabled = false; }
  });
  $('logout').addEventListener('click', async () => { try { await http('/api/auth/logout', {}); } catch { /* utloggad ändå */ } showLogin('Du är utloggad.'); });
  $('account-button').addEventListener('click', () => { $('account-description').textContent = data ? data.actor.name + ' · ' + data.actor.email : ''; $('new-password').value = ''; $('account-dialog').showModal(); });
  $('account-close').addEventListener('click', () => $('account-dialog').close());
  $('account-form').addEventListener('submit', async event => {
    event.preventDefault(); if (!event.target.reportValidity()) return;
    try { await http('/api/auth/password', { password: $('new-password').value }); $('account-dialog').close(); note('Ditt lösenord är bytt.', true); }
    catch (error) { $('account-description').textContent = error.message; }
  });
  setInterval(() => { if (data && view !== 'config' && view !== 'menu' && view !== 'staff' && view !== 'stock' && view !== 'purchase' && !busy && !fetching && !dirty && !needsRefresh && !document.hidden && !document.querySelector('dialog[open]') && !document.querySelector('.task-edit[open]') && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) load(true); }, 30000);
  switchView(view);
  load();
})();
