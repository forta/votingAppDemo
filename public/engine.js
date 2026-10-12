(function (root) {
  'use strict';
  /* Minimal browser-side board helper used by the legacy WTS renderer.
   * The sequence bot's game/whattheshell-engine.js owns authoritative rules. */
  const SIZE = 9;
  function createGame() {
    return { version: 1, size: SIZE, turn: 0, board: Array(SIZE * SIZE).fill(null) };
  }
  function legalCells(game) {
    return game.board.flatMap((piece, index) => piece === null ? [index] : []);
  }
  function coordinate(index) {
    if (!Number.isInteger(index) || index < 0 || index >= SIZE * SIZE) throw new RangeError('Invalid cell');
    return `${'ABCDEFGHJ'[index % SIZE]}${Math.floor(index / SIZE) + 1}`;
  }
  const engine = { createGame, legalCells, coordinate };
  if (typeof module !== 'undefined' && module.exports) module.exports = engine;
  else root.DemoEngine = engine;
})(globalThis);
