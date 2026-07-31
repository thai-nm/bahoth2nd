# 11 — Progress

Living status document. Updated when a milestone moves, not on a schedule.

**Last updated: 2026-08-01** · **Current milestone: M2 (next)**

## Status at a glance

| Milestone                        | Status         | Notes                                                         |
| -------------------------------- | -------------- | ------------------------------------------------------------- |
| M0 — Skeleton and the spine      | ✅ Complete    | Merged — [PR #2](https://github.com/thai-nm/bahoth2nd/pull/2) |
| M1 — Seats, identity, redaction  | ✅ Complete    | All nine items; D1–D5 closed                                  |
| M2 — The house                   | ⬜ Not started | The next substantial piece of work                            |
| M3 — Cards, traits, dice         | ⬜ Not started |                                                               |
| M4 — The haunt, and five of them | ⬜ Not started |                                                               |
| M5 — Polish                      | ⬜ Not started |                                                               |
| M6 — The remaining 45 haunts     | ⬜ Not started |                                                               |

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

_None open._

---

## Fixed defects

Kept rather than deleted: each one is a note on a failure mode worth
recognising again.

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

---

## Next actions

In order:

1. **Start M2** — the house. 44 tiles as content, the movement graph, discovery
   with the rotation prompt, and the board renderer. This is the milestone that
   makes the thing feel like the game, and the largest single content-authoring
   push so far. Split it the way M1 was split: content and schemas, then the
   movement graph, then discovery and the prompt lifecycle, then the renderer —
   a PR each, rather than one that touches everything.
2. **Confirm the turn-timer defaults with a real playtest** (roadmap open
   question 2). Ten minutes and ninety seconds are still guesses; they are now
   at least guesses that something reads.

## Metrics

Rough, for trend only.

|                     | M0                    | M1                    |
| ------------------- | --------------------- | --------------------- |
| Tests               | 49                    | 88                    |
| Packages            | 5                     | 5                     |
| Haunts implemented  | 0 / 50                | 0 / 50                |
| Room tiles authored | 0 / 44                | 0 / 44                |
| Cards authored      | 0 / ~65               | 0 / ~65               |
| Characters authored | 12 / 12 (placeholder) | 12 / 12 (placeholder) |
