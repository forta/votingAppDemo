'use strict';

/* Generic game discovery page: list integration-backed games or open a
 * sequence ID directly, optionally retaining its access code for the session. */

const translations = {
  es: { title: 'Explorar partidas', intro: 'Elige una secuencia disponible para conectarte y jugar.', loading: 'Cargando partidas…', refresh: 'Actualizar lista', empty: 'No hay partidas disponibles ahora.', connect: 'Abrir partida', error: 'No se pudo cargar la lista de partidas.', seqLabel: 'O indica el ID de una secuencia', secretLabel: 'Código de acceso (si te lo han dado)', openSequence: 'Abrir secuencia' },
  en: { title: 'Explore games', intro: 'Choose an available sequence to connect and play.', loading: 'Loading games…', refresh: 'Refresh list', empty: 'No games are available right now.', connect: 'Open game', error: 'Could not load the game list.', seqLabel: 'Or enter a sequence ID', secretLabel: 'Access code (if provided)', openSequence: 'Open sequence' },
  eo: { title: 'Esplori ludojn', intro: 'Elektu disponeblan sinsekvon por konektiĝi kaj ludi.', loading: 'Ŝargante ludojn…', refresh: 'Ĝisdatigi liston', empty: 'Neniuj ludoj disponeblas nun.', connect: 'Malfermi ludon', error: 'Ne eblis ŝargi la ludliston.', seqLabel: 'Aŭ enigu sinsekvan identigilon', secretLabel: 'Alirkodo (se donita)', openSequence: 'Malfermi sinsekvon' }
};
const language = document.getElementById('language');
language.value = localStorage.getItem('game-player-language') || 'es';
language.onchange = () => { localStorage.setItem('game-player-language', language.value); renderText(); loadGames(); };
const t = key => translations[language.value]?.[key] || translations.es[key];
function renderText() {
  document.documentElement.lang = language.value;
  document.title = `${t('title')} · Kunsido`;
  document.getElementById('title').textContent = t('title');
  document.getElementById('intro').textContent = t('intro');
  document.getElementById('refresh').textContent = t('refresh');
  document.getElementById('sequence-id-label').textContent = t('seqLabel');
  document.getElementById('access-secret-label').textContent = t('secretLabel');
  document.getElementById('open-sequence').textContent = t('openSequence');
}
function renderGames(games) {
  const list = document.getElementById('games');
  list.replaceChildren();
  if (!games.length) { list.textContent = t('empty'); return; }
  for (const game of games) {
    const card = document.createElement('article');
    card.className = 'game-card';
    const heading = document.createElement('h2');
    heading.textContent = game.name || game.seqId;
    const detail = document.createElement('p');
    detail.className = 'meta';
    detail.textContent = `${game.functionalityId} · ${game.state} · ${game.seqId}`;
    const link = document.createElement('a');
    link.className = 'button';
    link.textContent = t('connect');
    link.href = `?seq=${encodeURIComponent(game.seqId)}&runner=multibot`;
    if (!game.canConnect) { link.setAttribute('aria-disabled', 'true'); link.tabIndex = -1; }
    card.append(heading, detail, link);
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
