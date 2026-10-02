'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../server');
const { readGames, runGames } = require('../runner');
const { GameService } = require('../lib/service');

test('web server serves its own page and forwards only anonymous slot commands', async t => {
  const calls = [];
  const server = createServer({ async _execRemote(command, token) {
    calls.push({ command, token });
    if (command.includes('limited')) throw Object.assign(new Error('limited'), { status: 429, retryAfterMs: 5000 });
    return { success: true, data: {} };
  } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = command => fetch(`${base}/cli/execute`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer must-not-forward' }, body: JSON.stringify({ command }) });
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /whattheshell\/i18n.js/);
  assert.equal((await fetch(`${base}/CLI/state/private.json`)).status, 404);
  assert.equal((await post('seqs state --id=x --state=finished')).status, 403);
  assert.equal((await post('slotseqs configure --seq=x')).status, 403);
  assert.equal((await post('slotseqs public --seq=x')).status, 200);
  assert.deepEqual(calls, [{ command: 'slotseqs public --seq=x', token: null }]);
  const limited = await post('slotseqs public --seq=limited');
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '5');
});

test('site explorer lists available games and connects a selected sequence', async t => {
  const calls = [];
  const server = createServer({}, { gameManager: {
    async listGames() { return [{ seqId: 'seq-1', name: 'Demo', canConnect: true }]; },
    async connect(seqId) { calls.push(seqId); return { started: true, alreadyRunning: false }; }
  } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const listing = await fetch(`${base}/api/games`);
  assert.deepEqual(await listing.json(), { games: [{ seqId: 'seq-1', name: 'Demo', canConnect: true }] });
  const connected = await fetch(`${base}/api/games/seq-1/connect`, { method: 'POST' });
  assert.deepEqual(await connected.json(), { started: true, alreadyRunning: false });
  assert.deepEqual(calls, ['seq-1']);
  assert.match(await (await fetch(base)).text(), /explore\.js/);
});

test('runner validates before starting and isolates failures between games', async () => {
  const row = { sequenceId: 'one', apiKeyId: 'key', secretEnv: 'BOT_SECRET' };
  assert.throws(() => readGames([row], {}), /secretEnv/);
  assert.throws(() => readGames([row, row], { BOT_SECRET: 'secret' }), /one bot/);
  const games = readGames([row, { ...row, sequenceId: 'two' }], { BOT_SECRET: 'secret' });
  const started = [];
  const results = await runGames(games, async options => {
    started.push(options.sequenceId);
    if (options.sequenceId === 'one') throw new Error('simulated failure');
    return { status: 'finished' };
  });
  assert.deepEqual(started, ['one', 'two']);
  assert.deepEqual(results.map(result => result.status), ['rejected', 'fulfilled']);
});

test('slot administration preserves an existing reservation PIN without returning it', async () => {
  const service = new GameService({ games: {}, client: {}, config: { controllerId: 'controller' } });
  service.credentials = async () => ({ owner: { access_token: 'owner-token' } });
  const calls = [];
  service.command = async (command, token) => {
    calls.push({ command, token });
    if (command.startsWith('slotseqs list')) return { slots: [{ slotNumber: 1, surrogateUserId: 'surrogate-1', reserved: true, alias: 'North team' }] };
    return { configured: true };
  };
  const slots = Array.from({ length: 5 }, (_, index) => ({ surrogateUserId: `surrogate-${index + 1}`, reservedAlias: index === 0 ? 'North team' : '', reservedPin: '' }));
  const result = await service.configureSlots('seq-1', slots);
  assert.deepEqual(result, { configured: true });
  assert.equal(calls.length, 2);
  assert.match(calls[1].command, /North team/);
  assert.equal(calls[1].command.includes('pinHash'), false);
  assert.equal(calls[1].token, 'owner-token');
});
