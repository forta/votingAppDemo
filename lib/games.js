'use strict';

const { randomUUID } = require('node:crypto');

const statuses = ['provisioning', 'ready', 'running', 'paused', 'finished', 'error'];
const remoteFields = ['serverUrl', 'spaceId', 'sequenceId', 'ownerUserId', 'botApiKeyId', 'controllerApiKeyId'];

class Games {
  constructor(db) { this.db = db; this.collection = db.collection('games'); }

  async prepare() {
    if (!await this.db.listCollections({ name: 'games' }).hasNext()) {
      await this.db.createCollection('games', { validator: { $jsonSchema: {
        bsonType: 'object', additionalProperties: false,
        required: ['_id', 'schemaVersion', 'gameType', 'name', 'status', 'visibility', 'remote', 'settings', 'createdAt', 'updatedAt'],
        properties: {
          _id: { bsonType: 'string' }, schemaVersion: { enum: [1] }, gameType: { enum: ['whattheshell'] },
          name: { bsonType: 'string', minLength: 1, maxLength: 80 }, status: { enum: statuses }, visibility: { enum: ['unlisted', 'public'] },
          remote: { bsonType: 'object', additionalProperties: false, properties: Object.fromEntries(remoteFields.map(key => [key, { bsonType: 'string' }])) },
          settings: { bsonType: 'object', additionalProperties: false, required: ['durationMs', 'lang'], properties: { durationMs: { bsonType: ['int', 'long', 'double'], minimum: 10000, maximum: 3600000 }, lang: { enum: ['en', 'es', 'eo'] } } },
          provisioningStep: { bsonType: 'string' }, surrogateIds: { bsonType: 'array', items: { bsonType: 'string' } },
          lastError: { enum: ['PROVISIONING_FAILED', 'BOT_FAILED'] },
          createdAt: { bsonType: 'date' }, updatedAt: { bsonType: 'date' }, finishedAt: { bsonType: 'date' }
        }
      } } });
    }
    await this.collection.createIndex({ 'remote.serverUrl': 1, 'remote.sequenceId': 1 }, {
      unique: true, partialFilterExpression: { 'remote.sequenceId': { $type: 'string' } }, name: 'remote_sequence_unique'
    });
    await this.collection.createIndex({ visibility: 1, status: 1, createdAt: -1 }, { name: 'catalog' });
  }

  async create({ name, durationMs, lang }, serverUrl) {
    if (typeof name !== 'string' || !name.trim() || name.length > 80 || /[\x00-\x1f]/.test(name)
      || !Number.isInteger(durationMs) || durationMs < 10000 || durationMs > 3600000 || !['en', 'es', 'eo'].includes(lang)) {
      throw Object.assign(new Error('Invalid game settings'), { status: 400 });
    }
    const now = new Date();
    const game = { _id: randomUUID(), schemaVersion: 1, gameType: 'whattheshell', name: name.trim(),
      status: 'provisioning', visibility: 'unlisted', remote: { serverUrl }, settings: { durationMs, lang },
      createdAt: now, updatedAt: now };
    await this.collection.insertOne(game);
    return game;
  }

  async record(id, step, remote = {}, surrogateIds) {
    const fields = { provisioningStep: step, updatedAt: new Date() };
    for (const key of remoteFields) if (typeof remote[key] === 'string') fields[`remote.${key}`] = remote[key];
    if (surrogateIds) fields.surrogateIds = surrogateIds.map(String);
    await this.collection.updateOne({ _id: id }, { $set: fields });
  }

  async status(id, status, errorCode) {
    if (!statuses.includes(status)) throw new Error('Invalid game status');
    if (errorCode && !['PROVISIONING_FAILED', 'BOT_FAILED'].includes(errorCode)) throw new Error('Invalid error code');
    const fields = { status, updatedAt: new Date(), ...(errorCode ? { lastError: errorCode } : {}) };
    if (status === 'finished') fields.finishedAt = new Date();
    await this.collection.updateOne({ _id: id }, { $set: fields });
  }

  async list() { return this.collection.find({}, { projection: { remote: 1, name: 1, settings: 1, status: 1, createdAt: 1, lastError: 1, provisioningStep: 1 } }).sort({ createdAt: -1 }).limit(100).toArray(); }
  async get(id) { return this.collection.findOne({ _id: id }); }
}

async function connectGames(config) {
  const { MongoClient } = require('mongodb');
  const client = new MongoClient(config.mongoUri, { serverSelectionTimeoutMS: 5000 });
  try {
    await client.connect();
    const games = new Games(client.db(config.dbName));
    await games.prepare();
    return { games, close: () => client.close() };
  } catch (error) { await client.close(); throw error; }
}

module.exports = { Games, connectGames };
