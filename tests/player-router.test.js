'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createPlayerRouter } = require('../lib/player-router');
const { EventEmitter } = require('node:events');

test('generic player router works under the main backend path', async t => {
  const app = express();
  const listOptions = [];
  app.use(express.json({ limit: '8kb' }));
  app.use('/games/play', createPlayerRouter(express, {
    async _execRemote(command, token) { return { success: true, command, token }; }
  }, {
    gameManager: { async listGamesPage(options) { listOptions.push(options); return { games: [{ seqId: 'seq-1' }], offset: options.offset, limit: options.limit, hasMore: true }; }, async connect(seqId) { return { seqId }; } }
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
  assert.deepEqual(await games.json(), { success: true, data: { games: [{ seqId: 'seq-1' }], offset: 0, limit: 10, hasMore: true } });

  const searchedGames = await fetch(`${origin}/cli/execute`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command: 'games list', options: { offset: 20, limit: 25, functionalityId: 'ink', search: 'house', states: ['waiting', 'playing'] } })
  });
  assert.equal(searchedGames.status, 200);
  assert.deepEqual(listOptions.at(-1), { offset: 20, limit: 25, functionalityId: 'ink', search: 'house', state: '', states: ['waiting', 'playing'] });

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

test('sequence state relay batches scoped change events and sends a public snapshot', async t => {
  const sockets = [];
  class FakeWebSocket extends EventEmitter {
    static OPEN = 1;
    static CONNECTING = 0;
    constructor(url, options) {
      super();
      this.url = url;
      this.options = options;
      this.readyState = 0;
      sockets.push(this);
      setImmediate(() => {
        this.readyState = 1;
        this.emit('open');
        this.welcomed = true;
        this.emit('message', Buffer.from(JSON.stringify({ type: 'connection.established' })));
      });
    }
    send(raw) {
      const message = JSON.parse(raw);
      if (message.type !== 'subscribe') return;
      assert.equal(this.welcomed, true, 'subscribe only after authenticated welcome');
      setImmediate(() => {
        this.emit('message', Buffer.from(JSON.stringify({
          type: 'subscription.confirmed', scopes: [message.scope], rejectedScopes: []
        })));
        for (let index = 0; index < 3; index += 1) {
          this.emit('message', Buffer.from(JSON.stringify({
            type: 'sequence.game-state.changed', seqId: message.scope.id, identity: 'must-not-leak', choice: 1
          })));
        }
      });
    }
    close() { this.readyState = 3; this.emit('close'); }
  }
  const app = express();
  const calls = [];
  app.use(express.json({ limit: '8kb' }));
  let assignmentLookups = 0;
  app.use('/games/play', createPlayerRouter(express, {
    async _execRemote(command, token) {
      calls.push({ command, token });
      return calls.length === 1
        ? { success: true }
        : { success: true, data: { ballot: { ballotId: 'ballot-1', voteCounts: [{ choiceId: 0, count: 2 }] } } };
    }
  }, {
    WebSocket: FakeWebSocket,
    gameManager: {
      config: { serverUrl: 'https://voting.example' },
      async findAssignedSequence(seqId) { assignmentLookups += 1; return { token: 'server-only-token', sequence: { seqId } }; }
    },
    voteFlushIntervalMs: 10
  }));
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise(resolve => server.close(resolve)));
  await new Promise(resolve => server.once('listening', resolve));
  const controllers = [new AbortController(), new AbortController()];
  const responses = await Promise.all(controllers.map(controller => fetch(`http://127.0.0.1:${server.address().port}/games/play/events/sequence`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ seqId: 'seq-1' }), signal: controller.signal
  })));
  assert.deepEqual(responses.map(response => response.status), [200, 200]);
  assert.ok(responses.every(response => /text\/event-stream/.test(response.headers.get('content-type'))));
  const readUpdate = async response => {
    const reader = response.body.getReader();
    let received = '';
    while (!received.includes('event: state-updated')) {
      const { value, done } = await reader.read();
      if (done) break;
      received += new TextDecoder().decode(value);
    }
    return received;
  };
  const updates = await Promise.all(responses.map(readUpdate));
  controllers.forEach(controller => controller.abort());
  for (const received of updates) {
    assert.match(received, /event: ready\ndata: \{"count":0\}/);
    assert.match(received, /event: state-updated\ndata: \{"eventCount":4,"updateCount":1,"snapshot":\{"ballot":\{"ballotId":"ballot-1","voteCounts":\[\{"choiceId":0,"count":2\}\]\}\}\}/);
    assert.doesNotMatch(received, /identity|"choice"|server-only-token/);
  }
  assert.equal(sockets.length, 1);
  assert.equal(assignmentLookups, 1);
  assert.equal(calls.filter(call => call.command.startsWith('slotseqs public')).length, 3);
  assert.equal(calls.filter(call => call.command === 'slotseqs public --seq=seq-1').length, 3);
});

test('sequence state relay checks a game access code before opening a subscription', async t => {
  const app = express();
  let tokenLookup = false;
  app.use(express.json({ limit: '8kb' }));
  app.use('/games/play', createPlayerRouter(express, {
    async _execRemote(command) {
      assert.match(command, /--accessSecret="GAMES"/);
      return { success: false, error: 'GAME_ACCESS_CODE_REQUIRED', code: 'GAME_ACCESS_CODE_REQUIRED' };
    }
  }, { gameManager: { async findAssignedSequence() { tokenLookup = true; return {}; } } }));
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise(resolve => server.close(resolve)));
  await new Promise(resolve => server.once('listening', resolve));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/games/play/events/sequence`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ seqId: 'seq-1', accessSecret: 'games' })
  });
  assert.equal(response.status, 403);
  assert.equal(tokenLookup, false);
});
