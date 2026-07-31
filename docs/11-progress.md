# 11 — Progress

Living status document. Updated when a milestone moves, not on a schedule.

**Last updated: 2026-08-01** · **Current milestone: M1 (partial)**

## Status at a glance

| Milestone                        | Status         | Notes                                                                            |
| -------------------------------- | -------------- | -------------------------------------------------------------------------------- |
| M0 — Skeleton and the spine      | ✅ Complete    | In review — [PR #2](https://github.com/thai-nm/bahoth2nd/pull/2), not yet merged |
| M1 — Seats, identity, redaction  | 🟡 ~60%        | Four of seven items done; see below                                              |
| M2 — The house                   | ⬜ Not started | The next substantial piece of work                                               |
| M3 — Cards, traits, dice         | ⬜ Not started |                                                                                  |
| M4 — The haunt, and five of them | ⬜ Not started |                                                                                  |
| M5 — Polish                      | ⬜ Not started |                                                                                  |
| M6 — The remaining 45 haunts     | ⬜ Not started |                                                                                  |

A caution for anyone reading a status table: M1's _exit criteria_ would mostly
pass right now, while several of its _scope items_ are untouched. Exit criteria
were written to be demonstrable, not exhaustive. Check the item list, not the
demo.

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

## M1 — partial

| Item                                                                                   | Status                                                  |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Seat tokens in `localStorage`, `hello` with resume                                     | ✅ Done                                                 |
| Per-seat connection state                                                              | ✅ Done                                                 |
| `redactFor` plus the redaction test                                                    | ✅ Done (landed early, in M0)                           |
| Content pipeline: schemas, loader, fixtures, hash, join-time check, `GET /api/content` | ✅ Done                                                 |
| Character select in the lobby                                                          | ✅ Done                                                 |
| Trait tracks in state as indices                                                       | 🟡 Storage correct, **initialisation missing** — see D1 |
| Host transfer when the host drops                                                      | ❌ Not done                                             |
| Turn timers and the `TICK` action                                                      | ❌ Not done                                             |
| Disconnect handling and the remove-player vote                                         | 🟡 Disconnect yes, vote no                              |

---

## Known defects

Open defects in code that has shipped to a branch. Each one has a milestone by
which it must be fixed, and a note on why it is not visible yet.

### D1 — Explorers start at the skull _(must fix before M3)_

`startGame` copies players forward with `{ ...p }` and never reads
`character.start`, so after `START_GAME` every trait index is `0`.

```
traits: { speed: 0, might: 0, sanity: 0, knowledge: 0 }
```

Index 0 is the skull — the death slot. Every explorer is nominally dead from
the moment the game begins.

**Why it is invisible:** death detection does not exist until M3, and invariant
5 only checks that indices are integers in `[0, 7]`, which `0` satisfies.

**Why it matters:** this is exactly the trait-as-index failure mode that
[02-rules-model](02-rules-model.md#22-explorers-and-traits) warns about, and
anything built on trait values before it is fixed will be built on zeros.

**Fix:** initialise `traits` from `content.charactersById[charId].start` in
`startGame`. Add an invariant that a player with a `charId` has every trait
index ≥ 1, which would have caught this at the first reduction.

### D2 — Host transfer does not consider connection state _(M1)_

`getHostSeat` returns the lowest seat id by sort order and ignores whether that
seat is connected. If the host drops, nobody can start the game.
[06-networking](06-networking.md#disconnection-behaviour) specifies transfer to
the longest-connected seat.

### D3 — Turn timers are declared but never read _(M1)_

`config.turnTimeoutMs` and `config.disconnectTimeoutMs` exist and are
documented in the README, but nothing reads them. The engine handles the `TICK`
action; the server never sends one. A disconnected player on their turn stalls
the game indefinitely.

This is the failure mode worth naming out loud: **a config value that is
declared, documented, and never read looks implemented from every angle except
the one that matters.**

### D4 — No remove-player vote _(M1)_

A seat that never returns cannot be removed from `turnOrder`.

---

## Deviations from the plan

Deliberate departures from the design docs, recorded so they are decisions
rather than drift.

| #   | Deviation                                                                             | Why                                                                                                                                      |
| --- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Redaction test written in M0, not M1                                                  | The deck plumbing already existed; shipping a snapshot path without the leak test was not worth the ordering purity.                     |
| 2   | `START_GAME` goes straight to `explore`, skipping `setup`                             | Characters are chosen in the lobby, so `setup` had nothing to do. The phase remains declared for later use.                              |
| 3   | Invariant 1 keys off board emptiness, not a phase list                                | "Every living player is on the board once the board exists" stays correct after M2 places tiles; a phase list would have needed editing. |
| 4   | Property tests use our own seeded RNG, not fast-check                                 | Same properties, no extra dependency, failures reproducible from a printed seed. Revisit if shrinking becomes worth it.                  |
| 5   | Vite 8 / vitest 4 / zod 4 / React 19 instead of the versions implied at planning time | Starting fresh, the older majors carried a known dev-server advisory. Current majors audit clean.                                        |

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

1. **Fix D1.** A few lines plus the guarding invariant. Do this before anything
   reads a trait value.
2. **Close M1**: D2, D3, D4 — host transfer, the server-side turn timer that
   issues `TICK`, and the remove-player vote.
3. **Start M2** — the house. 44 tiles as content, the movement graph, discovery
   with the rotation prompt, and the board renderer. This is the milestone that
   makes the thing feel like the game, and the largest single content-authoring
   push so far.

## Metrics

Rough, for trend only.

|                     | M0                    |
| ------------------- | --------------------- |
| Tests               | 49                    |
| Packages            | 5                     |
| Haunts implemented  | 0 / 50                |
| Room tiles authored | 0 / 44                |
| Cards authored      | 0 / ~65               |
| Characters authored | 12 / 12 (placeholder) |
