'use strict';

/** Unwrap the API response envelope returned inside /cli/execute data. */
function unwrapCommandData(result) {
  if (!result?.success) throw new Error(result?.error || 'Voting API command failed.');

  let data = result.data;
  while (data && typeof data === 'object' && data.success === true
    && Object.prototype.hasOwnProperty.call(data, 'data')) {
    data = data.data;
  }
  return data;
}

module.exports = { unwrapCommandData };
