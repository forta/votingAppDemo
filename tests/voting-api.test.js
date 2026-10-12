'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createVotingApiClient } = require('../lib/voting-api');

test('bot authentication and commands use only the CLI execution endpoint', async () => {
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(options.body) });
    return new Response(JSON.stringify({ success: true, data: { access_token: 'token', identity: { type: 'apikey', id: 'pk_ink' } } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const client = createVotingApiClient('https://voting.example.test/');
    const login = await client.loginApiKey('pk_ink', 'hidden-secret');
    await client._execRemote('seqs list --functionalityId=ink', login.access_token);
    assert.deepEqual(calls.map(call => new URL(call.url).pathname), ['/cli/execute', '/cli/execute']);
    assert.equal(calls[0].body.command, 'auth token');
    assert.equal(calls[0].body.context.secret, 'hidden-secret');
    assert.equal(calls[1].body.command, 'seqs list --functionalityId=ink');
  } finally { global.fetch = originalFetch; }
});
