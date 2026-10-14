'use strict';

/**
 * Loads VotingAppDemo environment settings and builds the list of supported
 * game integrations. This service requires no MongoDB configuration.
 */

const path = require('node:path');
const fs = require('node:fs');

function loadEnvironment() {
  if (process.env.WTS_ENV_FILE) {
    const file = fs.realpathSync(process.env.WTS_ENV_FILE);
    const root = fs.realpathSync(path.join(__dirname, '..'));
    const relative = path.relative(root, file);
    if (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
      throw new Error('WTS_ENV_FILE must be outside the VotingAppDemo directory.');
    }
    const result = require('dotenv').config({ path: file, quiet: true });
    if (result.error) throw new Error('Cannot load the external environment file.');
  } else {
    const localFile = path.join(__dirname, '..', '.env');
    if (fs.existsSync(localFile)) require('dotenv').config({ path: localFile, quiet: true });
  }
}

function configuration(env = process.env) {
  return {
    host: env.WTS_GAME_HOST || '127.0.0.1',
    port: Number(env.WTS_GAME_PORT || 3100),
    publicUrl: env.WTS_GAME_PUBLIC_URL || 'http://localhost:3100',
    serverUrl: env.WTS_CLI_SERVER_URL || 'http://localhost:3000',
    language: env.WTS_LANGUAGE || 'es',
    botPollIntervalMs: Number(env.WTS_BOT_POLL_INTERVAL_MS || 5000),
    botMaxTurns: Number(env.WTS_BOT_MAX_TURNS || 500),
    reconcileIntervalMs: Number(env.WTS_BOT_RECONCILE_INTERVAL_MS || 30000),
    games: [
      { functionalityId: 'whattheshell', apiKeyId: env.WTS_BOT_API_KEY_ID || '', secret: env.WTS_BOT_SECRET || '', adapter: 'whattheshell' },
      { functionalityId: 'ink', apiKeyId: env.INK_BOT_API_KEY_ID || '', secret: env.INK_BOT_SECRET || '', adapter: 'ink' }
    ]
  };
}

module.exports = { loadEnvironment, configuration };
