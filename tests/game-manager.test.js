'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { GameManager } = require('../lib/game-manager');

function setup(overrides = {}) {
  const sequence = {
    seqId: 'seq-game-1', name: 'Demo', state: 'waiting', ballotIds: [],
    functionalityId: 'whattheshell', botUserId: 'pk-game', botMode: 'sequence_bot', botKeySource: 'integration'
  };
  const commands = [];
  let seqState = null;
  const client = {
    async loginApiKey(apiKeyId, secret) {
      assert.equal(apiKeyId, 'pk-game');
      assert.equal(secret, 'private');
      return { access_token: 'header.payload.signature', identity: { type: 'apikey', apiKeyId } };
    },
    async _execRemote(command, token) {
      commands.push({ command, token });
      if (command.startsWith('seqs list ')) return { success: true, data: [sequence] };
      if (command.startsWith('seqs get ')) return { success: true, data: sequence };
      if (command.startsWith('seqs seq-state-get ')) return { success: true, data: {
        success: true, data: { seqId: sequence.seqId, seqState }
      } };
      throw new Error(`Unexpected command: ${command}`);
    }
  };
  const started = [];
  const manager = new GameManager({
    client,
    config: { games: [{ functionalityId: 'whattheshell', apiKeyId: 'pk-game', secret: 'private', adapter: 'whattheshell' }] },
    runBots: { whattheshell: async (options, dependencies) => { started.push({ options, dependencies }); await new Promise(() => {}); } },
    output() {},
    ...overrides
  });
  return { manager, sequence, commands, started, get seqState() { return seqState; }, set seqState(value) { seqState = value; } };
}

test('lists only sequences assigned to a configured functionality integration', async () => {
  const { manager, commands } = setup();
  const games = await manager.listGames();
  assert.deepEqual(games, [{ seqId: 'seq-game-1', functionalityId: 'whattheshell', name: 'Demo', state: 'waiting', createdAt: null, canConnect: true, connected: false }]);
  assert.equal(commands[0].command, 'seqs list --functionalityId=whattheshell --botKeySource=integration --limit=11 --offset=0 --compact=true');
  assert.equal(JSON.stringify(games).includes('pk-game'), false);
});

test('searches and pages game sequences through the voting API', async () => {
  const { manager } = setup();
  const commands = [];
  manager.command = async command => {
    commands.push(command);
    return [{
      seqId: 'seq-search', name: 'Demo evening', state: 'waiting', ballotIds: [],
      functionalityId: 'whattheshell', botUserId: 'pk-game', botMode: 'sequence_bot',
      botKeySource: 'integration', createdAt: '2026-03-01T10:00:00.000Z'
    }];
  };

  const result = await manager.listGamesPage({ offset: 20, limit: 25, functionalityId: 'whattheshell', search: 'evening test', state: 'paused' });
  assert.equal(result.offset, 20);
  assert.equal(result.limit, 25);
  assert.equal(result.hasMore, false);
  assert.deepEqual(result.games.map(game => game.seqId), ['seq-search']);
  assert.match(commands[0], /--botKeySource=integration --state=paused --limit=26 --offset=20 --compact=true/);
  assert.match(commands[0], /--search64=ZXZlbmluZyB0ZXN0/);
});

test('combines selected states before sorting and paginating', async () => {
  const { manager } = setup();
  const makeSequence = (seqId, state, createdAt) => ({
    seqId, name: seqId, state, ballotIds: [], functionalityId: 'whattheshell',
    botUserId: 'pk-game', botMode: 'sequence_bot', botKeySource: 'integration', createdAt
  });
  const commands = [];
  manager.command = async command => {
    commands.push(command);
    if (command.includes('--state=waiting')) return [
      makeSequence('wait-old', 'waiting', '2026-01-01T00:00:00.000Z'),
      makeSequence('wait-new', 'waiting', '2026-03-01T00:00:00.000Z')
    ];
    if (command.includes('--state=playing')) return [makeSequence('playing-mid', 'playing', '2026-02-01T00:00:00.000Z')];
    throw new Error(`Unexpected state query: ${command}`);
  };

  const result = await manager.listGamesPage({ offset: 1, limit: 1, functionalityId: 'whattheshell', states: ['waiting', 'playing'] });
  assert.deepEqual(result.games.map(game => game.seqId), ['playing-mid']);
  assert.equal(result.hasMore, true);
  assert.equal(commands.length, 2);
  assert.ok(commands.every(command => /--limit=3 --offset=0/.test(command)));
});

test('returns no games without querying when no states are selected', async () => {
  const { manager, commands } = setup();
  assert.deepEqual(await manager.listGamesPage({ states: [] }), { games: [], offset: 0, limit: 10, hasMore: false });
  assert.deepEqual(commands, []);
});

test('returns a globally sorted page when browsing more than one game type', async () => {
  const { manager } = setup({ config: { games: [
    { functionalityId: 'whattheshell', apiKeyId: 'pk-wts', secret: 'secret', adapter: 'whattheshell' },
    { functionalityId: 'ink', apiKeyId: 'pk-ink', secret: 'secret', adapter: 'ink' }
  ] } });
  manager.token = async game => game.apiKeyId;
  manager.command = async (command, token) => {
    const functionalityId = token === 'pk-wts' ? 'whattheshell' : 'ink';
    const seqId = functionalityId === 'whattheshell' ? 'seq-wts' : 'seq-ink';
    return [{
      seqId, name: seqId, state: 'waiting', ballotIds: [], functionalityId,
      botUserId: token, botMode: 'sequence_bot', botKeySource: 'integration',
      createdAt: functionalityId === 'whattheshell' ? '2026-02-01T00:00:00.000Z' : '2026-03-01T00:00:00.000Z'
    }];
  };

  const result = await manager.listGamesPage({ offset: 1, limit: 1 });
  assert.deepEqual(result.games.map(game => game.seqId), ['seq-wts']);
  assert.equal(result.hasMore, false);
});

test('lists games from newest to oldest by sequence creation time', async () => {
  const { manager } = setup();
  const older = {
    seqId: 'seq-older', name: 'Older', state: 'waiting', ballotIds: [],
    functionalityId: 'whattheshell', botUserId: 'pk-game', botMode: 'sequence_bot',
    botKeySource: 'integration', createdAt: '2026-01-01T10:00:00.000Z'
  };
  const newer = { ...older, seqId: 'seq-newer', name: 'Newer', createdAt: '2026-02-01T10:00:00.000Z' };
  manager.command = async () => [older, newer];

  const games = await manager.listGames();
  assert.deepEqual(games.map(game => game.seqId), ['seq-newer', 'seq-older']);
});

test('connects an assigned game and starts only one adapter per sequence', async () => {
  const { manager, commands, started } = setup();
  assert.deepEqual(await manager.connect('seq-game-1'), { started: true, alreadyRunning: false });
  assert.deepEqual(await manager.connect('seq-game-1'), { started: false, alreadyRunning: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(started.length, 1);
  assert.equal(started[0].options.sequenceId, 'seq-game-1');
  assert.equal(started[0].dependencies.token, 'header.payload.signature');
  assert.equal(started[0].dependencies.signal.aborted, false);
  assert.ok(commands.every(item => item.command.startsWith('seqs list ') || item.command.startsWith('seqs get ')
    || item.command.startsWith('seqs seq-state-get ')));
  assert.equal(commands.at(-1).token, 'header.payload.signature');
  manager.stop();
  assert.equal(started[0].dependencies.signal.aborted, true);
});

test('does not list or connect a sequence assigned to an owner key', async () => {
  const { manager, sequence } = setup();
  sequence.botKeySource = 'owner';
  assert.deepEqual(await manager.listGames(), []);
  await assert.rejects(manager.connect('seq-game-1'), { status: 403, message: 'SEQUENCE_NOT_ASSIGNED_TO_THIS_GAME' });
});

test('resumes a sequence with ballots when its adapter checkpoint is compatible', async () => {
  const { manager, sequence, started } = setup();
  sequence.ballotIds.push('ballot-old');
  manager.command = async command => command.startsWith('seqs list ')
    ? [sequence]
    : command.startsWith('seqs seq-state-get ')
      ? { seqState: { application: 'whattheshell', version: 1 } }
      : sequence;
  const [listed] = await manager.listGames();
  assert.equal(listed.canConnect, true);
  assert.deepEqual(await manager.connect('seq-game-1'), { started: true, alreadyRunning: false });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(started.length, 1);
});

test('does not resume a sequence with ballots and a missing or incompatible checkpoint', async () => {
  const { manager, sequence, started } = setup();
  sequence.ballotIds.push('ballot-old');
  manager.command = async command => command.startsWith('seqs list ')
    ? [sequence]
    : command.startsWith('seqs seq-state-get ')
      ? { seqState: { application: 'ink', version: 1 } }
      : sequence;
  await assert.rejects(manager.connect('seq-game-1'), { status: 409, message: 'GAME_STATE_NOT_RECOVERABLE' });
  assert.equal(started.length, 0);
});

test('startup reconciliation reattaches a persisted in-progress game', async () => {
  const { manager, sequence, started } = setup();
  sequence.state = 'playing';
  sequence.ballotIds.push('ballot-old');
  manager.command = async command => command.startsWith('seqs list ')
    ? [sequence]
    : command.startsWith('seqs seq-state-get ')
      ? { seqState: { application: 'whattheshell', version: 1 } }
      : sequence;
  await manager.reconcile();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(started.length, 1);
  manager.stop();
});
