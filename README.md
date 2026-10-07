# What the Shell multi-bot example

Standalone Node.js example using the voting system through its public CLI
client. The voting backend remains a separate service. This project serves the
player site, discovers sequences assigned to the `whattheshell` functionality,
and starts one in-memory bot when someone connects to a game.

## Development setup

Requires Node.js 18 or newer and the dependencies declared in `CLI/package.json`.
The `CLI/` directory is the public CLI client used to call the voting backend.
This project does not import backend modules. The active explore-and-connect
flow does not connect to MongoDB; the optional provisioning/admin modules
described below are separate.

When developing from the main repository, link the CLI directory if needed and
install its dependencies:

```powershell
npm run link:cli
npm --prefix CLI install
```

For local development, create `votingAppDemo/.env` and fill in the game bot's
credentials. Do not commit this file. It loads automatically.
For deployments, inject the values or set `MULTIBOT_ENV_FILE` to a file
outside this directory. Then start the site:

```powershell
cd votingAppDemo
npm start
```

The site listens on `http://127.0.0.1:3100` by default. The explore-and-connect
flow uses these environment values:

```env
CLI_SERVER_URL=http://localhost:3000
WTS_FUNCTIONALITY_ID=whattheshell
WTS_BOT_API_KEY_ID=pk_...
WTS_BOT_SECRET=...
```

`GAME_HOST`, `GAME_PORT` and `GAME_PUBLIC_URL` control the local listener and
shareable URL. `WTS_FUNCTIONALITY_ID` defaults to `whattheshell`.

The bot API key must be active, use `sequence_bot` mode, and be the key
registered for the functionality. No owner login or `surrogate_controller`
credentials are needed to discover and play already prepared sequences.

## Explore and play

Open the site root to list sequences visible to the configured game bot. The
backend only returns sequences assigned to that API key; the site exposes a
small public projection and never sends the key or token to the browser.
Selecting a sequence asks the site process to start its bot. The bot waits for
a slot holder to claim a slot and press **Start game**.

Before it can be played, a sequence must have the `whattheshell` functionality,
be assigned to the corresponding sequence bot, and have its five game slots
configured. The bot stores an opaque What the Shell checkpoint in the sequence
through the backend's `seqState` API. When run directly again, it can restore
the board, random generator and any in-flight machine move. A sequence with
ballots but no compatible checkpoint is rejected because its game state cannot
be reconstructed safely. The web explorer currently rejects sequences that
already have ballots, including ones with a checkpoint; web-based recovery is
therefore not yet available.

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

Each connected sequence gets at most one bot in a running process. The bot
persists an opaque checkpoint through the backend's `seqState` commands and
can restore it when run again. However, the current explorer manager rejects a
sequence that already has ballots, so it does not yet restart a played game
after a site-process restart. Bots honor upstream `Retry-After` responses; the
site does not implement a shared request scheduler. The sequence explorer
currently uses the backend's existing list limit of 20.

## Project structure and modes

- `server.js` serves the player pages and exposes sequence discovery and bot
  connection endpoints for the explore-and-connect mode.
- `lib/game-manager.js` lists sequences assigned to the configured bot key and
  starts at most one bot per sequence in this process.
- `game/whattheshell-engine.js`, `whattheshell-strategy.js` and
  `whattheshell-bot.js` contain the game rules, machine strategy and bot loop.
  `whattheshell-launcher.js` is a separate manual tool that creates a demo
  sequence and runs a bot for it.
- `public/` contains the explorer, player page, shared browser engine, styles
  and translations. The browser sends public `slotseqs` commands to
  `/cli/execute`; in standalone mode this server proxies only the allowed
  public slot commands to the voting backend.
- `CLI/` is the public CLI client used by the server-side bot and launcher.
- `runner.js` is an alternative operator tool for running bots against a fixed
  JSON list of sequence IDs; it is not used by the web explorer.
- `lib/admin.js`, `lib/service.js`, `lib/games.js`, `public/admin.*` and
  `scripts/prepare-db.js` belong to an optional password-protected game
  provisioning flow. The current explore-and-connect flow does not initialize
  that service or require its local `games` collection.
- `tests/` covers the game engine, strategy, bot, game manager and optional
  provisioning service.

For a future split, the active site needs the public CLI client, the game
modules, `lib/game-manager.js`, `server.js`, and the player assets in `public/`.
The runner, launcher and Mongo-backed admin provisioning flow are separate
entry points and can be included only when that use case is wanted.

Do not distribute the development CLI junction. Replace it with a copy of the
public CLI source and its package manifest/lockfile. Exclude `.env`, `state/`,
`contexts/`, `node_modules/`, logs, and credentials.

## Checks

```powershell
npm test
```
