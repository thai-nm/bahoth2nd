# 09 — Roadmap

Seven milestones. Each one ends in something you can actually run, and each
one's exit criteria are testable. Effort estimates assume one developer
working part-time; treat them as relative sizes, not commitments.

The ordering is deliberate: **the boring infrastructure that is painful to
retrofit comes first** (determinism, redaction, reconnect), and the fun
content comes last, because content is the part that can be paused and
resumed without breaking anything.

---

## M0 — Skeleton and the spine (~1 week)

Prove the whole pipeline end to end with a trivial game before any real rules
exist.

- npm workspaces monorepo, the five packages, strict TS, ESLint import
  boundaries, Prettier, Vitest, GitHub Actions.
- `shared`: core types and the zod-validated protocol envelopes.
- `engine`: `reduce`, seeded RNG in state, `JOIN` / `START_GAME` / `END_TURN`
  only, invariants module, `playGame` test helper.
- `server`: ws endpoint, room map, create/join by code, serial per-room
  reduction, snapshot broadcast, JSONL action log, replay on boot.
- `client`: Vite + React, home screen, lobby, a debug panel that renders raw
  `GameState` JSON and buttons for the three actions.
- Dockerfile, one-container deploy, `/healthz`.

**Exit:** three browsers join a room, pass a turn around, one refreshes and
rejoins with state intact; killing and restarting the server restores the room
from its log. CI green.

---

## M1 — Seats, identity, redaction (~1 week)

- Seat tokens in `localStorage`, `hello` with resume, connection state per
  seat, host transfer.
- `redactFor` plus the **redaction test**, both written now and never removed.
- Content pipeline: schemas, loader, placeholder fixtures, content hash, the
  join-time hash check, `GET /api/content`.
- Character select in the lobby; trait tracks in state as indices.
- Turn timers and the `TICK` action.
- Disconnect handling and the remove-player vote.

**Exit:** a full lobby flow with 6 seats, characters chosen, disconnect and
rejoin mid-lobby, and no snapshot anywhere containing a hidden card id.

---

## M2 — The house (~2 weeks)

The first milestone that feels like the game.

- All 44 tiles plus the three starting tiles and two landings authored as
  content, with doors, floors, symbols, and static links.
- `movement.ts`: adjacency, rotation, static links, reachability, the
  no-backtrack rule.
- Discovery: tile draw with floor legality, the rotation prompt, placement.
- `PendingPrompt` lifecycle including timeout defaults — build the
  suspend/resume mechanism properly here, everything later depends on it.
- Board renderer: DOM tiles, pan/zoom, floor tabs, movement highlights,
  doorway arrows, discovery animation.
- Event log panel driven by `GameEvent`s.

**Exit:** 3–6 players explore the entire house across all three floors, use
every staircase and special connection, and the movement graph never
disagrees between client and server. Property test: 500 random legal actions
never break an invariant.

---

## M3 — Cards, traits, dice (~2 weeks)

- Item / Event / Omen decks: draw, resolve, discard, reshuffle.
- The `Effect` interpreter, with prompt suspension. This is the piece the
  haunt system is built on — do not rush it.
- Card content authored for all three decks.
- Trait tracks: index arithmetic, clamping, death detection, drop-items-on-death.
- Dice system and the roll UI.
- Items: hold, use, trade, drop. Weapons and companions flagged.
- Haunt roll after every omen.

**Exit:** a complete pre-haunt game: players explore, draw all three card
types, trait changes resolve correctly, someone dies to an event, and the
haunt roll fires at a plausible point. Playable and genuinely fun already.

---

## M4 — The haunt, and five of them (~3 weeks)

The vertical slice completes here.

- Haunt table content (all 50 omen × room entries mapped, even for
  unimplemented haunts).
- Haunt selection, traitor determination for all five `traitorRule` kinds,
  tie-breaks.
- Private haunt reveal: separate instruction panels for traitor and heroes.
- Trigger rule system, all trigger points, priority ordering.
- Monsters: definitions, spawning, traitor-controlled movement and attacks.
- Combat: attack resolution, damage allocation prompt, mental attacks.
- Win condition evaluation, game-over screen.
- **Five haunts fully implemented**, chosen to exercise different shapes:
  one "kill all heroes", one "escape the house", one "collect N tokens",
  one "protect/destroy an object", one survival haunt with no traitor.
- **Manual mode** for the other 45: reveal, show prose, enforce movement and
  combat, resolve the winner by vote.

**Exit:** six humans play a complete game start to finish, on one of the five
implemented haunts, in three browsers, with one deliberate mid-game disconnect.
Then again on an unimplemented haunt in manual mode.

---

## M5 — Polish (~2 weeks)

Everything that makes it feel like a product rather than a prototype.

- Visual pass: palette, typography, tile styling, layered shadows.
- Motion pass, plus full `prefers-reduced-motion` support.
- Sound: dice, card flip, door, haunt sting. Off by default.
- Spectators, and dead players as spectators.
- Chat.
- Tablet landscape layout; best-effort phone layout.
- Accessibility pass: keyboard board navigation, `aria-live` log, contrast audit.
- Rules reference panel, per-card and per-room tooltips.
- In-app bug report that uploads the action log.
- Playwright smoke test.

**Exit:** someone who has never played the physical game can be taught to play
from inside the app, on a tablet, with sound off and a screen reader on.

---

## M6 — The remaining 45 haunts (ongoing)

Batched by mechanical similarity per the workflow in
[08-haunt-system.md](08-haunt-system.md#87-authoring-workflow-for-the-remaining-45).
Each haunt: JSON, 30-minute timebox on the DSL, script module if it doesn't
fit, two scripted-game tests, flip `implemented: true`.

Ship continuously — every haunt that lands is immediately playable. Expect
the first batch to be slow and later batches to accelerate sharply as the
effect vocabulary saturates.

**Exit:** `implemented: true` on all 50, every haunt covered by a traitor-win
and a hero-win test.

---

## Deferred beyond M6

Listed so they stay out of earlier milestones:

- AI opponents for empty seats.
- Widow's Walk expansion content.
- Accounts, persistent stats, replay viewer as a shareable link.
- Multi-process scaling.
- Localisation.

---

## Critical path and risk

```
M0 ──▶ M1 ──▶ M2 ──▶ M3 ──▶ M4 ──▶ M5
                       └──────▶ M6 (parallelisable after M4)
```

| Risk                                                                                               | Mitigation                                                                                                                                                                 |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Haunt variety defeats the DSL** — the biggest risk in the project                                | The script escape hatch exists from the start, and the 30-minute timebox is a rule, not a suggestion. Five deliberately dissimilar haunts in M4 test the vocabulary early. |
| **Content entry is a slog** — 44 tiles, ~65 cards, 12 characters, 50 haunt-table rows, all by hand | Do it in M2/M3 as scheduled, not "later". Content validation tests catch transcription errors. Consider a small internal editor if it drags.                               |
| **Prompt suspend/resume gets bolted on badly**                                                     | Build it once in M2 for tile rotation, generalise it in M3 inside the effect interpreter, before any haunt depends on it.                                                  |
| **Trait-as-value instead of trait-as-index**                                                       | Called out in three documents; caught by the content validation test asserting 8-entry tracks.                                                                             |
| **Scope creep into art and animation**                                                             | M5 is a fixed box. Nothing visual moves earlier.                                                                                                                           |
| **Two-person team stalls at M6**                                                                   | M6 is explicitly ongoing and shippable in increments; the game is complete and playable without it.                                                                        |

---

## Open questions

Resolve these before or during the milestone noted. Answers go into the
relevant document, not into this list.

1. **Unimplemented-haunt policy** (M4). Manual mode, or reroll onto an
   implemented haunt? Current plan: manual mode, with reroll as a room setting.
2. **Turn timer defaults** (M1). 10 minutes for connected players, 90 seconds
   for disconnected. Needs a real playtest to confirm the first number isn't
   annoying.
3. **Where does real content come from** (M2). Hand-entered by us from a
   physical copy into `content/`, gitignored. Confirm no better source exists
   that is actually redistributable.
4. **Do we support 2-player games?** (M4). Not in the printed rules; several
   haunts break. Current plan: minimum 3 seats, with a clear message.
5. **Reconnect grace before a seat can be voted out** (M1). 10 minutes is a
   guess.
6. **Does the client need the tile deck count?** (M1 redaction). Showing
   "18 rooms left" is a nice touch and leaks nothing meaningful. Probably yes.
7. **Rotation prompt when only one rotation is legal** (M2). Auto-apply, or
   still confirm? Current plan: auto-apply, since there is no decision to make.
