'use strict';

/**
 * HTTP routes for the generic anonymous game player. Static assets and game
 * discovery are public; command forwarding is limited to approved slot actions.
 */

const path = require('node:path');

const publicOperations = new Set([
  'public', 'claim-public', 'claim-reserved-public', 'recover-public',
  'start-public', 'vote-public', 'abstain-public', 'release-public'
]);

function createPlayerRouter(express, client, options = {}) {
  const router = express.Router();
  const gameManager = options.gameManager;
  const publicDir = options.publicDir || path.join(__dirname, '..', 'public');

  router.get('/', (req, res) => {
    const page = req.query.seq ? 'player/index.html' : 'explore.html';
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.sendFile(path.join(publicDir, page));
  });

  router.get('/index.html', (req, res) => {
    const page = req.query.seq ? 'player/index.html' : 'explore.html';
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.sendFile(path.join(publicDir, page));
  });

  router.get('/api/games', async (req, res) => {
    if (!gameManager) return res.status(503).json({ error: 'Game discovery is unavailable.' });
    res.set('Cache-Control', 'no-store');
    res.json({ games: await gameManager.listGames() });
  });

  router.post('/api/games/:seqId/connect', async (req, res) => {
    if (!gameManager) return res.status(503).json({ error: 'Game connection is unavailable.' });
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(req.params.seqId)) return res.status(400).json({ error: 'Invalid sequence ID.' });
    res.set('Cache-Control', 'no-store');
    res.json(await gameManager.connect(req.params.seqId));
  });

  router.post('/cli/execute', async (req, res) => {
    const command = req.body?.command;
    const match = typeof command === 'string' && /^slotseqs ([a-z-]+)(?:\s|$)/.exec(command);
    if (!match || !publicOperations.has(match[1])) {
      return res.status(403).json({ success: false, error: 'Command is not available to anonymous players.' });
    }
    res.set('Cache-Control', 'no-store');
    res.json(await client._execRemote(command, null));
  });

  router.use(express.static(publicDir, {
    index: false,
    dotfiles: 'deny',
    setHeaders(res, filePath) {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
      else if (path.basename(filePath) === 'explore.js') res.setHeader('Cache-Control', 'no-cache');
      else res.setHeader('Cache-Control', 'public, max-age=300');
    }
  }));

  router.use((req, res, next) => res.status(404).json({ error: 'Not found.' }));
  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error.status === 429 && Number.isFinite(error.retryAfterMs)) res.set('Retry-After', String(Math.ceil(error.retryAfterMs / 1000)));
    res.status(error.status || 502).json({ success: false, error: error.message || 'Game service request failed.', ...(error.code ? { code: error.code } : {}) });
  });
  return router;
}

module.exports = { createPlayerRouter };
