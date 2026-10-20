'use strict';

/* Generic game discovery page: filter supported game integrations or open a
 * specific sequence, optionally preserving its access code for this session. */
const translations = {
  es: {
    signedInAs: 'Sesión: {name}', title: 'Explorar partidas', gamesLink: 'Juegos', gamesBack: 'Volver a los juegos', languageLabel: 'Idioma',
    intro: 'Elige un tipo de juego o explora todas las partidas disponibles.',
    loading: 'Cargando partidas…', refresh: 'Actualizar lista',
    empty: 'No hay partidas disponibles ahora.',
    emptyOpenable: 'No hay partidas que se puedan abrir. Hay partidas no recuperables ocultas.',
    connect: 'Abrir partida', showUnavailable: 'Mostrar partidas no disponibles',
    hideUnavailable: 'Ocultar partidas no disponibles',
    notRecoverable: 'No hay un estado de juego compatible para recuperar esta secuencia.',
    stateUnavailable: 'No se puede abrir en este estado.',
    error: 'No se pudo cargar la lista de partidas.',
    typeLabel: 'Tipo de juego', allTypes: 'Todos los juegos'
  },
  en: {
    signedInAs: 'Signed in as {name}', title: 'Explore games', gamesLink: 'Games', gamesBack: 'Back to games', languageLabel: 'Language',
    intro: 'Choose a game type or browse all available games.',
    loading: 'Loading games…', refresh: 'Refresh list',
    empty: 'No games are available right now.',
    emptyOpenable: 'There are no games you can open. Unrecoverable games are hidden.',
    connect: 'Open game', showUnavailable: 'Show unavailable games',
    hideUnavailable: 'Hide unavailable games',
    notRecoverable: 'No compatible game checkpoint is available for this sequence.',
    stateUnavailable: 'This sequence cannot be opened in its current state.',
    error: 'Could not load the game list.',
    typeLabel: 'Game type', allTypes: 'All games'
  },
  eo: {
    signedInAs: 'Ensalutinta kiel {name}', title: 'Esplori ludojn', gamesLink: 'Ludoj', gamesBack: 'Reen al ludoj', languageLabel: 'Lingvo',
    intro: 'Elektu ludspecon aŭ esploru ĉiujn disponeblajn ludojn.',
    loading: 'Ŝargante ludojn…', refresh: 'Ĝisdatigi liston',
    empty: 'Neniuj ludoj disponeblas nun.',
    emptyOpenable: 'Ne estas ludoj malfermeblaj. Nereakireblaj ludoj estas kaŝitaj.',
    connect: 'Malfermi ludon', showUnavailable: 'Montri ne disponeblajn ludojn',
    hideUnavailable: 'Kaŝi ne disponeblajn ludojn',
    notRecoverable: 'Ne ekzistas kongrua ludkontrolpunkto por restarigi ĉi tiun sinsekvon.',
    stateUnavailable: 'La sinsekvo ne povas malfermiĝi en sia nuna stato.',
    error: 'Ne eblis ŝargi la ludliston.',
    typeLabel: 'Ludspeco', allTypes: 'Ĉiuj ludoj'
  }
};

const language = document.getElementById('language');
const query = new URLSearchParams(location.search);
const supportedTypes = new Set(['whattheshell', 'ink']);
let selectedType = supportedTypes.has(query.get('type')) ? query.get('type') : '';
const requestedLanguage = query.get('lang');
language.value = ['es', 'en', 'eo'].includes(requestedLanguage)
  ? requestedLanguage : (localStorage.getItem('game-player-language') || 'es');
if (['es', 'en', 'eo'].includes(requestedLanguage)) localStorage.setItem('game-player-language', requestedLanguage);
language.onchange = () => {
  localStorage.setItem('game-player-language', language.value);
  renderText();
  loadGames();
};
const t = key => translations[language.value]?.[key] || translations.es[key];
const showUnavailableKey = 'game-player-show-unavailable';
let showUnavailable = localStorage.getItem(showUnavailableKey) === 'true';
let allGames = [];

function renderAccount() {
  const token = localStorage.getItem('voting_app_token') || localStorage.getItem('voting_platform_token') || localStorage.getItem('koncenso_token');
  const storedUser = localStorage.getItem('voting_app_user') || localStorage.getItem('voting_platform_user') || localStorage.getItem('kunsido_user');
  const account = document.getElementById('account-name');
  account.hidden = true;
  if (!token || !storedUser) return;
  try {
    const user = JSON.parse(storedUser);
    const name = user?.alias || user?.name || user?.email || user?.id;
    if (!name) return;
    account.textContent = t('signedInAs').replace('{name}', name);
    account.hidden = false;
  } catch {}
}

function renderText() {
  document.documentElement.lang = language.value;
  document.title = t('title') + ' · Kunsido';
  renderAccount();
  document.getElementById('games-link').textContent = t('gamesLink');
  document.getElementById('games-footer-link').textContent = t('gamesBack');
  document.querySelector('.language span').textContent = t('languageLabel');
  language.setAttribute('aria-label', t('languageLabel'));
  document.getElementById('title').textContent = t('title');
  document.getElementById('intro').textContent = t('intro');
  document.getElementById('refresh').textContent = t('refresh');
  document.getElementById('game-type-label').textContent = t('typeLabel');
  document.querySelector('#game-type option[value=""]').textContent = t('allTypes');
  renderGames(allGames);
}

function renderGames(games) {
  allGames = games;
  const list = document.getElementById('games');
  list.replaceChildren();
  const matchingGames = selectedType ? games.filter(game => game.functionalityId === selectedType) : games;
  const unavailable = matchingGames.filter(game => !game.canConnect);
  const toggle = document.getElementById('toggle-unavailable');
  toggle.hidden = unavailable.length === 0;
  toggle.textContent = t(showUnavailable ? 'hideUnavailable' : 'showUnavailable');
  const visibleGames = showUnavailable ? matchingGames : matchingGames.filter(game => game.canConnect);
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
    detail.textContent = game.functionalityId + ' · ' + game.state + ' · ' + game.seqId;
    let action;
    let reason = null;
    if (game.canConnect) {
      action = document.createElement('a');
      action.href = '?seq=' + encodeURIComponent(game.seqId) + '&runner=multibot';
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
    const response = await fetch('cli/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'games list' })
    });
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.error || t('error'));
    renderGames(result.data?.games || []);
    status.textContent = '';
  } catch (error) {
    document.getElementById('games').replaceChildren();
    status.textContent = error.message || t('error');
    document.getElementById('indicator').classList.add('error');
  }
}

document.getElementById('game-type').value = selectedType;
document.getElementById('game-type').onchange = event => {
  selectedType = supportedTypes.has(event.target.value) ? event.target.value : '';
  const next = new URL(location.href);
  if (selectedType) next.searchParams.set('type', selectedType);
  else next.searchParams.delete('type');
  history.replaceState(null, '', next);
  renderGames(allGames);
};
document.getElementById('refresh').onclick = loadGames;
document.getElementById('toggle-unavailable').onclick = () => {
  showUnavailable = !showUnavailable;
  localStorage.setItem(showUnavailableKey, String(showUnavailable));
  renderGames(allGames);
};
renderText();
loadGames();
