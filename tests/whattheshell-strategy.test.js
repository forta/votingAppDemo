'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../game/whattheshell-engine');
const { analyzePosition, chooseMachineMove } = require('../game/whattheshell-strategy');

function seeded() { let state = 37; return () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296); }

test('machine considers simultaneous enemy moves and blocks an immediate five', () => {
  const board = Array(81).fill(null);
  for (let cell = 0; cell < 4; cell += 1) board[cell] = engine.BLACK;
  const position = engine.createGame({ board });
  const before = JSON.stringify(position);
  const analysis = analyzePosition(position, seeded(), { depth: 1, iterations: 1200 });
  assert.equal(analysis.move, 4);
  assert.deepEqual(analysis.policy, [{ cell: 4, probability: 1 }]);
  assert.equal(JSON.stringify(position), before);
  assert.equal(chooseMachineMove(position, seeded()), 4);
});

test('strategy simulations use the simultaneous rules engine, including a collision egg', () => {
  const position = engine.createGame();
  const sameCell = 40;
  const result = engine.resolveTurn(position, { black: sameCell, white: sameCell });
  assert.equal(result.game.board[sameCell], engine.EGG);
  assert.equal(result.game.eggNumbers[sameCell], 1);
  assert.equal(result.events[0].type, 'collision');
});

test('chosen machine move is legal and analysis leaves eggs and board untouched', () => {
  const board = Array(81).fill(null);
  board[40] = engine.EGG;
  board[10] = engine.WHITE;
  board[11] = engine.WHITE;
  board[12] = engine.BLACK;
  const game = engine.createGame({ board, eggs: [40], eggNumbers: { 40: 8 }, nextEggNumber: 9 });
  const before = JSON.stringify(game);
  const analysis = analyzePosition(game, seeded(), { depth: 1, iterations: 600 });
  assert.ok(engine.legalCells(game).includes(analysis.move));
  assert.ok(analysis.evaluatedTurns > 0);
  assert.equal(JSON.stringify(game), before);
});
