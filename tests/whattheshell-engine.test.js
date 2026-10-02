'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../game/whattheshell-engine');
const { BLACK, WHITE, EGG, index: at, createGame, resolveTurn, resultFor } = engine;

function position({ black = [], white = [], eggs = [], ...options } = {}) {
  const board = Array(81).fill(null);
  for (const [color, cells] of [[BLACK, black], [WHITE, white], [EGG, eggs]]) {
    for (const cell of cells) {
      assert.equal(board[cell], null, `Overlapping fixture at ${cell}`);
      board[cell] = color;
    }
  }
  return createGame({ board, eggs, ...options });
}

test('coordinates and legal moves respect board edges and terminal states', () => {
  assert.equal(at(8, 8), 80);
  assert.equal(at(-1, 0), -1);
  assert.equal(at(0, 9), -1);
  assert.equal(engine.rowOf(23), 2);
  assert.equal(engine.columnOf(23), 5);
  const game = createGame();
  assert.equal(engine.legalCells(game).length, 81);
  const next = resolveTurn(game, { black: { row: 0, column: 8 }, white: { cell: 9 } }).game;
  assert.equal(next.board[8], BLACK);
  assert.equal(next.board[9], WHITE);
  assert.equal(engine.legalCoordinates(next).length, 79);
  for (const state of ['draw', 'finished']) {
    assert.deepEqual(engine.legalCells({ ...game, state }), []);
    assert.throws(() => resolveTurn({ ...game, state }, { black: 0 }), /finished/);
  }
});

test('moves and game metadata are validated without mutating inputs', () => {
  const game = position({ black: [0], eggs: [1] });
  const before = JSON.stringify(game);
  for (const black of [-1, 81, 0, 1, 1.5, { row: 9, column: 0 }]) {
    assert.throws(() => resolveTurn(game, { black }));
  }
  resolveTurn(game, { black: 2, white: 3 });
  assert.equal(JSON.stringify(game), before);
  assert.throws(() => createGame({ board: [null] }));
  assert.throws(() => createGame({ board: Array(81).fill('invalid') }));
  assert.throws(() => createGame({ ...game, eggs: [1, 1] }), /egg order/);
  assert.throws(() => createGame({ ...game, eggs: [] }), /egg order/);
  assert.throws(() => createGame({ ...game, nextEggNumber: 1 }), /egg number/);
  assert.throws(() => createGame({ turn: -1 }), /turn/);
});

test('collisions create numbered neutral eggs and never trigger captures', () => {
  const game = position({ black: [0, 3], white: [1, 2] });
  const first = resolveTurn(game, { black: 40, white: 40 });
  assert.equal(first.game.board[40], EGG);
  assert.equal(first.game.board[1], WHITE);
  assert.equal(first.game.eggNumbers[40], 1);
  assert.deepEqual(first.captures, { black: 0, white: 0 });
  assert.deepEqual(first.events, [{ type: 'collision', cell: 40, eggNumber: 1 }]);
  const second = resolveTurn(first.game, { black: 41, white: 41 });
  assert.deepEqual(second.game.eggs, [40, 41]);
  assert.deepEqual(second.game.eggNumbers, { 40: 1, 41: 2 });
  assert.equal(second.game.nextEggNumber, 3);
});

for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
  test(`captures exactly two pieces in direction (${dr}, ${dc})`, () => {
    const first = at(4 + dr, 4 + dc);
    const second = at(4 + dr * 2, 4 + dc * 2);
    const end = at(4 + dr * 3, 4 + dc * 3);
    const result = resolveTurn(position({ black: [end], white: [first, second] }), { black: at(4, 4) });
    assert.equal(result.game.board[first], null);
    assert.equal(result.game.board[second], null);
    assert.equal(result.game.board[end], BLACK);
    assert.deepEqual(result.captures, { black: 1, white: 0 });
  });
}

test('one or three enemies and a wrapped row do not form a capture', () => {
  for (const count of [1, 3]) {
    const result = resolveTurn(position({ black: [count + 1], white: Array.from({ length: count }, (_, i) => i + 1) }), { black: 0 });
    assert.equal(result.captures.black, 0);
  }
  const result = resolveTurn(position({ black: [11], white: [9, 10] }), { black: 8 });
  assert.equal(result.captures.black, 0);
});

test('walking into an existing bracket is safe', () => {
  const result = resolveTurn(position({ black: [0, 3], white: [1] }), { white: 2 });
  assert.equal(result.game.board[2], WHITE);
  assert.deepEqual(result.captures, { black: 0, white: 0 });
});

test('an anticipated enemy placement can be captured in the same turn', () => {
  const result = resolveTurn(position({ black: [3], white: [1] }), { black: 0, white: 2 });
  assert.equal(result.game.board[2], null);
  assert.equal(result.captures.black, 1);
});

test('mutual captures still happen when both new anchors are themselves captured', () => {
  const game = position({ black: [at(4, 3), at(4, 7)], white: [at(4, 2), at(4, 6)], eggs: [0, 8] });
  const result = resolveTurn(game, { black: at(4, 4), white: at(4, 5) });
  for (const column of [3, 4, 5, 6]) assert.equal(result.game.board[at(4, column)], null);
  assert.deepEqual(result.captures, { black: 1, white: 1 });
  assert.equal(result.game.board[0], null);
  assert.equal(result.game.board[8], EGG);
  assert.equal(result.events.filter(event => event.type === 'hatch_cancel').length, 1);
});

const twoBlackCaptures = {
  black: [at(4, 7), at(7, 4)],
  white: [at(4, 5), at(4, 6), at(5, 4), at(6, 4)]
};

test('each capture hatches an egg and FIFO follows creation order, not cell order', () => {
  const game = position({ ...twoBlackCaptures, eggs: [8, 0, 80], eggNumbers: { 8: 10, 0: 11, 80: 12 }, nextEggNumber: 13 });
  const result = resolveTurn(game, { black: at(4, 4) });
  assert.deepEqual(result.captures, { black: 2, white: 0 });
  assert.deepEqual(result.events.filter(event => event.type === 'hatch').map(event => [event.cell, event.eggNumber]), [[8, 10], [0, 11]]);
  assert.deepEqual(result.game.eggs, [80]);
  assert.deepEqual(result.game.eggNumbers, { 80: 12 });
  const next = resolveTurn(result.game, { black: 1, white: 1 });
  assert.equal(next.game.eggNumbers[1], 13);
});

test('opposing claims dissolve one oldest egg per pair and hatch the remainder', () => {
  const game = position({
    black: [...twoBlackCaptures.black, at(1, 2), at(1, 3)],
    white: [...twoBlackCaptures.white, at(1, 1)],
    eggs: [0, 8, 80]
  });
  const result = resolveTurn(game, { black: at(4, 4), white: at(1, 4) });
  assert.deepEqual(result.captures, { black: 2, white: 1 });
  assert.equal(result.game.board[0], null);
  assert.equal(result.game.board[8], BLACK);
  assert.equal(result.game.board[80], EGG);
});

test('multiple opposing claim pairs dissolve multiple eggs without reusing claims', () => {
  const game = position({
    black: [...twoBlackCaptures.black, at(1, 2), at(1, 3), at(1, 5), at(1, 6)],
    white: [...twoBlackCaptures.white, at(1, 1), at(1, 7)],
    eggs: [0, 8, 80]
  });
  const result = resolveTurn(game, { black: at(4, 4), white: at(1, 4) });
  assert.deepEqual(result.captures, { black: 2, white: 2 });
  assert.deepEqual(result.events.filter(event => event.type === 'hatch_cancel').map(event => event.cell), [0, 8]);
  assert.deepEqual(result.game.eggs, [80]);
});

test('captured eggs leave the queue before the surviving oldest egg hatches', () => {
  const game = position({ black: [at(4, 7)], white: [at(4, 6)], eggs: [at(4, 5), 8, 0] });
  const result = resolveTurn(game, { black: at(4, 4) });
  assert.equal(result.game.board[at(4, 5)], null);
  assert.equal(result.game.board[8], BLACK);
  assert.deepEqual(result.game.eggs, [0]);
  assert.deepEqual(result.game.eggNumbers, { 0: 3 });
});

test('hatched turtles cascade captures, without reusing earlier rewards', () => {
  const game = position({ black: [at(4, 7), 3], white: [at(4, 5), at(4, 6), 1, 2], eggs: [0, 8, 80] });
  const result = resolveTurn(game, { black: at(4, 4) });
  assert.deepEqual(result.captures, { black: 2, white: 0 });
  assert.equal(result.game.board[1], null);
  assert.equal(result.game.board[2], null);
  assert.deepEqual(result.events.filter(event => event.type === 'hatch').map(event => event.cell), [0, 8]);
  assert.deepEqual(result.game.eggs, [80]);
});

test('two simultaneous hatched anchors bracketing the same pair earn one reward', () => {
  const game = position({ ...twoBlackCaptures, white: [...twoBlackCaptures.white, 1, 2], eggs: [0, 3, 8, 80] });
  const result = resolveTurn(game, { black: at(4, 4) });
  assert.equal(result.captures.black, 3);
  assert.deepEqual(result.events.filter(event => event.type === 'hatch').map(event => event.cell), [0, 3, 8]);
  assert.deepEqual(result.game.eggs, [80]);
});

test('capture rewards are not saved until a later turn', () => {
  const first = resolveTurn(position({ black: [3], white: [1, 2] }), { black: 0 });
  const second = resolveTurn(first.game, { black: 8, white: 8 });
  assert.equal(second.game.board[8], EGG);
  assert.deepEqual(second.game.eggs, [8]);
});

for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
  test(`five or more wins in line direction (${dr}, ${dc})`, () => {
    const cells = Array.from({ length: 5 }, (_, distance) => at(2 + dr * distance, 4 + dc * distance));
    const result = resolveTurn(position({ black: cells.slice(0, 4) }), { black: cells[4] });
    assert.equal(result.game.state, 'finished');
    assert.equal(result.game.winner, BLACK);
    assert.equal(result.outcome.winningCounts.black, 5);
  });
}

test('official victory counts the union of winning lines, not the longest line', () => {
  const cross = [...Array.from({ length: 5 }, (_, col) => at(4, col)), ...[2, 3, 5, 6].map(row => at(row, 2))];
  const board = position({ black: cross, white: Array.from({ length: 8 }, (_, col) => at(0, col)) }).board;
  const result = resultFor(board);
  assert.equal(result.winner, BLACK);
  assert.deepEqual(result.winningCounts, { black: 9, white: 8 });
  assert.deepEqual(result.lineLengths, { black: 5, white: 8 });
  const twoLines = position({ black: cross, white: [0, 8].flatMap(row => Array.from({ length: 5 }, (_, col) => at(row, col))) });
  assert.equal(resultFor(twoLines.board).winner, WHITE);
  assert.equal(resultFor(twoLines.board).winningCounts.white, 10);
});

test('equal winning counts continue in sudden death and are recomputed each turn', () => {
  const game = position({ black: [0, 1, 2, 3], white: [72, 73, 74, 75] });
  const equal = resolveTurn(game, { black: 4, white: 76 });
  assert.equal(equal.game.state, 'sudden_death');
  assert.equal(equal.game.winner, null);
  const extended = resolveTurn(equal.game, { white: 77 });
  assert.equal(extended.game.winner, WHITE);
  assert.equal(extended.game.state, 'finished');
});

test('victory is checked after captures break a line created by placement', () => {
  const game = position({ black: [at(4, 0), at(4, 1), at(4, 2), at(4, 3), at(5, 4)], white: [at(6, 4)] });
  const result = resolveTurn(game, { black: at(4, 4), white: at(3, 4) });
  assert.equal(result.game.board[at(4, 4)], null);
  assert.equal(result.outcome.winningCounts.black, 0);
  assert.equal(result.game.state, 'playing');
});

test('a full board without a winner draws and rejects further turns', () => {
  const board = Array(81).fill(EGG);
  board[80] = null;
  const result = resolveTurn(createGame({ board }), { black: 80, white: 80 });
  assert.equal(result.game.state, 'draw');
  assert.equal(resultFor(result.game.board).state, 'draw');
  assert.throws(() => resolveTurn(result.game, {}), /finished/);
});
