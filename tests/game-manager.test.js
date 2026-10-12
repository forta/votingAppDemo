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
  return { manager, sequence, commands, started };
}

test('lists only sequences assigned to a configured functionality integration', async () => {
  const { manager, commands } = setup();
  const games = await manager.listGames();
  assert.deepEqual(games, [{ seqId: 'seq-game-1', functionalityId: 'whattheshell', name: 'Demo', state: 'waiting', createdAt: null, canConnect: true, connected: false }]);
  assert.equal(commands[0].command, 'seqs list --functionalityId=whattheshell');
  assert.equal(JSON.stringify(games).includes('pk-game'), false);
});

test('connects an assigned game and starts only one adapter per sequence', async () => {
  const { manager, commands, started } = setup();
  assert.deepEqual(await manager.connect('seq-game-1'), { started: true, alreadyRunning: false });
  assert.deepEqual(await manager.connect('seq-game-1'), { started: false, alreadyRunning: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(started.length, 1);
  assert.equal(started[0].options.sequenceId, 'seq-game-1');
  assert.equal(started[0].dependencies.token, 'header.payload.signature');
  assert.ok(commands.every(item => item.command.startsWith('seqs list ') || item.command.startsWith('seqs get ')));
  assert.equal(commands.at(-1).token, 'header.payload.signature');
});

test('does not list or connect a sequence assigned to an owner key', async () => {
  const { manager, sequence } = setup();
  sequence.botKeySource = 'owner';
  assert.deepEqual(await manager.listGames(), []);
  await assert.rejects(manager.connect('seq-game-1'), { status: 403, message: 'SEQUENCE_NOT_ASSIGNED_TO_THIS_GAME' });
});

test('does not start sequences that already have ballots', async () => {
  const { manager, sequence, started } = setup();
  sequence.ballotIds.push('ballot-old');
  await assert.rejects(manager.connect('seq-game-1'), { status: 409, message: 'GAME_REQUIRES_A_FRESH_SEQUENCE' });
  assert.equal(started.length, 0);
});
