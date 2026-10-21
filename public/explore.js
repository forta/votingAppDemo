'use strict';

/* Generic game discovery page: filter supported game integrations or open a
 * specific sequence, optionally preserving its access code for this session. */
const translations = {
  es: {
    signedInAs: 'Sesión: {name}', title: 'Explorar partidas', gamesLink: 'Juegos', gamesBack: 'Volver a los juegos', languageLabel: 'Idioma',
    searchLabel: 'Filtrar por nombre', searchPlaceholder: 'Escribe el nombre de una secuencia', pageSizeLabel: 'Partidas por página', previous: 'Anterior', next: 'Siguiente', pageStatus: 'Página {page}',
    intro: 'Elige un tipo de juego o explora todas las partidas disponibles.',
    loading: 'Cargando partidas…', refresh: 'Actualizar lista',
    empty: 'No hay partidas disponibles ahora.', emptySearch: 'Ninguna partida coincide con los filtros.', emptyStates: 'Selecciona al menos un estado.',
    emptyOpenable: 'No hay partidas que se puedan abrir. Hay partidas no recuperables ocultas.',
    connect: 'Abrir partida', showUnavailable: 'Mostrar partidas no disponibles',
    hideUnavailable: 'Ocultar partidas no disponibles',
    notRecoverable: 'No hay un estado de juego compatible para recuperar esta secuencia.',
    stateUnavailable: 'No se puede abrir en este estado.',
    error: 'No se pudo cargar la lista de partidas.',
    typeLabel: 'Tipo de juego', allTypes: 'Todos los juegos', stateLabel: 'Estado', state_waiting: 'Sin iniciar', state_playing: 'En curso', state_paused: 'Pausada', state_finished: 'Finalizada', state_unknown: 'Estado desconocido', copyId: 'Copiar identificador', idCopied: 'Identificador copiado', copyFailed: 'No se pudo copiar el identificador', untitledGame: 'Partida sin título'
  },
  en: {
    signedInAs: 'Signed in as {name}', title: 'Explore games', gamesLink: 'Games', gamesBack: 'Back to games', languageLabel: 'Language',
    searchLabel: 'Filter by name', searchPlaceholder: 'Type a sequence name', pageSizeLabel: 'Games per page', previous: 'Previous', next: 'Next', pageStatus: 'Page {page}',
    intro: 'Choose a game type or browse all available games.',
    loading: 'Loading games…', refresh: 'Refresh list',
    empty: 'No games are available right now.', emptySearch: 'No games match the current filters.', emptyStates: 'Select at least one status.',
    emptyOpenable: 'There are no games you can open. Unrecoverable games are hidden.',
    connect: 'Open game', showUnavailable: 'Show unavailable games',
    hideUnavailable: 'Hide unavailable games',
    notRecoverable: 'No compatible game checkpoint is available for this sequence.',
    stateUnavailable: 'This sequence cannot be opened in its current state.',
    error: 'Could not load the game list.',
    typeLabel: 'Game type', allTypes: 'All games', stateLabel: 'Status', state_waiting: 'Not started', state_playing: 'In progress', state_paused: 'Paused', state_finished: 'Finished', state_unknown: 'Unknown status', copyId: 'Copy sequence ID', idCopied: 'ID copied', copyFailed: 'Could not copy the ID', untitledGame: 'Untitled game'
  },
  eo: {
    signedInAs: 'Ensalutinta kiel {name}', title: 'Esplori ludojn', gamesLink: 'Ludoj', gamesBack: 'Reen al ludoj', languageLabel: 'Lingvo',
    searchLabel: 'Filtri laŭ nomo', searchPlaceholder: 'Tajpu sinsekvan nomon', pageSizeLabel: 'Ludoj en paĝo', previous: 'Antaŭa', next: 'Sekva', pageStatus: 'Paĝo {page}',
    intro: 'Elektu ludspecon aŭ esploru ĉiujn disponeblajn ludojn.',
    loading: 'Ŝargante ludojn…', refresh: 'Ĝisdatigi liston',
    empty: 'Neniuj ludoj disponeblas nun.', emptySearch: 'Neniu ludo kongruas kun la filtriloj.', emptyStates: 'Elektu almenaŭ unu staton.',
    emptyOpenable: 'Ne estas ludoj malfermeblaj. Nereakireblaj ludoj estas kaŝitaj.',
    connect: 'Malfermi ludon', showUnavailable: 'Montri ne disponeblajn ludojn',
    hideUnavailable: 'Kaŝi ne disponeblajn ludojn',
    notRecoverable: 'Ne ekzistas kongrua ludkontrolpunkto por restarigi ĉi tiun sinsekvon.',
    stateUnavailable: 'La sinsekvo ne povas malfermiĝi en sia nuna stato.',
    error: 'Ne eblis ŝargi la ludliston.',
    typeLabel: 'Ludspeco', allTypes: 'Ĉiuj ludoj', stateLabel: 'Stato', state_waiting: 'Ne komencita', state_playing: 'En progreso', state_paused: 'Paŭzita', state_finished: 'Finita', state_unknown: 'Nekonata stato', copyId: 'Kopii sinsekvan identigilon', idCopied: 'Identigilo kopiita', copyFailed: 'Ne eblis kopii la identigilon', untitledGame: 'Sentitola ludo'
  }
};

const language = document.getElementById('language');
const query = new URLSearchParams(location.search);
const supportedTypes = new Set(['whattheshell', 'ink']);
let selectedType = supportedTypes.has(query.get('type')) ? query.get('type') : '';
const allowedStates = ['waiting', 'playing', 'paused', 'finished'];
const defaultStates = ['waiting', 'playing', 'paused'];
const queryStates = (query.get('states') || query.get('state') || '').split(',').filter(state => allowedStates.includes(state));
let selectedStates = new Set(query.has('states') || query.has('state') ? queryStates : defaultStates);
const requestedLanguage = query.get('lang');
const allowedPageSizes = [10, 25, 50, 100];
let pageSize = allowedPageSizes.includes(Number(query.get('pageSize'))) ? Number(query.get('pageSize')) : 10;
let currentPage = Math.max(1, Number.parseInt(query.get('page'), 10) || 1);
let currentOffset = (currentPage - 1) * pageSize;
let searchValue = query.get('search') || '';
let hasMore = false;
let searchTimer = null;
let loadRequestId = 0;
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
  document.getElementById('search-label').textContent = t('searchLabel');
  document.getElementById('game-search').placeholder = t('searchPlaceholder');
  document.getElementById('game-search').setAttribute('aria-label', t('searchLabel'));
  document.getElementById('game-state-label').textContent = t('stateLabel');
  for (const state of allowedStates) document.querySelector(`[data-state-label="${state}"]`).textContent = t(`state_${state}`);
  document.getElementById('page-size-label').textContent = t('pageSizeLabel');
  document.getElementById('page-size').setAttribute('aria-label', t('pageSizeLabel'));
  document.getElementById('previous-page').textContent = t('previous');
  document.getElementById('next-page').textContent = t('next');
  document.querySelector('.language span').textContent = t('languageLabel');
  language.setAttribute('aria-label', t('languageLabel'));
  document.getElementById('title').textContent = t('title');
  document.getElementById('intro').textContent = t('intro');
  document.getElementById('refresh').textContent = t('refresh');
  document.getElementById('game-type-label').textContent = t('typeLabel');
  document.querySelector('#game-type option[value=""]').textContent = t('allTypes');
  renderGames({ games: allGames, hasMore });
}


async function writeClipboard(value) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value);
  const input = document.createElement('textarea');
  input.value = value;
  input.style.position = 'fixed';
  input.style.opacity = '0';
  document.body.append(input);
  input.select();
  const copied = document.execCommand('copy');
  input.remove();
  if (!copied) throw new Error('Clipboard copy failed');
}

function createCopyButton(seqId) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'copy-sequence-id';
  button.title = t('copyId');
  button.setAttribute('aria-label', t('copyId'));
  button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="13" rx="2"></rect><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h3"></path></svg>';
  button.onclick = async () => {
    try {
      await writeClipboard(seqId);
      button.title = t('idCopied');
      button.setAttribute('aria-label', t('idCopied'));
    } catch {
      button.title = t('copyFailed');
      button.setAttribute('aria-label', t('copyFailed'));
    }
    setTimeout(() => { button.title = t('copyId'); button.setAttribute('aria-label', t('copyId')); }, 1600);
  };
  return button;
}
function renderGames(result) {
  const games = Array.isArray(result) ? result : (result?.games || []);
  allGames = games;
  hasMore = Boolean(result?.hasMore);
  const pagination = document.getElementById('pagination');
  pagination.hidden = currentPage === 1 && !hasMore;
  document.getElementById('previous-page').disabled = currentPage <= 1;
  document.getElementById('next-page').disabled = !hasMore;
  document.getElementById('page-status').textContent = t('pageStatus').replace('{page}', String(currentPage));
  document.getElementById('page-size').value = String(pageSize);
  for (const checkbox of document.querySelectorAll('#game-state-filter input[type="checkbox"]')) checkbox.checked = selectedStates.has(checkbox.value);
  document.getElementById('game-search').value = searchValue;
  const list = document.getElementById('games');
  list.replaceChildren();
  const matchingGames = selectedType ? games.filter(game => game.functionalityId === selectedType) : games;
  const unavailable = matchingGames.filter(game => !game.canConnect);
  const toggle = document.getElementById('toggle-unavailable');
  toggle.hidden = unavailable.length === 0;
  toggle.textContent = t(showUnavailable ? 'hideUnavailable' : 'showUnavailable');
  const visibleGames = showUnavailable ? matchingGames : matchingGames.filter(game => game.canConnect);
  if (!visibleGames.length) {
    list.textContent = unavailable.length ? t('emptyOpenable') : (!selectedStates.size ? t('emptyStates') : (searchValue || selectedStates.size !== defaultStates.length || defaultStates.some(state => !selectedStates.has(state)) ? t('emptySearch') : t('empty')));
    return;
  }
  for (const game of visibleGames) {
    const card = document.createElement('article');
    card.className = 'game-card';
    const heading = document.createElement('h2');
    const name = document.createElement('span');
    name.textContent = game.name || t('untitledGame');
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
    const detail = document.createElement('div');
    detail.className = 'game-meta';
    const functionality = document.createElement('span');
    functionality.className = 'meta';
    functionality.textContent = game.functionalityId;
    const state = document.createElement('span');
    state.className = `game-state state-${allowedStates.includes(game.state) ? game.state : 'unknown'}`;
    state.textContent = game.state && allowedStates.includes(game.state) ? t(`state_${game.state}`) : t('state_unknown');
    const copy = createCopyButton(game.seqId);
    detail.append(functionality, state, copy);
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
  const requestId = ++loadRequestId;
  const status = document.getElementById('status');
  status.textContent = t('loading');
  document.getElementById('indicator').classList.remove('error');
  try {
    const response = await fetch('cli/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'games list', options: {
        offset: currentOffset,
        limit: pageSize,
        functionalityId: selectedType,
        search: searchValue.trim(),
        states: [...selectedStates]
      } })
    });
    const result = await response.json();
    if (requestId !== loadRequestId) return;
    if (!response.ok || !result.success) throw new Error(result.error || t('error'));
    renderGames(result.data || { games: [] });
    status.textContent = '';
  } catch (error) {
    if (requestId !== loadRequestId) return;
    document.getElementById('games').replaceChildren();
    document.getElementById('pagination').hidden = true;
    allGames = [];
    hasMore = false;
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
  currentPage = 1;
  currentOffset = 0;
  syncExploreUrl();
  loadGames();
};
document.getElementById('game-search').oninput = event => {
  searchValue = event.target.value;
  currentPage = 1;
  currentOffset = 0;
  syncExploreUrl();
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadGames, 250);
};
document.getElementById('game-state-filter').onchange = event => {
  const checkbox = event.target.closest('input[type="checkbox"]');
  if (!checkbox) return;
  if (checkbox.checked) selectedStates.add(checkbox.value);
  else selectedStates.delete(checkbox.value);
  currentPage = 1;
  currentOffset = 0;
  syncExploreUrl();
  loadGames();
};
document.getElementById('page-size').onchange = event => {
  pageSize = allowedPageSizes.includes(Number(event.target.value)) ? Number(event.target.value) : 10;
  currentPage = 1;
  currentOffset = 0;
  syncExploreUrl();
  loadGames();
};
document.getElementById('previous-page').onclick = () => {
  if (currentPage <= 1) return;
  currentPage -= 1;
  currentOffset = (currentPage - 1) * pageSize;
  syncExploreUrl();
  loadGames();
};
document.getElementById('next-page').onclick = () => {
  if (!hasMore) return;
  currentPage += 1;
  currentOffset = (currentPage - 1) * pageSize;
  syncExploreUrl();
  loadGames();
};
function syncExploreUrl() {
  const next = new URL(location.href);
  if (selectedType) next.searchParams.set('type', selectedType);
  else next.searchParams.delete('type');
  if (searchValue.trim()) next.searchParams.set('search', searchValue.trim());
  else next.searchParams.delete('search');
  next.searchParams.delete('state');
  if (selectedStates.size) next.searchParams.set('states', allowedStates.filter(state => selectedStates.has(state)).join(','));
  else next.searchParams.delete('states');
  next.searchParams.set('page', String(currentPage));
  next.searchParams.set('pageSize', String(pageSize));
  history.replaceState(null, '', next);
}
document.getElementById('refresh').onclick = loadGames;
document.getElementById('toggle-unavailable').onclick = () => {
  showUnavailable = !showUnavailable;
  localStorage.setItem(showUnavailableKey, String(showUnavailable));
  renderGames(allGames);
};
renderText();
loadGames();
