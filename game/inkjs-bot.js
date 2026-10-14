#!/usr/bin/env node
'use strict';

/**
 * Runs one Ink story as a sequence of voting ballots. A versioned seqState
 * checkpoint stores InkJS state and the current scene/ballot transition so a
 * new process can resume without relying on its previous in-memory Story.
 */

const { stdin, stdout } = require('process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const { loadInkStory } = require('../scripts/inkjs-story');
const { unwrapCommandData } = require('../lib/command-data');

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
  return unwrapCommandData(result);
}

function pause(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function stopAwarePause(ms, signal) {
  if (!signal) return pause(ms);
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });
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

function storyStateJson(story) {
  return story.state.ToJson();
}

function restoreStoryState(story, serialized) {
  if (typeof serialized !== 'string' || !serialized) throw new Error('Ink checkpoint has no serialized story state.');
  story.state.LoadJson(serialized);
}

function storyFingerprint(options, story) {
  const source = options.storyContent ?? (options.storyPath ? fs.readFileSync(options.storyPath) : null);
  if (source) return createHash('sha256').update(source).digest('hex');
  // Integrated mode supplies a compiled Story and a fingerprint computed from
  // the downloaded source file by GameManager.
  return story.fingerprint || null;
}

function renderScene(story) {
  const narrative = readStoryContinuation(story);
  let choices = story.currentChoices || [];
  const isEnding = choices.length === 0 && narrative.length > 0;
  if (isEnding) choices = [{ text: 'Finish the game' }];
  return { narrative, choices: choices.map(choice => ({ text: choice.text })), isEnding };
}

function isSupportedCheckpoint(checkpoint) {
  return checkpoint?.application === 'ink' && checkpoint.version === 1
    && typeof checkpoint.storyState === 'string' && checkpoint.scene
    && Number.isInteger(checkpoint.turn);
}

async function runInkBot(options, dependencies = {}) {
  const client = dependencies.client || require('../lib/voting-api').createVotingApiClient(process.env.WTS_CLI_SERVER_URL);
  const story = dependencies.story || loadInkStory(options.storyPath);
  const signal = dependencies.signal;
  const wait = dependencies.wait || (ms => stopAwarePause(ms, signal));
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
    output(`Sequence: ${sequence.name} (${sequence.seqId})`);
    const fingerprint = dependencies.storyFingerprint || storyFingerprint(options, story);
    if (!fingerprint) throw new Error('The Ink source fingerprint is unavailable; restart recovery cannot be verified.');
    const saved = await executeData(client, `seqs seq-state-get --id=${sequence.seqId}`, token);
    let checkpoint = saved?.seqState || null;
    const history = [...(sequence.turnHistory || [])];
    if (checkpoint && !isSupportedCheckpoint(checkpoint)) throw new Error('Unsupported Ink checkpoint version.');
    if (checkpoint && checkpoint.storyFingerprint !== fingerprint) throw new Error('The Ink source file differs from the one used by the saved game.');
    if (!checkpoint && (sequence.ballotIds || []).length) throw new Error('This sequence has ballots but no Ink checkpoint; it cannot be safely resumed.');

    const saveCheckpoint = async next => {
      checkpoint = { application: 'ink', version: 1, storyFingerprint: fingerprint, ...next };
      await executeData(client, `seqs seq-state-set --id=${sequence.seqId} --value=${quoteJsonForCommand(checkpoint)}`, token);
    };
    const persistState = async state => {
      sequence = await executeData(client, `seqs get --id=${sequence.seqId}`, token);
      await setSequenceState(client, token, sequence, state, history);
      sequence.state = state;
    };

    if (checkpoint) restoreStoryState(story, checkpoint.storyState);
    else {
      const scene = renderScene(story);
      checkpoint = { turn: 0, phase: 'awaiting-ballot', scene, storyState: storyStateJson(story), ballotId: null, processedBallotId: null, historyEntry: null };
      if (!scene.choices.length) {
        await persistState('finished');
        await saveCheckpoint({ ...checkpoint, completed: true });
        return { status: 'finished', turns: 0 };
      }
      await saveCheckpoint(checkpoint);
    }
    output(checkpoint.turn ? `Restored Ink story at turn ${checkpoint.turn + 1}.` : 'Ink story checkpoint ready.');

    let lastPersistedTurn = -1;
    while (checkpoint.turn < options.maxTurns && !checkpoint.completed) {
      if (signal?.aborted) return { status: sequence.state, reason: 'shutdown', turns: checkpoint.turn };
      if (interrupted) {
        await persistState('paused');
        output('Interrupted. The current Ink scene is saved and can be resumed.');
        return { status: 'paused', reason: 'interrupt', turns: checkpoint.turn };
      }
      sequence = await executeData(client, `seqs get --id=${sequence.seqId}`, token);
      if (['finished', 'deleted'].includes(sequence.state)) return { status: sequence.state, turns: checkpoint.turn };
      if (sequence.state === 'paused' || sequence.state === 'waiting' || sequence.state === 'ready') {
        await wait(options.pollIntervalMs);
        continue;
      }
      if (sequence.state !== 'playing') throw new Error(`Cannot run Ink game while sequence is ${sequence.state}.`);

      if (checkpoint.phase === 'choice-selected') {
        if (checkpoint.scene.isEnding) {
          if (checkpoint.historyEntry && !history.some(entry => entry.ballotId === checkpoint.historyEntry.ballotId)) history.push(checkpoint.historyEntry);
          await persistState('finished');
          await saveCheckpoint({ ...checkpoint, phase: 'completed', completed: true });
          output('Ink story complete; sequence marked finished.');
          return { status: 'finished', turns: checkpoint.turn + 1 };
        }
        restoreStoryState(story, checkpoint.storyState);
        story.ChooseChoiceIndex(checkpoint.choiceIndex);
        const nextScene = renderScene(story);
        const entry = checkpoint.historyEntry;
        if (entry && !history.some(item => item.ballotId === entry.ballotId)) history.push(entry);
        checkpoint = {
          turn: checkpoint.turn + 1,
          phase: 'awaiting-ballot',
          scene: nextScene,
          storyState: storyStateJson(story),
          ballotId: null,
          processedBallotId: checkpoint.ballotId,
          historyEntry: null
        };
        await saveCheckpoint(checkpoint);
        await persistState('playing');
        continue;
      }

      if (checkpoint.phase !== 'awaiting-ballot') throw new Error(`Unsupported Ink checkpoint phase: ${checkpoint.phase}`);
      const { scene } = checkpoint;
      if (!scene?.choices?.length) {
        await persistState('finished');
        await saveCheckpoint({ ...checkpoint, phase: 'completed', completed: true });
        return { status: 'finished', turns: checkpoint.turn };
      }
      if (checkpoint.ballotId && sequence.ballotIds?.at(-1) !== checkpoint.ballotId) {
        throw new Error('Another runner changed the sequence ballot while this Ink game was paused.');
      }
      if (!checkpoint.ballotId) {
        const newest = sequence.ballotIds?.at(-1);
        let ballotId = null;
        if (newest && newest !== checkpoint.processedBallotId) {
          const candidate = await executeData(client, `ballots select --id=${newest}`, token);
          if (candidate.title === (scene.isEnding ? 'Ink game · ending' : `Ink game · turn ${checkpoint.turn + 1}`)) ballotId = newest;
        }
        if (!ballotId) {
          const created = await executeData(client, buildCreateBallotCommand({
            sequenceId: sequence.seqId, spaceId: sequence.spaceId, turn: checkpoint.turn,
            choices: scene.choices, description: scene.narrative, isEnding: scene.isEnding
          }), token);
          ballotId = created?.ballotId;
          if (!ballotId) throw new Error('Ballot creation returned no ballot ID.');
        }
        checkpoint = { ...checkpoint, ballotId };
        await saveCheckpoint(checkpoint);
        output(`Ink turn ${checkpoint.turn + 1}: ballot ${ballotId}.`);
      }
      if (checkpoint.turn !== lastPersistedTurn) {
        output(scene.isEnding ? '\nFinal turn — vote to acknowledge the ending:' : `\nTurn ${checkpoint.turn + 1} — vote for the next story choice:`);
        scene.choices.forEach((choice, index) => output(`  ${index + 1}. ${choice.text}`));
        lastPersistedTurn = checkpoint.turn;
      }

      await wait(options.pollIntervalMs);
      if (signal?.aborted) return { status: sequence.state, reason: 'shutdown', turns: checkpoint.turn };
      if (interrupted) continue;
      sequence = await executeData(client, `seqs get --id=${sequence.seqId}`, token);
      if (sequence.state === 'paused') continue;
      if (sequence.ballotIds?.at(-1) !== checkpoint.ballotId) throw new Error('Another runner changed the sequence ballot.');
      const ballot = await executeData(client, `ballots select --id=${checkpoint.ballotId}`, token);
      if (!ballot.closed && ballot.state !== 'closed' && ballot.state !== 'canceled') continue;
      if (ballot.state === 'canceled') {
        checkpoint = { ...checkpoint, processedBallotId: checkpoint.ballotId, ballotId: null };
        await saveCheckpoint(checkpoint);
        continue;
      }
      const results = await executeData(client, `ballots results --id=${checkpoint.ballotId}`, token);
      const choiceIndex = findWinningChoiceIndex(results, scene.choices);
      if (choiceIndex === null) {
        await persistState('paused');
        checkpoint = { ...checkpoint, processedBallotId: checkpoint.ballotId, ballotId: null };
        await saveCheckpoint(checkpoint);
        output('The ballot has no unambiguous winning choice. Sequence paused; the saved scene will be offered again after resume.');
        continue;
      }
      const winner = scene.choices[choiceIndex];
      const historyEntry = {
        turn: checkpoint.turn + 1, ballotId: checkpoint.ballotId, winner: winner.text,
        choiceIndex, ...(scene.isEnding ? { ending: true } : {}),
        votes: results.ballotSummary?.totalVotes || 0
      };
      checkpoint = { ...checkpoint, phase: 'choice-selected', choiceIndex, historyEntry };
      await saveCheckpoint(checkpoint);
      output(`Winner: ${winner.text}`);
    }

    await persistState('paused');
    output(`Reached the ${options.maxTurns}-turn safety limit; sequence paused with its Ink state saved.`);
    return { status: 'paused', reason: 'max-turns', turns: checkpoint.turn };
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
  isSupportedCheckpoint,
  restoreStoryState,
  storyStateJson,
  runInkBot,
  setSequenceState
};
