'use strict';

/**
 * Chooses the machine's white move using only the current board.
 * It values wins, blocks, line growth, and egg tactics without reading the
 * team's still-open ballot or predicting its next move.
 */

const engine = require('./whattheshell-engine');

const DIRECTIONS = [[0, 1], [1, 0], [1, 1], [1, -1]];
const TERMINAL = 1e9;
const WINDOW_WEIGHTS = [0, 0, 14, 360, 8500, 150000];
const LINES = [];
for (const [dr, dc] of DIRECTIONS) {
  for (let row = 0; row < engine.SIZE; row++) {
    for (let column = 0; column < engine.SIZE; column++) {
      if (engine.index(row - dr, column - dc) >= 0) continue;
      const line = [];
      for (let r = row, c = column; engine.index(r, c) >= 0; r += dr, c += dc) line.push(engine.index(r, c));
      LINES.push(line);
    }
  }
}

// Extract line threats and opportunities for one color without mutation.
function features(board, color) {
  const enemy = color === engine.WHITE ? engine.BLACK : engine.WHITE;
  const winningPoints = new Set();
  let value = 0;
  let longest = 0;
  let vulnerable = 0;
  for (const line of LINES) {
    let run = 0;
    for (const cell of line) {
      run = board[cell] === color ? run + 1 : 0;
      longest = Math.max(longest, run);
    }
    for (let start = 0; start + 5 <= line.length; start++) {
      let count = 0;
      let empty = -1;
      for (let offset = 0; offset < 5; offset++) {
        const cell = line[start + offset];
        if (board[cell] === color) count++;
        else if (board[cell] === null) empty = cell;
        else { count = 0; break; }
      }
      value += WINDOW_WEIGHTS[count];
      if (count === 4) winningPoints.add(empty);
    }
    for (let start = 0; start + 4 <= line.length; start++) {
      const [a, b, c, d] = line.slice(start, start + 4).map(cell => board[cell]);
      if (((a === enemy && d === null) || (d === enemy && a === null)) &&
          (b === color || b === engine.EGG) && (c === color || c === engine.EGG)) {
        vulnerable += Number(b === color) + Number(c === color);
      }
    }
  }
  // Multiple distinct winning squares include open fours and intersecting forks.
  value += winningPoints.size * 12000 + Math.max(0, winningPoints.size - 1) * 35000;
  value += longest >= 3 ? Math.pow(8, longest) * 3 : longest === 2 ? 40 : 0;
  value -= vulnerable * 1200;
  return { value, longest, winningPoints, vulnerable };
}

function evaluate(result) {
  if (result.outcome.winner === engine.WHITE) return TERMINAL;
  if (result.outcome.winner === engine.BLACK) return -TERMINAL;
  if (result.game.state === 'draw') return 0;
  const black = features(result.game.board, engine.BLACK);
  const white = features(result.game.board, engine.WHITE);
  // Defence takes precedence over comparable growth, while a real win takes all.
  return Math.max(-TERMINAL / 4, Math.min(TERMINAL / 4, white.value - 1.6 * black.value));
}

function randomIndex(length, random) {
  return Math.max(0, Math.min(length - 1, Math.floor(random() * length)));
}

function shuffled(items, random) {
  const copy = items.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = randomIndex(i + 1, random);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function bestIndex(values, maximize) {
  let best = 0;
  for (let i = 1; i < values.length; i++) {
    if (maximize ? values[i] > values[best] : values[i] < values[best]) best = i;
  }
  return best;
}

/** Approximate the zero-sum simultaneous game by fictitious play. */
function equilibrium(matrix, iterations) {
  const rowScores = Array(matrix.length).fill(0);
  const columnScores = Array(matrix[0].length).fill(0);
  const rowCounts = Array(matrix.length).fill(0);
  const columnCounts = Array(matrix[0].length).fill(0);
  let row = bestIndex(matrix.map(values => Math.min(...values)), true);
  let column = bestIndex(matrix[row], false);
  for (let iteration = 0; iteration < iterations; iteration++) {
    rowCounts[row]++;
    columnCounts[column]++;
    for (let i = 0; i < matrix.length; i++) rowScores[i] += matrix[i][column];
    for (let j = 0; j < matrix[0].length; j++) columnScores[j] += matrix[row][j];
    row = bestIndex(rowScores, true);
    column = bestIndex(columnScores, false);
  }
  const white = rowCounts.map(count => count / iterations);
  const black = columnCounts.map(count => count / iterations);
  const guaranteed = Math.min(...matrix[0].map((_, columnIndex) => matrix.reduce((sum, values, rowIndex) => sum + white[rowIndex] * values[columnIndex], 0)));
  return { white, black, value: guaranteed };
}

function candidateIndexes(probabilities, matrix, white, width) {
  const indexes = probabilities.map((_, index) => index);
  const quality = index => white ? Math.min(...matrix[index]) : -Math.max(...matrix.map(row => row[index]));
  return indexes.sort((a, b) => probabilities[b] - probabilities[a] || quality(b) - quality(a)).slice(0, width);
}

/**
 * All inputs are settled public state. No actual or proposed opposing move is accepted.
 * Every root action pair uses the rules engine, including collisions and hatch cascades.
 * The second turn is a bounded beam search, not a proof that the game is solved.
 */
// Compare candidate simultaneous outcomes against plausible black replies.
/** Return the selected move and diagnostics for a settled board position. */
function analyzePosition(game, random = Math.random, options = {}) {
  const legal = engine.legalCells(game);
  const stats = { evaluatedTurns: 0, depth: 1 };
  if (!legal.length || ['finished', 'draw'].includes(game.state)) return { move: null, policy: [], ...stats };
  const resolve = (position, black, white) => {
    stats.evaluatedTurns++;
    return engine.resolveTurn(position, { black, white });
  };
  const whites = shuffled(legal, random);
  // Passing remains a possible opposing action when the team sends no vote.
  const blacks = shuffled([...legal, null], random);
  const results = whites.map(white => blacks.map(black => resolve(game, black, white)));
  let matrix = results.map(row => row.map(evaluate));
  // Never randomize into an immediate defeat if an action avoids every such defeat.
  const safeRows = results.flatMap((row, index) => row.every(result => result.outcome.winner !== engine.BLACK) ? [index] : []);
  const rows = safeRows.length ? safeRows : whites.map((_, index) => index);
  matrix = rows.map(index => matrix[index]);
  const iterations = options.iterations ?? 6000;
  let solution = equilibrium(matrix, iterations);
  const own = features(game.board, engine.WHITE);
  const enemy = features(game.board, engine.BLACK);
  if (options.depth !== 1 && Math.max(own.longest, enemy.longest) >= 2 && legal.length > 2) {
    const rootWidth = Math.max(2, Math.min(12, options.rootWidth ?? 6));
    const childWidth = Math.max(2, Math.min(12, options.childWidth ?? 6));
    const rootRows = candidateIndexes(solution.white, matrix, true, rootWidth);
    const rootColumns = candidateIndexes(solution.black, matrix, false, rootWidth);
    const refined = rootRows.map(row => rootColumns.map(column => {
      const result = results[rows[row]][column];
      if (result.outcome.winner || result.game.state === 'draw') return matrix[row][column];
      const cells = engine.legalCells(result.game);
      if (!cells.length) return matrix[row][column];
      // Order continuations by exact one-sided outcomes, including capture/hatch effects.
      const priorities = cells.map(cell => ({
        cell,
        white: evaluate(resolve(result.game, null, cell)),
        black: evaluate(resolve(result.game, cell, null))
      }));
      const nextWhites = priorities.slice().sort((a, b) => b.white - a.white).slice(0, childWidth).map(item => item.cell);
      const nextBlacks = priorities.slice().sort((a, b) => a.black - b.black).slice(0, childWidth).map(item => item.cell);
      // Include collision defences against every selected tactical threat.
      for (const cell of nextBlacks.slice()) if (!nextWhites.includes(cell)) nextWhites.push(cell);
      for (const cell of nextWhites.slice()) if (!nextBlacks.includes(cell)) nextBlacks.push(cell);
      nextBlacks.push(null);
      const child = nextWhites.map(white => nextBlacks.map(black => evaluate(resolve(result.game, black, white))));
      return 0.92 * equilibrium(child, 1200).value + 0.08 * matrix[row][column];
    }));
    const deeper = equilibrium(refined, iterations);
    const proposed = Array(rows.length).fill(0);
    rootRows.forEach((row, index) => { proposed[row] = deeper.white[index]; });
    // The full first-turn matrix guards against threats omitted by the narrow search.
    const immediateFloor = Math.min(...blacks.map((_, column) => matrix.reduce((sum, values, row) => sum + proposed[row] * values[column], 0)));
    if (immediateFloor >= solution.value - Math.max(500, Math.abs(solution.value) * 0.04)) solution = { ...deeper, white: proposed };
    stats.depth = 2;
  }
  // Discard numerical exploration dust before drawing the committed machine move.
  const weights = solution.white.map(probability => probability >= 0.002 ? probability : 0);
  const sum = weights.reduce((total, weight) => total + weight, 0);
  const policy = rows.flatMap((row, index) => weights[index] ? [{ cell: whites[row], probability: weights[index] / sum }] : []);
  let draw = Math.max(0, Math.min(1, random()));
  let move = policy[policy.length - 1].cell;
  for (const item of policy) {
    draw -= item.probability;
    if (draw < 0) { move = item.cell; break; }
  }
  return { move, policy, value: solution.value, legalMoves: legal.length, immediateSafeMoves: safeRows.length, ...stats };
}

// Return a legal white move before the team's ballot is opened.
/** Public strategy entry point used by the bot and deterministic tests. */
function chooseMachineMove(game, random = Math.random, options = {}) {
  return analyzePosition(game, random, options).move;
}

module.exports = { chooseMachineMove, analyzePosition };
