(() => {
  'use strict';
  // Tävlingslistan: hämtar Instagram-namn och status från /api/giveaway och låter besökaren söka sitt namn.
  const $ = id => document.getElementById(id);
  const list = $('giveaway-list'), search = $('giveaway-search'), status = $('giveaway-status'), summary = $('giveaway-summary');
  if (!list || !search) return;
  let entries = [], filter = 'all';
  const clean = value => String(value || '').toLowerCase().replace(/[@\s]/g, '');

  function row(entry) {
    const item = document.createElement('li');
    item.className = entry.ok ? 'is-ok' : 'is-missing';
    const name = document.createElement('span');
    name.className = 'giveaway-name';
    name.textContent = '@' + entry.u;
    const mark = document.createElement('span');
    mark.className = 'giveaway-mark';
    mark.textContent = entry.ok ? 'Avklarat' : 'Ej avklarat';
    item.append(name, mark);
    return item;
  }

  function render() {
    const term = clean(search.value);
    const shown = entries.filter(e => (filter === 'all' || (filter === 'ok') === e.ok) && (!term || e.u.includes(term)));
    list.replaceChildren(...shown.map(row));
    if (!entries.length) return;
    if (!shown.length) status.textContent = term ? 'Vi hittar inget namn som matchar. Kontrollera stavningen, eller kommentera inlägget på Instagram för att komma med.' : 'Inga namn att visa.';
    else if (term || filter !== 'all') status.textContent = shown.length === 1 ? '1 namn visas.' : shown.length + ' namn visas.';
    else status.textContent = '';
  }

  document.querySelectorAll('[data-giveaway-filter]').forEach(button => button.addEventListener('click', () => {
    filter = button.dataset.giveawayFilter;
    document.querySelectorAll('[data-giveaway-filter]').forEach(b => b.setAttribute('aria-pressed', String(b === button)));
    render();
  }));
  search.addEventListener('input', render);
  const form = search.closest('form');
  if (form) form.addEventListener('submit', event => event.preventDefault());

  async function load() {
    try {
      const response = await fetch('/api/giveaway', { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error('fel');
      const data = await response.json();
      entries = Array.isArray(data.entries) ? data.entries.filter(e => e && typeof e.u === 'string') : [];
      if (!data.published || !entries.length) {
        status.textContent = 'Listan är inte publicerad just nu. Titta in igen lite senare.';
        return;
      }
      const done = entries.filter(e => e.ok).length;
      const parts = [entries.length + ' deltagare', done + ' avklarade'];
      if (data.updatedAt) {
        const when = new Date(data.updatedAt);
        if (!Number.isNaN(when.getTime())) parts.push('uppdaterad ' + new Intl.DateTimeFormat('sv-SE', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Stockholm' }).format(when));
      }
      summary.textContent = parts.join(' · ');
      $('giveaway-tools').hidden = false;
      render();
    } catch {
      status.textContent = 'Listan kunde inte hämtas just nu. Försök igen om en stund.';
    }
  }
  load();
})();
