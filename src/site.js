(() => {
  'use strict';
  const toggle = document.querySelector('.nav-toggle');
  const nav = document.querySelector('.navlinks');
  const closeNav = () => {
    nav?.classList.remove('open');
    toggle?.setAttribute('aria-expanded', 'false');
  };
  toggle?.addEventListener('click', () => {
    const open = nav.classList.toggle('open');
    toggle.setAttribute('aria-expanded', String(open));
  });
  nav?.querySelectorAll('a').forEach(a => a.addEventListener('click', closeNav));
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && nav?.classList.contains('open')) {
      closeNav();
      toggle.focus();
    }
  });
  matchMedia('(min-width:761px)').addEventListener('change', closeNav);
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  const selectTab = tab => tabs.forEach(item => {
    const selected = item === tab;
    item.setAttribute('aria-selected', String(selected));
    item.tabIndex = selected ? 0 : -1;
    document.getElementById(item.getAttribute('aria-controls')).hidden = !selected;
  });
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => selectTab(tab));
    tab.addEventListener('keydown', event => {
      let next;
      if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
      else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = tabs.length - 1;
      else return;
      event.preventDefault();
      selectTab(tabs[next]);
      tabs[next].focus();
    });
  });
  const filters = document.querySelectorAll('[data-menu-filter]');
  filters.forEach(button => button.addEventListener('click', () => {
    filters.forEach(item => item.setAttribute('aria-pressed', String(item === button)));
    document.querySelectorAll('[data-menu-category]').forEach(section => {
      section.hidden = button.dataset.menuFilter !== 'all' && section.dataset.menuCategory !== button.dataset.menuFilter;
    });
  }));
  document.getElementById('print-menu')?.addEventListener('click', () => window.print());
  const dialog = document.querySelector('dialog');
  if (dialog) {
    let previousFocus;
    document.querySelectorAll('[data-image]').forEach(button => button.addEventListener('click', () => {
      previousFocus = button;
      const large = document.getElementById('large-image');
      large.src = button.dataset.image;
      large.alt = button.querySelector('img').alt;
      document.getElementById('image-caption').textContent = button.dataset.caption;
      dialog.showModal();
      document.body.classList.add('locked');
    }));
    document.getElementById('close-image')?.addEventListener('click', () => dialog.close());
    dialog.addEventListener('click', event => {
      if (event.target !== dialog) return;
      const r = dialog.getBoundingClientRect();
      if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close();
    });
    dialog.addEventListener('close', () => {
      document.body.classList.remove('locked');
      previousFocus?.focus();
    });
  }
  const book = document.querySelector('.mobile-book');
  const hero = document.querySelector('.hero, .page-intro');
  if (book && hero && !document.body.classList.contains('booking-page')) {
    new IntersectionObserver(([entry]) => book.classList.toggle('visible', !entry.isIntersecting)).observe(hero);
  }
  const year = document.getElementById('year');
  if (year) year.textContent = new Date().getFullYear();
})();
