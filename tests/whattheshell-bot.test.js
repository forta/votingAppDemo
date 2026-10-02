'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../game/whattheshell-engine');
const { run, formatCell } = require('../game/whattheshell-bot');

function fakeClient(events = [], initialState = 'playing') {
  const sequence = { seqId: 'seq-test', spaceId: 'space-test', botUserId: 'pk-test', botMode: 'sequence_bot', state: initialState, ballotIds: [], turnHistory: [] };
  const commands = [];
  const ballot = { ballotId: 'ballot-test', state: 'closed', closed: true };
  return {
    sequence, commands,
    async _httpRequest() { return { access_token: 'token', identity: { id: 'pk-test', apiKeyId: 'pk-test', type: 'apikey' } }; },
    async _execRemote(command) {
      commands.push(command);
      if (command.startsWith('seqs get ')) return { success: true, data: { ...sequence } };
      if (command.startsWith('ballots create ')) { events.push('ballot-create'); sequence.ballotIds.push(ballot.ballotId); return { success: true, data: { ballotId: ballot.ballotId } }; }
      if (command.startsWith('ballots select ')) return { success: true, data: ballot };
      if (command.startsWith('ballots results ')) return { success: true, data: { finalResult: { hasWinner: false, winningOption: null }, ballotSummary: { totalVotes: 1 } } };
      if (command.startsWith('slotseqs public ')) return { success: true, data: { ballot: null, lastCompletedBallot: { ballotId: ballot.ballotId, votes: [] }, slots: [] } };
      if (command.startsWith('seqs state ')) {
        const stateMatch = command.match(/--state=([^\s]+)/);
        const historyMatch = command.match(/--history='(.*)'$/);
        sequence.state = stateMatch[1];
        sequence.turnHistory = JSON.parse(historyMatch[1]);
        return { success: true, data: { ...sequence } };
      }
      throw new Error(`Unexpected command: ${command}`);
    }
  };
}

test('bot preserves its game when polling is rate limited', async () => {
  const client = fakeClient([], 'waiting');
  const originalExec = client._execRemote.bind(client);
  let reads = 0;
  client._execRemote = async command => {
    if (command.startsWith('seqs get ') && ++reads === 2) {
      throw Object.assign(new Error('limited'), { status: 429, retryAfterMs: 5000 });
    }
    return originalExec(command);
  };
  const waits = [];
  const result = await run({ sequenceId: 'seq-test', apiKeyId: 'pk-test', secret: 'private', pollIntervalMs: 3000, maxTurns: 1 }, {
    client, wait: async ms => { waits.push(ms); if (ms === 5250) client.sequence.state = 'playing'; },
    chooseMachineMove: () => 40, output: () => {}
  });
  assert.equal(result.turns, 1);
  assert.ok(waits.includes(5250));
  assert.equal(client.commands.filter(command => command.startsWith('ballots create ')).length, 1);
});

test('bot processes the machine move when voters participated but no option won', async () => {
  const log = [];
  const client = fakeClient(log);
  const originalExec = client._execRemote.bind(client);
  client._execRemote = async command => command.startsWith('ballots results ')
    ? { success: true, data: { finalResult: { hasWinner: false, winningOption: null }, ballotSummary: { totalVotes: 1 } } }
    : originalExec(command);
  const output = [];
  const choose = (game, random) => {
    log.push('machine-choice');
    assert.equal(game.turn, 0);
    assert.equal(typeof random, 'function');
    return 40;
  };
  const result = await run({ sequenceId: 'seq-test', apiKeyId: 'pk-test', secret: 'private', pollIntervalMs: 250, maxTurns: 1, seed: 1, lang: 'en' }, {
    client, wait: async () => {}, chooseMachineMove: choose, output: line => output.push(line)
  });
  assert.ok(client.commands.findIndex(command => command.startsWith('ballots create ')) > -1);
  assert.deepEqual(log.slice(0, 2), ['machine-choice', 'ballot-create']);
  assert.equal(client.sequence.turnHistory[0].black, null);
  assert.equal(client.sequence.turnHistory[0].white, 40);
  assert.equal(client.sequence.turnHistory[0].board[40], engine.WHITE);
  assert.equal(result.status, 'paused');
  assert.ok(output.includes('Votes received: none'));
  assert.ok(output.includes('Winning option: none'));
  assert.ok(output.includes(`Computer move (white): ${formatCell(40)}`));
});

test('bot waits for the sequence to be started before opening its first ballot', async () => {
  const events = [];
  const client = fakeClient(events, 'waiting');
  const output = [];
  let waits = 0;
  const result = await run({ sequenceId: 'seq-test', apiKeyId: 'pk-test', secret: 'private', pollIntervalMs: 250, maxTurns: 1, seed: 1, lang: 'en' }, {
    client,
    wait: async () => {
      waits += 1;
      if (waits === 1) {
        assert.equal(client.commands.some(command => command.startsWith('ballots create ')), false);
        client.sequence.state = 'playing';
      }
    },
    chooseMachineMove: () => 40,
    output: line => output.push(line)
  });
  assert.equal(result.status, 'paused');
  assert.equal(waits, 2);
  assert.ok(output.includes('Waiting for a slot holder to start the game...'));
  assert.ok(output.includes('Game started.'));
  assert.equal(client.commands.filter(command => command.startsWith('ballots create ')).length, 1);
});

test('a zero-vote ballot pauses without applying either move and retries from the same board', async () => {
  const events = [];
  const client = fakeClient(events);
  const originalExec = client._execRemote.bind(client);
  let resultCount = 0;
  client._execRemote = async command => {
    if (command.startsWith('ballots results ')) {
      resultCount += 1;
      if (resultCount === 1) return { success: true, data: { finalResult: { hasWinner: false, winningOption: null }, ballotSummary: { totalVotes: 0 } } };
      if (resultCount === 2) return { success: true, data: { finalResult: { hasWinner: false, winningOption: null }, ballotSummary: { totalVotes: 1 } } };
    }
    return originalExec(command);
  };
  let waitCount = 0;
  const boardsAtMachineChoice = [];
  const result = await run({ sequenceId: 'seq-test', apiKeyId: 'pk-test', secret: 'private', pollIntervalMs: 250, maxTurns: 1, seed: 1, lang: 'en' }, {
    client,
    wait: async () => { waitCount += 1; if (waitCount === 2) client.sequence.state = 'playing'; },
    chooseMachineMove: game => { boardsAtMachineChoice.push([...game.board]); return boardsAtMachineChoice.length === 1 ? 40 : 41; },
    output: () => {}
  });
  assert.equal(result.status, 'paused');
  assert.equal(boardsAtMachineChoice.length, 2);
  assert.ok(boardsAtMachineChoice.every(board => board.every(cell => cell === null)));
  assert.equal(client.sequence.turnHistory.length, 1);
  assert.equal(client.sequence.turnHistory[0].white, 41);
  assert.equal(client.sequence.turnHistory[0].board[40], null);
  assert.equal(client.sequence.turnHistory[0].board[41], engine.WHITE);
});
