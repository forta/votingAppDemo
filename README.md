# VotingAppDemo: Generic Sequence Game Player

`VotingAppDemo/` is a Node.js game-player service and API example. It contains
a generic browser player plus server-side adapters for What the Shell and Ink.
It has no database connection. Reads and writes to the voting system go through
`POST /cli/execute` on the main backend. The service can run as a separate Node
process or be mounted inside the main backend process.

The browser can discover sequences assigned to configured integrations, open a
sequence by ID, and claim one of its anonymous game slots. The server keeps
API-key credentials, short-lived tokens, and running-bot handles in process
memory; credentials and tokens are never sent to the browser. Ink story files
are downloaded for the assigned sequence through `seqs file-download` and
compiled in memory.

## Code layout

```text
VotingAppDemo/
├── server.js                 Standalone HTTP entry point
├── lib/
│   ├── config.js             Environment loading and game configuration
│   ├── voting-api.js         Authenticated command gateway client
│   ├── game-manager.js       Discovery, bot startup, and in-memory lifecycle
│   ├── player-router.js      Generic player HTTP routes and command allowlist
│   └── backend-integration.js Legacy WTS-only router for /games/wts_multibot/
├── game/
│   ├── whattheshell-bot.js   Persistent-state WTS sequence bot
│   ├── whattheshell-engine.js Pure WTS rules and turn resolution
│   ├── whattheshell-strategy.js Machine-move selection
│   ├── whattheshell-request.js Retry handling for rate-limited requests
│   ├── whattheshell-launcher.js Operator launcher for a new WTS game
│   └── inkjs-bot.js          Ink story-to-ballot sequence bot
├── scripts/inkjs-story.js    Ink source/JSON loading and compilation
├── public/                   Explorer, generic player, legacy WTS view, assets
├── runner.js                 Operator runner for a configured WTS bot list
├── CLI/                      Bundled/shared CLI support and local scenarios
└── tests/                    Unit and HTTP integration tests
```

`server.js` starts the separate service on the configured host and port. In the
main backend, `GAME_PLAYER_ENABLED=true` mounts the generic player routes under
`/games/play/` on the backend's existing port. The older
`WTS_MULTIBOT_ENABLED=true` route at `/games/wts_multibot/` uses
`lib/backend-integration.js`, which is WTS-only. The separate process and the
generic integrated player both load WTS and Ink credentials from their server
environment and use `lib/game-manager.js`.

The browser flow is split between `public/explore.html` plus `explore.js` and
`public/player/index.html` plus `player/play.js`. The latter obtains the public
sequence/slot projection and uses the game functionality to select a renderer.
Anonymous player requests are restricted to the public `slotseqs` commands in
`lib/player-router.js`; bot credentials stay on the server. A supplied sequence
ID opens the player view directly, while bot startup still requires that the
sequence use a configured integration key. The generic player calls the bot
API independently through the server-side `GameManager`.

`lib/voting-api.js` is the only application API client: it exchanges configured
API-key credentials through the `auth token` command and submits all subsequent
commands to `/cli/execute`. `CLI/` contains the bundled CLI client and local
operator/test material. The WTS launcher uses its CLI helper to provision a
demo sequence; the web player and game bots use `lib/voting-api.js` at runtime.
No player or bot connects to MongoDB directly.

## Configuration

For local development, put these values in `VotingAppDemo/.env` or inject them
into the process environment. Deployments can set `WTS_ENV_FILE` to an
environment file outside the project. Do not commit real credentials.

```env
WTS_GAME_HOST=127.0.0.1
WTS_GAME_PORT=3100
WTS_GAME_PUBLIC_URL=http://localhost:3100
WTS_CLI_SERVER_URL=http://localhost:3000
WTS_LANGUAGE=es
WTS_BOT_POLL_INTERVAL_MS=5000
WTS_BOT_MAX_TURNS=500

WTS_BOT_API_KEY_ID=pk_...
WTS_BOT_SECRET=...
INK_BOT_API_KEY_ID=pk_...
INK_BOT_SECRET=...
```

Each configured key must be active, use `sequence_bot` mode, and be registered
for its functionality (`whattheshell` or `ink`) in the main backend. If a key is
omitted, that functionality is not included in discovery. No MongoDB URI, owner
account, or `surrogate_controller` credential is used by this service.

```powershell
cd VotingAppDemo
npm start
```

The service listens on `http://127.0.0.1:3100` by default. Open its root page to
explore games, or open `/?seq=<sequence-id>` for a particular game.

## Integrated mode in the main backend

To serve the player at `/games/play/` from the main backend's own process and
port, set this in the main backend's `.env` and restart it:

```env
GAME_PLAYER_ENABLED=true
```

Copy `.env_integrated` to `VotingAppDemo/.env` before starting the main backend.
The backend loads the player credentials from that file only when
`GAME_PLAYER_ENABLED=true`. The port remains the main backend's port; no second
player process or `GAME_PLAYER_SERVICE_URL` is involved. Set the flag to `false`
or remove it to disable the integrated player. `WTS_MULTIBOT_ENABLED` remains a
separate flag for the older WTS-only route at `/games/wts_multibot/`.

For standalone mode, copy `.env_isolated` to `VotingAppDemo/.env` and run
`npm start` from this directory. That process listens on port 3100 by default.

## Sequence setup

Create a sequence in the voting app and choose either the `whattheshell` or
`ink` functionality. The backend assigns the registered integration key and
provisions the required surrogate slots. For Ink, upload the declared `story`
file before starting the sequence. The player discovers the sequence
automatically; users claim a slot and start the game from the player page.

## Bot restart and persisted state

The HTTP service itself keeps no durable registry of active bots. The
`GameManager` stores tokens and running tasks in in-memory maps; both disappear
when its process exits. A restarted service can authenticate again and discover
sequences, but the current `connect()` path accepts only sequences with no
ballots. Therefore the web-managed bot cannot currently reattach to a game
after its first ballot has been created.

The What the Shell bot has a separate recovery mechanism. It writes its board,
random-generator state, pending machine move, and ballot checkpoint to the
sequence's `seqState` through `/cli/execute`. Re-running the WTS bot directly
for that sequence can rebuild its in-flight turn, provided the checkpoint is
present and supported. The generic player's current `GameManager` gate still
prevents reconnecting that existing game from the explorer or player page.

The Ink bot currently does not persist InkJS story state. Its `Story` instance
lives in process memory, and it rejects sequences that already have ballots.
After a process restart it cannot restore the previous scene from the voting
history alone. Restart and recovery behavior for isolated and
`VotingAppDemo`-managed bots is a planned v1.015 acceptance area; test WTS and
Ink separately because their persistence models differ.

## Layout and checks

- `server.js` serves the explorer and player, exposes the game connection API,
  and forwards only the anonymous slot commands allowed by the player.
- `lib/voting-api.js` is the only upstream HTTP client. It sends commands to
  `/cli/execute`, including the API-key token exchange.
- `lib/game-manager.js` discovers assigned sequences and dispatches to the
  matching game adapter.
- `game/` contains the What the Shell and Ink sequence runners.
- `public/` contains the generic player, explorer, styles, and translations.
- `runner.js` is an optional operator tool for running a fixed list of WTS
  sequences; it uses the same `/cli/execute` gateway as the web service. It is
  not the multi-game web service and does not load Ink adapters.

```powershell
npm test
```
