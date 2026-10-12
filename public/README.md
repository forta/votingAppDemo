# VotingAppDemo browser assets

The generic player uses `explore.html` and the `player/` directory. It is served
at `/` by the standalone service or at `/games/play/` by the integrated backend.
The older WTS-only page uses `index.html`, `whattheshell.js`, `engine.js`, and
the `whattheshell_*.json` translations. It remains available through the legacy
`/games/wts_multibot/` route and is subject to the v1.015 unused-player audit.

See [WHATTHESHELL.md](WHATTHESHELL.md) for the What the Shell rules, components,
turn lifecycle, and development notes.
