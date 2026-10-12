'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { GameManager } = require('../lib/game-manager');

test('Ink adapter downloads and compiles the sequence story through CLI commands', async () => {
  const sequence = {
    seqId: 'ink-sequence', name: 'Ink test', state: 'waiting', ballotIds: [],
    functionalityId: 'ink', botUserId: 'pk-ink', botMode: 'sequence_bot', botKeySource: 'integration'
  };
  const calls = [];
  const client = {
    async loginApiKey() { return { access_token: 'token', identity: { id: 'pk-ink', type: 'apikey' } }; },
    async _execRemote(command, token) {
      calls.push({ command, token });
      if (command.startsWith('seqs list')) return { success: true, data: [sequence] };
      if (command.startsWith('seqs file-download')) return { success: true, data: {
        filename: "attachment; filename*=UTF-8''story.ink",
        contentBase64: Buffer.from('=== start ===\nHello, story.\n-> END\n').toString('base64')
      } };
      throw new Error(`Unexpected CLI command: ${command}`);
    }
  };
  let started;
  const manager = new GameManager({
    client,
    config: { games: [{ functionalityId: 'ink', apiKeyId: 'pk-ink', secret: 'secret', adapter: 'ink' }] },
    runBots: { ink: async (options, dependencies) => { started = { options, dependencies }; } },
    output() {}
  });
  assert.deepEqual(await manager.connect('ink-sequence'), { started: true, alreadyRunning: false });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(started.options.sequenceId, 'ink-sequence');
  assert.equal(started.dependencies.story.canContinue, true);
  assert.ok(calls.some(item => item.command === 'seqs file-download --id=ink-sequence --label=story' && item.token === 'token'));
});
