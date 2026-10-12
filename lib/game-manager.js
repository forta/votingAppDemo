'use strict';

/**
 * Discovers sequences assigned to configured integrations and starts one game
 * adapter per sequence. Tokens and running tasks live only in process memory;
 * restart/reconnection policy is described in the VotingAppDemo README.
 */

const wtsBot = require('../game/whattheshell-bot');
const inkBot = require('../game/inkjs-bot');
const { compileInkStory } = require('../scripts/inkjs-story');
const request = require('../game/whattheshell-request');

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
    if (!result?.success) throw Object.assign(new Error(result?.error || 'VOTING_API_COMMAND_FAILED'), { status: 502 });
    return result.data;
  }

  async listGames() {
    const games = [];
    const configured = this.configuredGames();
    if (!configured.length) throw Object.assign(new Error('GAME_BOT_CREDENTIALS_REQUIRED'), { status: 503 });
    for (const game of configured) {
      const token = await this.token(game);
      const sequences = await this.command(`seqs list --functionalityId=${game.functionalityId}`, token);
      if (!Array.isArray(sequences)) throw Object.assign(new Error('INVALID_SEQUENCE_LIST'), { status: 502 });
      for (const sequence of sequences) {
        if (sequence.functionalityId !== game.functionalityId || sequence.botKeySource !== 'integration'
          || sequence.botUserId !== game.apiKeyId || sequence.botMode !== 'sequence_bot') continue;
        games.push({
          seqId: sequence.seqId,
          functionalityId: game.functionalityId,
          name: sequence.name || sequence.seqId,
          state: sequence.state,
          createdAt: sequence.createdAt || null,
          canConnect: ['waiting', 'playing', 'paused'].includes(sequence.state)
            && !(sequence.ballotIds || []).length,
          connected: this.running.has(sequence.seqId)
        });
      }
    }
    return games;
  }

  async findAssignedSequence(seqId) {
    const configured = this.configuredGames();
    if (!configured.length) throw Object.assign(new Error('GAME_BOT_CREDENTIALS_REQUIRED'), { status: 503 });
    for (const game of configured) {
      const token = await this.token(game);
      const sequences = await this.command(`seqs list --functionalityId=${game.functionalityId}`, token);
      const sequence = Array.isArray(sequences) && sequences.find(item => item.seqId === seqId);
      if (sequence && sequence.functionalityId === game.functionalityId && sequence.botKeySource === 'integration'
        && sequence.botUserId === game.apiKeyId && sequence.botMode === 'sequence_bot') {
        return { game, token, sequence };
      }
    }
    throw Object.assign(new Error('SEQUENCE_NOT_ASSIGNED_TO_THIS_GAME'), { status: 403 });
  }

  async connect(seqId) {
    if (!validSequenceId(seqId)) throw Object.assign(new Error('INVALID_SEQUENCE_ID'), { status: 400 });
    if (this.running.has(seqId) || this.starting.has(seqId)) return { started: false, alreadyRunning: true };
    this.starting.add(seqId);
    try {
      const { game, token, sequence } = await this.findAssignedSequence(seqId);
      // This web-managed path currently starts only fresh games. Although the
      // WTS bot can restore seqState when run directly, this manager cannot yet
      // reattach to that game's existing ballot after a process restart.
      if (!['waiting', 'playing', 'paused'].includes(sequence.state) || (sequence.ballotIds || []).length) {
        throw Object.assign(new Error('GAME_REQUIRES_A_FRESH_SEQUENCE'), { status: 409 });
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
      const dependencies = {
        client: {
          ...this.client,
          _execRemote: async (command, suppliedToken) => {
            const currentToken = await this.token(game);
            return this.client._execRemote(command, currentToken || suppliedToken);
          }
        },
        token,
        output: message => this.output(`[${seqId}] ${message}`)
      };
      if (game.adapter === 'ink') {
        const file = await this.command(`seqs file-download --id=${seqId} --label=story`, token);
        if (!file?.contentBase64 || !file.filename) {
          throw Object.assign(new Error('INK_STORY_FILE_UNAVAILABLE'), { status: 409 });
        }
        dependencies.story = compileInkStory(Buffer.from(file.contentBase64, 'base64'), require('node:path').extname(file.filename));
      }
      const task = Promise.resolve().then(() => runner(options, dependencies));
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
