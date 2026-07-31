# bahoth2nd

Web game: Betrayal at House on the Hill, 2nd edition. Online multiplayer,
3–6 players, TypeScript end to end.

**Status: M0 complete.** The spine works — rooms, seats, authoritative
snapshots, reconnection, and crash recovery — with a placeholder game on top of
it. There is no board yet; that is M2.

## Quick start

```bash
npm install
```

```bash
npm run dev
```

Then open http://localhost:5173. Create a game, share the 5-character room
code, and have other players join. Three players minimum.

To run the production shape (one process serving the client and the socket on
one port):

```bash
npm run build && npm start
```

## Layout

| Package            | Contains                                                   |
| ------------------ | ---------------------------------------------------------- |
| `packages/shared`  | Types and the zod-validated wire protocol. No logic.       |
| `packages/content` | Content schemas, loader, placeholder fixtures.             |
| `packages/engine`  | The game, as pure functions. No I/O, no clock, no globals. |
| `packages/server`  | ws gateway, room manager, action log, static hosting.      |
| `packages/client`  | Vite + React app.                                          |

Design docs live in [docs/](docs/README.md) — start with
[the overview](docs/01-overview.md) and
[the architecture](docs/03-architecture.md).

## The four rules that keep this maintainable

1. **Traits are an index into the printed 8-slot track, never the displayed
   number.** Effects move an explorer _steps_ along a non-linear track.
2. **The engine is pure and its RNG lives in state.** A lint rule bans
   `Math.random`, `Date.now`, and `node:*` inside `packages/engine`. This is
   what makes the action log double as crash recovery and as a test fixture.
3. **The server sends redacted snapshots.** The client never applies a reducer
   to produce authoritative state, so desync is structurally impossible.
4. **Legality has one implementation.** `getLegalActions` drives both the UI's
   enabled controls and the server's rejection path.

## Scripts

| Command             | Does                                            |
| ------------------- | ----------------------------------------------- |
| `npm run dev`       | Server + Vite dev server with HMR               |
| `npm run build`     | Build every package and the client bundle       |
| `npm start`         | Run the built server (serves the client too)    |
| `npm test`          | Vitest across all packages                      |
| `npm run typecheck` | `tsc --build` over the project references       |
| `npm run lint`      | ESLint, including the dependency-boundary rules |

## Content and copyright

The engine is ours; the printed card, room, and haunt text is not. Real content
loads at runtime from `CONTENT_DIR` (default `./content/`, gitignored) and is
never baked into the Docker image. Committed placeholder fixtures in
`packages/content/fixtures/` use invented names and stats so a fresh clone runs
and CI passes without any of it. See
[docs/01-overview.md](docs/01-overview.md#intellectual-property-position).

## Configuration

| Variable                     | Default                | Meaning                                |
| ---------------------------- | ---------------------- | -------------------------------------- |
| `PORT`                       | `8080`                 | HTTP + WebSocket port                  |
| `CONTENT_DIR`                | `./content`            | Real content; falls back to fixtures   |
| `DATA_DIR`                   | `./data`               | Per-room JSONL action logs             |
| `CLIENT_DIR`                 | `packages/client/dist` | Static bundle to serve                 |
| `ROOM_TTL_HOURS`             | `4`                    | Idle room eviction                     |
| `TURN_TIMEOUT_SECONDS`       | `600`                  | Connected-player turn timer            |
| `DISCONNECT_TIMEOUT_SECONDS` | `90`                   | Disconnected-player turn timer         |
| `LOG_LEVEL`                  | `info`                 | `debug` \| `info` \| `warn` \| `error` |

## Known constraints

- Seat tokens are keyed by room code in `localStorage`, so two tabs in the same
  browser cannot hold two different seats in the same room — the second tab
  resumes the first one's seat. Use separate browsers or profiles to play
  multiple seats from one machine.
- Recovering a room after a restart cannot restore seat tokens (they are
  secrets that are never written to disk), so every player must re-claim a seat
  by rejoining.

## Roadmap

M0 done. Next is [M1](docs/09-roadmap.md#m1--seats-identity-redaction) and then
[M2](docs/09-roadmap.md#m2--the-house), which brings the actual house.
