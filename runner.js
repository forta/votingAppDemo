'use strict';

/**
 * Operator tool for running a fixed list of What the Shell bots in one process.
 * The generic web GameManager is separate and supports multiple adapters.
 */

const fs = require('node:fs/promises');
const bot = require('./game/whattheshell-bot');

function readGames(rows, env = process.env) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('Provide a non-empty games array.');
  const seen = new Set();
  return rows.map(row => {
    if (!row || typeof row.secretEnv !== 'string' || !env[row.secretEnv]) throw new Error('Each game needs a populated secretEnv variable.');
    const options = bot.readArguments([
      `--sequenceId=${row.sequenceId || ''}`, `--apiKeyId=${row.apiKeyId || ''}`,
      `--poll-interval=${row.pollIntervalMs ?? 3000}`, `--max-turns=${row.maxTurns ?? 500}`,
      `--lang=${row.lang || 'es'}`, ...(row.seed === undefined ? [] : [`--seed=${row.seed}`])
    ], { WTS_BOT_SECRET: env[row.secretEnv] });
    if (seen.has(options.sequenceId)) throw new Error('A sequence can only have one bot in this runner.');
    seen.add(options.sequenceId);
    return options;
  });
}

async function runGames(games, run = bot.run, dependencies = {}) {
  // Each bot retains its own board and wait loop. A failure does not stop peers.
  return Promise.allSettled(games.map(options => Promise.resolve().then(() => run(options, {
    ...dependencies,
    output: message => console.log(`[${options.sequenceId}] ${message}`)
  })).catch(error => {
    console.error(`[${options.sequenceId}] ${error.message}`);
    throw error;
  })));
}

if (require.main === module) {
  Promise.resolve().then(async () => {
    const { loadEnvironment, configuration } = require('./lib/config');
    loadEnvironment();
    const config = configuration();
    if (!process.argv[2]) throw new Error('Usage: node runner.js games.local.json');
    const games = readGames(JSON.parse(await fs.readFile(process.argv[2], 'utf8')));
    const { createVotingApiClient } = require('./lib/voting-api');
    const client = createVotingApiClient(config.serverUrl);
    const results = await runGames(games, bot.run, { client });
    if (results.some(result => result.status === 'rejected')) process.exitCode = 1;
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { readGames, runGames };
