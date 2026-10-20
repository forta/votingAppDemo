'use strict';

(() => {
  const key = 'voting_app_theme';
  const labels = {
    es: { dark: 'Activar fondo oscuro', light: 'Activar fondo claro' },
    en: { dark: 'Switch to dark background', light: 'Switch to light background' },
    eo: { dark: 'Ŝalti malhelan fonon', light: 'Ŝalti helan fonon' }
  };

  function update(button) {
    const theme = localStorage.getItem(key) === 'dark' ? 'dark' : 'light';
    document.documentElement.dataset.theme = theme;
    const language = document.documentElement.lang || 'es';
    const next = theme === 'dark' ? 'light' : 'dark';
    button.innerHTML = theme === 'dark'
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42"></path></svg>'
      : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.2 15.5A8.5 8.5 0 0 1 8.5 3.8 8.6 8.6 0 1 0 20.2 15.5Z"></path></svg>';
    button.setAttribute('aria-label', (labels[language] || labels.en)[next]);
    button.title = (labels[language] || labels.en)[next];
    button.setAttribute('aria-pressed', String(theme === 'dark'));
  }

  document.addEventListener('DOMContentLoaded', () => {
    const header = document.querySelector('header');
    if (!header) return;
    let button = header.querySelector('[data-theme-toggle]');
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'theme-toggle';
      button.dataset.themeToggle = '';
      header.append(button);
    }
    update(button);
    button.addEventListener('click', () => {
      localStorage.setItem(key, document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
      update(button);
    });
    document.getElementById('language')?.addEventListener('change', () => update(button));
  });
})();
