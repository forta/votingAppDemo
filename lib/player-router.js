'use strict';

/**
 * HTTP routes for the generic anonymous game player. Static assets and game
 * discovery are public; command forwarding is limited to approved slot actions.
 */

const path = require('node:path');
const { VoteEventRelay } = require('./vote-event-relay');

const publicOperations = new Set([
  'public', 'claim-public', 'claim-reserved-public', 'recover-public',
  'start-public', 'vote-public', 'abstain-public', 'release-public'
]);

function createPlayerRouter(express, client, options = {}) {
  const router = express.Router();
  const gameManager = options.gameManager;
  const voteEventRelay = options.voteEventRelay || (gameManager ? new VoteEventRelay({
    client,
    gameManager,
    WebSocketClient: options.WebSocket,
    flushIntervalMs: options.voteFlushIntervalMs || 1000
  }) : null);
  const publicDir = options.publicDir || path.join(__dirname, '..', 'public');

  router.get('/', (req, res) => {
    const requestUrl = new URL(req.originalUrl, 'http://localhost');
    if (!requestUrl.pathname.endsWith('/')) {
      return res.redirect(308, requestUrl.pathname + '/' + requestUrl.search);
    }
    const page = req.query.seq ? 'player/index.html' : 'explore.html';
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.sendFile(path.join(publicDir, page));
  });

  router.get('/index.html', (req, res) => {
    const page = req.query.seq ? 'player/index.html' : 'explore.html';
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.sendFile(path.join(publicDir, page));
  });

  // Relay only an anonymous event counter. The integration API-key token stays
  // on this server and is never sent to the browser.
  router.post(['/events/sequence', '/events/votes'], async (req, res, next) => {
    const seqId = req.body?.seqId;
    const accessSecret = typeof req.body?.accessSecret === 'string' ? req.body.accessSecret.trim().toUpperCase() : '';
    if (typeof seqId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(seqId)) {
      return res.status(400).json({ success: false, error: 'INVALID_SEQUENCE_ID' });
    }
    if (!gameManager) return res.status(503).json({ success: false, error: 'Game event relay is unavailable.' });

    try {
      // Reuse the public slot command to enforce any game access code before
      // opening a stream. This returns the normal public snapshot only server-side.
      const accessOption = accessSecret ? ` --accessSecret=${JSON.stringify(accessSecret)}` : '';
      const accessCheck = await client._execRemote(`slotseqs public --seq=${seqId}${accessOption}`, null);
      if (!accessCheck?.success) {
        const error = new Error(accessCheck?.error || 'Game access was denied.');
        error.status = accessCheck?.status || 403;
        error.code = accessCheck?.code || 'GAME_ACCESS_DENIED';
        throw error;
      }
      await voteEventRelay.subscribe(seqId, res, accessSecret);
    } catch (error) {
      next(error);
    }
  });

  router.post('/cli/execute', async (req, res) => {
    const command = req.body?.command;
    if (command === 'games list') {
      if (!gameManager) return res.status(503).json({ success: false, error: 'Game discovery is unavailable.' });
      res.set('Cache-Control', 'no-store');
      const options = req.body?.options && typeof req.body.options === 'object' && !Array.isArray(req.body.options)
        ? req.body.options : {};
      return res.json({ success: true, data: await gameManager.listGamesPage({
        offset: options.offset === undefined ? 0 : Number(options.offset),
        limit: options.limit === undefined ? 10 : Number(options.limit),
        functionalityId: options.functionalityId || '',
        search: options.search || '',
        state: options.state || '',
        ...(Array.isArray(options.states) ? { states: options.states } : {})
      }) });
    }
    const connectMatch = typeof command === 'string' && /^games connect --seqId=([A-Za-z0-9_-]{1,128})$/.exec(command);
    if (connectMatch) {
      if (!gameManager) return res.status(503).json({ success: false, error: 'Game connection is unavailable.' });
      res.set('Cache-Control', 'no-store');
      return res.json({ success: true, data: await gameManager.connect(connectMatch[1]) });
    }
    const slotMatch = typeof command === 'string' && /^slotseqs ([a-z-]+)(?:\s|$)/.exec(command);
    if (!slotMatch || !publicOperations.has(slotMatch[1])) {
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
      else if (['explore.js', 'play.js'].includes(path.basename(filePath))) res.setHeader('Cache-Control', 'no-cache');
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
