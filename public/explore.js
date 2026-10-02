(async function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const lang = window.AppClient.i18n.getCurrentLanguage();
  const text = await fetch(`/games/whattheshell/whattheshell_${lang}.json`).then(response => response.json());
  document.documentElement.lang = lang;
  document.title = `${text.title} · ${text.exploreTitle}`;
  $('explore-title').textContent = text.exploreTitle;
  $('explore-intro').textContent = text.exploreIntro;
  $('language-label').textContent = text.language;
  $('language').value = lang;
  $('language').onchange = () => window.AppClient.i18n.setLanguage($('language').value);
  $('refresh').textContent = text.exploreRefresh;

  function status(message, connected = false) {
    $('status').textContent = message;
    $('indicator').classList.toggle('connected', connected);
  }

  async function load() {
    $('refresh').disabled = true;
    $('games').replaceChildren();
    status(text.exploreLoading);
    try {
      const response = await fetch('/api/games', { headers: { Accept: 'application/json' } });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || text.connectionError);
      const games = result.games || [];
      if (!games.length) {
        status(text.exploreEmpty, true);
        return;
      }
      const cards = games.map(game => {
        const card = document.createElement('article');
        card.className = 'game-card';
        const heading = document.createElement('h2');
        heading.textContent = game.name;
        const state = document.createElement('p');
        state.className = 'meta';
        state.textContent = `${text.exploreState}: ${text.states?.[game.state] || game.state}`;
        const link = document.createElement('a');
        link.className = 'game-link';
        link.href = `/games/whattheshell/?seq=${encodeURIComponent(game.seqId)}&lang=${encodeURIComponent(lang)}`;
        link.textContent = text.explorePlay;
        if (!game.canConnect) {
          link.setAttribute('aria-disabled', 'true');
          link.title = text.exploreFreshOnly;
          link.classList.add('disabled');
        }
        card.append(heading, state, link);
        return card;
      });
      $('games').append(...cards);
      status(text.exploreFound.replace('{count}', String(games.length)), true);
    } catch (error) {
      status(text[error.message] || error.message || text.exploreFailed);
    } finally {
      $('refresh').disabled = false;
    }
  }

  $('refresh').onclick = load;
  await load();
})();
