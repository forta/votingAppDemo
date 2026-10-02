'use strict';

const path = require('path');
const dotenv = require('dotenv');

// The public CLI owns its runtime configuration and does not load server config.
if (process.env.CLI_LOAD_ENV !== 'false') {
  dotenv.config({ path: path.join(__dirname, '.env') });
}

module.exports = {
  serverUrl: process.env.CLI_SERVER_URL || 'http://localhost:3000'
};
