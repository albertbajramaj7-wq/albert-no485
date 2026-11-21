(() => {
  'use strict';
  // Tävlingslistan: hämtar Instagram-namn och status från /api/giveaway och låter besökaren söka sitt namn.
  const $ = id => document.getElementById(id);
  const list = $('giveaway-list'), search = $('giveaway-search'), status = $('giveaway-status'), summary = $('giveaway-summary');
  if (!list || !search) return;
  // Vad som är kvar att göra, i samma ordning som stegen på sidan.
  const steps = [['story', 'Dela inlägget i din story och tagga oss'], ['tag', 'Tagga en vän i kommentarerna'], ['follow', 'Följ oss på Instagram']];
  let entries = [], filter = 'all';
  const clean = value => String(value || '').toLowerCase().replace(/[@\s]/g, '');
  const el = (tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = text; return node; };

  function row(entry) {
    const double = entry.ok && entry.x2;
    const item = el('li', double ? 'is-double' : entry.ok ? 'is-ok' : 'is-missing');
    const info = el('div', 'giveaway-who');
    info.append(el('span', 'giveaway-name', '@' + entry.u));
    if (!entry.ok) {
      const left = steps.filter(([code]) => (entry.miss || []).includes(code)).map(([, label]) => label);
      info.append(el('span', 'giveaway-todo', left.length ? 'Kvar att göra: ' + left.join('. ') + '.' : 'Något saknas. Skriv till oss på Instagram så hjälper vi dig.'));
      if (entry.x2) info.append(el('span', 'giveaway-todo giveaway-extra', 'Kvittot för dubbel chans har vi fått.'));
    }
    item.append(info, el('span', 'giveaway-mark', double ? 'Dubbel chans' : entry.ok ? 'Avklarat' : 'Ej avklarat'));
    return item;
  }

  function matches(entry) {
    if (filter === 'ok') return entry.ok;
    if (filter === 'missing') return !entry.ok;
    if (filter === 'double') return entry.ok && entry.x2;
    return true;
  }

  function render() {
    const term = clean(search.value);
    const shown = entries.filter(e => matches(e) && (!term || e.u.includes(term)));
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
      const parts = [entries.length + ' deltagare', entries.filter(e => e.ok).length + ' avklarade', entries.filter(e => e.ok && e.x2).length + ' med dubbel chans'];
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
