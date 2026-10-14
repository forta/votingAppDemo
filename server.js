'use strict';

/**
 * Standalone HTTP entry point for the generic game player. The main backend
 * can mount the same router modules without starting this separate listener. 
 */

const http = require('node:http');
const express = require('express');
const { createVotingApiClient } = require('./lib/voting-api');
const { GameManager } = require('./lib/game-manager');
const { createPlayerRouter } = require('./lib/player-router');

function createServer(client, options = {}) {
  const app = express();
  app.get('/health', (req, res) => res.json({ status: 'ok' }));
  app.use(express.json({ limit: '8kb' }));
  app.use(createPlayerRouter(express, client, options));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error.status === 429 && Number.isFinite(error.retryAfterMs)) res.set('Retry-After', String(Math.ceil(error.retryAfterMs / 1000)));
    const status = error.type === 'entity.too.large' ? 413 : error.status || 502;
    res.status(status).json({ success: false, error: error.message || 'Game service request failed.', ...(error.code ? { code: error.code } : {}) });
  });
  return http.createServer(app);
}

if (require.main === module) {
  (async () => {
    const { loadEnvironment, configuration } = require('./lib/config');
    loadEnvironment();
    const config = configuration();
    const client = createVotingApiClient(config.serverUrl);
    const gameManager = new GameManager({ client, config });
    const server = createServer(client, { gameManager });
    server.listen(config.port, config.host, () => {
      console.log(`Generic game player: http://${config.host}:${config.port}`);
      gameManager.start();
    });
    const close = () => {
      gameManager.stop();
      server.close();
    };
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
  })().catch(error => { console.error(`Game service stopped: ${error.message}`); process.exitCode = 1; });
}

module.exports = { createServer };
