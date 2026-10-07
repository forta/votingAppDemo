#!/usr/bin/env node
'use strict';

/**
 * Runs the What the Shell sequence bot against the voting backend.
 * The bot chooses white before each team ballot, resolves both moves together,
 * and stores rules-engine checkpoints in the sequence so a paused game can be
 * resumed after the bot process restarts.
 */

const { randomInt } = require('node:crypto');
const engine = require('./whattheshell-engine');
const { chooseMachineMove } = require('./whattheshell-strategy');
const request = require('./whattheshell-request');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const quote = value => `'${JSON.stringify(value).replace(/'/g, '\\u0027')}'`;

function readArguments(args, env = process.env) {
  const options = { sequenceId: null, apiKeyId: null, secret: env.WTS_BOT_SECRET || null, pollIntervalMs: 3000, maxTurns: 500, seed: undefined, lang: 'es' };
  const aliases = { '--sequenceId': 'sequenceId', '--sequence-id': 'sequenceId', '--apiKeyId': 'apiKeyId', '--api-key-id': 'apiKeyId', '--secret': 'secret', '--poll-interval': 'pollIntervalMs', '--max-turns': 'maxTurns', '--seed': 'seed', '--lang': 'lang' };
  for (let i = 0; i < args.length; i += 1) {
    const [flag, inline] = args[i].split(/=(.*)/s, 2); const key = aliases[flag];
    if (!key) throw new Error(`Unknown argument: ${flag}`);
    const value = inline === undefined ? args[++i] : inline;
    if (!value) throw new Error(`Missing value for ${flag}`);
    options[key] = ['pollIntervalMs', 'maxTurns', 'seed'].includes(key) ? Number(value) : value;
  }
  if (!options.sequenceId || !options.apiKeyId) throw new Error('Sequence ID and API key ID are required.');
  if (!options.secret) throw new Error('Set WTS_BOT_SECRET or pass --secret.');
  if (!Number.isInteger(options.pollIntervalMs) || options.pollIntervalMs < 250) throw new Error('--poll-interval must be at least 250.');
  if (!Number.isInteger(options.maxTurns) || options.maxTurns < 1) throw new Error('--max-turns must be positive.');
  if (options.seed !== undefined && !Number.isSafeInteger(options.seed)) throw new Error('--seed must be an integer.');
  if (!['en', 'es', 'eo'].includes(options.lang)) throw new Error('--lang must be en, es or eo.');
  return options;
}

function randomSource(seed, restoredState) {
  let state = restoredState === undefined ? seed >>> 0 : restoredState >>> 0;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
  random.getState = () => state;
  return random;
}
function formatCell(cell) { if (cell === null || cell === undefined) return 'none'; const value = Number(cell); if (!Number.isInteger(value) || value < 0 || value >= 81) return String(cell); return `(${'abcdefghj'[value % 9]}, ${Math.floor(value / 9) + 1})`; }
function choicesFor(cells) { return cells.map(cell => ({ type: 'text', text: String(cell) })); }
function createBallotCommand(options, sequence, turn, cells) {
  return `ballots create --title="What the Shell · turn ${turn + 1}" --space=${sequence.spaceId} ` +
    `--options=${quote(choicesFor(cells))} --state=ready --seq=${sequence.seqId}`;
}
// Translate the backend's resolved ballot winner to the current legal-cell list.
function winnerIndex(results, cells) {
  if (results?.finalResult?.hasWinner !== true) return null;
  const winner = results.finalResult.winningOption;
  if (winner === null || winner === undefined) return null;
  const text = typeof winner === 'string' ? winner : winner.text;
  const index = Number.isInteger(winner.choiceId) ? winner.choiceId : cells.findIndex(cell => String(cell) === text);
  return Number.isInteger(index) && index >= 0 && index < cells.length ? index : null;
}

/** Authenticate, wait for the game, and run turns until completion or pause. */
async function run(options, dependencies = {}) {
  const client = dependencies.client || new (require('../CLI/lib'))(); const wait = dependencies.wait || sleep;
  const choose = dependencies.chooseMachineMove || chooseMachineMove;
  const messages = require(`../public/whattheshell_${options.lang || 'es'}.json`);
  const translate = (key, values = {}) => Object.entries(values).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), messages[key] || key);
  const output = dependencies.output || console.log; const command = async (text, token) => {
    const result = await request(() => client._execRemote(text, token), wait); if (!result?.success) throw new Error(result?.error || `Command failed: ${text}`); return result.data;
  };
  const login = dependencies.token ? null : await request(() => client._httpRequest('POST', '/api/auth/login', { type: 'user', credentials: { email: options.apiKeyId, password: options.secret } }), wait);
  if (!dependencies.token && (!login.access_token || login.identity?.type !== 'apikey' || (login.identity.apiKeyId || login.identity.id) !== options.apiKeyId)) throw new Error('The supplied credentials are not the requested API key.');
  const token = dependencies.token || login.access_token; let sequence = await command(`seqs get --id=${options.sequenceId}`, token);
  if (sequence.botUserId !== options.apiKeyId || sequence.botMode !== 'sequence_bot') throw new Error('Assign this API key to the sequence in sequence_bot mode first.');
  if (sequence.state === 'finished') return { status: 'finished', turns: sequence.currentTurn || 0 };
  if (!['waiting', 'playing', 'paused'].includes(sequence.state)) throw new Error(`Sequence must be waiting, playing or paused (state: ${sequence.state}).`);
  const saved = await command(`seqs seq-state-get --id=${sequence.seqId}`, token);
  let checkpoint = saved?.seqState || null;
  if (checkpoint && (checkpoint.application !== 'whattheshell' || checkpoint.version !== 1)) {
    throw new Error('The sequence state belongs to another application or an unsupported What the Shell state version.');
  }
  if (!checkpoint && (sequence.ballotIds || []).length) {
    throw new Error('This sequence has ballots but no What the Shell checkpoint; it cannot be safely resumed.');
  }
  const seed = checkpoint?.seed ?? options.seed ?? randomInt(0x100000000);
  const random = randomSource(seed, checkpoint?.randomState);
  let game = checkpoint ? engine.createGame(checkpoint.game) : engine.createGame();
  let history = [...(sequence.turnHistory || [])];
  const saveCheckpoint = async next => {
    checkpoint = { application: 'whattheshell', version: 1, ...next };
    await command(`seqs seq-state-set --id=${sequence.seqId} --value=${quote(checkpoint)}`, token);
  };
  const persist = state => command(`seqs state --id=${sequence.seqId} --state=${state} --history=${quote(history)}`, token);
  const waitUntilPlaying = async () => {
    while (sequence.state === 'paused') {
      await wait(options.pollIntervalMs);
      sequence = await command(`seqs get --id=${sequence.seqId}`, token);
      if (['finished', 'deleted'].includes(sequence.state)) return false;
    }
    return sequence.state === 'playing';
  };
  const waitForClosure = async ballotId => {
    while (true) {
      await wait(options.pollIntervalMs);
      sequence = await command(`seqs get --id=${sequence.seqId}`, token);
      if (['finished', 'deleted'].includes(sequence.state)) return null;
      if (sequence.state === 'paused' && !await waitUntilPlaying()) return null;
      if (sequence.ballotIds?.at(-1) !== ballotId) throw new Error('Another runner changed the sequence ballot.');
      const current = await command(`ballots select --id=${ballotId}`, token);
      if (current.state === 'canceled') { await persist('paused'); return null; }
      if (current.closed || current.state === 'closed') return current;
    }
  };
  const finish = async (outcome, reason) => {
    if (checkpoint?.completed) return { status: 'finished', reason, turns: game.turn, outcome };
    const message = reason === 'inactivity' ? translate('gameInactive') : outcome.winner
      ? translate('gameWon', { color: translate(outcome.winner) }) : translate('gameDraw');
    output(message);
    let ending = checkpoint?.ending;
    if (!ending) {
      ending = { ballotId: null, reason, outcome, message };
      await saveCheckpoint({ ...checkpoint, ending });
    }
    if (!ending.ballotId) {
      const newestBallotId = sequence.ballotIds?.at(-1);
      let ballotId = newestBallotId && newestBallotId !== checkpoint.lastProcessedBallotId ? newestBallotId : null;
      if (!ballotId) {
        // The final acknowledgment is a regular ballot; only the host closes it.
        const created = await command(`ballots create --title=${quote(translate('gameEndTitle'))} --space=${sequence.spaceId} --seq=${sequence.seqId} --state=ready --options=${quote([{ type: 'text', text: translate('accept') }])} --descriptionJson=${quote(message)}`, token);
        ballotId = created.ballotId;
      }
      ending = { ...ending, ballotId };
      await saveCheckpoint({ ...checkpoint, ending });
    }
    if (!history.some(entry => entry.ballotId === ending.ballotId)) {
      history.push({ turn: game.turn, ballotId: ending.ballotId, ending: true, reason, board: [...game.board], eggNumbers: { ...game.eggNumbers }, outcome });
    }
    await persist('playing');
    const closed = await waitForClosure(ending.ballotId);
    if (!closed) return { status: sequence.state, turns: game.turn, outcome };
    // Assigned bots use seqs state; seqs finish is creator-only.
    await persist('finished');
    await saveCheckpoint({ ...checkpoint, ending: null, completed: true });
    return { status: 'finished', reason, turns: game.turn, outcome };
  };
  output(`What the Shell bot connected to ${sequence.seqId}`);
  if (sequence.state === 'waiting' || sequence.state === 'paused') {
    output('Waiting for a slot holder to start the game...');
    while (['waiting', 'paused'].includes(sequence.state)) {
      await wait(options.pollIntervalMs);
      sequence = await command(`seqs get --id=${sequence.seqId}`, token);
    }
    if (sequence.state !== 'playing') return { status: sequence.state, turns: 0 };
    output('Game started.');
  }
  if (!checkpoint) {
    checkpoint = {
      application: 'whattheshell', version: 1, seed, randomState: random.getState(),
      game, pending: null, lastProcessedBallotId: null, lastOutcome: null, ending: null, completed: false
    };
    await saveCheckpoint(checkpoint);
  }
  if (checkpoint.historyEntryPending) {
    if (!history.some(entry => entry.ballotId === checkpoint.historyEntryPending.ballotId)) history.push(checkpoint.historyEntryPending);
    await persist(sequence.state);
    await saveCheckpoint({ ...checkpoint, historyEntryPending: null });
  }
  if (checkpoint.ending || ['finished', 'draw'].includes(game.state)) {
    const ending = checkpoint.ending;
    return finish(ending?.outcome || checkpoint.lastOutcome || { state: game.state, winner: game.winner }, ending?.reason || game.state);
  }
  for (let processedTurns = 0; processedTurns < options.maxTurns;) {
    const legal = engine.legalCells(game); if (!legal.length) break;
    let pending = checkpoint.pending;
    if (!pending) {
      // Persist the private machine move before opening a ballot so a process
      // restart cannot choose a different move for an already-open turn.
      pending = { turn: game.turn, white: choose(game, random), ballotId: null };
      await saveCheckpoint({ ...checkpoint, game, seed, randomState: random.getState(), pending });
    }
    let ballotId = pending.ballotId;
    if (!ballotId) {
      const newestBallotId = sequence.ballotIds?.at(-1);
      if (newestBallotId && newestBallotId !== checkpoint.lastProcessedBallotId) {
        ballotId = newestBallotId;
      } else {
        const ballot = await command(createBallotCommand(options, sequence, pending.turn, legal), token);
        ballotId = ballot.ballotId;
        output(`Turn ${pending.turn + 1}: ballot ${ballotId} (${legal.length} cells)`);
      }
      pending = { ...pending, ballotId };
      await saveCheckpoint({ ...checkpoint, pending });
    }
    const closed = await waitForClosure(ballotId);
    if (!closed) return { status: sequence.state, turns: game.turn };
    const results = await command(`ballots results --id=${ballotId}`, token);
    if (Number(results.ballotSummary?.totalVotes || 0) === 0) {
      // A zero-vote round is not a move: keep the board and turn untouched.
      output('No votes received. Pausing without applying either move.');
      await persist('paused');
      await saveCheckpoint({ ...checkpoint, game, pending: null, lastProcessedBallotId: ballotId });
      sequence = await command(`seqs get --id=${sequence.seqId}`, token);
      if (!await waitUntilPlaying()) return { status: sequence.state, turns: game.turn };
      output('Game resumed at the same board position.');
      continue;
    }
    // A ballot may contain votes but no winner (for example, a non-random tie).
    // In that case black passes while the already-selected white move proceeds.
    const selected = winnerIndex(results, legal);
    const publicState = await command(`slotseqs public --seq=${sequence.seqId}`, token);
    const completed = publicState.lastCompletedBallot;
    const votesBySlot = completed?.ballotId === ballotId ? completed.votes : [];
    if (votesBySlot.length) {
      output('Votes received:');
      votesBySlot.forEach(slot => output(`  Slot ${slot.slotNumber}${slot.alias ? ` (${slot.alias})` : ''}: ${formatCell(legal[slot.choiceId])}`));
    } else {
      output('Votes received: none');
    }
    const winnerText = selected === null ? null : legal[selected];
    output(`Winning option: ${winnerText === null ? 'none' : formatCell(winnerText)}`);
    const black = selected === null ? null : legal[selected];
    output(`Computer move (white): ${formatCell(pending.white)}`);
    const resolved = engine.resolveTurn(game, { black, white: pending.white }); game = resolved.game;
    const historyEntry = { turn: game.turn, ballotId, black, white: pending.white, winner: black, board: [...game.board], eggs: [...game.eggs], eggNumbers: { ...game.eggNumbers }, nextEggNumber: game.nextEggNumber, resolvedAt: new Date().toISOString(), outcome: resolved.outcome, events: resolved.events };
    history.push(historyEntry);
    await saveCheckpoint({ ...checkpoint, game, pending: null, lastProcessedBallotId: ballotId, lastOutcome: resolved.outcome, historyEntryPending: historyEntry });
    sequence = await command(`seqs get --id=${sequence.seqId}`, token);
    // Sequence bots may record history and lifecycle state, while the backend
    // owns ballot membership and turn counters.
    if (['paused', 'finished', 'deleted'].includes(sequence.state)) return { status: sequence.state, turns: game.turn };
    await persist('playing');
    await saveCheckpoint({ ...checkpoint, historyEntryPending: null });
    output(`Resolved turn ${game.turn}: team=${formatCell(black)}, machine=${formatCell(pending.white)}`);
    const outcome = resolved.outcome;
    if (outcome.state === 'finished' || outcome.state === 'draw') {
      return finish(outcome, outcome.state);
    }
    processedTurns += 1;
  }
  await persist('paused'); return { status: 'paused', reason: 'max-turns', turns: game.turn };
}

function usage() { return 'Usage: node cli-scripts/whattheshell-bot.js --sequenceId=<id> --apiKeyId=<id> [--secret=<secret>] [--poll-interval=3000] [--max-turns=500] [--seed=123] [--lang=es]'; }
if (require.main === module) Promise.resolve().then(() => run(readArguments(process.argv.slice(2)))).catch(error => { console.error(`What the Shell bot stopped: ${error.message}`); console.error(usage()); process.exitCode = 1; });
module.exports = { readArguments, choicesFor, winnerIndex, chooseMachineMove, formatCell, run };
