'use strict';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// A 429 rejects the operation before it runs. Do not replay transport errors
// or other statuses: their writes may already have reached the server.
async function request(operation, wait = sleep) {
  for (;;) {
    try { return await operation(); }
    catch (error) {
      if (error.status !== 429) throw error;
      await wait(Math.max(1000, error.retryAfterMs ?? 60000) + 250);
    }
  }
}

module.exports = request;
