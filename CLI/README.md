# votingApp CLI

Current release context: `v1.008`

This directory is the publishable command-line client and selected public tools. It
is intentionally independent from the private server package and communicates
with the server through `/cli/execute` and the explicitly public endpoints
used by the scenarios.

## Install

From this directory:

```bash
npm install
```

Copy `.env.example` to `.env` and set `CLI_SERVER_URL`. The public CLI tools
communicate with the server through its HTTP interface and do not connect
directly to MongoDB.

Login contexts are stored separately for each normalized `CLI_SERVER_URL` in
`state/contexts/<safe-server-name>-<url-hash>/`. The context name (for example,
`pepe`) is selected within that server. Existing context files in the old
`state/contexts/` layout are migrated to the localhost server the first time
the CLI runs with `http://localhost:3000`; they are not treated as production
credentials. The read-only summary takes the account and context explicitly.

The read-only account summary requires both the account name and context name.
It reuses the saved token and does not log in or renew credentials:

```bash
node cli.js login --username <username-or-email> --password <password> --context <context-name>
node public/summarize.js --username <username-or-email> --context <context-name>
```

Run the summary from the `CLI/` directory with the same `CLI_SERVER_URL` used
for login.

Scenario instance data that must be shared by consecutive scripts for one
server (such as the bot credentials produced by `04a-bot-setup`) lives in
`CLI/contexts/<safe-server-name>-<url-hash>/`. It is separate from login
sessions but scoped to the same server instance. This runtime directory is
ignored by Git because scenario files can contain bot credentials.

## Public tools

```bash
npm run cli -- login --username=alice@example.com --password=alice123 --context=alice
node public/summarize.js --username alice@example.com --context alice
node public/sequence-bot.js --sequenceId=<sequence-id> --apiKeyId=<api-key-id> --secret=<api-key-secret>
```

The summary requires a saved login context and performs only read operations.
The sequence bot requires an existing sequence assigned to the API key. It
creates the first ballot, waits for it to close, records the outcome, and
advances the sequence. Run it only against a sequence you intend the bot to
operate.

Developer and regression simulations live in the repository's `cli-scripts/`
directory, outside this publishable npm package. Several use system accounts
or clear/create test data; see the repository's root documentation before
running them locally.

The server's strict anti-flood policy is the default. Automated simulations
that intentionally create many requests may set `RELAX_RATE_LIMITS=true` only
in the server development environment; this variable is not required by the
CLI itself and must remain unset or false in production.

## Configuration boundary

`CLI/config.js` contains only CLI runtime settings. The CLI does not import
the server's `config.js`, database modules, routes, or command translator.
The command catalogue remains the shared public contract in the parent
project's `config/commands.json`; it is not duplicated here.

## Dependencies

- `node-fetch`: HTTP requests from the CLI helper.
- `chalk`: readable scenario output.
- `ws`: WebSocket integration scenarios.
- `dotenv`: local CLI environment configuration.
