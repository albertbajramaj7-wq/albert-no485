(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm' }).format(new Date());
  const last = new Date(today + 'T12:00:00Z'); last.setUTCDate(last.getUTCDate() + 30);
  $('booking-date').min = today; $('booking-date').max = last.toISOString().slice(0, 10); $('booking-date').value = today;
  const readable = date => new Intl.DateTimeFormat('sv-SE', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(date + 'T12:00:00Z'));
  let mode = 'here', selected, availability, serial = 0, busy = false, uncertain = false, snapshot, key = crypto.randomUUID(), confirmation;
  function el(tag, text, cls) { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (cls) node.className = cls; return node; }
  const values = () => ({ date: $('booking-date').value, count: Number($('pizza-count').value), mode, guests: mode === 'here' ? Number($('guest-count').value) : 0 });
  function error(message) { $('booking-error').textContent = message; $('booking-error').hidden = !message; }
  function step(value) {
    document.querySelectorAll('[data-step]').forEach(panel => panel.hidden = Number(panel.dataset.step) !== value);
    document.querySelectorAll('[data-progress]').forEach(label => { if (Number(label.dataset.progress) === Math.min(value, 3)) label.setAttribute('aria-current', 'step'); else label.removeAttribute('aria-current'); });
    const heading = document.querySelector('[data-step="' + value + '"] h2'); heading.tabIndex = -1; heading.focus({ preventScroll: true });
    $('boka').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion:reduce)').matches ? 'instant' : 'smooth', block: 'start' });
  }
  async function loadAvailability() {
    const current = ++serial; selected = undefined; $('to-contact').disabled = true; $('available-times').replaceChildren(); error('');
    const v = values(); if (!v.date) { $('availability-status').textContent = 'Välj vilken dag du vill komma.'; return; }
    $('availability-status').textContent = 'Hämtar lediga tider.';
    try {
      const response = await fetch('/api/availability?' + new URLSearchParams(Object.entries(v).map(([k, v]) => [k, String(v)])), { cache: 'no-store' });
      const result = await response.json(); if (current !== serial) return;
      if (!response.ok) throw new Error(result.error || 'Tiderna kunde inte hämtas.');
      availability = result;
      if (result.closed) $('availability-status').textContent = 'Vi har stängt den här dagen. Välj onsdag–söndag.';
      else if (result.paused) $('availability-status').textContent = 'Bokningen är pausad den här dagen. Välj en annan dag eller ring oss.';
      else if (!result.slots.some(slot => slot.bookable)) $('availability-status').textContent = 'Inga lediga tider för ditt val. Prova en annan dag eller ring oss.';
      else $('availability-status').textContent = 'Välj när pizzorna ska vara färdiga. Kom tio minuter tidigare.';
      renderSlots();
    } catch (e) { if (current === serial) { $('availability-status').textContent = ''; error(e.message + ' Ring 0340–827 75 om du behöver hjälp.'); } }
  }
  function renderSlots() {
    const root = $('available-times'); root.replaceChildren();
    for (const [title, rows] of [['Lunch', availability.slots.filter(s => s.minute < 900)], ['Kväll', availability.slots.filter(s => s.minute >= 900)]]) {
      if (!rows.length) continue;
      root.append(el('p', title + ' / Färdigtider', 'slot-group-label')); const group = el('div', undefined, 'slots');
      rows.forEach(slot => {
        const button = el('button'); button.type = 'button'; button.disabled = !slot.bookable; button.setAttribute('aria-pressed', String(slot.time === selected?.time));
        button.append(el('strong', slot.time), el('small', slot.bookable ? slot.remaining + ' pizzor kvar' : 'Ej tillgänglig'));
        button.addEventListener('click', () => { selected = slot; $('to-contact').disabled = false; renderSlots(); }); group.append(button);
      }); root.append(group);
    }
  }
  document.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => {
    mode = button.dataset.mode; document.querySelectorAll('[data-mode]').forEach(b => b.setAttribute('aria-pressed', String(b === button))); $('guest-field').hidden = mode === 'away'; loadAvailability();
  }));
  ['booking-date', 'pizza-count', 'guest-count'].forEach(id => $(id).addEventListener('change', loadAvailability));
  document.querySelectorAll('[data-jump-booking]').forEach(button => button.addEventListener('click', () => $('boka').scrollIntoView({ behavior: 'smooth' })));
  $('to-contact').addEventListener('click', () => { if (!selected) return; const v = values(); $('selected-summary').textContent = readable(v.date) + ' · ' + selected.time + ' · ' + v.count + ' pizzor · ' + (mode === 'here' ? 'Äta här, ' + v.guests + ' gäster' : 'Ta med'); step(2); });
  document.querySelectorAll('[data-back]').forEach(button => button.addEventListener('click', () => { if (!busy && !uncertain) { error(''); step(Number(button.dataset.back)); } }));
  $('guest-form').addEventListener('submit', event => {
    event.preventDefault(); if (!$('guest-form').reportValidity()) return;
    const phone = $('guest-phone').value.trim(); if (!/^(?:\+|00)?[0-9\s().-]{8,24}$/.test(phone)) { error('Skriv ett giltigt telefonnummer.'); $('guest-phone').focus(); return; }
    snapshot = { ...values(), time: selected.time, contact: { name: $('guest-name').value.trim(), email: $('guest-email').value.trim(), phone }, website: $('guest-website').value, accepted: true };
    const t = selected.minute, format = min => String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0');
    const rows = [['Datum', readable(snapshot.date)], ['Färdigtid', snapshot.time], ['Kom senast', format(t - 10)], ['Antal pizzor', snapshot.count], ['Hos oss', mode === 'here' ? 'Äta här · ' + snapshot.guests + ' gäster' : 'Ta med'], ...(mode === 'here' ? [['Sittning', format(t - 10) + '–' + format(t + 50)]] : []), ['Namn', snapshot.contact.name], ['E-post', snapshot.contact.email], ['Telefon', snapshot.contact.phone]];
    $('booking-review').replaceChildren(); rows.forEach(([name, value]) => { const row = el('div'); row.append(el('dt', name), el('dd', value)); $('booking-review').append(row); });
    $('agreement-text').textContent = mode === 'here' ? 'Jag kommer tio minuter före färdigtiden. Sittningen är 60 minuter från ankomsten.' : 'Jag kommer tio minuter före färdigtiden och väljer pizza på plats.';
    $('booking-accepted').checked = false; $('confirm-booking').disabled = true; error(''); step(3);
  });
  $('booking-accepted').addEventListener('change', () => { $('confirm-booking').disabled = busy || !$('booking-accepted').checked; });
  $('confirm-booking').addEventListener('click', async () => {
    if (busy || !snapshot || !$('booking-accepted').checked) return;
    busy = true; $('confirm-booking').disabled = true; $('confirm-booking').textContent = uncertain ? 'Kontrollerar bokningen.' : 'Sparar din bokning.'; error('');
    document.querySelectorAll('[data-back]').forEach(button => button.disabled = true);
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 25000);
    try {
      const response = await fetch('/api/bookings', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(snapshot), signal: controller.signal });
      const result = await response.json();
      if (!response.ok) { const e = new Error(result.error || 'Bokningen kunde inte sparas.'); e.status = response.status; throw e; }
      confirmation = result; $('confirmation-date').textContent = readable(result.date); $('confirmation-time').textContent = result.time; $('confirmation-arrival').textContent = 'Kom senast ' + result.arrival + '.';
      $('confirmation-details').textContent = result.count + ' pizzor · ' + (result.mode === 'here' ? result.guests + ' gäster · sittning ' + result.arrival + '–' + result.sittingEnd : 'Ta med') + '. Välj pizza och betala på plats.';
      $('confirmation-id').textContent = 'Bokningsnummer: ' + result.id; step(4);
      const mail = result.email?.status;
      $('confirmation-email').textContent = mail === 'sent' ? 'En bekräftelse har skickats till ' + snapshot.contact.email + '. Kontrollera även skräpposten.' : ['sending', 'pending'].includes(mail) ? 'Din bokning är sparad. Mejlbekräftelsen är ännu inte bekräftad, så spara gärna bekräftelsen nedan.' : mail === 'uncertain' ? 'Din bokning är sparad. Vi kunde inte bekräfta mejlutskicket. Spara bekräftelsen nedan.' : 'Din bokning är sparad. Mejlbekräftelse kunde inte skickas, så spara bekräftelsen nedan.';
    } catch (e) {
      uncertain = !e.status || e.status >= 500;
      if (uncertain) error('Bokningen kan ha sparats. Tryck Kontrollera bokningen för att kontrollera samma bokning. Gör inte en ny bokning. Ring 0340–827 75 om du behöver hjälp.');
      else if (e.status === 409) { step(1); await loadAvailability(); error(e.message); }
      else error(e.message);
    } finally {
      clearTimeout(timer); busy = false; $('confirm-booking').textContent = uncertain ? 'Kontrollera bokningen' : 'Bekräfta bokningen'; $('confirm-booking').disabled = !$('booking-accepted').checked;
      document.querySelectorAll('[data-back]').forEach(button => button.disabled = uncertain);
    }
  });
  $('save-confirmation').addEventListener('click', () => {
    if (!confirmation) return;
    const content = ['Albert NO.485', 'Pilgatan 3, Varberg', '', readable(confirmation.date), 'Färdigtid: ' + confirmation.time, $('confirmation-arrival').textContent, $('confirmation-details').textContent, '', 'Bokningsnummer: ' + confirmation.id, 'Ändring eller avbokning: 0340–827 75'].join('\n');
    const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' })), link = el('a'); link.href = url; link.download = 'Albert-bokning-' + confirmation.date + '.txt'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  loadAvailability();
})();
