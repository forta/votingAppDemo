'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../..');

test('game catalogue routes each supported game type to the shared explorer', () => {
  const catalogue = fs.readFileSync(path.join(root, 'subsites/games/games.js'), 'utf8');
  const catalogueHtml = fs.readFileSync(path.join(root, 'subsites/games/index.html'), 'utf8');
  const explorerHtml = fs.readFileSync(path.join(__dirname, '../public/explore.html'), 'utf8');
  const playerHtml = fs.readFileSync(path.join(__dirname, '../public/player/index.html'), 'utf8');
  const themeScript = fs.readFileSync(path.join(__dirname, '../public/theme.js'), 'utf8');
  const explorerScript = fs.readFileSync(path.join(__dirname, '../public/explore.js'), 'utf8');

  assert.doesNotThrow(() => new vm.Script(catalogue));
  assert.doesNotThrow(() => new vm.Script(explorerScript));
  assert.doesNotThrow(() => new vm.Script(themeScript));
  assert.match(catalogue, /type=.*encodeURIComponent\(game\.id\)/);
  assert.match(catalogue, /id="direct-game-form"/);
  assert.match(catalogue, /id="access-secret"/);
  assert.match(catalogue, /logo-home/);
  assert.match(catalogueHtml, /games\.css/);
  assert.match(explorerHtml, /class="player-home"/);
  assert.match(explorerHtml, /theme\.js/);
  assert.match(explorerHtml, /id="game-type"/);
  assert.doesNotMatch(explorerHtml, /id="sequence-id"|id="access-secret"/);
  assert.match(explorerHtml, /href="\/games\/" id="games-link"/);
  assert.match(playerHtml, /id="home-brand"[\s\S]*?src="logo\.png"/);
  assert.match(playerHtml, /href="\/games\/" id="games-link"/);
  assert.match(playerHtml, /theme\.js/);
  assert.match(explorerScript, /game\.functionalityId === selectedType/);
  assert.match(explorerScript, /gamesBack:/);
});

test('game catalogue translations are valid and have the same keys', () => {
  const locales = ['es', 'en', 'eo'].map(language => JSON.parse(
    fs.readFileSync(path.join(root, 'subsites/games/games_' + language + '.json'), 'utf8')
  ));
  const keys = Object.keys(locales[0]).sort();
  for (const locale of locales.slice(1)) assert.deepEqual(Object.keys(locale).sort(), keys);
});
