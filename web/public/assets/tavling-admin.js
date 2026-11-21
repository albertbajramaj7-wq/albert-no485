(() => {
  'use strict';
  // Admin för tävlingslistan. Använder samma inloggning som /admin/ (kakorna gäller för /api).
  const $ = id => document.getElementById(id);
  const clean = value => String(value || '').toLowerCase().replace(/[@\s]/g, '');
  let data = { published: false, entries: [] }, busy = false, confirmRemove = '';

  function note(message, error = false) {
    $('ga-notice').textContent = message; $('ga-notice').hidden = !message; $('ga-notice').classList.toggle('error', error);
  }
  async function http(body) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch('/api/admin/giveaway', { method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) { const error = new Error(result.error || 'Åtgärden kunde inte genomföras.'); error.status = response.status; throw error; }
      return result;
    } finally { clearTimeout(timer); }
  }
  function button(text, cls, onClick) { const b = document.createElement('button'); b.type = 'button'; b.textContent = text; b.className = cls; b.addEventListener('click', onClick); return b; }

  async function change(body, done) {
    if (busy) return;
    busy = true; render();
    try { data = await http(body); note(done || ''); }
    catch (error) { note(error.status === 401 ? 'Du har loggats ut. Logga in i admin och öppna sidan igen.' : error.message, true); }
    finally { busy = false; confirmRemove = ''; render(); }
  }

  function row(entry) {
    const item = document.createElement('li');
    if (entry.hidden) item.className = 'ga-hidden-row';
    const name = document.createElement('div'); name.className = 'ga-name'; name.textContent = '@' + entry.u;
    const info = [];
    if (entry.hidden) info.push('Borttagen från listan');
    else if (entry.manual) info.push('Ändrad för hand' + (entry.updatedBy ? ' av ' + entry.updatedBy : ''));
    if (info.length) { const small = document.createElement('small'); small.textContent = info.join(' · '); name.append(small); }
    const actions = document.createElement('div'); actions.className = 'ga-actions';
    if (entry.hidden) {
      actions.append(button('Lägg tillbaka', 'ga-small', () => change({ action: 'restore', username: entry.u }, '@' + entry.u + ' visas igen.')));
    } else {
      const state = button(entry.ok ? 'Avklarat' : 'Ej avklarat', 'ga-state ' + (entry.ok ? 'ok' : 'missing'), () => change({ action: 'set', username: entry.u, approved: !entry.ok }));
      state.setAttribute('aria-label', '@' + entry.u + ': ' + (entry.ok ? 'Avklarat' : 'Ej avklarat') + '. Tryck för att byta.');
      const remove = confirmRemove === entry.u
        ? button('Säkert? Ta bort', 'ga-small', () => change({ action: 'remove', username: entry.u }, '@' + entry.u + ' är borttagen från listan.'))
        : button('Ta bort', 'ga-small', () => { confirmRemove = entry.u; render(); });
      actions.append(state, remove);
    }
    actions.querySelectorAll('button').forEach(b => { b.disabled = busy; });
    item.append(name, actions);
    return item;
  }

  function render() {
    $('ga-published-text').textContent = data.published ? 'Listan visas på hemsidan.' : 'Listan är dold för besökare.';
    $('ga-publish').textContent = data.published ? 'Dölj listan' : 'Visa listan';
    $('ga-publish').disabled = busy;
    const term = clean($('ga-search').value), filter = $('ga-filter').value;
    const visible = data.entries.filter(e => !e.hidden);
    const shown = data.entries.filter(e => {
      if (term && !e.u.includes(term)) return false;
      if (filter === 'hidden') return e.hidden;
      if (e.hidden) return false;
      if (filter === 'ok') return e.ok;
      if (filter === 'missing') return !e.ok;
      if (filter === 'manual') return e.manual;
      return true;
    });
    $('ga-count').textContent = visible.length + ' deltagare, varav ' + visible.filter(e => e.ok).length + ' avklarade och ' + visible.filter(e => !e.ok).length + ' ej avklarade. ' + shown.length + ' visas här.';
    $('ga-list').replaceChildren(...shown.map(row));
  }

  $('ga-publish').addEventListener('click', () => change({ action: 'publish', published: !data.published }));
  $('ga-search').addEventListener('input', render);
  $('ga-filter').addEventListener('change', render);
  $('ga-add').addEventListener('submit', event => {
    event.preventDefault();
    const username = clean($('ga-add-name').value);
    if (!/^[a-z0-9._]{1,30}$/.test(username)) { note('Skriv ett giltigt Instagram-namn, utan mellanslag.', true); return; }
    change({ action: 'add', username, approved: $('ga-add-state').value === 'ok' }, '@' + username + ' är tillagd.').then(() => { $('ga-add-name').value = ''; });
  });

  (async () => {
    note('Hämtar listan.');
    try { data = await http(); note(''); $('ga-content').hidden = false; render(); }
    catch (error) {
      note(error.status === 401 ? 'Logga in i admin först och öppna sedan den här sidan igen.' : error.message, true);
    }
  })();
})();
