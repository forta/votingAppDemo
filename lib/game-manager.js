'use strict';

/**
 * Discovers integration-managed sequences and starts their game adapters.
 * The process-local task registry is rebuilt by scanning resumable sequences
 * on startup and periodically; durable game progress lives in sequence state.
 */

const wtsBot = require('../game/whattheshell-bot');
const inkBot = require('../game/inkjs-bot');
const { compileInkStory } = require('../scripts/inkjs-story');
const request = require('../game/whattheshell-request');
const { createHash } = require('node:crypto');
const { unwrapCommandData } = require('./command-data');

const validSequenceId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);

class GameManager {
  constructor({ client, config, runBots = {}, output = console.log }) {
    this.client = client;
    this.config = config;
    this.runBots = { whattheshell: wtsBot.run, ink: inkBot.runInkBot, ...runBots };
    this.output = output;
    this.sessions = new Map();
    this.running = new Map();
    this.starting = new Set();
    this.controllers = new Map();
    this.reconcileTimer = null;
    this.stopped = false;
  }

  configuredGames() {
    return (this.config.games || []).filter(game => game.apiKeyId && game.secret);
  }

  async token(game) {
    if (!game.apiKeyId || !game.secret) {
      throw Object.assign(new Error(`${game.functionalityId.toUpperCase()}_BOT_CREDENTIALS_REQUIRED`), { status: 503 });
    }
    const current = this.sessions.get(game.functionalityId);
    if (current?.token && current.expiresAt > Date.now() + 60_000) return current.token;
    if (typeof this.client.loginApiKey !== 'function') {
      throw Object.assign(new Error('CLI_API_KEY_EXCHANGE_UNAVAILABLE'), { status: 503 });
    }
    const login = await request(() => this.client.loginApiKey(game.apiKeyId, game.secret));
    if (!login?.access_token || login.identity?.type !== 'apikey'
      || (login.identity.apiKeyId || login.identity.id) !== game.apiKeyId) {
      throw Object.assign(new Error('INVALID_GAME_BOT_CREDENTIALS'), { status: 503 });
    }
    let expiresAt = Date.now() + 15 * 60_000;
    try {
      expiresAt = Number(JSON.parse(Buffer.from(login.access_token.split('.')[1], 'base64url').toString('utf8')).exp) * 1000;
    } catch {}
    this.sessions.set(game.functionalityId, { token: login.access_token, expiresAt });
    return login.access_token;
  }

  async command(command, token) {
    const result = await request(() => this.client._execRemote(command, token));
    try {
      return unwrapCommandData(result);
    } catch (error) {
      throw Object.assign(error, { status: error.status || 502 });
    }
  }

  async listGamesPage({ offset = 0, limit = 10, functionalityId = '', search = '', state = '', states } = {}) {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000000) {
      throw Object.assign(new Error('INVALID_GAME_PAGE_OFFSET'), { status: 400 });
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw Object.assign(new Error('INVALID_GAME_PAGE_SIZE'), { status: 400 });
    }
    if (typeof search !== 'string' || search.length > 100) {
      throw Object.assign(new Error('INVALID_GAME_SEARCH'), { status: 400 });
    }
    const allowedStates = new Set(['waiting', 'playing', 'paused', 'finished']);
    if (state && !allowedStates.has(state)) {
      throw Object.assign(new Error('INVALID_GAME_STATE'), { status: 400 });
    }
    if (states !== undefined && (!Array.isArray(states) || states.some(value => !allowedStates.has(value)))) {
      throw Object.assign(new Error('INVALID_GAME_STATE'), { status: 400 });
    }
    const selectedStates = states === undefined ? (state ? [state] : null) : [...new Set(states)];
    if (selectedStates && selectedStates.length === 0) return { games: [], offset, limit, hasMore: false };
    const configured = this.configuredGames();
    if (!configured.length) throw Object.assign(new Error('GAME_BOT_CREDENTIALS_REQUIRED'), { status: 503 });
    if (functionalityId && !configured.some(game => game.functionalityId === functionalityId)) {
      throw Object.assign(new Error('UNSUPPORTED_GAME_FUNCTIONALITY'), { status: 400 });
    }

    const candidates = [];
    for (const game of configured) {
      if (functionalityId && game.functionalityId !== functionalityId) continue;
      const token = await this.token(game);
      const searchOption = search ? ` --search64=${Buffer.from(search, 'utf8').toString('base64url')}` : '';
      const queryStates = selectedStates || [null];
      for (const selectedState of queryStates) {
        const stateOption = selectedState ? ` --state=${selectedState}` : '';
        const singleStatePage = queryStates.length === 1;
        const candidateLimit = functionalityId && singleStatePage ? limit + 1 : offset + limit + 1;
        if (candidateLimit > 10000) throw Object.assign(new Error('GAME_PAGE_TOO_DEEP'), { status: 400 });
        const queryOffset = functionalityId && singleStatePage ? offset : 0;
        const sequences = await this.command(`seqs list --functionalityId=${game.functionalityId} --botKeySource=integration${stateOption} --limit=${candidateLimit} --offset=${queryOffset} --compact=true${searchOption}`, token);
        if (!Array.isArray(sequences)) throw Object.assign(new Error('INVALID_SEQUENCE_LIST'), { status: 502 });
        for (const sequence of sequences) {
          if (sequence.functionalityId !== game.functionalityId || sequence.botKeySource !== 'integration'
            || sequence.botUserId !== game.apiKeyId || sequence.botMode !== 'sequence_bot') continue;
          candidates.push({
            seqId: sequence.seqId,
            functionalityId: game.functionalityId,
            name: sequence.name || '',
            state: sequence.state,
            createdAt: sequence.createdAt || null,
            hasBallots: sequence.hasBallots ?? ((sequence.ballotIds || []).length > 0),
            game,
            sequence
          });
        }
      }
    }
    const createdAtValue = value => {
      const timestamp = value ? Date.parse(value) : NaN;
      return Number.isFinite(timestamp) ? timestamp : 0;
    };
    candidates.sort((left, right) => createdAtValue(right.createdAt) - createdAtValue(left.createdAt)
      || String(left.seqId).localeCompare(String(right.seqId)));
    const start = functionalityId && selectedStates?.length === 1 ? 0 : offset;
    const pageCandidates = candidates.slice(start, start + limit + 1);
    const hasMore = start === 0 ? pageCandidates.length > limit : candidates.length > offset + limit;
    const page = pageCandidates.slice(0, limit);
    const games = await Promise.all(page.map(async candidate => {
      let canConnect = ['waiting', 'playing', 'paused'].includes(candidate.state);
      let unavailableReason = canConnect ? null : 'state-unavailable';
      if (canConnect && candidate.hasBallots) {
        const saved = await this.command(`seqs seq-state-get --id=${candidate.seqId}`, await this.token(candidate.game));
        canConnect = this.isRecoverableCheckpoint(candidate.game.adapter, saved?.seqState);
        if (!canConnect) unavailableReason = 'not-recoverable';
      }
      return {
        seqId: candidate.seqId,
        functionalityId: candidate.functionalityId,
        name: candidate.name,
        state: candidate.state,
        createdAt: candidate.createdAt,
        canConnect,
        ...(!canConnect ? { unavailableReason } : {}),
        connected: this.running.has(candidate.seqId)
      };
    }));
    return { games, offset, limit, hasMore };
  }

  async listGames(options = {}) {
    return (await this.listGamesPage(options)).games;
  }

  async findAssignedSequence(seqId) {
    const configured = this.configuredGames();
    if (!configured.length) throw Object.assign(new Error('GAME_BOT_CREDENTIALS_REQUIRED'), { status: 503 });
    for (const game of configured) {
      const token = await this.token(game);
      let sequence = null;
      try {
        sequence = await this.command(`seqs get --id=${seqId}`, token);
      } catch (error) {
        if (![403, 404].includes(error.status)) throw error;
      }
      if (sequence && sequence.functionalityId === game.functionalityId && sequence.botKeySource === 'integration'
        && sequence.botUserId === game.apiKeyId && sequence.botMode === 'sequence_bot') {
        return { game, token, sequence };
      }
    }
    throw Object.assign(new Error('SEQUENCE_NOT_ASSIGNED_TO_THIS_GAME'), { status: 403 });
  }

  async connect(seqId) {
    if (this.stopped) throw Object.assign(new Error('GAME_SERVICE_STOPPING'), { status: 503 });
    if (!validSequenceId(seqId)) throw Object.assign(new Error('INVALID_SEQUENCE_ID'), { status: 400 });
    if (this.running.has(seqId) || this.starting.has(seqId)) return { started: false, alreadyRunning: true };
    this.starting.add(seqId);
    try {
      const { game, token, sequence } = await this.findAssignedSequence(seqId);
      if (!['waiting', 'playing', 'paused'].includes(sequence.state)) {
        throw Object.assign(new Error('GAME_SEQUENCE_NOT_ACTIVE'), { status: 409 });
      }
      const saved = await this.command(`seqs seq-state-get --id=${seqId}`, token);
      const checkpoint = saved?.seqState || null;
      if (checkpoint && !this.isRecoverableCheckpoint(game.adapter, checkpoint)) {
        throw Object.assign(new Error('GAME_STATE_NOT_RECOVERABLE'), { status: 409 });
      }
      if ((sequence.ballotIds || []).length && !this.isRecoverableCheckpoint(game.adapter, checkpoint)) {
        throw Object.assign(new Error('GAME_STATE_NOT_RECOVERABLE'), { status: 409 });
      }
      const runner = this.runBots[game.adapter];
      if (typeof runner !== 'function') throw Object.assign(new Error('GAME_ADAPTER_UNAVAILABLE'), { status: 503 });
      const options = {
        sequenceId: seqId,
        apiKeyId: game.apiKeyId,
        secret: game.secret,
        pollIntervalMs: this.config.botPollIntervalMs || 5000,
        maxTurns: this.config.botMaxTurns || 500,
        lang: this.config.language || 'es'
      };
      const controller = new AbortController();
      const dependencies = {
        client: {
          ...this.client,
          _execRemote: async (command, suppliedToken) => {
            const currentToken = await this.token(game);
            return this.client._execRemote(command, currentToken || suppliedToken);
          }
        },
        token,
        checkpoint,
        signal: controller.signal,
        output: message => this.output(`[${seqId}] ${message}`)
      };
      if (game.adapter === 'ink') {
        const file = await this.command(`seqs file-download --id=${seqId} --label=story`, token);
        if (!file?.contentBase64 || !file.filename) {
          throw Object.assign(new Error('INK_STORY_FILE_UNAVAILABLE'), { status: 409 });
        }
        const source = Buffer.from(file.contentBase64, 'base64');
        dependencies.story = compileInkStory(source, require('node:path').extname(file.filename));
        dependencies.storyFingerprint = createHash('sha256').update(source).digest('hex');
      }
      const task = Promise.resolve().then(() => runner(options, dependencies));
      this.running.set(seqId, task);
      this.controllers.set(seqId, controller);
      task.catch(error => this.output(`[${seqId}] Bot stopped: ${error.message}`))
        .finally(() => {
          if (this.running.get(seqId) === task) this.running.delete(seqId);
          if (this.controllers.get(seqId) === controller) this.controllers.delete(seqId);
        });
      return { started: true, alreadyRunning: false };
    } finally {
      this.starting.delete(seqId);
    }
  }

  isRecoverableCheckpoint(adapter, checkpoint) {
    if (!checkpoint) return false;
    if (adapter === 'whattheshell') return checkpoint.application === 'whattheshell' && checkpoint.version === 1;
    if (adapter === 'ink') return checkpoint.application === 'ink' && checkpoint.version === 1
      && typeof checkpoint.storyState === 'string' && Number.isInteger(checkpoint.turn)
      && ['awaiting-ballot', 'choice-selected', 'completed'].includes(checkpoint.phase);
    return false;
  }

  async reconcile() {
    if (this.stopped || !this.configuredGames().length) return;
    for (const game of this.configuredGames()) {
      try {
        const token = await this.token(game);
        const pageSize = 100;
        for (let offset = 0; !this.stopped; offset += pageSize) {
          const sequences = await this.command(`seqs list --functionalityId=${game.functionalityId} --botKeySource=integration --limit=${pageSize} --offset=${offset} --compact=true`, token);
          if (!Array.isArray(sequences)) break;
          for (const sequence of sequences) {
            if (this.stopped) return;
            if (sequence.functionalityId !== game.functionalityId || sequence.botKeySource !== 'integration'
              || sequence.botUserId !== game.apiKeyId || sequence.botMode !== 'sequence_bot'
              || !['playing', 'paused'].includes(sequence.state)) continue;
            const saved = await this.command(`seqs seq-state-get --id=${sequence.seqId}`, token);
            const checkpoint = saved?.seqState || null;
            const hasBallots = sequence.hasBallots ?? ((sequence.ballotIds || []).length > 0);
            if (hasBallots && !this.isRecoverableCheckpoint(game.adapter, checkpoint)) {
              this.output(`[${sequence.seqId}] Recovery skipped: no compatible game checkpoint.`);
              continue;
            }
            await this.connect(sequence.seqId);
          }
          if (sequences.length < pageSize) break;
        }
      } catch (error) {
        this.output(`Game recovery scan failed for ${game.functionalityId}: ${error.message}`);
      }
    }
  }

  start() {
    if (this.reconcileTimer || this.stopped) return;
    const intervalMs = Math.max(5000, Number(this.config.reconcileIntervalMs) || 30000);
    // Start existing games immediately, then catch sequences created or
    // interrupted while this service was running on subsequent scans.
    void this.reconcile();
    this.reconcileTimer = setInterval(() => { void this.reconcile(); }, intervalMs);
    this.reconcileTimer.unref?.();
  }

  stop() {
    this.stopped = true;
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.reconcileTimer = null;
    for (const controller of this.controllers.values()) controller.abort();
  }
}

module.exports = { GameManager, validSequenceId };
