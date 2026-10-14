'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { GameManager } = require('../lib/game-manager');
const { runInkBot } = require('../game/inkjs-bot');
const { compileInkStory } = require('../scripts/inkjs-story');

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
      if (command.startsWith('seqs seq-state-get')) return { success: true, data: {
        success: true, data: { seqId: sequence.seqId, seqState: null }
      } };
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
  const serializedState = started.dependencies.story.state.ToJson();
  const restoredStory = compileInkStory(Buffer.from('=== start ===\nHello, story.\n-> END\n'), '.ink');
  restoredStory.state.LoadJson(serializedState);
  assert.equal(restoredStory.canContinue, started.dependencies.story.canContinue);
  assert.ok(calls.some(item => item.command === 'seqs file-download --id=ink-sequence --label=story' && item.token === 'token'));
});

test('Ink bot resumes a saved scene and resolves its existing ballot after a process restart', async () => {
  const sequence = {
    seqId: 'ink-resume', spaceId: 'space-1', state: 'playing', ballotIds: ['ballot-1'],
    botUserId: 'pk-ink', botMode: 'sequence_bot', turnHistory: []
  };
  let ballotClosed = false;
  let savedCheckpoint = {
    application: 'ink', version: 1, storyFingerprint: 'story-sha256',
    turn: 0, phase: 'awaiting-ballot', storyState: 'saved-state',
    scene: { narrative: 'Saved scene', choices: [{ text: 'Open the door' }], isEnding: false },
    ballotId: 'ballot-1', processedBallotId: null, historyEntry: null
  };
  const restoredStates = [];
  const client = {
    async _execRemote(command) {
      if (command.startsWith('seqs get ')) return { success: true, data: { ...sequence } };
      if (command.startsWith('seqs seq-state-get ')) return { success: true, data: {
        success: true, data: { seqState: savedCheckpoint }
      } };
      if (command.startsWith('seqs seq-state-set ')) {
        const match = command.match(/--value='(.*)'$/s);
        savedCheckpoint = JSON.parse(match[1]);
        return { success: true, data: { seqState: savedCheckpoint } };
      }
      if (command.startsWith('seqs state ')) {
        sequence.state = command.match(/--state='([^']+)'/)[1];
        sequence.turnHistory = JSON.parse(command.match(/--history='(.*)'$/s)[1]);
        return { success: true, data: sequence };
      }
      if (command === 'ballots select --id=ballot-1') return {
        success: true, data: { ballotId: 'ballot-1', title: 'Ink game · turn 1', closed: ballotClosed, state: ballotClosed ? 'closed' : 'ready' }
      };
      if (command === 'ballots results --id=ballot-1') return {
        success: true, data: { finalResult: { hasWinner: true, winningOption: { choiceId: 0, text: 'Open the door' } }, ballotSummary: { totalVotes: 2 } }
      };
      throw new Error(`Unexpected CLI command: ${command}`);
    }
  };
  const story = {
    state: {
      ToJson() { return 'next-state'; },
      LoadJson(value) { restoredStates.push(value); }
    },
    canContinue: false,
    currentChoices: [{ text: 'Open the door' }],
    ChooseChoiceIndex(index) { assert.equal(index, 0); this.currentChoices = []; }
  };
  const result = await runInkBot({ sequenceId: sequence.seqId, apiKeyId: 'pk-ink', secret: 'secret', pollIntervalMs: 250, maxTurns: 5 }, {
    client, token: 'test-token', story, storyFingerprint: 'story-sha256', output() {},
    async wait() { ballotClosed = true; }
  });
  assert.equal(result.status, 'finished');
  assert.deepEqual(restoredStates, ['saved-state', 'saved-state']);
  assert.equal(sequence.state, 'finished');
  assert.equal(savedCheckpoint.completed, true);
  assert.equal(sequence.turnHistory[0].ballotId, 'ballot-1');
});
