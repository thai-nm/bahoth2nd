# 10 — Testing & Ops

## 10.1 Test strategy

The value is concentrated in the engine, and the engine is pure functions with
in-state RNG. That makes the highest-value tests also the cheapest ones.
Weight the effort accordingly:

| Layer                        | Tool                     | Share of effort | What it catches                          |
| ---------------------------- | ------------------------ | --------------- | ---------------------------------------- |
| Engine unit + scripted games | Vitest                   | ~60%            | Every rules bug                          |
| Content validation           | Vitest + zod             | ~10%            | Malformed/incoherent content             |
| Server protocol              | Vitest + in-process ws   | ~15%            | Redaction leaks, reconnect, ordering     |
| Client component             | Vitest + Testing Library | ~10%            | Board maths, prompt wiring               |
| End-to-end                   | Playwright               | ~5%             | Smoke only: three browsers finish a turn |

### The scripted-game helper

Write this on day one; everything else leans on it.

```ts
const g = playGame({
  seed: 12345,
  players: ['Ana', 'Ben', 'Cal'],
  content: fixtures,
  actions: [
    { t: 'CHOOSE_CHAR', seat: 'seat_0', charId: 'char.a' },
    …
    { t: 'MOVE_THROUGH', seat: 'seat_0', dir: 'n' },
  ],
});

expect(g.state.board.placed).toHaveLength(4);
expect(g.events).toContainEvent({ t: 'discovered' });
expect(g.errors).toEqual([]);
```

A rules regression test is then two lines. When a player reports a bug, the
room's action log _is_ a test case — drop the JSONL into `fixtures/replays/`
and assert the corrected behaviour.

### Property tests worth having

Three, using fast-check, run over randomly generated action sequences:

1. **Invariants always hold.** Play 500 random legal actions from a random
   seed; assert every invariant in
   [04-data-model.md](04-data-model.md#45-invariants) after each step.
2. **Illegal actions never change state.** For any action not in
   `getLegalActions`, `reduce` returns an error and a structurally identical
   state.
3. **Replay is exact.** Reducing the action log from the initial state
   reproduces the final state byte-for-byte via `JSON.stringify`.

These three catch more than any number of hand-written cases, because the game
has far too many rule interactions to enumerate.

### The redaction test

Non-negotiable, written in M1:

> For every seat and every state reachable in a scripted game,
> `JSON.stringify(redactFor(state, seat))` contains no card id that is
> currently in any deck's draw pile, and no `rng` field.

### Content validation tests

Run against real content when present, always against fixtures:

- Every tile id referenced by the haunt table exists.
- Every omen × room pair in the haunt table maps to a haunt in 1–50.
- Every card id referenced by an effect exists.
- Every `spawn_monster.def` matches a monster definition in the same haunt.
- Every `scriptId` resolves to a registered script.
- Trait tracks are exactly 8 entries with `null` at index 0.
- Total card and tile counts match the expected component counts.

The last one is a deliberate tripwire for transcription errors while entering
content by hand.

## 10.2 Tooling and CI

- **TypeScript strict.** `strict: true`, `noUncheckedIndexedAccess: true`,
  `exactOptionalPropertyTypes: true`. Turning these on later is miserable.
- **ESLint** with the import-boundary rule from
  [03-architecture.md](03-architecture.md#dependency-rules) and a ban on
  `Math.random` / `Date.now` inside `packages/engine`. That single lint rule
  protects determinism better than any amount of discipline.
- **Prettier**, default config, no debate.
- **GitHub Actions** on push and PR: `typecheck → lint → test → build`. One
  job, Node 20, npm cache. Add Playwright as a separate job once it exists so
  a flaky browser test cannot block the engine suite.

## 10.3 Deployment

Two-stage Dockerfile: build all workspaces, then copy `packages/server/dist`,
`packages/client/dist`, and production `node_modules` into a slim runtime
image. One process, one port.

```
PORT=8080
CONTENT_DIR=/app/content        # real content, mounted, not baked into the image
DATA_DIR=/app/data              # room action logs
ROOM_TTL_HOURS=4
TURN_TIMEOUT_SECONDS=600        # baked into each room at creation
DISCONNECT_TIMEOUT_SECONDS=90   # ditto; a room never changes budget mid-game
PROMPT_TIMEOUT_SECONDS=60       # a prompt blocks the table, so it gets far less
TICK_INTERVAL_MS=1000           # how often rooms are checked for a due deadline
REMOVE_GRACE_SECONDS=600        # absence before a majority can vote a seat out
LOG_LEVEL=info
```

Content is a **mounted volume, not part of the image**, which keeps the
published artifact free of the publisher's copyrighted text. See
[01-overview.md](01-overview.md#intellectual-property-position).

Health check at `GET /healthz` returning room count and uptime. A single
1 vCPU / 512 MB instance comfortably handles dozens of concurrent rooms —
this workload is idle almost all the time.

## 10.4 Observability

Deliberately minimal, but not absent:

- **Structured JSON logs** to stdout: room lifecycle, join/leave, illegal
  action attempts (with the action and the rule error), invariant failures,
  unhandled exceptions.
- **Per-room action log** as JSONL in `DATA_DIR`. This is simultaneously crash
  recovery, the bug-report format, and the analytics source. It is the single
  most useful operational artifact in the system.
- **An in-app "report a bug" button** that uploads the current room's action
  log with a note. Given deterministic replay, this converts almost every
  report into a reproducible test.
- No metrics stack, no tracing, no error-reporting SaaS until there is a
  reason. Logs plus replay covers it at this scale.

## 10.5 Definition of done for a milestone

A milestone is done when all of these are true — not when the feature works
once on the developer's machine:

1. Its exit criteria in [09-roadmap.md](09-roadmap.md) are met.
2. CI is green: typecheck, lint, tests, build.
3. New rules have scripted-game tests, including the failure cases.
4. The invariant property test still passes over 500 random actions.
5. The redaction test still passes.
6. A real 3-player game has been played through the new feature by actual
   humans in three separate browsers.

Item 6 is the one that gets skipped and the one that finds the most bugs.
