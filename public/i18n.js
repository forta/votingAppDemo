(function () {
  'use strict';
  const supported = ['en', 'es', 'eo'];
  const storageKey = 'whattheshell:language';
  function getCurrentLanguage() {
    const candidates = [new URLSearchParams(location.search).get('lang'), localStorage.getItem(storageKey), navigator.language?.split('-')[0]];
    return candidates.find(value => supported.includes(value)) || 'en';
  }
  function setLanguage(lang) {
    if (!supported.includes(lang)) return;
    localStorage.setItem(storageKey, lang);
    const url = new URL(location.href);
    url.searchParams.set('lang', lang);
    location.href = url.toString();
  }
  window.AppClient = { i18n: { getCurrentLanguage, setLanguage } };
})();
