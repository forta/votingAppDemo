#!/usr/bin/env node
'use strict';

// Read-only summary for an account with an existing CLI login context.
// Reuses a saved CLI context and never logs in or renews its token.

const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const fetch = require('node-fetch');
const config = require('../config');

const SERVER_URL = config.serverUrl.replace(/\/+$/, '');
const CONTEXTS_DIR = path.join(
  __dirname,
  '..',
  'state',
  'contexts',
  require('../lib')._serverContextDirName(SERVER_URL)
);
const timing = {
  startedAt: 0,
  requestCount: 0,
  requestTotalMs: 0,
  requestMaxMs: 0
};

const READ_ONLY_COMMANDS = [
  /^spaces list$/,
  /^ballots list --space=[A-Za-z0-9_-]+ --type=all --status=all$/,
  /^seqs get --id=[A-Za-z0-9_-]+$/,
  /^votes mine --id=[A-Za-z0-9_-]+$/
];

function usageText() {
  return [
    'Usage:',
    '  node public/summarize.js --username <username-or-email> --context <context-name>',
    '',
    'The account must already have a saved login context for the server selected by CLI_SERVER_URL.',
    'First log in and save that context:',
    '  node cli.js login --username <username-or-email> --password <password> --context <context-name>',
    'Then run this read-only summary:',
    '  node public/summarize.js --username <username-or-email> --context <context-name>'
  ].join('\n');
}

function parseArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const match = arg.match(/^--(username|context)(?:=(.*))?$/);
    if (!match) throw new Error(`Unknown argument: ${arg}\n\n${usageText()}`);

    const [, key, inlineValue] = match;
    const value = inlineValue === undefined ? args[++index] : inlineValue;
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for --${key}.\n\n${usageText()}`);
    }
    options[key] = value.trim();
  }

  const missing = ['username', 'context'].filter(key => !options[key]);
  if (missing.length) {
    throw new Error(`Missing required parameter${missing.length > 1 ? 's' : ''}: ${missing.map(key => `--${key}`).join(', ')}.\n\n${usageText()}`);
  }

  return options;
}

async function requestJson(url, options = {}) {
  const requestStartedAt = performance.now();
  let response;
  let responseText;

  try {
    response = await fetch(url, options);
    responseText = await response.text();
  } finally {
    const requestMs = performance.now() - requestStartedAt;
    timing.requestCount += 1;
    timing.requestTotalMs += requestMs;
    timing.requestMaxMs = Math.max(timing.requestMaxMs, requestMs);
  }

  let payload;

  try {
    payload = responseText ? JSON.parse(responseText) : {};
  } catch {
    throw new Error(`Server returned non-JSON content (${response.status}) for ${url}`);
  }

  if (!response.ok) {
    throw new Error(payload.error || `HTTP ${response.status} from ${url}`);
  }

  return payload;
}

function loadSavedContext(username, contextName) {
  if (!/^[A-Za-z0-9_.-]+$/.test(contextName)) {
    throw new Error('--context contains invalid characters.');
  }

  const contextPath = path.join(CONTEXTS_DIR, `${contextName}.json`);
  let context;

  try {
    context = JSON.parse(fs.readFileSync(contextPath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`Saved context "${contextName}" not found for ${SERVER_URL}. Log in through the CLI first.`);
    }
    throw new Error(`Could not read saved context "${contextName}": ${error.message}`);
  }

  const savedUsername = context.credentials?.username?.trim().toLowerCase();
  if (savedUsername !== username.trim().toLowerCase()) {
    throw new Error(`Saved context "${contextName}" is logged in as "${context.credentials?.username || 'unknown'}", not "${username}".`);
  }

  if (context.serverUrl !== SERVER_URL) {
    throw new Error(`Saved context "${contextName}" belongs to a different server. Log in to ${SERVER_URL} first.`);
  }

  const expiresAt = Date.parse(context.expiresAt);
  if (!context.token || !Number.isFinite(expiresAt) || expiresAt <= Date.now() + 60_000) {
    throw new Error(`Saved context "${contextName}" has no usable token. Log in again through the CLI first.`);
  }

  if (!context.identity?.id) {
    throw new Error(`Saved context "${contextName}" has no identity information.`);
  }

  return context;
}

async function executeReadOnly(command, token) {
  if (!READ_ONLY_COMMANDS.some(pattern => pattern.test(command))) {
    throw new Error(`Refusing to execute a non-read-only command: ${command}`);
  }

  const result = await requestJson(`${SERVER_URL}/cli/execute`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({ command })
  });

  if (!result.success) {
    throw new Error(result.error || `Command failed: ${command}`);
  }

  return result.data;
}

function asArray(value, description) {
  if (!Array.isArray(value)) {
    throw new Error(`Expected an array when reading ${description}.`);
  }
  return value;
}

function optionLabel(options, choiceId) {
  const match = options.find((option, index) => {
    if (option && typeof option === 'object' && option.choiceId !== undefined) {
      return String(option.choiceId) === String(choiceId);
    }
    return index === Number(choiceId);
  });

  if (typeof match === 'string') return match;
  return match?.text || match?.label || match?.name || `choice ${choiceId}`;
}

function describeVote(vote, ballot) {
  const value = vote.vote || vote;
  let selection;

  if (value.type === 'choiceId' && value.choiceId !== undefined) {
    const options = ballot.ballotSpecs?.availableOptions || [];
    selection = optionLabel(options, value.choiceId);
  } else if (value.text !== undefined) {
    selection = value.text;
  } else {
    selection = JSON.stringify(value);
  }

  const weight = vote.weight === undefined ? '' : ` (weight ${vote.weight})`;
  const votedAt = vote.votedAt ? `, ${new Date(vote.votedAt).toISOString()}` : '';
  return `${selection}${weight}${votedAt}`;
}

function spaceRole(space, userId) {
  if (space.createdBy === userId) return 'owner';
  return space.members?.find(member => member.userId === userId)?.role || 'member';
}

async function summarizeSpace(space, userId, token) {
  const title = space.head?.title || 'Untitled space';
  const role = spaceRole(space, userId);
  const ballots = asArray(
    await executeReadOnly(
      `ballots list --space=${space.spaceId} --type=all --status=all`,
      token
    ),
    `ballots in ${space.spaceId}`
  );

  console.log(`\n${title} [${role}]`);
  console.log(`  Space: ${space.spaceId}`);
  console.log(`  Ballots: ${ballots.length}`);

  const sequenceIds = new Set();
  for (const ballot of ballots) {
    if (ballot.seqId) sequenceIds.add(ballot.seqId);
  }

  if (sequenceIds.size) {
    console.log('  Sequences referenced by these ballots:');
    for (const seqId of sequenceIds) {
      const sequence = await executeReadOnly(`seqs get --id=${seqId}`, token);
      if (sequence?.spaceId !== space.spaceId) continue;
      console.log(`    - ${sequence.name || 'Untitled sequence'} [${sequence.state || 'unknown'}] ${seqId}`);
    }
  } else {
    console.log('  Sequences referenced by these ballots: none');
  }

  for (const ballot of ballots) {
    const ballotTitle = ballot.ballotHead?.title || ballot.title || 'Untitled ballot';
    const state = ballot.closed ? 'closed' : (ballot.state || 'unknown');
    console.log(`  - ${ballotTitle} [${state}] ${ballot.ballotId}`);

    const votes = asArray(
      await executeReadOnly(`votes mine --id=${ballot.ballotId}`, token),
      `your votes on ${ballot.ballotId}`
    );

    if (votes.length) {
      for (const vote of votes) {
        console.log(`      Your vote: ${describeVote(vote, ballot)}`);
      }
    } else {
      console.log('      Your vote: none');
    }
  }
}

async function main() {
  const { username, context: contextName } = parseArguments(process.argv.slice(2));
  timing.startedAt = performance.now();
  console.log(`Read-only summary for ${username} at ${SERVER_URL}`);
  const context = loadSavedContext(username, contextName);
  const identity = context.identity;
  const spaces = asArray(await executeReadOnly('spaces list', context.token), 'spaces');
  const ownedSpaces = spaces.filter(space => space.createdBy === identity.id);
  const memberSpaces = spaces.filter(space =>
    space.createdBy !== identity.id && space.members?.some(member => member.userId === identity.id)
  );

  console.log(`Authenticated as ${identity.name || identity.alias || username} (${identity.id})`);
  console.log(`Using saved CLI context: ${contextName}`);
  console.log(`Spaces: ${spaces.length} total, ${ownedSpaces.length} owned, ${memberSpaces.length} joined`);

  for (const space of spaces) {
    await summarizeSpace(space, identity.id, context.token);
  }

  console.log('\nCoverage notes: existing CLI reads return at most 50 spaces and 50 ballots per space.');
  console.log('Sequences are discovered through those ballots; empty sequences cannot be listed per space with current commands.');

  const elapsedMs = performance.now() - timing.startedAt;
  const averageRequestMs = timing.requestCount
    ? timing.requestTotalMs / timing.requestCount
    : 0;
  console.log('\nTiming:');
  console.log(`  Total elapsed: ${(elapsedMs / 1000).toFixed(2)} s`);
  console.log(`  HTTP requests: ${timing.requestCount}`);
  console.log(`  HTTP request time: ${(timing.requestTotalMs / 1000).toFixed(2)} s total, ${averageRequestMs.toFixed(0)} ms average, ${timing.requestMaxMs.toFixed(0)} ms max`);
}

main().catch(error => {
  console.error(`Summary failed: ${error.message}`);
  process.exitCode = 1;
});
