'use strict';
const { loadEnvironment, configuration } = require('../lib/config');
const { connectGames } = require('../lib/games');
loadEnvironment();
connectGames(configuration()).then(async connection => {
  console.log('Games collection and indexes ready.');
  await connection.close();
}).catch(() => { console.error('Cannot prepare games database. Check MongoDB connection and permissions.'); process.exitCode = 1; });
