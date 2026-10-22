'use strict';

/**
 * Small command client for the voting backend. API-key exchange and every
 * authenticated or anonymous operation go through POST /cli/execute.
 */

function createVotingApiClient(serverUrl, { headers: extraHeaders = {} } = {}) {
  const baseUrl = String(serverUrl || '').replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(baseUrl)) throw new Error('WTS_CLI_SERVER_URL must be an HTTP(S) URL.');

  async function execute(command, token, context) {
    const headers = { ...extraHeaders, 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(`${baseUrl}/cli/execute`, {
      method: 'POST', headers,
      body: JSON.stringify({ command, ...(context ? { context } : {}) })
    });
    let data;
    try { data = await response.json(); } catch { data = {}; }
    if (!response.ok) {
      const error = new Error(data.error || `Voting API returned ${response.status}.`);
      error.status = response.status;
      error.code = data.code || null;
      const retryAfter = Number(response.headers.get('retry-after'));
      if (Number.isFinite(retryAfter) && retryAfter > 0) error.retryAfterMs = retryAfter * 1000;
      throw error;
    }
    return data;
  }

  return {
    serverUrl: baseUrl,
    _execRemote: (command, token) => execute(command, token),
    loginApiKey: async (apiKeyId, secret) => {
      const result = await execute('auth token', null, { apiKeyId, secret });
      if (!result.success || !result.data?.access_token) throw new Error(result.error || 'API key authentication failed.');
      return result.data;
    }
  };
}

module.exports = { createVotingApiClient };
