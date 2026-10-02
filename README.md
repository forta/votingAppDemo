# What the Shell multi-bot

Standalone Node.js example using the voting system through its public CLI
client. The voting backend remains a separate service. This project serves the
player site, discovers sequences assigned to the `whattheshell` functionality,
and starts one in-memory bot when someone connects to a game.

## Development setup

Requires Node.js 18 or newer and the dependencies declared in `CLI/package.json`.
`CLI` points to `../CLI` during development. No backend module or database
connection is imported by this project.

Create the ignored development junction if it is not already present, and
install the CLI dependencies when needed:

```powershell
npm run link:cli
npm --prefix CLI install
```

For local development, copy `.env.example` to `multi-bot/.env` and fill in the
game bot's credentials. This file is ignored by Git and loads automatically.
For deployments, inject the values or set `MULTIBOT_ENV_FILE` to a file
outside this directory. Then start the site:

```powershell
cd multi-bot
npm start
```

The site listens on `http://127.0.0.1:3100` by default. The minimum required
environment values are:

```env
CLI_SERVER_URL=http://localhost:3000
WTS_FUNCTIONALITY_ID=whattheshell
WTS_BOT_API_KEY_ID=pk_...
WTS_BOT_SECRET=...
```

The bot API key must be active, use `sequence_bot` mode, and be the key
registered for the functionality. No owner login or `surrogate_controller`
credentials are needed to discover and play already prepared sequences.

## Explore and play

Open the site root to list sequences visible to the configured game bot. The
backend only returns sequences assigned to that API key; the site exposes a
small public projection and never sends the key or token to the browser.
Selecting a sequence starts its bot in the site process. The bot waits for a
slot holder to claim a slot and press **Start game**.

Before it can be played, a sequence must have the `whattheshell` functionality,
be assigned to the corresponding sequence bot, and have its five game slots
configured. This initial runner only starts fresh sequences with no ballots;
recovery of an already played game after a process restart is not implemented.

## Creating a game sequence

Create a dedicated space, then create its sequence and select the approved
`whattheshell` functionality. Register this functionality with five slots,
which is the number of players What the Shell supports. The backend reuses the
owner's oldest active surrogate accounts, creates only enough to reach the
declared count, adds any missing accounts to the space and maps them to the
sequence slots. The new sequence is then ready to open from the site explorer.
Players claim slots and press **Start game**.

The current backend allows only one active sequence per space. A surrogate can
be mapped once per sequence and reused across other sequences. A mapping can
only be unassigned while its sequence is fresh and waiting. The same
functionality, bot credentials, and surrogate accounts are reusable across
games; no new integration or API key is needed. Creating a game checks the
owner's surrogate-account quota and the space's member quota before provisioning.

## Credential boundary and limitations

The browser sends only public `slotseqs` commands to this server. Bot commands
run in the Node process through the CLI client. Authentication uses the game
bot API key, while game rules and UI strings are copied into this project.
There is no local games database or password-protected game-creation page in
this workflow.

The game board and bot state remain in memory. Each connected sequence gets at
most one bot in a running process. Bots honor upstream `Retry-After` responses;
the site does not implement a shared request scheduler or token renewal for
long-running processes. The sequence explorer currently uses the backend's
existing list limit of 20.

Do not distribute the development CLI junction. Replace it with a copy of the
public CLI source and its package manifest/lockfile. Exclude `.env`, `state/`,
`contexts/`, `node_modules/`, logs, and credentials.

## Checks

```powershell
npm test
```
