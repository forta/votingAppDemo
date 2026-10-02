'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');

const publicOperations = new Set(['public', 'claim-public', 'claim-reserved-public', 'recover-public', 'start-public', 'vote-public', 'release-public']);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

function createServer(client, options = {}) {
  const admin = options.admin;
  const gameManager = options.gameManager;
  return http.createServer(async (req, res) => {
    const json = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    try {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      const url = new URL(req.url, 'http://localhost');
      if (admin && pathname.startsWith('/admin')) {
        if (pathname === '/admin' || pathname === '/admin/') {
          const page = await fs.readFile(path.join(__dirname, 'public', 'admin.html'));
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
          return res.end(page);
        }
        if (pathname === '/admin/admin.js' && (req.method === 'GET' || req.method === 'HEAD')) {
          const page = await fs.readFile(path.join(__dirname, 'public', 'admin.js'));
          res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
          return res.end(req.method === 'HEAD' ? undefined : page);
        }
        const readBody = async request => {
          let body = '';
          for await (const chunk of request) { body += chunk; if (Buffer.byteLength(body) > 12000) throw Object.assign(new Error('Body too large'), { status: 413 }); }
          return JSON.parse(body || '{}');
        };
        return admin(req, res, pathname, readBody, json, url);
      }
      if (req.method === 'GET' && pathname === '/api/games') {
        if (!gameManager) return json(503, { error: 'Game discovery is unavailable.' });
        return json(200, { games: await gameManager.listGames() });
      }
      const connectMatch = req.method === 'POST' && /^\/api\/games\/([A-Za-z0-9_-]{1,128})\/connect$/.exec(pathname);
      if (connectMatch) {
        if (!gameManager) return json(503, { error: 'Game connection is unavailable.' });
        const result = await gameManager.connect(decodeURIComponent(connectMatch[1]));
        return json(200, result);
      }
      if (req.method === 'POST' && pathname === '/cli/execute') {
        let body = '';
        for await (const chunk of req) {
          body += chunk;
          if (Buffer.byteLength(body) > 8192) return json(413, { success: false });
        }
        let command;
        try { ({ command } = JSON.parse(body)); } catch { return json(400, { success: false }); }
        const match = typeof command === 'string' && /^slotseqs ([a-z-]+)(?:\s|$)/.exec(command);
        if (!match || !publicOperations.has(match[1])) return json(403, { success: false });
        // Never forward browser authorization or attach an owner/bot token.
        return json(200, await client._execRemote(command, null));
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(405, { success: false });
      const prefix = '/games/whattheshell/';
      const name = pathname === '/' ? 'explore.html'
        : pathname === '/explore.js' ? 'explore.js'
          : pathname === prefix ? 'index.html'
            : pathname.startsWith(prefix) ? pathname.slice(prefix.length) : '';
      const extension = path.extname(name);
      if (!/^[a-zA-Z0-9_.-]+$/.test(name) || !types[extension]) return json(404, { success: false });
      const content = await fs.readFile(path.join(__dirname, 'public', name));
      res.writeHead(200, { 'Content-Type': `${types[extension]}; charset=utf-8`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch (error) {
      if (error.status === 429 && Number.isFinite(error.retryAfterMs)) res.setHeader('Retry-After', Math.ceil(error.retryAfterMs / 1000));
      const status = error.code === 'ENOENT' ? 404 : error.status || 502;
      json(status, { success: false, ...(error.status ? { error: error.message } : {}) });
    }
  });
}

if (require.main === module) {
  (async () => {
    require('./lib/config').loadEnvironment();
    const config = require('./lib/config').configuration();
    const Client = require('./CLI/lib');
    const { GameManager } = require('./lib/game-manager');
    const client = Client.createStateless(config.serverUrl);
    const gameManager = new GameManager({ client, config });
    const server = createServer(client, { gameManager });
    server.listen(config.port, config.host, () => console.log(`What the Shell: http://${config.host}:${config.port}`));
    const close = () => server.close();
    process.once('SIGINT', close); process.once('SIGTERM', close);
  })().catch(error => { console.error(`Server stopped: ${error.message}`); process.exitCode = 1; });
}

module.exports = { createServer };
