(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const labels = { confirmed: 'Bokad', checked_in: 'Incheckad', completed: 'Avslutad', cancelled: 'Avbokad' };
  const actionNames = { booking_created: 'Ny bokning', booking_checkin: 'Gäst incheckad', booking_finish: 'Bokning avslutad', booking_cancel: 'Bokning avbokad', dropin_changed: 'Drop-in ändrat', waste_changed: 'Svinn ändrat', day_settings: 'Dagsinställningar sparade', task_create: 'Arbetsuppgift tillagd', task_update: 'Arbetsuppgift flyttad eller redigerad', task_done: 'Arbetsuppgift ändrad', task_archive: 'Arbetsuppgift borttagen' };
  const phases = { opening: 'Öppning', general: 'Under dagen', closing: 'Stängning' };
  const areas = { kitchen: 'Kök & förberedelser', service: 'Servering & lokal', hygiene: 'Hygien & toalett', other: 'Övrigt' };
  const descriptions = { opening: 'Innan vi öppnar', general: 'Håll ordning under servicen', closing: 'Innan vi går hem' };
  const mailLabels = { sent: 'Bekräftelsemejl skickat', pending: 'Bekräftelsemejl väntar', sending: 'Mejl behandlas', failed: 'Mejl kunde inte skickas', uncertain: 'Mejlutskicket behöver kontrolleras', blocked: 'Mejl är inte aktiverat', review: 'Kontrollera utskicket i Resend', skipped: 'Mejlutskick stoppat' };
  const mailMessages = { sent: 'Bekräftelsen har skickats till mejltjänsten.', pending: 'Utskicket väntar. Försök igen om en stund.', sending: 'Utskicket behandlas redan. Uppdatera vyn om en stund.', failed: 'Mejltjänsten nekade utskicket. Kontrollera API-nyckel och avsändare.', uncertain: 'Mejltjänstens svar kunde inte bekräftas. Samma utskick kan kontrolleras igen om en stund.', not_configured: 'Mejlutskicken behöver aktiveras med en API-nyckel och avsändare.', review: 'Kontrollera det tidigare utskicket i Resend. Ett nytt mejl skickas inte automatiskt.', skipped: 'Utskicket har stoppats eftersom bokningen inte längre är aktuell.', not_queued: 'Inget mejlutskick finns sparat för bokningen.' };
  let data, fetching = false, busy = false, dirty = false, serial = 0, cancelId, view = 'day', needsRefresh = false, taskPhase = 'all';
  const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm' }).format(new Date());
  const time = minute => String(Math.floor(minute / 60)).padStart(2, '0') + ':' + String(minute % 60).padStart(2, '0');
  const readable = date => new Intl.DateTimeFormat('sv-SE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(date + 'T12:00:00Z'));
  function el(tag, text, cls) { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (cls) node.className = cls; return node; }
  function note(message, success = false) { $('notice').textContent = message; $('notice').hidden = !message; $('notice').classList.toggle('success', success); }
  function lock() {
    document.querySelectorAll('[data-mutation]').forEach(button => { button.disabled = busy || fetching || needsRefresh || (button.dataset.email === 'true' && !data?.emailSetup?.configured) || (!!button.dataset.counter && Number(button.dataset.delta) < 0 && (!data || data.day[button.dataset.counter] === 0)); });
    $('work-date').disabled = busy; $('today').disabled = busy; $('refresh').disabled = busy;
  }
  async function request(path, body) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch('/api/admin/' + path, { method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
      const result = await response.json();
      if (!response.ok) { const error = new Error(result.error || 'Åtgärden kunde inte genomföras.'); error.status = response.status; throw error; }
      return result;
    } finally { clearTimeout(timer); }
  }
  async function load(silent = false) {
    const current = ++serial; fetching = true; lock();
    if (!silent) { $('loading').hidden = false; $('loading').textContent = 'Hämtar din arbetsdag.'; $('admin-content').hidden = true; }
    try {
      const result = await request('day?date=' + encodeURIComponent($('work-date').value));
      if (current !== serial) return;
      data = result; needsRefresh = false; dirty = false;
      $('login-panel').hidden = true; $('admin-content').hidden = false;
      render();
      if (!silent) note('');
    } catch (error) {
      if (current !== serial) return;
      if ([401, 403].includes(error.status)) {
        $('login-panel').hidden = false; $('admin-content').hidden = true; $('login-message').textContent = error.message;
      } else note('Kunde inte hämta dagen. ' + error.message);
    } finally { if (current === serial) { $('loading').hidden = true; fetching = false; } lock(); }
  }
  async function mutate(path, body, message) {
    if (busy || fetching || needsRefresh || !data) return false;
    const focusId = document.activeElement?.id;
    busy = true; lock(); note('Sparar.');
    try {
      data = await request(path, body);
      dirty = false; render();
      if (path === 'email') note(mailMessages[data.emailAction?.status] || 'Utskicket kunde inte verifieras.', data.emailAction?.status === 'sent');
      else note(message, true);
      if (path === 'booking' && body.action === 'cancel') $('cancel-dialog').close();
      return true;
    } catch (error) {
      if (error.status) {
        await load(true); note(error.message);
      } else {
        needsRefresh = true;
        note('Ändringen kan ha sparats. Tryck Uppdatera innan du gör fler ändringar.');
      }
      return false;
    } finally { busy = false; lock(); if (focusId?.startsWith('task-done-')) $(focusId)?.focus({ preventScroll: true }); }
  }
  function switchView(value) {
    if (!['day', 'tasks', 'history'].includes(value)) value = 'day';
    view = value;
    document.querySelectorAll('[data-panel]').forEach(panel => panel.hidden = panel.dataset.panel !== value);
    document.querySelectorAll('[data-view]').forEach(button => { if (button.dataset.view === value) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current'); });
    $('view-title').textContent = { day: 'Dagsvy', tasks: 'Arbetsuppgifter', history: 'Historik' }[value];
  }
  function bookingAction(buttonLabel, action, row, cls) {
    const button = el('button', buttonLabel, cls); button.type = 'button'; button.dataset.mutation = 'true';
    button.addEventListener('click', () => {
      if (action === 'cancel') {
        cancelId = row.id; $('cancel-description').textContent = row.name + ' · ' + time(row.ready_min) + ' · ' + row.count + ' pizzor'; $('cancel-reason').value = ''; $('cancel-dialog').showModal(); $('cancel-reason').focus();
      } else mutate('booking', { id: row.id, action }, action === 'checkin' ? 'Gästen är incheckad.' : 'Bokningen är avslutad.');
    });
    return button;
  }
  function renderBookings() {
    if (!data) return;
    const search = $('search-bookings').value.trim().toLowerCase(), filter = $('status-filter').value;
    const rows = data.bookings.filter(b => (filter === 'all' || (filter === 'active' ? ['confirmed', 'checked_in'].includes(b.status) : b.status === filter)) && [b.name, b.phone, b.email, b.id].join(' ').toLowerCase().includes(search));
    $('booking-count').textContent = rows.length + (rows.length === 1 ? ' bokning' : ' bokningar');
    const root = $('booking-list'); root.replaceChildren();
    if (!rows.length) root.append(el('p', 'Inga bokningar att visa för det här urvalet.', 'empty-state'));
    rows.forEach(row => {
      const card = el('article', undefined, 'booking-row'), clock = el('div', undefined, 'booking-time');
      clock.append(el('strong', time(row.ready_min)), el('span', labels[row.status], 'booking-status ' + row.status));
      const person = el('div', undefined, 'booking-person'); person.append(el('strong', row.name));
      const phone = el('a', row.phone); phone.href = 'tel:' + row.phone.replace(/[^+0-9]/g, ''); person.append(phone, el('small', row.email));
      const emailStatus = row.confirmationEmail?.status;
      person.append(el('small', mailLabels[emailStatus] || 'Inget bekräftelsemejl skickat', 'email-status' + (emailStatus === 'sent' ? ' sent' : '')));
      const details = el('div', undefined, 'booking-detail'); details.append(el('span', row.count + ' pizzor · ' + (row.mode === 'here' ? row.guests + ' gäster' : 'Ta med')), el('small', 'Ankomst ' + time(row.ready_min - 10)));
      if (row.mode === 'here') details.append(el('small', 'Sittning ' + time(row.ready_min - 10) + '–' + time(row.ready_min + 50)));
      const actions = el('div', undefined, 'booking-actions-list');
      if (row.status === 'confirmed') actions.append(bookingAction('Checka in', 'checkin', row, 'admin-primary'));
      if (row.status === 'checked_in') actions.append(bookingAction('Avsluta besöket', 'finish', row, 'admin-primary'));
      if (['confirmed', 'checked_in'].includes(row.status)) actions.append(bookingAction('Avboka', 'cancel', row, 'secondary-button'));
      if (['confirmed', 'checked_in'].includes(row.status) && !['sent', 'review', 'skipped'].includes(emailStatus) && row.date >= today()) {
        const retry = el('button', emailStatus === 'uncertain' || emailStatus === 'sending' ? 'Kontrollera mejlet' : 'Skicka bekräftelse', 'text-button'); retry.type = 'button'; retry.dataset.mutation = 'true'; retry.dataset.email = 'true';
        retry.addEventListener('click', () => mutate('email', { id: row.id }, '')); actions.append(retry);
      }
      card.append(clock, person, details, actions);
      if (row.cancel_reason) card.append(el('div', 'Avbokningsorsak: ' + row.cancel_reason, 'cancel-reason'));
      root.append(card);
    }); lock();
  }
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
    document.querySelectorAll('[data-phase]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.phase === taskPhase)));
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
      let detail; try { detail = JSON.parse(item.detail); } catch { detail = {}; }
      const parts = [item.actor === 'guest' ? 'Gästbokning' : item.actor];
      if (detail.time) parts.push(detail.time); if (detail.count) parts.push(detail.count + ' pizzor'); if (detail.reason) parts.push(detail.reason); if (detail.title) parts.push(detail.title);
      if (detail.delta) parts.push('Ändring ' + (detail.delta > 0 ? '+' : '') + detail.delta); if (detail.value !== undefined) parts.push('Totalt ' + detail.value);
      if (detail.prepared !== undefined) parts.push(detail.prepared === null ? 'Ingen dagsgräns' : detail.prepared + ' förberedda');
      if (phases[detail.category]) parts.push(phases[detail.category]); if (areas[detail.area]) parts.push(areas[detail.area]);
      if (typeof detail.done === 'boolean') parts.push(detail.done ? 'Klar' : 'Öppnad igen');
      content.append(el('p', parts.join(' · '))); row.append(timestamp, content); root.append(row);
    });
  }
  function render() {
    $('account-name').textContent = data.actor.name;
    $('email-setup').hidden = !!data.emailSetup?.configured;
    $('email-setup').textContent = 'Mejlbekräftelser är inte aktiverade ännu. Resend behöver en API-nyckel och en verifierad avsändare. Bokningar sparas som vanligt.';
    $('day-label').textContent = readable(data.day.date);
    $('stat-booked').textContent = data.stats.booked;
    $('stat-remaining').textContent = data.stats.remaining === null ? 'Ej satt' : data.stats.remaining;
    $('stock-explanation').textContent = data.day.prepared === null ? 'Ingen dagsgräns satt. Lämna tomt för att ta bort en gräns.' : 'Av ' + data.day.prepared + ' förberedda dras bokningar, drop-in och svinn av.';
    $('guests-present').textContent = data.stats.guestsPresent; $('booking-open').textContent = data.day.paused ? 'Pausad' : 'Öppen';
    $('booking-open').classList.toggle('paused', !!data.day.paused);
    $('dropin-value').textContent = data.day.dropin; $('waste-value').textContent = data.day.waste;
    $('dropin-manual').value = data.day.dropin; $('waste-manual').value = data.day.waste;
    $('prepared').value = data.day.prepared === null ? '' : data.day.prepared; $('paused').checked = !!data.day.paused; $('after-closing').checked = !!data.day.allow_after_closing;
    renderBookings(); renderTasks(); renderHistory(); lock();
  }
  document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => switchView(button.dataset.view)));
  document.querySelectorAll('[data-phase]').forEach(button => button.addEventListener('click', () => { taskPhase = button.dataset.phase; renderTasks(); }));
  $('only-open-tasks').addEventListener('change', renderTasks);
  document.querySelectorAll('[data-counter]').forEach(button => button.addEventListener('click', () => mutate('counter', { date: data.day.date, field: button.dataset.counter, delta: Number(button.dataset.delta) }, 'Antalet är sparat.')));
  document.querySelectorAll('[data-counter-form]').forEach(form => form.addEventListener('submit', event => { event.preventDefault(); if (!form.reportValidity()) return; const field = form.dataset.counterForm; mutate('counter', { date: data.day.date, field, mode: 'set', value: Number($(field + '-manual').value), version: data.day.version }, 'Totalsumman är sparad.'); }));
  document.querySelectorAll('form').forEach(form => form.addEventListener('input', () => { dirty = true; }));
  $('stock-form').addEventListener('submit', event => { event.preventDefault(); if (!event.target.reportValidity() || !data) return; mutate('settings', { date: data.day.date, prepared: $('prepared').value === '' ? null : Number($('prepared').value), paused: !!data.day.paused, allowAfterClosing: !!data.day.allow_after_closing, version: data.day.version }, 'Dagens pizzantal är sparat.'); });
  $('settings-form').addEventListener('submit', event => { event.preventDefault(); if (!event.target.reportValidity() || !data) return; mutate('settings', { date: data.day.date, prepared: data.day.prepared, paused: $('paused').checked, allowAfterClosing: $('after-closing').checked, version: data.day.version }, 'Dagens inställningar är sparade.'); });
  $('start-checklist').addEventListener('click', () => { if (data) mutate('task', { date: data.day.date, action: 'start_checklist' }, 'Standardlistan är tillagd. Du kan ändra eller ta bort varje uppgift.'); });
  $('task-form').addEventListener('submit', async event => { event.preventDefault(); if (!event.target.reportValidity() || !data) return; const saved = await mutate('task', { date: data.day.date, action: 'create', title: $('task-title').value, category: $('task-category').value, area: $('task-area').value }, 'Uppgiften är tillagd.'); if (saved) { $('task-title').value = ''; taskPhase = 'all'; $('only-open-tasks').checked = false; renderTasks(); } });
  $('cancel-close').addEventListener('click', () => $('cancel-dialog').close());
  $('cancel-form').addEventListener('submit', event => { event.preventDefault(); if (!event.target.reportValidity()) return; mutate('booking', { id: cancelId, action: 'cancel', reason: $('cancel-reason').value }, 'Bokningen är avbokad.'); });
  $('search-bookings').addEventListener('input', renderBookings); $('status-filter').addEventListener('change', renderBookings);
  $('work-date').value = today(); $('work-date').addEventListener('change', () => { if ($('work-date').value) load(); });
  $('today').addEventListener('click', () => { $('work-date').value = today(); load(); }); $('refresh').addEventListener('click', () => load());
  $('export-bookings').addEventListener('click', () => {
    if (!data) return;
    const csv = value => { let text = String(value ?? ''); if (/^[=+@-]/.test(text)) text = "'" + text; return '"' + text.replaceAll('"', '""') + '"'; };
    const rows = [['Datum', 'Färdigtid', 'Namn', 'E-post', 'Telefon', 'Pizzor', 'Gäster', 'Typ', 'Status', 'Avbokningsorsak'], ...data.bookings.map(b => [b.date, time(b.ready_min), b.name, b.email, b.phone, b.count, b.guests, b.mode === 'here' ? 'Äta här' : 'Ta med', labels[b.status], b.cancel_reason])];
    const url = URL.createObjectURL(new Blob(['\ufeff' + rows.map(row => row.map(csv).join(';')).join('\r\n')], { type: 'text/csv;charset=utf-8' })); const a = el('a'); a.href = url; a.download = 'albert-bokningar-' + data.day.date + '.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  setInterval(() => { if (data && !busy && !fetching && !dirty && !needsRefresh && !document.hidden && !$('cancel-dialog').open && !document.querySelector('.task-edit[open]') && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) load(true); }, 30000);
  switchView(view);
  load();
})();
