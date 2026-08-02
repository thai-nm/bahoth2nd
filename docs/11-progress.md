# 11 — Progress

Living status document. Updated when a milestone moves, not on a schedule.

**Last updated: 2026-08-02** · **Current milestone: M2 (in progress)**

## Status at a glance

| Milestone                        | Status         | Notes                                                         |
| -------------------------------- | -------------- | ------------------------------------------------------------- |
| M0 — Skeleton and the spine      | ✅ Complete    | Merged — [PR #2](https://github.com/thai-nm/bahoth2nd/pull/2) |
| M1 — Seats, identity, redaction  | ✅ Complete    | All nine items; D1–D5 closed                                  |
| M2 — The house                   | 🟨 In progress | Tiles, renderer, and movement done; discovery to come         |
| M3 — Cards, traits, dice         | ⬜ Not started |                                                               |
| M4 — The haunt, and five of them | ⬜ Not started |                                                               |
| M5 — Polish                      | ⬜ Not started |                                                               |
| M6 — The remaining 45 haunts     | ⬜ Not started |                                                               |

---

## M2 — in progress

Planned as four PRs — content, movement, discovery, renderer — and running as
five, because the renderer turned out not to need the movement graph and went
early (deviation 8).

| Item                                                    | Status                                                             |
| ------------------------------------------------------- | ------------------------------------------------------------------ |
| Tiles, static links, and the starting layout as content | ✅ Done — [#13](https://github.com/thai-nm/bahoth2nd/pull/13)      |
| Rotation and grid primitives in `shared`                | ✅ Done — [#14](https://github.com/thai-nm/bahoth2nd/pull/14)      |
| Board renderer: tiles, doors, pan/zoom, floor tabs      | ✅ Done — [#15](https://github.com/thai-nm/bahoth2nd/pull/15)      |
| `movement.ts`: adjacency, rotation, links, no-backtrack | 🟨 In review — [#16](https://github.com/thai-nm/bahoth2nd/pull/16) |
| Discovery: tile draw, rotation prompt, placement        | ⬜ Not started                                                     |
| `PendingPrompt` lifecycle and timeout defaults          | ⬜ Not started                                                     |
| Event log panel driven by `GameEvent`s                  | ⬜ Not started                                                     |

The content item shipped 49 tiles (44 drawable plus the three starting rooms
and two landings), the `to_tile` / `to_floor` / `oneway_drop` link vocabulary,
and a `house` block that puts the starting arrangement in content rather than
in `setup.ts`. All of it placeholder — invented names, invented door layouts —
because real room text is not ours to commit
([01-overview](01-overview.md#intellectual-property-position)). The shapes are
what the engine needs: floor restrictions, a symbol mix, and at least one tile
of every link kind.

Two decisions worth recording:

- **Effects are carried opaquely rather than validated.** `EffectSchema` is
  `z.unknown()` until M3 builds the interpreter. Validating against a union
  that is still being designed would wave through exactly the typos the
  schema exists to catch.
- **The content directory is all-or-nothing.** With two parts on disk
  (`characters.json`, `tiles.json`), a directory holding one of them used to
  fall back to placeholders for the rest. It now refuses to start: seating
  real explorers in an invented house, silently, is the worse failure.

25 content tests, of which 14 assert that a coherence check rejects the
mistake it claims to catch. A validator nobody has watched fail is not a
validator — D1 was a range check the wrong value happened to satisfy.

One more, on the server: the client rebuilds the bundle from
`GET /api/content` and compares hashes before it may join, so a part the
endpoint forgets to serve is not a missing feature, it is every client locked
out of every room. The test fetches the real endpoint and rebuilds it; it was
watched failing with `tiles` removed from the payload.

### The renderer, brought forward

The roadmap put the renderer last in M2, behind the movement graph. It does not
need it: a board is a pure function of `BoardState` and `Content`, both of which
already existed, so it went early and the visual decisions got settled against
real pixels instead of prose. `reachable` arrives as a **prop**, so wiring
`getReachable` in later is a caller change rather than a rewrite.

The rotation math went into `shared` rather than the client, because
`movement.ts` needs the same transform. A tile stores its doors unrotated and
the placement stores the rotation, so every consumer applies it — and there are
exactly two. If each owned a copy, the first divergence would be a highlight
disagreeing with the server about where a door is, which looks like a movement
bug and is not one.

Three decisions worth recording, all visible in `styles.css`:

- **Tile colour comes from the floor**, not from a per-tile `art.bg`: basement
  cold, ground warm, upper bleached. Forty-four hand-picked colours would read
  as a jellybean jar for less legibility than three tints plus the symbol
  badge. `art.bg` still overrides when content supplies one, so the
  swap-in-real-art path survives.
- **The board is parchment inside dark chrome**, which forced a second accent.
  `--accent` measures **2.65:1** against the ground tint and fails; anything
  sitting on a tile uses `--accent-on-parchment` instead.
- **`TILE = 150`**, not the 120 in [07-ui](07-ui.md#73-board-rendering). At 120
  a room name lands near 8px once the badge and door notches take their bites.

**Two bugs the green build did not catch**, both found by opening the thing in
a browser: the fit-on-mount effect read `clientWidth` before layout settled and
measured 122px instead of ~1060, and pawns rendered over the room label.
Neither is reachable from a unit test.

**One test that was passing for the wrong reason.** The preview asserted that
every door meets its neighbour — and a first draft satisfied it by placing a
room with _no_ neighbours, floating two cells off the house, with a comment
calling that safe. The assertion only inspects occupied neighbours, so a
disconnected tile passes it trivially. There is now a connectivity walk from
each floor's landing beside it, watched failing by re-floating the tile. Same
family as D1: **a check the wrong value satisfies is not a check.**

### The movement graph

Then the graph over the house it renders: `getConnections` (grid adjacency after
rotation, plus static links), `getReachable` / `findPath` (BFS over
`(position, cameFrom)` rather than position alone, so the no-backtrack rule —
docs/02-rules-model.md#24 — can depend on how a room was entered), board setup
at `START_GAME`, and the movement budget refreshed at every point the active
seat changes (`startGame`, `endTurn`, a removal vote resolving, a concede).

One decision worth recording, with a known limitation:

- **`MOVE { to }` walks a whole shortest legal path, not one room.**
  `docs/07-ui.md` has the client highlight `getReachable()` and issue `MOVE`
  on a click of any highlighted room, so the engine finds the path itself
  (BFS, deterministic neighbour order) and emits one `moved` event per room
  entered. **Limitation:** when two shortest paths tie, the BFS's neighbour
  order picks one arbitrarily. That is invisible today because no room does
  anything on entry — but once M3 gives rooms `onEnter` effects, _which_ path
  was walked becomes player-visible (different rooms may trigger different
  card draws), and `MOVE` will need an explicit `via` path from the client
  rather than letting the engine choose.

31 movement tests, watched failing individually against the line each depends
on (rotation applied to doors, the no-backtrack check, `oneway_drop`'s reverse
direction, and the `beginTurnFor` call at every handover) before they passed.
The last of them is a property rather than a case: for every board these tests
build, every starting room, every `cameFrom`, and every budget up to 6, each
path `findPath` returns for a room `getReachable` promised must be a real
sequence of connections, must not begin by backtracking, and must fit the
budget. D7 was one instance of that property failing, and one instance is not
what you want to be asserting.

---

## M1 — complete

All nine scope items shipped, the four defects M0 left behind (D1–D4) are
closed, and so is D5, which D4 introduced and review caught. Each landed as one
PR: a small diff with its own tests, and the failure it fixes stated in its own
commit.

Three of them were worth more than their size:

- **D3** turned up a second bug it did not go looking for. Adding a periodic
  tick meant inert actions could no longer be allowed to bump the version, or
  every room's log would grow forever and idle rooms would never be evicted.
- The property test's random walk **could not reach any of this code**, because
  disconnects and ticks are server-originated and never appear in
  `getLegalActions`. It now injects them on a deterministic fake clock, and a
  companion test asserts the walk really does produce disconnected seats, armed
  clocks, votes, and removals — coverage that claims itself is not coverage.
- **D4 deadlocked a room** in a case review caught and neither the unit tests
  nor the widened property walk did. See D5 below.

88 tests, five files.

---

## M0 — complete

Stood up the whole pipeline end to end before any real rules existed, so the
parts that are painful to retrofit were settled first.

### What shipped

- npm workspaces monorepo, five packages, TypeScript strict plus
  `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.
- ESLint enforces the dependency boundaries from
  [03-architecture](03-architecture.md#dependency-rules), and bans
  `Math.random`, `Date.now`, and `node:*` imports inside `packages/engine`.
- Pure reducer returning `{state, events, error}`, with the PRNG held in
  `GameState`. Lobby and bare turn loop only; later actions are declared in the
  protocol and rejected with `UNKNOWN_ACTION`.
- Authoritative server: per-room serial reduction, JSONL action log, redacted
  snapshot broadcast, seat tokens, replay-on-boot recovery, `/healthz`, static
  client hosting on the same port.
- Vite + React client: home, lobby, and a debug game screen. Sends intents,
  renders snapshots, never applies a reducer.
- Dockerfile, CI on Node 22 running typecheck → lint → format → test → build.

### How it was verified

| Claim                      | Evidence                                                                                  |
| -------------------------- | ----------------------------------------------------------------------------------------- |
| Determinism                | `rng.test.ts`; replay property test over 25 seeds                                         |
| Invariants hold            | Property test, 500 random legal actions × 25 seeds                                        |
| Illegal actions are inert  | Property test asserts byte-identical state, no events, no version bump                    |
| No hidden-information leak | `redact.test.ts` — no draw-pile card id or seed in any snapshot                           |
| Reconnect works            | `gateway.test.ts` over real sockets; plus a real browser page reload                      |
| Crash recovery works       | `gateway.test.ts` restarts a server against the same `DATA_DIR`                           |
| It is actually playable    | Driven manually in a browser: create → join → pick → start → full round → reload → rejoin |

49 tests, five files.

### Bugs found during M0, fixed in M0

Recorded because each one was invisible to the tests that existed at the time.

1. **Recovery diverged from its own log.** Rebuilding a room applied
   `DISCONNECT` actions without logging them, so state and log disagreed and a
   _second_ recovery produced a different result. Fixed by routing them through
   `apply()`.
2. **Reconnect after reload was impossible.** The seat token was persisted only
   when the room code was already known, but `welcome` carries the token and
   arrives _before_ `room` carries the code. Caught only by actually reloading
   a page — every socket-level test passed.
3. **Stale lobby seat rows.** The seat list read `charId` from the `room`
   message, which is re-sent only on join/leave. Now reads `state.players`.

---

## M1 — item status

| Item                                                                                   | Status                        |
| -------------------------------------------------------------------------------------- | ----------------------------- |
| Seat tokens in `localStorage`, `hello` with resume                                     | ✅ Done                       |
| Per-seat connection state                                                              | ✅ Done                       |
| `redactFor` plus the redaction test                                                    | ✅ Done (landed early, in M0) |
| Content pipeline: schemas, loader, fixtures, hash, join-time check, `GET /api/content` | ✅ Done                       |
| Character select in the lobby                                                          | ✅ Done                       |
| Trait tracks in state as indices                                                       | ✅ Done                       |
| Host transfer when the host drops                                                      | ✅ Done                       |
| Turn timers and the `TICK` action                                                      | ✅ Done                       |
| Disconnect handling and the remove-player vote                                         | ✅ Done                       |

---

## Known defects

Open defects in code that has shipped to a branch. Each one has a milestone by
which it must be fixed, and a note on why it is not visible yet.

### D6 — The board's fit/resize wiring has no test _(open, fix by M5)_

`Board.tsx` decides its pan/zoom through two React effects and a
`ResizeObserver`. Both bugs found in that code — the premature `clientWidth`
read, and pawns over the label — were found by opening a browser, because
nothing there is reachable from `layout.test.ts`: vitest runs the `node`
environment, and the project deliberately adds no test dependency to reach a
real DOM.

The pure half is covered. `layout.ts` — bounds, fit, clamp, doorways — is
tested; what is untested is the component wiring that calls it.

**Not visible yet** because the preview is the only caller, and a wrong fit
there is cosmetic. It stops being cosmetic when the real game screen mounts the
board inside the M2 layout. **Fix by M5**, when the client gets a DOM test
environment; that decision is deferred rather than made badly now.

---

## Fixed defects

Kept rather than deleted: each one is a note on a failure mode worth
recognising again.

### D7 — The no-backtrack path collapsed to one step when the BFS looped through the start room _(found in review, fixed 2026-08-02)_

`walk`'s predecessor map was keyed by room id alone: `pred.set(nb, entry.pos)`.
The BFS correctly explores `(position, cameFrom)` states, not positions, so
that the no-backtrack rule (docs/02-rules-model.md#24, the [RULING]) can
depend on how a room was entered — but the map it recorded results into threw
that distinction away. When the search looped back through the start room
partway through exploring, it re-entered start from a `cameFrom` other than
the player's real one, and from there rediscovered the room the player was
actually forbidden to step back into. That state-shaped fact then got written
into a position-keyed map as `pred[forbidden room] = start`, and
`findPath` reconstructed a 1-step path straight back into `cameFrom` — the
no-backtrack rule silently defeated, and `move()` (`reduce.ts`) charging one
movement point for a path that was really the long way round.
`getReachable` was unaffected: that room genuinely is reachable, and stayed in
its result; only the reconstructed path, and so the cost, was wrong.

**Why the tests missed it.** The existing loop test ("cannot move straight
back into cameFrom, but can reach it around a loop of length >= 2") uses a
2-step loop and a budget of exactly 3 — enough to get around once, not enough
for the BFS to loop back through the start room a second time and manufacture
a bad predecessor. The defect needs the BFS to revisit start itself mid-search,
which that budget never gives it the room to do.

**Fixed by** keying the predecessor map by BFS state
(`pos|cameFrom`, `predState`) rather than position, and keeping a separate
`firstState` map from position to the minimal-depth state that discovered
it — that map's keys are exactly what `getReachable` returns, so the two
still share one traversal and cannot disagree. `findPath` reconstructs by
walking `predState` back to the root _state_, not just back to a position
match, since a mid-path visit to the start room is a different state from the
root and must stay in the path. A new test stands a seat in the start room
having just arrived from a dead-end, with enough budget to loop all the way
around back to that dead-end, and asserts both the full-length path and that
`MOVE` spends the full cost. The property test above it asserts the general
statement instead of that one shape, and both were watched failing against the
old reconstruction.

### D5 — Two removals on one tick deadlocked the room _(found in review, fixed 2026-08-01)_

`resolveRemovals` chose the next active seat with
`nextSeatInOrder(state, target)` — the state as it was **before** the tick.
When one tick carried two removals and the active seat was the second of them,
the successor was the seat the same tick had just removed. That breaks
invariant 6c, and `reduce` rejects an action whose result violates an
invariant, so the whole `TICK` was thrown away — including both removals.

The room then stopped for good. Every subsequent tick rebuilt the same state,
failed the same check, and was discarded: the turn clock never advanced again
and neither absent seat was ever removed.

**Why the tests missed it.** Each removal test removes exactly one seat, and
the property walk ticks often enough that two grace periods rarely expire
between ticks. Nothing was wrong with either; the case simply sits between them.

**Fixed by** choosing the successor against the tick's own accumulated state
rather than the state it started from, before the current target leaves
`turnOrder`. A test now removes the active seat and its immediate successor on
one tick.

### D4 — No remove-player vote _(fixed 2026-08-01)_

A seat that never returned could not be removed from `turnOrder`, and in the
lobby it was worse than a nuisance: every seat needs an explorer before the
game can start, so one player closing their laptop stranded the room.

**Fixed by** `VOTE_REMOVE`, `GameState.removeVotes`, and
`PlayerState.removed`. Voting is deliberately **clock-free** so legality stays
pure — the table may vote the moment somebody drops — and the grace period is
enforced when the vote _resolves_, inside `TICK`. A removed explorer is not
dead: the body stays on the board holding its items, it simply stops taking
turns. Coming back cancels every vote outright rather than banking them.

### D3 — Turn timers were declared but never read _(fixed 2026-08-01)_

`config.turnTimeoutMs` and `config.disconnectTimeoutMs` existed and were
documented in the README, but nothing read them. The engine handled `TICK`; the
server never sent one. A disconnected player on their turn stalled the room
permanently.

The failure mode worth naming out loud: **a config value that is declared,
documented, and never read looks implemented from every angle except the one
that matters.**

**Fixed by** putting the budgets in `GameState.timers` (fixed at room creation,
recorded in the log header, so a room cannot diverge from its own log when
config changes), adding `turnDeadline`, and having the server sweep rooms on an
interval and issue `TICK` only where a deadline is actually due.

The clock is armed by the first `TICK` of a turn rather than when the turn
starts, because the engine may not read a clock — a `TICK` is the only way time
enters it. Dropping or reconnecting mid-turn disarms it, so the next tick
re-arms against the budget that now applies.

**A second bug fell out of this one.** `reduce` bumped the version on every
accepted action, including inert ones, and the server logs, broadcasts, and
refreshes room liveness on any accepted action. A once-per-second tick would
therefore have grown every room's log without bound and kept idle rooms alive
forever. Inert actions now return the state by reference and are not logged —
which also removes the no-op `RECONNECT` that every join was writing.

### D2 — Host transfer ignored connection state _(fixed 2026-08-01)_

`getHostSeat` returned the lowest seat id by sort order regardless of whether
that seat was connected, so a host who dropped took the lobby with them —
nobody else could start the game, and there was no way to recover short of
making a new room.

**Fixed by** deriving the host as the earliest-joined seat that is currently
_connected_, falling back to the earliest seat when nobody is (which is exactly
the state crash recovery produces). Nothing is stored: the host is still
derived, so it needs no reconciliation. See deviation 6 for why this is not
literally "longest-connected".

### D1 — Explorers started at the skull _(fixed 2026-08-01)_

`startGame` copied players forward with `{ ...p }` and never read
`character.start`, so after `START_GAME` every trait index was `0`.

```
traits: { speed: 0, might: 0, sanity: 0, knowledge: 0 }
```

Index 0 is the skull — the death slot. Every explorer was nominally dead from
the moment the game began.

**Why it was invisible:** death detection does not exist until M3, and
invariant 5 only checked that indices are integers in `[0, 7]`, which `0`
satisfies. **A range check that the wrong value happens to satisfy is not a
check.**

**Fixed by** seeding `traits` from `character.start` in `CHOOSE_CHAR` rather
than `START_GAME` — the indices are then never out of step with the chosen
explorer, and clearing the choice returns them to zero. Invariant 5 now also
rejects any state where a living player with a `charId` has a trait on index 0,
which would have caught the original bug at the first reduction.

---

## Deviations from the plan

Deliberate departures from the design docs, recorded so they are decisions
rather than drift.

| #   | Deviation                                                                             | Why                                                                                                                                                                                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Redaction test written in M0, not M1                                                  | The deck plumbing already existed; shipping a snapshot path without the leak test was not worth the ordering purity.                                                                                                                                                                                 |
| 2   | `START_GAME` goes straight to `explore`, skipping `setup`                             | Characters are chosen in the lobby, so `setup` had nothing to do. The phase remains declared for later use.                                                                                                                                                                                          |
| 3   | Invariant 1 keys off board emptiness, not a phase list                                | "Every living player is on the board once the board exists" stays correct after M2 places tiles; a phase list would have needed editing.                                                                                                                                                             |
| 4   | Property tests use our own seeded RNG, not fast-check                                 | Same properties, no extra dependency, failures reproducible from a printed seed. Revisit if shrinking becomes worth it.                                                                                                                                                                              |
| 5   | Vite 8 / vitest 4 / zod 4 / React 19 instead of the versions implied at planning time | Starting fresh, the older majors carried a known dev-server advisory. Current majors audit clean.                                                                                                                                                                                                    |
| 6   | The host is the earliest-**joined** connected seat, not the longest-**connected** one | "Longest-connected" needs a clock, and the engine may not read one. Join order is already encoded in the seat id, so this is deterministic and free. It also behaves better: the role returns to the original host when they reconnect instead of drifting to whoever has been online longest since. |
| 7   | A removal vote may be cast immediately; only its EFFECT waits for the grace period    | Gating the vote itself would need a clock inside `getLegalActions`, which must stay pure. Voting early and resolving late is the same rule from the player's side, and keeps legality clock-free.                                                                                                    |
| 8   | The renderer shipped **before** `movement.ts`, not after it as M2 planned             | A board is a pure function of `BoardState` and `Content`; it never needed the movement graph. Going early settled tile size, floor tints, and rotation against real pixels a milestone-slice sooner, and `reachable` arriving as a prop keeps the later wiring to a caller change.                   |
| 9   | Tile colour derives from the **floor**, not from the per-tile `art.bg` in 07-ui       | Three tints read better than 44 hand-picked colours and cost no authoring. `art.bg` still wins where content supplies it, so nothing is closed off — and no fixture sets it today, so the documented path was decorative as written.                                                                 |
| 10  | A second accent token, `--accent-on-parchment`                                        | `--accent: #c8703c` measures 2.65:1 on the ground tint and fails 07-ui's own 4.5:1 rule. Chrome keeps `--accent`; anything on a tile uses `#9c4a16`. 07.6 predicted this surface would be the one that failed.                                                                                       |
| 11  | `TILE = 150`, not the 120 stated in 07-ui                                             | At 120 a room name lands near 8px once the symbol badge and door notches take their bites. Everything scales from the constant, so it stays cheap to revisit.                                                                                                                                        |
| 12  | The room name renders **outside** the rotated frame, rather than counter-rotating     | Same result — upright text over a rotated tile — with one transform instead of two.                                                                                                                                                                                                                  |
| 13  | `Colour` lives in `shared/ids.ts`, not derived from content's `ColourSchema`          | Domain enums already live there beside `Floor`/`Dir`/`Trait`. A client-local copy made the client the only package with an opinion about which colours exist; a content test now asserts the two never drift.                                                                                        |

---

## Constraints discovered during implementation

Not bugs — real properties of the design that were not obvious when planning.

- **Seat tokens are keyed by room code in `localStorage`**, so two tabs in one
  browser cannot hold two seats in the same room; the second tab resumes the
  first one's seat. Correct for real use, but it means multi-player testing
  needs separate browsers or profiles.
- **Recovery cannot restore seat tokens.** They are secrets never written to
  disk, so after a restart every player must re-claim a seat by rejoining.
- **`exactOptionalPropertyTypes` and zod disagree about optionals.** zod's
  inferred optionals include `| undefined`, which is a distinct type from an
  absent key. Optional action fields must be typed `?: T | undefined`, and
  `redactFor` omits `rng` by destructuring rather than assigning `undefined`.
- **A transitioned transform cannot be verified with `getComputedStyle`.**
  `.world` carries a 150 ms transform transition, and during it
  `getComputedStyle` returns the value being animated _from_ — so every floor
  appears to be showing its predecessor's fit. This cost a whole review round
  chasing an "order-dependent" bug that did not exist. Assert against the
  inline style the component actually writes, or wait past the transition.
  The same trap applies to any future visual check on animated state.

---

## Next actions

In order:

1. **Wire the board into the game screen.** `getReachable` now exists, so the
   `reachable` prop the renderer already takes has something to be passed —
   replace the debug JSON panel in `Game.tsx`, and retire the `#board-preview`
   route or keep it behind the dev flag for rendering work that needs no
   server. This is the first time the highlight and the engine's legality
   answer meet, which is the point of having shared them. Note that
   `BoardPreview` mints its own `PlacedId`s as bare tile ids, which invariant
   3b now rejects — its pawns and its hardcoded reachable list key off them
   too, so switching it to `placedIdFor` is that PR's job, not a one-line
   change. Nothing is broken today: no preview board reaches the engine.
2. **Discovery**: tile draw, the rotation prompt, and placement — the next
   engine PR on top of `movement.ts`.
3. **`PendingPrompt` lifecycle and timeout defaults.**
4. **Confirm the turn-timer defaults with a real playtest** (roadmap open
   question 2). Ten minutes and ninety seconds are still guesses; they are now
   at least guesses that something reads.
5. **Answer roadmap open question 3** — whether any redistributable room set
   exists — before hand-entering 44 tiles and ~65 cards from a physical copy.
   Ten minutes of looking against hours of transcription.

## Metrics

Rough, for trend only.

|                     | M0                    | M1                    | M2 (so far)           |
| ------------------- | --------------------- | --------------------- | --------------------- |
| Tests               | 49                    | 88                    | 169                   |
| Packages            | 5                     | 5                     | 5                     |
| Haunts implemented  | 0 / 50                | 0 / 50                | 0 / 50                |
| Room tiles authored | 0 / 44                | 0 / 44                | 44 / 44 (placeholder) |
| Cards authored      | 0 / ~65               | 0 / ~65               | 0 / ~65               |
| Characters authored | 12 / 12 (placeholder) | 12 / 12 (placeholder) | 12 / 12 (placeholder) |
