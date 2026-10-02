#!/usr/bin/env node
/*
Purpose: Run a sequence bot against an existing sequence.
- The sequence, space, users, and API key are created outside this simulation.
- The bot creates one ballot at a time and waits for clients to close it.
- Options are deliberately short letters so Node, web, and Telegram clients are easy to test.
*/

const Simulator = require('../lib');

const OPTION_LETTERS = ['a', 'b', 'c', 'd', 'e'];

function readArgument(name, fallback = null) {
  const prefix = `--${name}=`;
  const argument = process.argv.find(value => value.startsWith(prefix));
  return argument ? argument.slice(prefix.length) : fallback;
}

function buildOptions() {
  const count = 3 + Math.floor(Math.random() * 3);
  return OPTION_LETTERS.slice(0, count);
}

function optionsArgument(options) {
  return `'${JSON.stringify(options)}'`;
}

function usage() {
  console.error(
    'Usage: node public/sequence-bot.js ' +
    '--sequenceId=<id> --apiKeyId=<id> --secret=<secret> [--delay=<ms>]'
  );
}

async function main() {
  const sequenceId = readArgument('sequenceId') || readArgument('seq');
  const apiKeyId = readArgument('apiKeyId') || readArgument('clientId');
  const secret = readArgument('secret') || readArgument('clientSecret');
  const delayMs = Number.parseInt(readArgument('delay', '2000'), 10);

  if (!sequenceId || !apiKeyId || !secret || !Number.isFinite(delayMs) || delayMs < 100) {
    usage();
    process.exitCode = 1;
    return;
  }

  const sim = new Simulator();
  let token;
  let processedBallotId = null;

  console.log('\n' + '='.repeat(60));
  console.log('🤖 PUBLIC SEQUENCE BOT');
  console.log('='.repeat(60));
  console.log(`Sequence: ${sequenceId}`);
  console.log(`Polling every: ${delayMs} ms\n`);

  try {
    const loginResult = await sim._httpRequest('POST', '/api/auth/login', {
      type: 'user',
      credentials: {
        email: apiKeyId,
        password: secret
      }
    });

    token = loginResult.access_token;
    if (!token) {
      throw new Error('Failed to authenticate sequence bot');
    }

    console.log(`✅ Bot authenticated as ${loginResult.identity?.id || apiKeyId}`);

    while (true) {
      const sequenceResult = await sim._execRemote(`seqs get --id=${sequenceId}`, token);
      if (!sequenceResult.success || !sequenceResult.data) {
        throw new Error(sequenceResult.error || 'Sequence not found');
      }

      const sequence = sequenceResult.data;
      if (['finished', 'deleted'].includes(sequence.state)) {
        console.log(`🏁 Sequence is ${sequence.state}; stopping bot`);
        break;
      }

      const activeBallotId = sequence.ballotIds?.at(-1) || null;
      if (!activeBallotId) {
        const options = buildOptions();
        const createResult = await sim._execRemote(
          `ballots create --title="Turn 0" --space=${sequence.spaceId} ` +
          `--options=${optionsArgument(options)} --state=ready --seq=${sequenceId}`,
          token
        );

        if (!createResult.success) {
          throw new Error(createResult.error || 'Could not create turn 0 ballot');
        }

        console.log(`\n🎲 Turn 0`);
        console.log(`Options: [${options.join(',')}]`);
        console.log('Waiting for votes and manual ballot closure...');
        await sim._wait(delayMs);
        continue;
      }

      const ballotResult = await sim._execRemote(`ballots select --id=${activeBallotId}`, token);
      if (!ballotResult.success || !ballotResult.data) {
        throw new Error(ballotResult.error || 'Could not read active ballot');
      }

      const ballot = ballotResult.data;
      if (!(ballot.closed || ballot.state === 'closed')) {
        await sim._wait(delayMs);
        continue;
      }

      if (processedBallotId === activeBallotId) {
        await sim._wait(delayMs);
        continue;
      }

      const resultsResult = await sim._execRemote(`ballots results --id=${activeBallotId}`, token);
      if (!resultsResult.success || !resultsResult.data) {
        throw new Error(resultsResult.error || 'Could not read ballot results');
      }

      const results = resultsResult.data;
      const winner = results.finalResult?.winningOption;
      const turn = Number.isInteger(sequence.currentTurn) ? sequence.currentTurn : 0;
      const history = [...(sequence.turnHistory || []), {
        turn,
        ballotId: activeBallotId,
        winner: winner?.text || winner?.date || winner?.value || 'No winner',
        votes: results.ballotSummary?.totalVotes || 0
      }];
      console.log(`\n✅ Turn ${turn} closed`);
      console.log(`Winner: ${winner?.text || winner?.date || winner?.value || 'No winner'}`);
      console.log(`Votes: ${results.ballotSummary?.totalVotes || 0}`);

      const stateResult = await sim._execRemote(
        `seqs state --id=${sequenceId} --state=${sequence.state} ` +
        `--turn=${turn + 1} --ballots=${optionsArgument(sequence.ballotIds || [])} ` +
        `--history=${optionsArgument(history)}`,
        token
      );

      if (!stateResult.success) {
        throw new Error(stateResult.error || 'Could not advance sequence turn');
      }

      const options = buildOptions();
      const createResult = await sim._execRemote(
        `ballots create --title="Turn ${turn + 1}" --space=${sequence.spaceId} ` +
        `--options=${optionsArgument(options)} --state=ready --seq=${sequenceId}`,
        token
      );

      if (!createResult.success) {
        throw new Error(createResult.error || `Could not create turn ${turn + 1} ballot`);
      }

      processedBallotId = activeBallotId;
      console.log(`\n🎲 Turn ${turn + 1}`);
      console.log(`Options: [${options.join(',')}]`);
      console.log('Waiting for votes and manual ballot closure...');
      await sim._wait(delayMs);
    }
  } catch (error) {
    console.error(`\n❌ Sequence bot failed: ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = main;
