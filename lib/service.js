'use strict';

const bot = require('../game/whattheshell-bot');
const quote = value => `'${JSON.stringify(value).replace(/'/g, '\\u0027')}'`;

class GameService {
  constructor({ games, client, config, runBot = bot.run }) {
    Object.assign(this, { games, client, config, runBot });
    this.running = new Map();
    this.creating = false;
  }

  async login(username, password) {
    return this.client._httpRequest('POST', '/api/auth/login', { type: 'user', credentials: { email: username, password } });
  }

  async credentials() {
    const c = this.config;
    if (![c.ownerUsername, c.ownerPassword, c.botId, c.botSecret, c.controllerId, c.controllerSecret].every(Boolean)
      || c.ownerUsername.toLowerCase().split('@')[0] === 'alice') throw new Error('SERVICE_CREDENTIALS_REQUIRED');
    const owner = await this.login(c.ownerUsername, c.ownerPassword);
    if (!owner.access_token || owner.identity?.type !== 'registered' || owner.identity.superadmin
      || [owner.identity.username, owner.identity.id].some(value => value?.toLowerCase() === 'alice')) throw new Error('REGISTERED_OWNER_REQUIRED');
    const controller = await this.login(c.controllerId, c.controllerSecret);
    const machine = await this.login(c.botId, c.botSecret);
    for (const [login, id, mode] of [[controller, c.controllerId, 'surrogate_controller'], [machine, c.botId, 'sequence_bot']]) {
      if (!login.access_token || login.identity?.type !== 'apikey' || login.identity.apiKeyId !== id
        || login.identity.mode !== mode || login.identity.controlledBy !== owner.identity.id) throw new Error('INVALID_SERVICE_KEY');
    }
    return { owner, controller };
  }

  async command(text, token) {
    const result = await this.client._execRemote(text, token);
    if (!result?.success) throw new Error('COMMAND_FAILED');
    return result.data;
  }

  async create(settings) {
    if (this.creating) throw Object.assign(new Error('CREATION_IN_PROGRESS'), { status: 409 });
    this.creating = true;
    let game;
    try {
      // Validate and record intent before creating remote resources.
      game = await this.games.create(settings, this.config.serverUrl);
      const { owner, controller } = await this.credentials();
      const token = owner.access_token;
      await this.games.record(game._id, 'authenticated', { ownerUserId: owner.identity.id, botApiKeyId: this.config.botId, controllerApiKeyId: this.config.controllerId });
      // Use a generated identifier in command names; display names stay local.
      const name = `What the Shell ${game._id}`;
      const space = await this.command(`spaces create --name="${name}" --method=majority --majorityBase=castVotes --duration=${game.settings.durationMs} --voteTimingVisibility=public`, token);
      await this.games.record(game._id, 'space', { spaceId: space.spaceId });
      await this.command(`spaces member-vote-policy --space=${space.spaceId} --user=${owner.identity.id} --policy=deny`, token);
      const created = await this.command('auth subrogates-create --count=5 --aliasPrefix=Slot --role=participant', controller.access_token);
      const ids = created.surrogates.map(user => user.userId);
      await this.games.record(game._id, 'surrogates', {}, ids);
      await this.command(`spaces bulkJoin --space=${space.spaceId} --users=${ids.join(',')} --role=participant`, token);
      const sequence = await this.command(`seqs create --name="${name}" --space=${space.spaceId} --internal`, token);
      await this.games.record(game._id, 'sequence', { sequenceId: sequence.seqId });
      await this.command(`seqs assign-bot --id=${sequence.seqId} --botUserId=${this.config.botId}`, token);
      const mapping = ids.map((surrogateUserId, index) => ({ slotNumber: index + 1, surrogateUserId }));
      await this.command(`slotseqs configure --seq=${sequence.seqId} --controller=${this.config.controllerId} --mapping=${quote(mapping)}`, token);
      await this.games.status(game._id, 'ready');
      this.start(game, sequence.seqId);
      return { id: game._id, sequenceId: sequence.seqId };
    } catch (error) {
      if (game) await this.games.status(game._id, 'error', 'PROVISIONING_FAILED');
      // Raw upstream errors may include command payloads. Persist only codes.
      throw Object.assign(new Error('PROVISIONING_FAILED'), { status: error.status === 400 ? 400 : error.status === 429 ? 429 : 502 });
    } finally { this.creating = false; }
  }

  start(game, sequenceId) {
    const task = Promise.resolve().then(() => this.runBot({ sequenceId, apiKeyId: this.config.botId,
      secret: this.config.botSecret, pollIntervalMs: 3000, maxTurns: 500, lang: game.settings.lang }, {
      client: this.client, output: () => {}
    })).then(result => this.games.status(game._id, result.status === 'finished' ? 'finished' : 'paused'))
      .catch(() => this.games.status(game._id, 'error', 'BOT_FAILED'))
      .catch(() => { console.error('Could not record bot status.'); })
      .finally(() => this.running.delete(game._id));
    this.running.set(game._id, task);
  }

  async list() {
    return (await this.games.list()).map(game => ({ id: game._id, name: game.name, status: game.status,
      botActive: this.running.has(game._id), sequenceId: game.remote?.sequenceId || null,
      createdAt: game.createdAt, error: game.lastError || null }));
  }

  async slotDetails(sequenceId) {
    if (typeof sequenceId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(sequenceId)) throw Object.assign(new Error('INVALID_SEQUENCE'), { status: 400 });
    const { owner } = await this.credentials();
    return this.command(`slotseqs list --seq=${sequenceId}`, owner.access_token);
  }

  async configureSlots(sequenceId, slots) {
    if (typeof sequenceId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(sequenceId) || !Array.isArray(slots) || slots.length !== 5) throw Object.assign(new Error('INVALID_SLOT_CONFIGURATION'), { status: 400 });
    const { owner } = await this.credentials();
    const current = await this.command(`slotseqs list --seq=${sequenceId}`, owner.access_token);
    const byNumber = new Map((current.slots || []).map(slot => [slot.slotNumber, slot]));
    const mapping = slots.map((slot, index) => {
      const slotNumber = index + 1;
      const surrogateUserId = typeof slot.surrogateUserId === 'string' ? slot.surrogateUserId.trim() : '';
      const reservedAlias = typeof slot.reservedAlias === 'string' ? slot.reservedAlias.trim() : '';
      const reservedPin = typeof slot.reservedPin === 'string' ? slot.reservedPin.trim() : '';
      const existing = byNumber.get(slotNumber);
      const keepsExistingPin = existing?.reserved && existing.alias === reservedAlias && !reservedPin;
      if (!surrogateUserId || surrogateUserId.length > 150 || (reservedAlias && !keepsExistingPin && (!reservedPin || !/^\d{4}$/.test(reservedPin))) || (!reservedAlias && reservedPin)) {
        throw Object.assign(new Error('INVALID_SLOT_CONFIGURATION'), { status: 400 });
      }
      if (existing?.surrogateUserId && existing.surrogateUserId !== surrogateUserId) throw Object.assign(new Error('SLOT_MAPPING_IMMUTABLE'), { status: 409 });
      return { slotNumber, surrogateUserId, ...(reservedAlias ? { reservedAlias, reservedPin } : {}) };
    });
    const quote = value => `'${JSON.stringify(value).replace(/'/g, '\\u0027')}'`;
    return this.command(`slotseqs configure --seq=${sequenceId} --controller=${this.config.controllerId} --mapping=${quote(mapping)}`, owner.access_token);
  }
}

module.exports = { GameService };
