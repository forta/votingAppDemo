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

The explorer searches sequence names on the backend and loads one page at a
time. It defaults to 10 results and offers 25, 50, or 100 per page. Its `type`,
`search`, `page`, and `pageSize` query parameters preserve the current view in
the URL.

## Code layout

```text
VotingAppDemo/
├── server.js                 Standalone HTTP entry point
├── lib/
│   ├── config.js             Environment loading and game configuration
│   ├── voting-api.js         Authenticated command gateway client
│   ├── game-manager.js       Discovery, bot startup, and in-memory lifecycle
│   ├── player-router.js      Generic player HTTP routes and command allowlist
├── game/
│   ├── whattheshell-bot.js   Persistent-state WTS sequence bot
│   ├── whattheshell-engine.js Pure WTS rules and turn resolution
│   ├── whattheshell-strategy.js Machine-move selection
│   ├── whattheshell-request.js Retry handling for rate-limited requests
│   ├── whattheshell-launcher.js Operator launcher for a new WTS game
│   └── inkjs-bot.js          Ink story-to-ballot sequence bot
├── scripts/inkjs-story.js    Ink source/JSON loading and compilation
├── public/                   Explorer and generic player assets
├── runner.js                 Operator runner for a configured WTS bot list
├── CLI/                      Bundled/shared CLI support and local scenarios
└── tests/                    Unit and HTTP integration tests
```

`server.js` starts the separate service on the configured host and port. In the
main backend, `GAME_PLAYER_ENABLED=true` mounts the generic player routes under
`/games/play/` on the backend's existing port. Both the separate process and
the integrated player use the same explorer, player page, and game manager for
What the Shell and Ink.

The browser flow is split between `public/explore.html` plus `explore.js` and
`public/player/index.html` plus `player/play.js`. The latter obtains the public
sequence/slot projection and uses the game functionality to select a renderer.
Browser game-data and control requests use `POST /cli/execute`; static assets
such as translation JSON files are served normally. The player submits public
`slotseqs` operations, while the explorer and runner use service-local
`games list` and `games connect --seqId=...` commands. The router handles those
commands and the game manager communicates with the voting backend only through
its `/cli/execute` client. No separate `/api/games` routes are exposed, and bot
credentials stay on the server. A supplied sequence ID opens the player
directly; bot startup requires a configured integration key.

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
WTS_BOT_RECONCILE_INTERVAL_MS=30000

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
or remove it to disable the integrated player.

For standalone mode, copy `.env_isolated` to `VotingAppDemo/.env` and run
`npm start` from this directory. That process listens on port 3100 by default.

## Sequence setup

Create a sequence in the voting app and choose either the `whattheshell` or
`ink` functionality. The backend assigns the registered integration key and
provisions the required surrogate slots. For Ink, upload the declared `story`
file before starting the sequence. The player discovers the sequence
automatically; users claim a slot and start the game from the player page.

## Bot restart and persisted state

The `GameManager`'s token cache and running-task map are process-local, so they
are rebuilt after a restart. On startup it scans sequences assigned to each
configured integration key, attaches runners to active (`playing` or `paused`)
sequences, and repeats the scan every `WTS_BOT_RECONCILE_INTERVAL_MS` (30
seconds by default). A sequence with no ballots can start from its initial
state. A sequence that already has ballots resumes only when its `seqState`
contains a checkpoint with a supported application and version. The browser
can reconnect to either kind of active sequence.

WTS stores its board, random-generator state, pending machine move, ballot ID,
and history transition in `seqState`. Ink stores InkJS `StoryState` JSON, the
current rendered scene and choices, the story source SHA-256 fingerprint, and
the ballot/choice transition. Ink refuses to resume if its uploaded story
differs from the source used by the saved checkpoint. Both bots continue to
communicate only through `/cli/execute`; no game database or process-local
story state is required for a restart.

The backend limits `seqState` to `MAX_SEQ_STATE_BYTES` (16 KiB by default).
Large Ink stories may exceed that limit if their runtime state grows; the bot
will stop with the backend's size error rather than silently lose progress.
Recovery is at-least-once across crashes around remote command boundaries, so
the checkpoint records pending ballot IDs and transitions to avoid creating a
second ballot or applying a selected branch twice in normal restart cases.

Run a single `VotingAppDemo` process for each configured integration key. The
manager prevents duplicate runners within one process and reconciles after
restart, but the current API has no cross-process lease/CAS for runners; two
simultaneous service instances configured with the same key can both attempt to
manage one sequence. Add a backend-owned atomic runner lease before scaling to
multiple instances.

The player currently exposes only the slot-scoped vote projection provided by
the public slot API. A future product decision should determine whether votes
cast by eligible users outside mapped game slots should be shown, and how to
label them distinctly; this implementation does not change vote visibility.

### Restart smoke test

For an isolated bot, stop `whattheshell-bot.js` or `inkjs-bot.js` while a ballot
is open, then run the same command again with the same sequence and credentials.
For Ink, keep the uploaded story file unchanged. For the managed player, stop
and restart either the standalone `VotingAppDemo` process or the integrated
main backend with `GAME_PLAYER_ENABLED=true`; the startup scan should log the
sequence ID and reattach the adapter without creating a duplicate ballot. Check
both a live ballot and a paused sequence with no unambiguous winner, then
resume the latter from the voting app. The demo scripts should also be tested
with two service instances only after an atomic runner lease is available.

## Layout and checks

- `server.js` serves the explorer and player and exposes the command-only
  player gateway for game discovery, runner startup and allowed slot actions.
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
