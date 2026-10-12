'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../server');

async function withServer(server, run) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

test('standalone server serves the generic explorer and player assets', async () => {
  const server = createServer({}, { gameManager: { async listGames() { return []; }, async connect() { return {}; } } });
  await withServer(server, async origin => {
    const explorer = await fetch(`${origin}/`);
    assert.equal(explorer.status, 200);
    assert.match(await explorer.text(), /Explorar partidas/);

    const player = await fetch(`${origin}/?seq=seq-1`);
    assert.equal(player.status, 200);
    assert.match(await player.text(), /renderer-panel/);

    const stylesheet = await fetch(`${origin}/player/style.css`);
    assert.equal(stylesheet.status, 200);
    assert.match(stylesheet.headers.get('content-type'), /text\/css/);

    const listing = await fetch(`${origin}/api/games`);
    assert.deepEqual(await listing.json(), { games: [] });
  });
});

test('anonymous CLI proxy only forwards the allowed slot commands', async () => {
  const calls = [];
  const server = createServer({ async _execRemote(command, token) { calls.push({ command, token }); return { success: true }; } });
  await withServer(server, async origin => {
    const allowed = await fetch(`${origin}/cli/execute`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'slotseqs public --seq=seq-1' })
    });
    assert.equal(allowed.status, 200);
    assert.deepEqual(calls, [{ command: 'slotseqs public --seq=seq-1', token: null }]);

    const denied = await fetch(`${origin}/cli/execute`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'seqs list' })
    });
    assert.equal(denied.status, 403);
    assert.equal(calls.length, 1);
  });
});
