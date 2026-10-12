'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { configuration } = require('../lib/config');

test('game player configuration has no database settings and reads both bot credentials', () => {
  assert.deepEqual(configuration({
    WTS_GAME_HOST: '0.0.0.0', WTS_GAME_PORT: '3200',
    WTS_GAME_PUBLIC_URL: 'https://games.example.test',
    WTS_CLI_SERVER_URL: 'https://api.example.test',
    WTS_BOT_API_KEY_ID: 'pk_wts', WTS_BOT_SECRET: 'wts-secret',
    INK_BOT_API_KEY_ID: 'pk_ink', INK_BOT_SECRET: 'ink-secret',
    WTS_BOT_POLL_INTERVAL_MS: '6000', WTS_BOT_MAX_TURNS: '250', WTS_LANGUAGE: 'en'
  }), {
    host: '0.0.0.0', port: 3200, publicUrl: 'https://games.example.test',
    serverUrl: 'https://api.example.test', language: 'en',
    botPollIntervalMs: 6000, botMaxTurns: 250,
    games: [
      { functionalityId: 'whattheshell', apiKeyId: 'pk_wts', secret: 'wts-secret', adapter: 'whattheshell' },
      { functionalityId: 'ink', apiKeyId: 'pk_ink', secret: 'ink-secret', adapter: 'ink' }
    ]
  });
});
