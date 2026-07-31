# 03 — Architecture

## 3.1 Stack, and why

| Layer           | Choice                                         | Why not the alternative                                                                                                                                                                            |
| --------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Language        | TypeScript, everywhere                         | One language across client, server, engine, and content schemas. Types for game state are shared by construction rather than by convention.                                                        |
| Client build    | Vite                                           | Fastest zero-config option; dev server, HMR, and a static build with one dependency.                                                                                                               |
| Client UI       | React 18                                       | The game is 80% panels, cards, modals, and lists. That is DOM work. A game framework (Phaser, Pixi) would make the map slightly nicer and every other screen worse.                                |
| Board rendering | Absolutely positioned DOM tiles + SVG overlays | 44 tiles across 3 floors is nothing. CSS transforms give pan/zoom and animation for free; tiles are inspectable in devtools; text is selectable and accessible. Canvas buys nothing at this scale. |
| Client state    | Zustand                                        | The authoritative state arrives from the server as a snapshot. We need a store, not a state management philosophy. Redux Toolkit is fine too; do not use both.                                     |
| Server          | Node 20 + `ws`                                 | Turn-based, low message rate, tiny payloads. Socket.io's reconnection and fallback machinery is not needed once we implement resume-by-token ourselves — and we must implement that anyway.        |
| Validation      | Zod                                            | One schema definition serves runtime validation of network messages _and_ of content JSON, and infers the TypeScript types.                                                                        |
| Tests           | Vitest                                         | Same config as Vite; the engine is pure functions, so most tests need no DOM.                                                                                                                      |
| Repo            | npm workspaces                                 | Ships with Node. No Turborepo/Nx/Lerna until build times actually hurt.                                                                                                                            |

Deliberately **not** using: an ORM, a database, GraphQL, a state-sync library
(Colyseus, Yjs), a CSS framework beyond CSS Modules, or a monorepo task runner.
Each can be added later when a concrete problem demands it.

## 3.2 Package layout

```
bahoth2nd/
├── package.json                 # npm workspaces root
├── tsconfig.base.json
├── docs/
├── content/                     # real content, gitignored, runtime-loaded
└── packages/
    ├── shared/                  # types + protocol + zod schemas. No logic.
    ├── engine/                  # pure game logic. No I/O, no imports of node:*
    ├── content/                 # content schemas, loader, placeholder fixtures
    ├── server/                  # ws server, room manager, engine host
    └── client/                  # vite + react app
```

### Dependency rules

```
shared   ← nothing
content  ← shared
engine   ← shared, content
server   ← shared, content, engine
client   ← shared, content, engine
```

Enforced by an ESLint `no-restricted-imports` rule. Two rules matter more than
the rest:

1. **`engine` must not import anything with side effects.** No `node:fs`, no
   `Date.now()`, no `Math.random()`, no `crypto`. If the engine needs
   randomness or time, it comes in through the state or the action.
2. **`client` may import `engine`, but only for read-only helpers** —
   `getLegalActions`, `getConnectedRooms`, formatting. The client never applies
   a reducer to produce authoritative state.

Reason for (2): the client needs to grey out illegal buttons and preview
movement range. Sharing the legality functions means the client and server can
never disagree about what is legal. Reason for the restriction inside (2): if
the client ever _applies_ actions locally, we inherit an entire class of
desync bugs for zero benefit in a turn-based game.

## 3.3 The core loop

```
┌──────────┐  Intent   ┌────────────────────────────┐
│  Client  │──────────▶│ Server                     │
│  (React) │           │  ├─ validate envelope (zod)│
│          │           │  ├─ authorise seat         │
│          │           │  ├─ engine.reduce(s, a)    │──▶ append to action log
│          │◀──────────│  ├─ redact per player      │
└──────────┘  Snapshot └────────────────────────────┘
              + Events
```

Every state change is one call to the engine reducer. The server owns the only
authoritative `GameState`. After each successful reduction it sends every
connected player a **redacted full snapshot** plus the list of **events** the
reduction produced.

**Why full snapshots instead of deltas or client-side prediction:** the state
is a few kilobytes, a game produces perhaps 500 state changes over 90 minutes,
and there is no latency requirement. Snapshots make desync structurally
impossible and make reconnection identical to a normal update. Events exist
only to drive animation and the text log — they are never the source of truth
for what the board looks like.

If snapshot size ever becomes a real problem, the fix is a JSON-patch diff
against the last acknowledged snapshot, which is a localised change to the
transport layer. Do not do this preemptively.

## 3.4 Server process model

One process. Rooms live in an in-memory `Map<RoomCode, Room>`.

```ts
interface Room {
  code: string;
  hostSeatId: SeatId;
  seats: Seat[]; // players, incl. disconnected ones
  state: GameState; // authoritative
  log: LoggedAction[]; // append-only, also flushed to disk
  createdAt: number;
  lastActivityAt: number;
}
```

- Rooms are evicted after 4 hours of inactivity.
- The action log is flushed to `data/rooms/<code>.jsonl`. On process start, any
  log younger than the eviction window is replayed through the engine to
  rebuild state. This gives crash recovery without a database, and it works
  _because_ the engine is deterministic.
- Horizontal scaling is out of scope. If it is ever needed, rooms are already
  independent, so a consistent-hash router in front of N processes is the
  answer — not shared state.

## 3.5 Build and deploy shape

- `npm run dev` runs the Vite dev server and the Node server concurrently, with
  the client proxying `/ws` to the server.
- `npm run build` produces `packages/client/dist` (static) and compiles the
  server with `tsc`.
- In production the **same Node process serves the static client bundle and
  the WebSocket endpoint on one port.** One container, one port, no CORS, no
  reverse-proxy configuration.
- Dockerfile is a two-stage build. Target host: any container platform (Fly,
  Railway, Render, a VPS). See [10-testing-and-ops.md](10-testing-and-ops.md).

## 3.6 Content loading

Content is JSON, validated by zod at load time, loaded once at process start
on the server and fetched over HTTP by the client.

- The **server** is authoritative for content too. It loads `content/` from
  disk and computes a content hash.
- The **client** fetches content from `GET /api/content` and receives the same
  hash. If a client's hash does not match the room's, it refuses to join with
  a clear error rather than desyncing.
- Placeholder content ships in `packages/content/fixtures/` and is used
  whenever `content/` is absent, so a fresh clone runs and tests pass.
