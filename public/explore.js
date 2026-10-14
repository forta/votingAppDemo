'use strict';

/* Generic game discovery page: list integration-backed games or open a
 * sequence ID directly, optionally retaining its access code for the session. */

const translations = {
  es: { title: 'Explorar partidas', intro: 'Elige una secuencia disponible para conectarte y jugar.', loading: 'Cargando partidas…', refresh: 'Actualizar lista', empty: 'No hay partidas disponibles ahora.', emptyOpenable: 'No hay partidas que se puedan abrir. Hay partidas no recuperables ocultas.', connect: 'Abrir partida', showUnavailable: 'Mostrar partidas no disponibles', hideUnavailable: 'Ocultar partidas no disponibles', notRecoverable: 'No hay un estado de juego compatible para recuperar esta secuencia.', stateUnavailable: 'No se puede abrir en este estado.', error: 'No se pudo cargar la lista de partidas.', seqLabel: 'O indica el ID de una secuencia', secretLabel: 'Código de acceso (si te lo han dado)', openSequence: 'Abrir secuencia' },
  en: { title: 'Explore games', intro: 'Choose an available sequence to connect and play.', loading: 'Loading games…', refresh: 'Refresh list', empty: 'No games are available right now.', emptyOpenable: 'There are no games you can open. Unrecoverable games are hidden.', connect: 'Open game', showUnavailable: 'Show unavailable games', hideUnavailable: 'Hide unavailable games', notRecoverable: 'No compatible game checkpoint is available for this sequence.', stateUnavailable: 'This sequence cannot be opened in its current state.', error: 'Could not load the game list.', seqLabel: 'Or enter a sequence ID', secretLabel: 'Access code (if provided)', openSequence: 'Open sequence' },
  eo: { title: 'Esplori ludojn', intro: 'Elektu disponeblan sinsekvon por konektiĝi kaj ludi.', loading: 'Ŝargante ludojn…', refresh: 'Ĝisdatigi liston', empty: 'Neniuj ludoj disponeblas nun.', emptyOpenable: 'Ne estas ludoj malfermeblaj. Nereakireblaj ludoj estas kaŝitaj.', connect: 'Malfermi ludon', showUnavailable: 'Montri ne disponeblajn ludojn', hideUnavailable: 'Kaŝi ne disponeblajn ludojn', notRecoverable: 'Ne ekzistas kongrua ludkontrolpunkto por restarigi ĉi tiun sinsekvon.', stateUnavailable: 'La sinsekvo ne povas malfermiĝi en sia nuna stato.', error: 'Ne eblis ŝargi la ludliston.', seqLabel: 'Aŭ enigu sinsekvan identigilon', secretLabel: 'Alirkodo (se donita)', openSequence: 'Malfermi sinsekvon' }
};
const language = document.getElementById('language');
language.value = localStorage.getItem('game-player-language') || 'es';
language.onchange = () => { localStorage.setItem('game-player-language', language.value); renderText(); loadGames(); };
const t = key => translations[language.value]?.[key] || translations.es[key];
const showUnavailableKey = 'game-player-show-unavailable';
let showUnavailable = localStorage.getItem(showUnavailableKey) === 'true';
let allGames = [];
function renderText() {
  document.documentElement.lang = language.value;
  document.title = `${t('title')} · Kunsido`;
  document.getElementById('title').textContent = t('title');
  document.getElementById('intro').textContent = t('intro');
  document.getElementById('refresh').textContent = t('refresh');
  document.getElementById('sequence-id-label').textContent = t('seqLabel');
  document.getElementById('access-secret-label').textContent = t('secretLabel');
  document.getElementById('open-sequence').textContent = t('openSequence');
  renderGames(allGames);
}
function renderGames(games) {
  allGames = games;
  const list = document.getElementById('games');
  list.replaceChildren();
  const unavailable = games.filter(game => !game.canConnect);
  const toggle = document.getElementById('toggle-unavailable');
  toggle.hidden = unavailable.length === 0;
  toggle.textContent = t(showUnavailable ? 'hideUnavailable' : 'showUnavailable');
  const visibleGames = showUnavailable ? games : games.filter(game => game.canConnect);
  if (!visibleGames.length) {
    list.textContent = unavailable.length ? t('emptyOpenable') : t('empty');
    return;
  }
  for (const game of visibleGames) {
    const card = document.createElement('article');
    card.className = 'game-card';
    const heading = document.createElement('h2');
    const name = document.createElement('span');
    name.textContent = game.name || game.seqId;
    heading.append(name);
    const createdAt = game.createdAt ? new Date(game.createdAt) : null;
    if (createdAt && Number.isFinite(createdAt.getTime())) {
      const date = document.createElement('time');
      date.className = 'created-at';
      date.dateTime = createdAt.toISOString();
      try {
        const locale = { es: 'es-ES', en: 'en-GB', eo: 'eo' }[language.value] || 'es-ES';
        date.textContent = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(createdAt);
      } catch {
        date.textContent = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(createdAt);
      }
      heading.append(date);
    }
    const detail = document.createElement('p');
    detail.className = 'meta';
    detail.textContent = `${game.functionalityId} · ${game.state} · ${game.seqId}`;
    let action;
    let reason = null;
    if (game.canConnect) {
      action = document.createElement('a');
      action.href = `?seq=${encodeURIComponent(game.seqId)}&runner=multibot`;
    } else {
      action = document.createElement('button');
      action.type = 'button';
      action.disabled = true;
      reason = document.createElement('p');
      reason.className = 'meta';
      reason.textContent = t(game.unavailableReason === 'not-recoverable' ? 'notRecoverable' : 'stateUnavailable');
    }
    action.className = 'button';
    action.textContent = t('connect');
    card.append(heading, detail);
    if (reason) card.append(reason);
    card.append(action);
    list.append(card);
  }
}
async function loadGames() {
  const status = document.getElementById('status');
  status.textContent = t('loading');
  document.getElementById('indicator').classList.remove('error');
  try {
    const response = await fetch('api/games', { cache: 'no-store' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || t('error'));
    renderGames(result.games || []);
    status.textContent = '';
  } catch (error) {
    document.getElementById('games').replaceChildren();
    status.textContent = error.message || t('error');
    document.getElementById('indicator').classList.add('error');
  }
}
document.getElementById('refresh').onclick = loadGames;
document.getElementById('toggle-unavailable').onclick = () => {
  showUnavailable = !showUnavailable;
  localStorage.setItem(showUnavailableKey, String(showUnavailable));
  renderGames(allGames);
};
document.getElementById('direct-game-form').addEventListener('submit', event => {
  event.preventDefault();
  const seqId = document.getElementById('sequence-id').value.trim();
  const secret = document.getElementById('access-secret').value.trim().toUpperCase();
  if (!seqId) return;
  if (secret) sessionStorage.setItem(`sequence-play:${seqId}:access`, secret);
  location.href = `?seq=${encodeURIComponent(seqId)}`;
});
renderText();
loadGames();
