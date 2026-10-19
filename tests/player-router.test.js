'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createPlayerRouter } = require('../lib/player-router');

test('generic player router works under the main backend path', async t => {
  const app = express();
  app.use(express.json({ limit: '8kb' }));
  app.use('/games/play', createPlayerRouter(express, {
    async _execRemote(command, token) { return { success: true, command, token }; }
  }, {
    gameManager: { async listGames() { return [{ seqId: 'seq-1' }]; }, async connect(seqId) { return { seqId }; } }
  }));
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise(resolve => server.close(resolve)));
  await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}/games/play`;

  const noSlash = await fetch(origin, { redirect: 'manual' });
  assert.equal(noSlash.status, 308);
  assert.equal(noSlash.headers.get('location'), '/games/play/');

  const explorer = await fetch(`${origin}/`);
  assert.equal(explorer.status, 200);
  assert.match(await explorer.text(), /Explorar partidas/);

  const player = await fetch(`${origin}/?seq=seq-1`);
  assert.match(await player.text(), /renderer-panel/);

  const asset = await fetch(`${origin}/player/play.js`);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get('content-type'), /javascript/);

  const explorerScript = await fetch(`${origin}/explore.js?v=test`);
  assert.equal(explorerScript.status, 200);
  assert.equal(explorerScript.headers.get('cache-control'), 'no-cache');
  assert.match(await explorerScript.text(), /created-at/);

  const games = await fetch(`${origin}/cli/execute`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command: 'games list' })
  });
  assert.deepEqual(await games.json(), { success: true, data: { games: [{ seqId: 'seq-1' }] } });

  const connect = await fetch(`${origin}/cli/execute`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command: 'games connect --seqId=seq-1' })
  });
  assert.deepEqual(await connect.json(), { success: true, data: { seqId: 'seq-1' } });

  const directApi = await fetch(`${origin}/api/games`);
  assert.equal(directApi.status, 404);
  const command = await fetch(`${origin}/cli/execute`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command: 'slotseqs public --seq=seq-1' })
  });
  assert.equal(command.status, 200);
  assert.deepEqual(await command.json(), { success: true, command: 'slotseqs public --seq=seq-1', token: null });
});
