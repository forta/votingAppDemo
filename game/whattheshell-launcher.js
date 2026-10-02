#!/usr/bin/env node
'use strict';

/**
 * Creates a dedicated voting space, five surrogate slot voters, a sequence,
 * and its bot, then prints the shareable What the Shell game URL.
 */

const Simulator = require('../CLI/lib');
const bot = require('./whattheshell-bot');
const request = require('./whattheshell-request');

const quote = value => `'${JSON.stringify(value).replace(/'/g, '\\u0027')}'`;
const loginKey = async (sim, key) => {
  const id = key.apiKeyId || key.userId; const secret = key.secret || key.clientSecret;
  const login = await request(() => sim._httpRequest('POST', '/api/auth/login', { type: 'user', credentials: { email: id, password: secret } }));
  if (!login.access_token) throw new Error(`Could not authenticate API key ${id}`);
  return { id, secret, token: login.access_token };
};

/** Provision one standalone game and run its bot in this process. */
async function main() {
  const sim = new Simulator(); const context = sim.activeContext;
  if (!context) throw new Error('Log in with the CLI first.');
  const ownerToken = await request(() => sim._ensureAuthenticatedForContext(context));
  const owner = sim.contexts[context].identity;
  if (!['registered', 'system'].includes(owner.type)) throw new Error('Use a registered or system owner context.');
  const command = async (text, token = ownerToken) => { const result = await request(() => sim._execRemote(text, token)); if (!result.success) throw new Error(result.error || text); return result.data; };
  const suffix = Date.now().toString(36);
  const space = await command(`spaces create --name="What the Shell demo ${suffix}" --method=majority --majorityBase=castVotes --duration=30000 --voteTimingVisibility=public`);
  await command(`spaces member-vote-policy --space=${space.spaceId} --user=${owner.id} --policy=deny`);
  const controller = await loginKey(sim, await command(`user apikey-create --alias="What the Shell slots ${suffix}" --mode=surrogate_controller`));
  const sequenceBot = await loginKey(sim, await command(`user apikey-create --alias="What the Shell bot ${suffix}" --mode=sequence_bot`));
  const created = await command('auth subrogates-create --count=5 --aliasPrefix=Slot --role=participant', controller.token);
  await command(`spaces bulkJoin --space=${space.spaceId} --users=${created.surrogates.map(user => user.userId).join(',')} --role=participant`);
  const sequence = await command(`seqs create --name="What the Shell demo ${suffix}" --space=${space.spaceId} --internal`);
  await command(`seqs assign-bot --id=${sequence.seqId} --botUserId=${sequenceBot.id}`);
  const mapping = created.surrogates.map((user, index) => ({ slotNumber: index + 1, surrogateUserId: user.userId }));
  await command(`slotseqs configure --seq=${sequence.seqId} --controller=${controller.id} --mapping=${quote(mapping)}`);
  const gameUrl = new URL('/games/whattheshell/', process.env.GAME_PUBLIC_URL || 'http://localhost:3100');
  gameUrl.searchParams.set('seq', sequence.seqId);
  console.log('\nWhat the Shell demo is ready.');
  console.log(`Share this game URL: ${gameUrl.toString()}`);
  console.log(`bot apiKeyId: ${sequenceBot.id}`);
  console.log('The bot is waiting. Claim a slot and press Start on the page when everyone is ready.');
  await bot.run({ sequenceId: sequence.seqId, apiKeyId: sequenceBot.id, secret: sequenceBot.secret, pollIntervalMs: 3000, maxTurns: 500 });
}

if (require.main === module) main().catch(error => { console.error(`Launcher stopped: ${error.message}`); process.exitCode = 1; });
module.exports = { main };
