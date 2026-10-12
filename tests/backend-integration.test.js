'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { createBackendIntegration } = require('../lib/backend-integration');

async function withServer(app, run) {
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

test('integrated multibot has a separate page route and exposes bot APIs', async () => {
  const gameManager = {
    async listGames() { return [{ seqId: 'seq-1', name: 'Test game' }]; },
    async connect(seqId) { return { started: true, seqId }; }
  };
  const integration = createBackendIntegration(express, {
    WTS_CLI_SERVER_URL: 'http://127.0.0.1:3000', WTS_FUNCTIONALITY_ID: 'whattheshell',
    WTS_BOT_API_KEY_ID: '', WTS_BOT_SECRET: '', WTS_BOT_POLL_INTERVAL_MS: 5000,
    WTS_BOT_MAX_TURNS: 500, WTS_LANGUAGE: 'es'
  }, { client: { async _execRemote(command) { return { success: true, command }; } }, gameManager });
  const app = express();
  app.use('/games/wts_multibot', integration.pageRouter);
  app.get('/games/wts4bots/', (req, res) => res.send('monobot'));
  app.use('/api/games', integration.apiRouter);

  await withServer(app, async origin => {
    const monobot = await fetch(`${origin}/games/wts4bots/`);
    assert.equal(await monobot.text(), 'monobot');

    const explorer = await fetch(`${origin}/games/wts_multibot/`);
    assert.equal(explorer.status, 200);
    assert.match(await explorer.text(), /Explorar partidas/);

    const stylesheet = await fetch(`${origin}/games/wts_multibot/style.css`);
    assert.equal(stylesheet.status, 200);

    const game = await fetch(`${origin}/games/wts_multibot/?seq=seq-1`);
    assert.equal(game.status, 200);
    assert.match(await game.text(), /renderer-panel/);

    const list = await fetch(`${origin}/api/games`);
    assert.deepEqual(await list.json(), { games: [{ seqId: 'seq-1', name: 'Test game' }] });

    const nestedList = await fetch(`${origin}/games/wts_multibot/api/games`);
    assert.deepEqual(await nestedList.json(), { games: [{ seqId: 'seq-1', name: 'Test game' }] });

    const connect = await fetch(`${origin}/api/games/seq-1/connect`, { method: 'POST' });
    assert.deepEqual(await connect.json(), { started: true, seqId: 'seq-1' });
  });
});
