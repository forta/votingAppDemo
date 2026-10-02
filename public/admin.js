'use strict';

(async () => {
  const $ = id => document.getElementById(id);
  const lang = window.AppClient.i18n.getCurrentLanguage();
  const text = await fetch(`/games/whattheshell/whattheshell_${lang}.json`).then(response => response.json());
  const t = (key, values = {}) => Object.entries(values).reduce((value, [name, replacement]) => value.replaceAll(`{${name}}`, replacement), text[key] || key);
  document.documentElement.lang = lang;
  document.querySelectorAll('[data-admin-i18n]').forEach(element => { element.textContent = t(element.dataset.adminI18n); });

  async function request(path, body) {
    const response = await fetch(path, { method: body ? 'POST' : 'GET', credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const result = await response.json();
    if (!response.ok) { const error = new Error(result.code || text.adminFailed); error.status = response.status; throw error; }
    return result;
  }
  function showWorkspace() { $('login').hidden = true; $('workspace').hidden = false; $('logout').hidden = false; }
  function showLogin() { $('login').hidden = false; $('workspace').hidden = true; $('logout').hidden = true; }
  async function loadSlots(sequenceId) {
    const result = await request(`/admin/slots?seq=${encodeURIComponent(sequenceId)}`);
    const container = $('slot-rows'); container.replaceChildren();
    const rows = [...(result.slots || [])].sort((a, b) => a.slotNumber - b.slotNumber);
    for (let index = 0; index < 5; index++) {
      const row = rows.find(item => item.slotNumber === index + 1) || {};
      const fieldset = document.createElement('fieldset');
      const legend = document.createElement('legend'); legend.textContent = t('adminSlot', { n: index + 1 }); fieldset.append(legend);
      const info = document.createElement('p'); info.textContent = row.surrogateUserId ? `${t('adminExistingMapping')}: ${row.surrogateUserId}` : ''; fieldset.append(info);
      const account = document.createElement('label'); account.textContent = t('adminSurrogateAccount');
      const accountInput = document.createElement('input'); accountInput.name = 'surrogateUserId'; accountInput.required = true; accountInput.maxLength = 150; accountInput.value = row.surrogateUserId || ''; accountInput.readOnly = Boolean(row.surrogateUserId); account.append(accountInput); fieldset.append(account);
      const alias = document.createElement('label'); alias.textContent = t('adminReservedAlias');
      const aliasInput = document.createElement('input'); aliasInput.name = 'reservedAlias'; aliasInput.maxLength = 60; aliasInput.value = row.reserved ? row.alias || '' : ''; alias.append(aliasInput); fieldset.append(alias);
      const pin = document.createElement('label'); pin.textContent = t('adminReservedPin');
      const pinInput = document.createElement('input'); pinInput.name = 'reservedPin'; pinInput.inputMode = 'numeric'; pinInput.pattern = '[0-9]{4}'; pinInput.maxLength = 4; pinInput.autocomplete = 'new-password'; pin.append(pinInput); fieldset.append(pin);
      container.append(fieldset);
    }
    $('slots-form').hidden = false; $('status').textContent = t('adminLoaded');
  }
  $('login').onsubmit = async event => {
    event.preventDefault();
    try { await request('/admin/login', { password: $('password').value }); $('password').value = ''; showWorkspace(); $('status').textContent = ''; }
    catch (error) { $('status').textContent = error.status === 401 ? t('adminWrongPassword') : t('adminFailed'); }
  };
  $('logout').onclick = async () => { try { await request('/admin/logout', {}); } finally { showLogin(); } };
  $('sequence-form').onsubmit = async event => {
    event.preventDefault();
    try { await loadSlots($('sequence-id').value.trim()); }
    catch { $('slots-form').hidden = true; $('status').textContent = t('adminFailed'); }
  };
  $('slots-form').onsubmit = async event => {
    event.preventDefault();
    const slots = [...$('slot-rows').querySelectorAll('fieldset')].map(fieldset => Object.fromEntries([...fieldset.querySelectorAll('input')].map(input => [input.name, input.value.trim()])));
    try { await request('/admin/slots', { sequenceId: $('sequence-id').value.trim(), slots }); $('status').textContent = t('adminSaved'); await loadSlots($('sequence-id').value.trim()); }
    catch { $('status').textContent = t('adminFailed'); }
  };
  request('/admin/games').then(() => showWorkspace()).catch(() => showLogin());
})();
