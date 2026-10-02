'use strict';

const { createHash, timingSafeEqual, randomBytes } = require('node:crypto');

function createAdmin({ password, publicUrl, service, now = Date.now }) {
  const sessions = new Map();
  const failures = new Map();
  const origin = new URL(publicUrl).origin;
  const secure = new URL(publicUrl).protocol === 'https:';
  const digest = value => createHash('sha256').update(value).digest();
  const cookie = (token, seconds) => `wts_admin=${token}; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=${seconds}${secure ? '; Secure' : ''}`;

  return async (req, res, pathname, readBody, json) => {
    const time = now();
    for (const [id, session] of sessions) if (session.expires <= time) sessions.delete(id);
    for (const [ip, attempt] of failures) if (attempt.until <= time) failures.delete(ip);
    if (!password) return json(503, { code: 'adminUnavailable' });
    // Validate the configured origin for every state-changing browser request.
    if (req.method === 'POST' && req.headers.origin !== origin) return json(403, { code: 'adminForbidden' });
    if (pathname === '/admin/login' && req.method === 'POST') {
      const ip = req.socket.remoteAddress;
      const attempt = failures.get(ip) || { count: 0, until: time + 60000 };
      if (attempt.count >= 5 || failures.size >= 10000) return json(429, { code: 'adminWait' });
      const body = await readBody(req);
      if (typeof body.password !== 'string' || !timingSafeEqual(digest(body.password), digest(password))) {
        attempt.count++; failures.set(ip, attempt);
        return json(401, { code: 'wrongPassword' });
      }
      failures.delete(ip);
      if (sessions.size >= 100) return json(429, { code: 'adminWait' });
      const token = randomBytes(32).toString('hex');
      sessions.set(token, { expires: time + 3600000 });
      res.setHeader('Set-Cookie', cookie(token, 3600));
      return json(200, { success: true });
    }
    const token = /(?:^|;\s*)wts_admin=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
    if (!token || !sessions.has(token)) return json(401, { code: 'adminLoginRequired' });
    if (pathname === '/admin/logout' && req.method === 'POST') {
      sessions.delete(token); res.setHeader('Set-Cookie', cookie('', 0));
      return json(200, { success: true });
    }
    if (pathname === '/admin/games' && req.method === 'GET') return json(200, { games: await service.list() });
    if (pathname === '/admin/games' && req.method === 'POST') {
      const body = await readBody(req);
      try { return json(201, await service.create({ name: body.name, durationMs: body.durationMs, lang: body.lang })); }
      catch (error) { return json(error.status || 502, { code: 'adminCreateFailed' }); }
    }
    if (pathname === '/admin/slots' && req.method === 'GET') {
      const sequenceId = new URL(req.url, origin).searchParams.get('seq');
      try { return json(200, await service.slotDetails(sequenceId)); }
      catch (error) { return json(error.status || 502, { code: error.status === 404 ? 'sequenceNotFound' : 'slotLookupFailed' }); }
    }
    if (pathname === '/admin/slots' && req.method === 'POST') {
      const body = await readBody(req);
      try { return json(200, await service.configureSlots(body.sequenceId, body.slots)); }
      catch (error) { return json(error.status || 502, { code: error.status === 400 ? 'invalidSlotConfiguration' : error.status === 409 ? 'slotMappingConflict' : 'slotConfigurationFailed' }); }
    }
    return json(404, { code: 'adminForbidden' });
  };
}

module.exports = { createAdmin };
