'use strict';

const path = require('node:path');
const fs = require('node:fs');

function loadEnvironment() {
  if (process.env.MULTIBOT_ENV_FILE) {
    const file = fs.realpathSync(process.env.MULTIBOT_ENV_FILE);
    const root = fs.realpathSync(path.join(__dirname, '..'));
    const relative = path.relative(root, file);
    if (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
      throw new Error('MULTIBOT_ENV_FILE must be outside the multi-bot directory.');
    }
    const result = require('dotenv').config({ path: file, quiet: true });
    if (result.error) throw new Error('Cannot load the external environment file.');
  } else {
    // The local development .env is ignored by Git. Deployments should use an
    // injected environment or point MULTIBOT_ENV_FILE outside this project.
    const localFile = path.join(__dirname, '..', '.env');
    if (fs.existsSync(localFile)) require('dotenv').config({ path: localFile, quiet: true });
  }
  // The linked CLI must not load its development account credentials.
  process.env.CLI_LOAD_ENV = 'false';
}

function configuration(env = process.env) {
  return {
    host: env.GAME_HOST || '127.0.0.1', port: Number(env.GAME_PORT || 3100),
    serverUrl: env.CLI_SERVER_URL || 'http://localhost:3000',
    functionalityId: env.WTS_FUNCTIONALITY_ID || 'whattheshell',
    botId: env.WTS_BOT_API_KEY_ID || '', botSecret: env.WTS_BOT_SECRET || '',
    botPollIntervalMs: Number(env.WTS_BOT_POLL_INTERVAL_MS || 5000),
    botMaxTurns: Number(env.WTS_BOT_MAX_TURNS || 500),
    lang: env.WTS_LANGUAGE || 'es'
  };
}

module.exports = { loadEnvironment, configuration };
