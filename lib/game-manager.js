'use strict';

const bot = require('../game/whattheshell-bot');
const request = require('../game/whattheshell-request');

const validSequenceId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);

class GameManager {
  constructor({ client, config, runBot = bot.run, output = console.log }) {
    this.client = client;
    this.config = config;
    this.runBot = runBot;
    this.output = output;
    this.accessToken = null;
    this.tokenExpiresAt = 0;
    this.running = new Map();
    this.starting = new Set();
  }

  async token() {
    const config = this.config;
    if (!config.botId || !config.botSecret) {
      throw Object.assign(new Error('GAME_BOT_CREDENTIALS_REQUIRED'), { status: 503 });
    }
    if (this.accessToken && this.tokenExpiresAt > Date.now() + 60_000) return this.accessToken;

    const login = await request(() => this.client._httpRequest('POST', '/api/auth/login', {
      type: 'user', credentials: { email: config.botId, password: config.botSecret }
    }));
    if (!login?.access_token || login.identity?.type !== 'apikey'
      || (login.identity.apiKeyId || login.identity.id) !== config.botId) {
      throw Object.assign(new Error('INVALID_GAME_BOT_CREDENTIALS'), { status: 503 });
    }
    this.accessToken = login.access_token;
    try {
      const payload = JSON.parse(Buffer.from(login.access_token.split('.')[1], 'base64url').toString('utf8'));
      this.tokenExpiresAt = Number(payload.exp) * 1000;
    } catch {
      this.tokenExpiresAt = Date.now() + 15 * 60_000;
    }
    return this.accessToken;
  }

  async command(command) {
    const result = await request(() => this.client._execRemote(command, this.accessToken));
    if (!result?.success) {
      throw Object.assign(new Error(result?.error || 'VOTING_API_COMMAND_FAILED'), { status: 502 });
    }
    return result.data;
  }

  async listGames() {
    await this.token();
    const functionalityId = this.config.functionalityId || 'whattheshell';
    const sequences = await this.command(`seqs list --functionalityId=${functionalityId}`);
    if (!Array.isArray(sequences)) throw Object.assign(new Error('INVALID_SEQUENCE_LIST'), { status: 502 });
    const assigned = sequences.filter(sequence => sequence.functionalityId === functionalityId
      && sequence.botUserId === this.config.botId && sequence.botMode === 'sequence_bot');
    if (sequences.length && !assigned.length) {
      throw Object.assign(new Error('INVALID_GAME_BOT_CREDENTIALS'), { status: 503 });
    }
    return assigned.map(sequence => ({
      seqId: sequence.seqId,
      name: sequence.name || sequence.seqId,
      state: sequence.state,
      createdAt: sequence.createdAt || null,
      canConnect: ['waiting', 'playing', 'paused'].includes(sequence.state)
        && !(sequence.ballotIds || []).length,
      connected: this.running.has(sequence.seqId)
    }));
  }

  async connect(seqId) {
    if (!validSequenceId(seqId)) throw Object.assign(new Error('INVALID_SEQUENCE_ID'), { status: 400 });
    if (this.running.has(seqId) || this.starting.has(seqId)) return { started: false, alreadyRunning: true };
    this.starting.add(seqId);
    try {
      const token = await this.token();
      const sequence = await this.command(`seqs get --id=${seqId}`);
      if (sequence.functionalityId !== (this.config.functionalityId || 'whattheshell')
        || sequence.botUserId !== this.config.botId || sequence.botMode !== 'sequence_bot') {
        throw Object.assign(new Error('SEQUENCE_NOT_ASSIGNED_TO_THIS_GAME'), { status: 403 });
      }
      if (!['waiting', 'playing', 'paused'].includes(sequence.state) || (sequence.ballotIds || []).length) {
        throw Object.assign(new Error('GAME_REQUIRES_A_FRESH_SEQUENCE'), { status: 409 });
      }

      const task = Promise.resolve().then(() => this.runBot({
        sequenceId: seqId,
        apiKeyId: this.config.botId,
        secret: this.config.botSecret,
        pollIntervalMs: this.config.botPollIntervalMs || 5000,
        maxTurns: this.config.botMaxTurns || 500,
        lang: this.config.lang || 'es'
      }, {
        client: this.client,
        token,
        output: message => this.output(`[${seqId}] ${message}`)
      }));
      this.running.set(seqId, task);
      task.catch(error => this.output(`[${seqId}] Bot stopped: ${error.message}`))
        .finally(() => { if (this.running.get(seqId) === task) this.running.delete(seqId); });
      return { started: true, alreadyRunning: false };
    } finally {
      this.starting.delete(seqId);
    }
  }
}

module.exports = { GameManager, validSequenceId };
