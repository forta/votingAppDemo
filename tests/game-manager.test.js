'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { GameManager } = require('../lib/game-manager');

function setup(overrides = {}) {
  const sequence = {
    seqId: 'seq-game-1', name: 'Demo', state: 'waiting', ballotIds: [],
    functionalityId: 'whattheshell', botUserId: 'pk-game', botMode: 'sequence_bot'
  };
  const commands = [];
  const client = {
    async _httpRequest(method, path, body) {
      assert.equal(method, 'POST');
      assert.equal(path, '/api/auth/login');
      assert.equal(body.credentials.email, 'pk-game');
      return { access_token: 'header.payload.signature', identity: { type: 'apikey', apiKeyId: 'pk-game' } };
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
    config: { botId: 'pk-game', botSecret: 'private', functionalityId: 'whattheshell' },
    runBot: async options => { started.push(options); await new Promise(() => {}); },
    output() {},
    ...overrides
  });
  return { manager, sequence, commands, started };
}

test('game manager lists a safe projection of functionality-assigned sequences', async () => {
  const { manager, commands } = setup();
  const games = await manager.listGames();
  assert.deepEqual(games, [{ seqId: 'seq-game-1', name: 'Demo', state: 'waiting', createdAt: null, canConnect: true, connected: false }]);
  assert.equal(commands[0].command, 'seqs list --functionalityId=whattheshell');
  assert.equal(JSON.stringify(games).includes('pk-game'), false);
});

test('connecting starts at most one bot for a fresh assigned sequence', async () => {
  const { manager, commands, started } = setup();
  assert.deepEqual(await manager.connect('seq-game-1'), { started: true, alreadyRunning: false });
  assert.deepEqual(await manager.connect('seq-game-1'), { started: false, alreadyRunning: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(started.length, 1);
  assert.equal(started[0].sequenceId, 'seq-game-1');
  assert.equal(commands.at(-1).token, 'header.payload.signature');
});

test('game manager rejects sequences outside the assigned functionality and bot', async () => {
  const { manager, sequence } = setup();
  sequence.botUserId = 'another-key';
  await assert.rejects(manager.connect('seq-game-1'), { status: 403, message: 'SEQUENCE_NOT_ASSIGNED_TO_THIS_GAME' });
});

test('game manager does not start a sequence that already has ballots', async () => {
  const { manager, sequence, started } = setup();
  sequence.ballotIds.push('ballot-old');
  await assert.rejects(manager.connect('seq-game-1'), { status: 409, message: 'GAME_REQUIRES_A_FRESH_SEQUENCE' });
  assert.equal(started.length, 0);
});
