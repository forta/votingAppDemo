'use strict';

/**
 * Pure What the Shell rules engine. It has no database, HTTP or CLI state.
 * Board coordinates are zero-based indexes, row-major, on a 9x9 board.
 * Black is the team's resolved ballot choice; white is the bot's private
 * preselected move. resolveTurn applies both simultaneously and checks outcomes.
 */
const SIZE = 9;
const EMPTY = null;
const EGG = 'egg';
const BLACK = 'black';
const WHITE = 'white';
const DIRECTIONS = [[1, 0], [0, 1], [1, 1], [1, -1]];
const ALL_DIRECTIONS = DIRECTIONS.flatMap(([dr, dc]) => [[dr, dc], [-dr, -dc]]);

function index(row, column) {
  if (!Number.isInteger(row) || !Number.isInteger(column) || row < 0 || row >= SIZE || column < 0 || column >= SIZE) return -1;
  return row * SIZE + column;
}
function rowOf(cell) { return Math.floor(cell / SIZE); }
function columnOf(cell) { return cell % SIZE; }
function step(cell, dr, dc, distance = 1) { return index(rowOf(cell) + dr * distance, columnOf(cell) + dc * distance); }
function other(color) { return color === BLACK ? WHITE : BLACK; }

function validateBoard(board) {
  if (!Array.isArray(board) || board.length !== SIZE * SIZE) throw new Error('A What the Shell board must contain 81 cells');
  for (const cell of board) if (![EMPTY, EGG, BLACK, WHITE].includes(cell)) throw new Error('Invalid board cell');
}

function createGame(options = {}) {
  const board = options.board === undefined ? Array(SIZE * SIZE).fill(EMPTY) : options.board.slice();
  validateBoard(board);
  const eggs = options.eggs === undefined ? board.flatMap((cell, cellIndex) => cell === EGG ? [cellIndex] : []) : options.eggs.slice();
  if (new Set(eggs).size !== eggs.length || eggs.some(cell => !Number.isInteger(cell) || board[cell] !== EGG)
    || eggs.length !== board.filter(cell => cell === EGG).length) throw new Error('Invalid egg order');
  const eggNumbers = {};
  let previousNumber = 0;
  for (const cell of eggs) {
    const number = options.eggNumbers?.[cell] ?? previousNumber + 1;
    if (!Number.isSafeInteger(number) || number <= previousNumber) throw new Error('Invalid egg number');
    eggNumbers[cell] = number;
    previousNumber = number;
  }
  const nextEggNumber = options.nextEggNumber ?? previousNumber + 1;
  if (!Number.isSafeInteger(nextEggNumber) || nextEggNumber <= previousNumber) throw new Error('Invalid next egg number');
  const turn = options.turn ?? 0;
  if (!Number.isSafeInteger(turn) || turn < 0) throw new Error('Invalid turn');
  const state = options.state ?? 'playing';
  if (!['playing', 'sudden_death', 'finished', 'draw'].includes(state)) throw new Error('Invalid game state');
  return {
    version: 1,
    size: SIZE,
    turn,
    board,
    eggs,
    eggNumbers,
    nextEggNumber,
    state,
    winner: options.winner || null
  };
}

function legalCells(game) { return ['finished', 'draw'].includes(game.state) ? [] : game.board.flatMap((cell, cellIndex) => cell === EMPTY ? [cellIndex] : []); }
function legalCoordinates(game) { return legalCells(game).map(cell => ({ cell, row: rowOf(cell), column: columnOf(cell) })); }

function normalizeMove(move) {
  if (Number.isInteger(move)) return move;
  if (move && Number.isInteger(move.cell)) return move.cell;
  if (move && Number.isInteger(move.row) && Number.isInteger(move.column)) return index(move.row, move.column);
  throw new Error('A move must identify a board cell');
}

function collectCaptures(board, color, anchors) {
  const enemy = other(color);
  const captures = [];
  const seen = new Set();
  for (const anchor of anchors) {
    if (board[anchor] !== color) continue;
    for (const [dr, dc] of ALL_DIRECTIONS) {
      const first = step(anchor, dr, dc);
      const second = step(anchor, dr, dc, 2);
      const end = step(anchor, dr, dc, 3);
      if (first < 0 || second < 0 || end < 0 || (board[first] !== enemy && board[first] !== EGG)
        || (board[second] !== enemy && board[second] !== EGG) || board[end] !== color) continue;
      const key = `${Math.min(first, second)}:${Math.max(first, second)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      captures.push({ color, anchor, cells: [first, second] });
    }
  }
  return captures;
}

function removeCaptured(game, captures) {
  const removed = new Set(captures.flatMap(capture => capture.cells));
  for (const cell of removed) {
    game.board[cell] = EMPTY;
    delete game.eggNumbers[cell];
  }
  game.eggs = game.eggs.filter(cell => !removed.has(cell));
}

function consumeEgg(game, color, events) {
  if (!game.eggs.length) return null;
  const cell = game.eggs.shift();
  const eggNumber = game.eggNumbers[cell];
  delete game.eggNumbers[cell];
  game.board[cell] = color;
  events.push(color === EMPTY ? { type: 'hatch_cancel', cell, eggNumber } : { type: 'hatch', color, cell, eggNumber });
  return cell;
}

function winningCells(board, color) {
  const winning = new Set();
  for (let cell = 0; cell < board.length; cell++) {
    if (board[cell] !== color) continue;
    for (const [dr, dc] of DIRECTIONS) {
      const previous = step(cell, -dr, -dc);
      if (previous >= 0 && board[previous] === color) continue;
      const line = [];
      let current = cell;
      while (current >= 0 && board[current] === color) { line.push(current); current = step(current, dr, dc); }
      if (line.length >= 5) line.forEach(item => winning.add(item));
    }
  }
  return winning;
}

function longestLine(board, color) {
  let longest = 0;
  for (let cell = 0; cell < board.length; cell++) {
    if (board[cell] !== color) continue;
    for (const [dr, dc] of DIRECTIONS) {
      const previous = step(cell, -dr, -dc);
      if (previous >= 0 && board[previous] === color) continue;
      let length = 0; let current = cell;
      while (current >= 0 && board[current] === color) { length += 1; current = step(current, dr, dc); }
      longest = Math.max(longest, length);
    }
  }
  return longest;
}

function resultFor(board) {
  validateBoard(board);
  const black = winningCells(board, BLACK);
  const white = winningCells(board, WHITE);
  const blackLength = longestLine(board, BLACK); const whiteLength = longestLine(board, WHITE);
  const details = {
    winningCells: { black: [...black], white: [...white] },
    winningCounts: { black: black.size, white: white.size },
    lineLengths: { black: blackLength, white: whiteLength },
    lineLength: Math.max(blackLength, whiteLength)
  };
  if (black.size > white.size) return { state: 'finished', winner: BLACK, ...details };
  if (white.size > black.size) return { state: 'finished', winner: WHITE, ...details };
  if (board.every(cell => cell !== EMPTY)) return { state: 'draw', winner: null, ...details };
  return { state: black.size ? 'sudden_death' : 'playing', winner: null, ...details };
}

// Apply both moves to one copy of the current board before evaluating outcomes.
function resolveTurn(game, moves) {
  if (!game || !Array.isArray(game.board) || game.board.length !== SIZE * SIZE) throw new Error('Invalid game state');
  if (game.state === 'finished' || game.state === 'draw') throw new Error('Game is already finished');
  const next = createGame(game);
  const blackMove = moves?.black === null || moves?.black === undefined ? null : normalizeMove(moves.black);
  const whiteMove = moves?.white === null || moves?.white === undefined ? null : normalizeMove(moves.white);
  for (const move of [blackMove, whiteMove]) if (move !== null && (move < 0 || game.board[move] !== EMPTY)) throw new Error('Both moves must target empty cells');

  const events = [];
  const anchors = { black: [], white: [] };
  if (blackMove !== null && blackMove === whiteMove) {
    next.board[blackMove] = EGG;
    next.eggs.push(blackMove);
    const eggNumber = next.nextEggNumber++;
    next.eggNumbers[blackMove] = eggNumber;
    events.push({ type: 'collision', cell: blackMove, eggNumber });
  } else {
    if (blackMove !== null) { next.board[blackMove] = BLACK; anchors.black.push(blackMove); events.push({ type: 'placement', color: BLACK, cell: blackMove }); }
    if (whiteMove !== null) { next.board[whiteMove] = WHITE; anchors.white.push(whiteMove); events.push({ type: 'placement', color: WHITE, cell: whiteMove }); }
  }

  const totalCaptures = { black: 0, white: 0 };
  while (anchors.black.length || anchors.white.length) {
    const captures = [...collectCaptures(next.board, BLACK, anchors.black), ...collectCaptures(next.board, WHITE, anchors.white)];
    if (!captures.length) break;
    // Capture both colors from the same position, including anchors being captured.
    removeCaptured(next, captures);
    const claims = { black: 0, white: 0 };
    captures.forEach(capture => { totalCaptures[capture.color]++; claims[capture.color]++; });
    events.push({ type: 'capture', captures: captures.map(capture => ({ color: capture.color, cells: capture.cells.slice() })) });
    anchors.black = [];
    anchors.white = [];
    // Each claim is spent once in this wave; excess claims are never banked.
    const paired = Math.min(claims.black, claims.white);
    for (let claim = 0; claim < paired && next.eggs.length; claim++) consumeEgg(next, EMPTY, events);
    for (const color of [BLACK, WHITE]) {
      for (let claim = paired; claim < claims[color] && next.eggs.length; claim++) {
        anchors[color].push(consumeEgg(next, color, events));
      }
    }
  }

  next.turn++;
  const outcome = resultFor(next.board);
  next.state = outcome.state;
  next.winner = outcome.winner;
  return { game: next, events, captures: totalCaptures, outcome };
}

const engine = { SIZE, EMPTY, EGG, BLACK, WHITE, createGame, legalCells, legalCoordinates, resolveTurn, winningCells, longestLine, resultFor, index, rowOf, columnOf };
if (require.main === module) {
  const game = createGame();
  const turn = resolveTurn(game, { black: index(4, 4), white: index(0, 0) });
  console.log(JSON.stringify({ turn: turn.game.turn, state: turn.game.state, events: turn.events }));
} else module.exports = engine;
