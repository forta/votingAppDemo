# VotingAppDemo browser assets

The generic player uses `explore.html` and the `player/` directory. The
standalone service serves it at `/`; the main backend mounts the same player at
`/games/play/`. Game-specific rendering lives in `player/play.js` and is chosen
from the sequence functionality or an explicit view hint.

What the Shell rules and bot notes are in `WHATTHESHELL.md`.
