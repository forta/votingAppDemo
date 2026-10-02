'use strict';

function httpError(response, data) {
  const error = new Error(data.error || `HTTP ${response.status}`);
  error.status = response.status;
  const value = response.headers.get('retry-after') ?? data.retryAfterSeconds ?? data.details?.retryAfterSeconds;
  const seconds = value == null ? NaN : Number(value);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  error.retryAfterMs = Number.isFinite(delay) && delay >= 0 ? delay : null;
  return error;
}

module.exports = httpError;
