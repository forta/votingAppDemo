'use strict';

/**
 * Legacy WTS-only integration mounted at /games/wts_multibot/. The generic
 * multi-game player uses player-router.js and game-manager.js instead.
 */

const path = require('node:path');
const { GameManager } = require('./game-manager');
const { createVotingApiClient } = require('./voting-api');

function createInternalClient(serverUrl) {
  return createVotingApiClient(serverUrl);
}

function createBackendIntegration(express, config, options = {}) {
  const client = options.client || createInternalClient(config.WTS_CLI_SERVER_URL);
  const gameConfig = {
    games: [{
      functionalityId: config.WTS_FUNCTIONALITY_ID || 'whattheshell',
      apiKeyId: config.WTS_BOT_API_KEY_ID,
      secret: config.WTS_BOT_SECRET,
      adapter: 'whattheshell'
    }],
    botPollIntervalMs: config.WTS_BOT_POLL_INTERVAL_MS,
    botMaxTurns: config.WTS_BOT_MAX_TURNS,
    lang: config.WTS_LANGUAGE
  };
  const gameManager = options.gameManager || new GameManager({ client, config: gameConfig });
  const publicDir = path.join(__dirname, '..', 'public');

  const pageRouter = express.Router();
  pageRouter.use(express.static(publicDir, {
    index: false,
    dotfiles: 'deny',
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
    }
  }));
  pageRouter.get('/', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(publicDir, req.query.seq ? 'player' : '', req.query.seq ? 'index.html' : 'explore.html'));
  });

  const apiRouter = express.Router();
  apiRouter.get('/', async (req, res) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      res.json({ games: await gameManager.listGames() });
    } catch (error) {
      res.status(error.status || 502).json({ error: error.message || 'Game discovery failed.' });
    }
  });
  apiRouter.post('/:seqId/connect', async (req, res) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      res.json(await gameManager.connect(req.params.seqId));
    } catch (error) {
      res.status(error.status || 502).json({ error: error.message || 'Game connection failed.' });
    }
  });

  pageRouter.use('/api/games', apiRouter);
  pageRouter.post('/cli/execute', express.json({ limit: '8kb' }), async (req, res) => {
    const command = req.body?.command;
    const match = typeof command === 'string' && /^slotseqs (public|claim-public|claim-reserved-public|recover-public|start-public|vote-public|release-public)(?:\s|$)/.exec(command);
    if (!match) return res.status(403).json({ success: false, error: 'Command is not available to anonymous players.' });
    try {
      res.setHeader('Cache-Control', 'no-store');
      return res.json(await client._execRemote(command, null));
    } catch (error) {
      return res.status(error.status || 502).json({ success: false, error: error.message || 'Voting API command failed.' });
    }
  });

  return { pageRouter, apiRouter, gameManager };
}

module.exports = { createBackendIntegration, createInternalClient };
