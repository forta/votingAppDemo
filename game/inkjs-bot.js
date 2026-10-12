#!/usr/bin/env node
'use strict';

/**
 * Runs one Ink story as a sequence of voting ballots. The story instance is
 * currently process-local; this bot only accepts fresh sequences and does not
 * restore InkJS state after a process restart.
 */

const { stdin, stdout } = require('process');
const { loadInkStory } = require('../scripts/inkjs-story');

const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_MAX_TURNS = 500;

function readArguments(args, env = process.env) {
  const options = {
    sequenceId: null,
    apiKeyId: env.INK_BOT_API_KEY_ID || null,
    storyPath: env.INK_BOT_STORY || null,
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    maxTurns: DEFAULT_MAX_TURNS,
    secret: env.INK_BOT_SECRET || null
  };

  const aliases = {
    '--sequenceId': 'sequenceId',
    '--sequence-id': 'sequenceId',
    '--apiKeyId': 'apiKeyId',
    '--api-key-id': 'apiKeyId',
    '--story': 'storyPath',
    '--poll-interval': 'pollIntervalMs',
    '--max-turns': 'maxTurns'
  };

  for (let index = 0; index < args.length; index += 1) {
    const [flag, inlineValue] = args[index].split(/=(.*)/s, 2);
    const key = aliases[flag];
    if (!key) throw new Error(`Unknown argument: ${flag}`);

    const value = inlineValue === undefined ? args[++index] : inlineValue;
    if (!value) throw new Error(`Missing value for ${flag}`);
    if (key === 'pollIntervalMs' || key === 'maxTurns') {
      options[key] = Number.parseInt(value, 10);
    } else {
      options[key] = value;
    }
  }

  if (!options.sequenceId || !options.apiKeyId || !options.storyPath) {
    throw new Error('Sequence ID, API key ID and story path are required.');
  }
  if (!Number.isInteger(options.pollIntervalMs) || options.pollIntervalMs < 250) {
    throw new Error('--poll-interval must be at least 250 ms.');
  }
  if (!Number.isInteger(options.maxTurns) || options.maxTurns < 1) {
    throw new Error('--max-turns must be a positive integer.');
  }

  return options;
}

function quoteJsonForCommand(value) {
  // The command parser accepts single-quoted values but has no quote escaping.
  return `'${JSON.stringify(value).replace(/'/g, '\\u0027')}'`;
}

function buildCreateBallotCommand({ sequenceId, spaceId, turn, choices, description, isEnding = false }) {
  const options = choices.map(choice => ({ type: 'text', text: choice.text }));
  const title = isEnding ? 'Ink game · ending' : `Ink game · turn ${turn + 1}`;
  const descriptionFlag = description ? ` --descriptionJson=${quoteJsonForCommand(description)}` : '';
  return `ballots create --title="${title}" ` +
    `--space=${spaceId} --options=${quoteJsonForCommand(options)} ` +
    `--allowCustom=false --state=ready --seq=${sequenceId}${descriptionFlag}`;
}

function findWinningChoiceIndex(results, choices) {
  const finalResult = results?.finalResult;
  if (finalResult?.hasWinner !== true || !finalResult.winningOption) return null;

  const winner = finalResult.winningOption;
  if (Number.isInteger(winner.choiceId) && winner.choiceId >= 0 && winner.choiceId < choices.length) {
    return winner.choiceId;
  }

  const winnerText = typeof winner === 'string' ? winner : winner.text;
  if (typeof winnerText !== 'string') return null;
  const matches = choices
    .map((choice, index) => choice.text === winnerText ? index : -1)
    .filter(index => index >= 0);
  return matches.length === 1 ? matches[0] : null;
}

async function promptSecret() {
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
    throw new Error('Set INK_BOT_SECRET or run in a terminal to enter the API key secret securely.');
  }

  stdout.write('API key secret (input hidden): ');
  const originalRawMode = stdin.isRaw;
  stdin.setRawMode(true);
  stdin.resume();

  return new Promise((resolve, reject) => {
    let secret = '';
    const cleanup = () => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(Boolean(originalRawMode));
      stdin.pause();
      stdout.write('\n');
    };
    const onData = chunk => {
      for (const character of chunk.toString('utf8')) {
        if (character === '\u0003') {
          cleanup();
          reject(new Error('Secret entry cancelled.'));
          return;
        }
        if (character === '\r' || character === '\n') {
          cleanup();
          resolve(secret);
          return;
        }
        if (character === '\u007f' || character === '\b') {
          secret = secret.slice(0, -1);
        } else {
          secret += character;
        }
      }
    };
    stdin.on('data', onData);
  });
}

async function executeData(client, command, token) {
  const result = await client._execRemote(command, token);
  if (!result?.success) throw new Error(result?.error || `Command failed: ${command}`);
  return result.data;
}

function pause(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function setSequenceState(client, token, sequence, state, history) {
  const command = `seqs state --id=${sequence.seqId} --state='${state}' ` +
    `--history=${quoteJsonForCommand(history)}`;
  return executeData(client, command, token);
}

function readStoryContinuation(story) {
  let narrative = '';
  while (story.canContinue) narrative += story.Continue();
  if (narrative) stdout.write(narrative.endsWith('\n') ? narrative : `${narrative}\n`);
  return narrative.trim();
}

async function runInkBot(options, dependencies = {}) {
  const client = dependencies.client || require('../lib/voting-api').createVotingApiClient(process.env.WTS_CLI_SERVER_URL);
  const story = dependencies.story || loadInkStory(options.storyPath);
  const wait = dependencies.wait || pause;
  const output = dependencies.output || (message => console.log(message));
  const secret = options.secret || await (dependencies.promptSecret || promptSecret)();
  let interrupted = false;
  const onInterrupt = () => { interrupted = true; };

  process.on('SIGINT', onInterrupt);
  try {
    let token = dependencies.token;
    if (!token) {
      if (typeof client.loginApiKey !== 'function') throw new Error('API key authentication must use the /cli/execute gateway.');
      const login = await client.loginApiKey(options.apiKeyId, secret);
      const identity = login.identity;
      if (!login.access_token || identity?.type !== 'apikey' || (identity.apiKeyId || identity.id) !== options.apiKeyId) {
        throw new Error('The supplied credentials did not authenticate as the requested API key.');
      }
      token = login.access_token;
    }
    output(`Authenticated as sequence bot ${options.apiKeyId} at ${client.serverUrl}.`);

    let sequence = await executeData(client, `seqs get --id=${options.sequenceId}`, token);
    if (sequence.seqId !== options.sequenceId) throw new Error('Sequence ID mismatch.');
    if (sequence.botUserId !== options.apiKeyId || sequence.botMode !== 'sequence_bot') {
      throw new Error('Assign this sequence to the supplied API key in sequence_bot mode first.');
    }
    if ((sequence.ballotIds || []).length !== 0) {
      throw new Error('This first version only runs on a fresh sequence with no ballots; it cannot resume a game.');
    }

    output(`Sequence: ${sequence.name} (${sequence.seqId})`);
    output('This run starts a new Ink story from its beginning; no Ink state is saved.');
    if (sequence.state !== 'playing') output('Waiting for the sequence owner to start or resume the game in the voting app...');
    while (sequence.state !== 'playing') {
      if (sequence.state === 'finished' || sequence.state === 'deleted') {
        output(`Sequence is ${sequence.state}; stopping bot.`);
        return { status: sequence.state, turns: 0 };
      }
      if (sequence.state !== 'waiting' && sequence.state !== 'paused' && sequence.state !== 'ready') {
        throw new Error(`Cannot wait for sequence state: ${sequence.state}`);
      }
      await wait(options.pollIntervalMs);
      if (interrupted) return { status: 'paused', reason: 'interrupt', turns: 0 };
      sequence = await executeData(client, `seqs get --id=${options.sequenceId}`, token);
      if (sequence.ballotIds?.length) {
        throw new Error('This first version only runs on a fresh sequence with no ballots; it cannot resume a game.');
      }
    }
    const history = [...(sequence.turnHistory || [])];

    for (let turn = 0; turn < options.maxTurns; turn += 1) {
      if (interrupted) {
        sequence = await executeData(client, `seqs get --id=${options.sequenceId}`, token);
        await setSequenceState(client, token, sequence, 'paused', history);
        output('Interrupted. Sequence paused; this run cannot be resumed from a new process.');
        return { status: 'paused', reason: 'interrupt', turns: turn };
      }

      const narrative = readStoryContinuation(story);
      let choices = story.currentChoices || [];
      const isEnding = choices.length === 0 && narrative.length > 0;

      if (choices.length === 0) {
        if (!isEnding) {
          await setSequenceState(client, token, sequence, 'finished', history);
          output('Ink story complete; sequence marked finished.');
          return { status: 'finished', turns: turn };
        }
        choices = [{ text: 'Finish the game' }];
      }

      output(isEnding
        ? '\nFinal turn — cast one vote to acknowledge the ending:'
        : `\nTurn ${turn + 1} — cast one vote for the next story choice:`);
      choices.forEach((choice, index) => output(`  ${index + 1}. ${choice.text}`));

      let sceneResolved = false;
      while (!sceneResolved) {
        const createCommand = buildCreateBallotCommand({
          sequenceId: options.sequenceId,
          spaceId: sequence.spaceId,
          turn,
          choices,
          description: narrative,
          isEnding
        });
        const created = await executeData(client, createCommand, token);
        const ballotId = created?.ballotId;
        if (!ballotId) throw new Error('Ballot creation returned no ballot ID.');
        output(`Ballot created: ${ballotId}. Waiting for votes and closure.`);

        let retryScene = false;
        while (true) {
          await wait(options.pollIntervalMs);
          if (interrupted) {
            sequence = await executeData(client, `seqs get --id=${options.sequenceId}`, token);
            await setSequenceState(client, token, sequence, 'paused', history);
            output('Interrupted. Sequence paused; this run cannot be resumed from a new process.');
            return { status: 'paused', reason: 'interrupt', turns: turn };
          }

          sequence = await executeData(client, `seqs get --id=${options.sequenceId}`, token);
          if (sequence.state === 'finished' || sequence.state === 'deleted') {
            output(`Sequence is ${sequence.state}; stopping bot.`);
            return { status: sequence.state, turns: turn };
          }
          if (sequence.state === 'paused') continue;

          const currentBallotId = sequence.ballotIds?.at(-1);
          if (currentBallotId !== ballotId) {
            throw new Error(`Unexpected sequence ballot change: expected ${ballotId}, received ${currentBallotId || 'none'}.`);
          }

          const ballot = await executeData(client, `ballots select --id=${ballotId}`, token);
          if (ballot.closed || ballot.state === 'closed' || ballot.state === 'canceled') {
            const results = await executeData(client, `ballots results --id=${ballotId}`, token);
            const choiceIndex = findWinningChoiceIndex(results, choices);
            if (choiceIndex === null) {
              await setSequenceState(client, token, sequence, 'paused', history);
              const noVotes = Number(results.ballotSummary?.totalVotes || 0) === 0;
              output(noVotes
                ? 'No votes were received before the ballot closed. Sequence paused; waiting for a slot holder to resume.'
                : 'The ballot has no unambiguous winning choice. Sequence paused; waiting for a slot holder to resume.');

              while (true) {
                await wait(options.pollIntervalMs);
                if (interrupted) {
                  output('Interrupted while paused. The sequence remains paused.');
                  return { status: 'paused', reason: 'interrupt', turns: turn };
                }
                sequence = await executeData(client, `seqs get --id=${options.sequenceId}`, token);
                if (sequence.state === 'finished' || sequence.state === 'deleted') {
                  output(`Sequence is ${sequence.state}; stopping bot.`);
                  return { status: sequence.state, turns: turn };
                }
                if (sequence.state === 'playing') {
                  output('Sequence resumed. Reopening the same Ink scene for voting.');
                  retryScene = true;
                  break;
                }
              }
              break;
            }

            const winner = choices[choiceIndex];
            history.push({
              turn: turn + 1,
              ballotId,
              winner: winner.text,
              choiceIndex,
              ...(isEnding ? { ending: true } : {}),
              votes: results.ballotSummary?.totalVotes || 0
            });
            await setSequenceState(client, token, sequence, isEnding ? 'finished' : 'playing', history);
            output(`Winner: ${winner.text}`);
            if (isEnding) {
              output('Ink story complete; sequence marked finished.');
              return { status: 'finished', turns: turn + 1 };
            }
            story.ChooseChoiceIndex(choiceIndex);
            sceneResolved = true;
            break;
          }
        }
        if (!retryScene && !sceneResolved) break;
      }
    }

    sequence = await executeData(client, `seqs get --id=${options.sequenceId}`, token);
    await setSequenceState(client, token, sequence, 'paused', history);
    output(`Reached the ${options.maxTurns}-turn safety limit; sequence paused.`);
    return { status: 'paused', reason: 'max-turns', turns: options.maxTurns };
  } finally {
    process.removeListener('SIGINT', onInterrupt);
  }
}

function usage() {
  return 'Usage: node cli-scripts/ink-launcher.js --sequenceId=<id> [--apiKeyId=<id>] [--story=<file.ink|file.json>] ' +
    '[--poll-interval=2000] [--max-turns=500] (or set INK_BOT_API_KEY_ID, INK_BOT_SECRET and INK_BOT_STORY)';
}

async function main(args = process.argv.slice(2)) {
  try {
    const options = readArguments(args);
    await runInkBot(options);
  } catch (error) {
    console.error(`InkJS bot stopped: ${error.message}`);
    console.error(usage());
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  buildCreateBallotCommand,
  findWinningChoiceIndex,
  quoteJsonForCommand,
  readStoryContinuation,
  readArguments,
  runInkBot,
  setSequenceState
};
