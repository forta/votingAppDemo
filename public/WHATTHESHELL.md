# What the Shell: game and implementation notes

These rules were copied with the initial game extraction. Backend module names
below refer to the separate voting service, not modules imported by this
project. See `../README.md` for the independent server and multi-bot setup.

## Purpose

What the Shell is a cooperative five-in-a-row game played through the voting
sequence API. The team plays black using one shared ballot; a sequence bot plays
white. The browser is a public game client and never receives the bot's API key
or secret.

The site explorer lists sequences assigned to the configured game
functionality. Selecting a fresh sequence starts its bot and opens a URL that
contains the sequence ID. Each sequence represents a separate game:

`http://localhost:3100/?seq=<sequence-id>`

The generic player explorer and sequence view are served by the independent
Node service. WTS is rendered by the shared player based on the sequence
functionality.

## Rules and turn resolution

- The board is 9 by 9. Empty cells are ballot options.
- The team's black move is the winning ballot option, when there is one. The
  bot chooses a white move before the ballot opens, so it cannot react to the
  team's choice in the same turn. Both moves are applied simultaneously.
- If black and white choose the same empty cell, that cell becomes a numbered
  egg instead of a stone. Eggs hatch in their numbered order when captures
  create claims; paired opposing captures can cancel eggs.
- A stone captures two adjacent opposing stones or eggs when the next cell in
  that direction contains a friendly stone. Captures are evaluated from the
  same post-placement position for both colors.
- A player wins by owning the greater number of distinct stones that belong to
  horizontal, vertical, or diagonal lines of at least five. A tie in those
  counts continues as sudden death; a full board with no winner is a draw.
- A ballot with votes but no winning option gives black no move; the bot's
  white move is still applied. If the ballot tie policy is `random`, the backend
  may select randomly among the top tied options. The page reports the
  resulting decision.
- If a ballot closes with zero votes, the bot pauses the sequence without
  applying either move or advancing the game board. A slot holder can resume
  after that ballot has closed; the bot then opens a new ballot for the same
  board position.

## Components

- `game/whattheshell-engine.js` is the authoritative, pure rules engine.
  It applies simultaneous moves, captures, egg hatching, line scoring, and game
  outcomes without making network or database calls.
- `game/whattheshell-strategy.js` chooses the bot's white move using only
  the current board. It evaluates tactical replies and bounded continuations;
  its search is heuristic, not a proof of optimal play.
- `game/whattheshell-bot.js` authenticates as the sequence bot, opens and
  waits for ballots, reports votes and results, and updates sequence history.
  The bot keeps the live engine state in process memory. Recovery after the bot
  process itself exits is not implemented yet.
- `lib/game-manager.js` lists assigned sequences and starts one bot when a
  player connects to a fresh game.
- `game/whattheshell-simulation.js` exercises the slot protocol and game
  engine together.
- `lib/sequenceSlotManager.js` authorizes anonymous and registered slot
  operations and maps each slot to its surrogate voter. A slot lease lasts two
  minutes after its latest explicit action: claiming, starting/resuming, or
  voting. Merely leaving the page open does not renew it.
- `public/player/play.js` reads the sequence ID from the URL, displays the
  public board and ballot state, and submits slot actions.
  The public projection includes safe ballot-resolution details without
  exposing private individual votes.

## Turn lifecycle

1. The bot selects a white move from the current board and opens a ballot with
   every empty cell as an option.
2. Slot holders submit votes as their mapped surrogate users. The page displays
   their proposals when ballot visibility permits.
3. The backend closes and resolves the ballot according to its configured
   voting and tie policies.
4. With zero votes, the bot pauses and keeps the board unchanged. With at least
   one vote, the bot resolves the winning black move (if any) together with its
   preselected white move, then stores the resulting board in sequence history.
5. The page refreshes the public sequence projection and displays the board,
   outcome, ballot resolution, turn count, and current ballot countdown.

## Running and checking

Start the independent site with the functionality's sequence-bot API key, then
choose a sequence from the explorer. The sequence must have its game slots
configured before players can claim them.

Players claim a slot and press **Start game** when the group is ready. A
paused game can be resumed by a current slot holder after the previous ballot
closes. Restart recovery for a game that already has ballots is not available.

The launcher and bot poll every three seconds by default. HTTP 429 responses
pause the pending operation for `Retry-After` plus a small margin (60 seconds
when no usable delay is supplied), then retry while retaining the board in
memory. Network errors and other HTTP failures are not automatically replayed.
The CLI keeps HTTP status and retry metadata for this recovery.

Deploy the matching server changes and restart it to stop counting each
internal command forward against the global IP limit a second time. Keep
`RELAX_RATE_LIMITS` unset or false in production. External requests and the
specialized public-slot limits remain protected. A shared proxy/NAT or several
game pages can still exhaust a shared budget; multiplayer production acceptance
remains necessary. Restarting an exited bot still does not restore a played game.

Relevant checks:

```sh
node tests/whattheshell-engine.test.js
node tests/whattheshell-strategy.test.js
node tests/whattheshell-bot.test.js
npm test
```
