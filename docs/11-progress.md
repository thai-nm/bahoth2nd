# 11 — Progress

Living status document. Updated when a milestone moves, not on a schedule.

**Last updated: 2026-08-02** · **Current milestone: M2 (complete) → M3 next**

## Status at a glance

| Milestone                        | Status         | Notes                                                            |
| -------------------------------- | -------------- | ---------------------------------------------------------------- |
| M0 — Skeleton and the spine      | ✅ Complete    | Merged — [PR #2](https://github.com/thai-nm/bahoth2nd/pull/2)    |
| M1 — Seats, identity, redaction  | ✅ Complete    | All nine items; D1–D5 closed                                     |
| M2 — The house                   | ✅ Complete    | All six roadmap items, shipped as eight PRs; D7 found and closed |
| M3 — Cards, traits, dice         | ⬜ Not started |                                                                  |
| M4 — The haunt, and five of them | ⬜ Not started |                                                                  |
| M5 — Polish                      | ⬜ Not started |                                                                  |
| M6 — The remaining 45 haunts     | ⬜ Not started |                                                                  |

---

## M2 — complete

Planned as four PRs — content, movement, discovery, renderer — and shipped as
eight, because the renderer turned out not to need the movement graph and went
early (deviation 8), wiring it to the engine was worth its own diff, and
discovery shipped the prompt mechanism a milestone-item ahead of the generic
lifecycle that now sits under it.

**Exit criteria met.** 3–6 players explore the whole house across all three
floors; every staircase and the one-way drop are reachable and were walked in
a browser; the movement graph cannot disagree between client and server
because both call one `getReachable` (docs/05-engine.md#57), asserted on a
redacted snapshot as well as on the server's own state; and the property test
runs 500 random legal actions × 25 seeds without breaking an invariant.

| Item                                                    | Status                                                        |
| ------------------------------------------------------- | ------------------------------------------------------------- |
| Tiles, static links, and the starting layout as content | ✅ Done — [#13](https://github.com/thai-nm/bahoth2nd/pull/13) |
| Rotation and grid primitives in `shared`                | ✅ Done — [#14](https://github.com/thai-nm/bahoth2nd/pull/14) |
| Board renderer: tiles, doors, pan/zoom, floor tabs      | ✅ Done — [#15](https://github.com/thai-nm/bahoth2nd/pull/15) |
| `movement.ts`: adjacency, rotation, links, no-backtrack | ✅ Done — [#16](https://github.com/thai-nm/bahoth2nd/pull/16) |
| Wire the board into the game screen                     | ✅ Done — [#17](https://github.com/thai-nm/bahoth2nd/pull/17) |
| Discovery: tile draw, rotation prompt, placement        | ✅ Done — [#18](https://github.com/thai-nm/bahoth2nd/pull/18) |
| `PendingPrompt` lifecycle and timeout defaults          | ✅ Done — [#19](https://github.com/thai-nm/bahoth2nd/pull/19) |
| Event log panel driven by `GameEvent`s                  | ✅ Done — this PR                                             |

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

### Wiring the board into the game screen

The joint the last two items existed to make: `Game.tsx` now calls
`getReachable(state, seatId, content)` and hands the result to `Board` as
the `reachable` prop it has taken since #15, instead of a debug JSON panel.
This is the first time the highlight the renderer draws and the engine's own
legality answer meet each other, rather than one standing in for the other.

Two decisions worth recording:

- **Doorway arrows stay dead.** `MOVE_THROUGH` is still `UNKNOWN_ACTION` in
  the engine — discovery has not landed — so `Game.tsx` does not pass
  `onMoveThrough`. `Board` already dims and disables an arrow when that
  handler is `undefined`; wiring one through anyway would put an error banner
  behind every doorway click for a feature that doesn't exist yet.
- **`getReachable` is filtered to the displayed floor before it reaches
  `Board`.** The engine's answer spans floors — a staircase link crosses
  one — but `Board` only ever renders one floor at a time. Passing the
  unfiltered list through would silently drop the entries for rooms on the
  other floor, which reads as the engine being wrong when it is the caller
  that forgot to filter.

`BoardPreview` came along for the cleanup it predicted (see "Next actions" in
the previous update): invariant 3b now requires `placed[key].id ===
placedIdFor(floor, x, y)`, and the preview used to mint bare tile ids
instead. It now calls `placedIdFor` like the engine does, and its pawns and
hardcoded reachable list resolve their `PlacedId`s by looking placements up
by tile id rather than hardcoding the derived string — a coordinate change
in the preview's layout can no longer silently orphan a pawn onto an id
nobody placed. `layout.test.ts` turns "the preview is a board the engine
would accept" from a comment into an assertion: it attaches
`buildPreviewBoard` to a real `createInitialState` and asserts
`checkInvariants` reports nothing. Watched failing first, by reverting the
id back to the bare tile id — it failed with exactly invariant 3b's
complaint, one line per tile.

The players rail and the event log are untouched — both are their own M2
items, and the rail still shows the plain seat list rather than
`docs/07-ui.md#72`'s portraits and trait strips, since traits have no death
detection until M3. `store.ts`'s `describe()` picks up `moved` and
`discovered` so the log narrates something better than the bare event name
the first time either fires; nothing else about the log panel changed.

**One bug the green build did not catch**, continuing #15's record. Pawns
take their letter from the explorer's name, and every placeholder explorer is
named "The something" — so the first real game drew three pawns all reading
**"T"**, separable only by colour, which is the one job the letter was there
to do. Nothing in the suite could see it: every assertion was about _which_
pawn sat _where_, and all three were individually correct. A leading article
is now stripped before the initial is taken, which is the right rule for real
content too ("Ox Bellows" is unaffected), and the test asserts the thing that
actually broke — that the three explorers a 3-player game seats get three
_distinct_ letters, not that any one of them is right.

Verified by driving a real game in a browser: three seats (one browser, two
scripted websocket clients, because seat tokens are keyed by room code in
`localStorage` and two tabs would share one seat), start, a one-room move, a
two-room path, a cross-floor move through the staircase link, and a
four-room path from the upper landing down to the basement — which is
`getReachable` spanning three floors and the per-floor filter both doing
their jobs at once. The no-backtrack rule is visible on screen: the room you
just left stops being highlighted.

### Discovery

The item the previous five were building toward: `MOVE_THROUGH { dir }` draws a
tile, the seat chooses a rotation, and the room comes into existence
(docs/05-engine.md#56, steps 1-5). The house is now explorable — every room in
it arrives by someone walking through a doorway that had nothing behind it.

Steps 6-9 of that worked example are deliberately absent. A discovered tile
with a symbol draws no card and does not end movement, because the decks do not
exist until M3; the seam is commented where it will go.

**The tile deck lives in state**, shuffled from `content.deckTiles` at
`START_GAME` with the in-state RNG, right after the turn-order shuffle so the
order the two draw in is fixed and replay reproduces both. The draw is
docs/02-rules-model.md#24's [RULING]: take the first tile in the deck that this
floor allows, and shuffle the passed-over ones back.

Four decisions worth recording:

- **Rotation options are deduplicated by their effective doors.** A tile with
  doors on all four sides has four "legal" rotations that are the same room.
  Prompting for a choice with no effect is worse than not prompting — and the
  dedupe is also what makes auto-apply (roadmap open question 7, now settled:
  auto-apply) fire on exactly the symmetric tiles it should, rather than on
  one-door tiles only.
- **A plain draw does not burn a random number.** Only a draw that actually
  passed something over touches the RNG. Advancing it on every discovery would
  perturb every later roll for no reason, which is the kind of thing that is
  invisible until a haunt roll is being argued about.
- **A pending prompt offers `ROTATE_TILE`, not the generic `ANSWER`.**
  `getLegalActions` used to return `ANSWER { answer: null }` for any prompt —
  an action `reduce` rejects with `UNKNOWN_ACTION`. That is precisely what the
  property test exists to catch, and it stayed green only because no prompt
  could ever be raised. It now enumerates the seat's real rotation choices, and
  returns `[]` for a prompt kind it cannot enumerate rather than one the
  reducer will refuse.
- **A prompt is the resume point.** `pending.payload` carries the drawn tile,
  its target cell, the room being left, and the legal rotations — everything
  `finishDiscovery` needs, so there is no continuation to reconstruct. Three
  callers reach that one function: auto-apply, `ROTATE_TILE`, and default
  resolution.

**Default resolution, not prompt-dropping.** The tile leaves the deck the
moment it is drawn, whether or not a prompt follows. So every path that could
previously discard `pending` now resolves it on `defaultAnswer` instead —
`tick`'s deadline branch, `tick`'s turn-expiry branch, and (see below)
`concede` and `resolveRemovals`. Dropping a prompt would make content vanish:
an explorer stuck mid-doorway and a tile that is nowhere. The generic half of
the `PendingPrompt` item — server-set deadlines, `ANSWER`, defaults for kinds
that do not exist yet — is still its own item; what could not wait was the hole
that a prompt with no owner leaves behind.

**Two bugs found in review, neither visible from a green build.**

The first: `getOpenDoorways` asked "is a tile left that this floor allows?" by
reading `state.tileDeck` — which `redactFor` empties. The client only ever
holds a redacted snapshot and calls the same `getLegalActions`
(docs/05-engine.md#57), so it would have received an empty answer forever and
every doorway arrow would have been permanently dead. Caught by probing a real
game rather than by reading:

```
1 at=ground:0,1 moves=3 open=["e","w"]     openRedacted=[]
3 at=upper:0,0  moves=1 open=["n","e","w"] openRedacted=[]
```

The fix is not to un-redact the deck. The deck's **order** is hidden — that is
what docs/06-networking.md#64's "Tile deck order — same treatment" means — but
its **composition is public**: the tile list is public content, the board is
public, and the deck is exactly "every drawable copy, minus what has been
placed". So drawability is derived from content and the board, and agrees with
the deck by construction. The test that guards it asserts the two legality
answers match **and** that the set is non-empty, because a weaker version
passes with both sides blank, which is how this got through in the first place.

The second: **a prompt could outlive the seat that owns it.** If the prompted
seat conceded, `pending` survived pointing at a seat that was now dead — and
`getLegalActions` keys the prompt off `pending.seatId` alone, so a dead seat
was still the only one who could answer. If it was voted out instead, worse:
that function returns `[]` early for a removed seat, so _nobody_ could. Either
way the table was stuck until the turn clock expired: up to ten minutes, with a
drawn tile in limbo. **D5's exact shape** — a reachable state whose only escape
is a clock. `concede` and `resolveRemovals` now resolve a prompt owned by the
departing seat before it leaves, and invariant 7a asserts a pending prompt's
seat is neither dead nor removed, so the stuck state is unreachable rather than
merely unlikely. Both fixes were watched failing against that invariant, which
is the point of adding it.

**What the property test does and does not reach.** Its random walk finds
discovery and the rotation prompt on its own, and both are now asserted in the
reach test. It does _not_ reach either prompt-orphaning path: `CONCEDE` is never
offered by `getLegalActions`, so the walk cannot issue it at all, and the
removal-vote path turned up 0 times across the seeds the test actually uses.
Those two stay unit tests. Padding the seed range until a rare path went green
would have bought a flaky assertion instead of coverage.

210 tests, twelve files.

**Verified by driving a real game in a browser** — three seats, one browser plus
two scripted websocket clients, since seat tokens are keyed by room code in
`localStorage`. Both the choice prompt (three rotations) and auto-apply
(one-door tile, no prompt) behave; other seats see the ghost tile and the "is
placing the…" line with no controls; arrows on rooms you are not standing in
stay dead; and a discovery on the upper floor drew a tile the upper floor
allows. One note on method: the browser tool's synthetic pointer clicks did not
register on the board's own buttons — which carry pan/drag pointer capture —
and were driven with dispatched `MouseEvent`s instead. That is a harness quirk,
not shipped behaviour, but it means the click path itself is verified slightly
less directly than the rest.

### The prompt lifecycle, the generic half

Discovery built suspend/resume and exactly one kind on top of it. What was
left was making it general before M3 leans on it hard: a prompt's own clock,
the `ANSWER` action, and a story for the five kinds nothing raises yet.

**The prompt gets its own clock, and it is much shorter than the turn's.**
Before this, an unanswered prompt could only be resolved by the turn clock
expiring — so one undecided rotation cost the seat its entire turn, ten
minutes of it. Now `timers.promptMs` (60 s, `PROMPT_TIMEOUT_SECONDS`) resolves
the prompt on its default and **play carries on inside the same turn**. That
asymmetry is the reason the budget is separate rather than shared: a turn is
spent by one seat, a prompt blocks the whole table.

Four decisions worth recording:

- **The deadline is armed by `TICK`, not written by the server.**
  docs/04-data-model.md says `deadline` is "set by the server", which is true
  of where `now` comes from and not of who writes the field — the reducer is
  still the only mutator, and a deadline invented outside the action log would
  not survive replay. So it works exactly like `turnDeadline`: raised null,
  armed by the next tick. **Arming and firing are deliberately different
  ticks** — doing both in one pass makes a `promptMs` of 0 resolve instantly,
  which reads as a prompt that expired before anyone saw it.
- **`ANSWER` and `ROTATE_TILE` are two doors into one function.** Both land in
  `answerPrompt`, and a test asserts the two produce byte-identical states and
  events. `ANSWER` additionally checks `promptId` against `pending.id`, which
  is the whole reason that field exists: a client answering the prompt it
  _saw_ must not land on the prompt that replaced it in flight.
- **A default answer is validated like any other answer.** `resolvePromptWithDefault`
  no longer has its own idea of what to apply; it runs `defaultAnswer` through
  the same `validateAnswer` a player's answer goes through, and resumes through
  the same function. A timeout that could do something no player was offered is
  a bug that only ever shows up on a clock nobody is watching.
- **`PROMPT_HANDLERS` is a total `Record<PromptKind, …>`.** Adding a kind to
  `shared` without deciding how it validates is now a **compile error** rather
  than a prompt that silently accepts nothing and times out into a branch
  nobody wrote. The five unraised kinds get an explicit handler that refuses
  every answer and enumerates nothing — their real validators land with the
  code that raises them, because a validator written now against a payload
  shape nobody has designed is a check that cannot fail, which is D1's family.

**One bug this found in its own migration path, before it could ship.**
Recovery read `header.timers ?? this.timers()`. A log written before `promptMs`
existed carries the other three budgets and not that one, so the `??` hands the
room a `promptMs: undefined` — every prompt deadline becomes `now + undefined`,
i.e. `NaN`, and `now >= NaN` is false forever. A prompt clock that looks armed
and never fires, in exactly the rooms that survived a restart. The header is
merged over today's defaults now, invariant 7b rejects a non-finite deadline,
and the test writes a genuinely old-format log and recovers from it.

**Two tests that passed while the code was broken, and had to be fixed to
be worth anything.** The first: the server-side "arms an unarmed prompt clock"
test passed with `isTickDue` completely blind to prompts, because a freshly
started room has an unarmed _turn_ clock, which is due on its own and drags the
prompt's arming along with it. It now arms the turn clock first, so only the
prompt can make the sweep fire. The second was self-inflicted during review of
this work — a mutation meant to break `ANSWER` never applied, and the suite
staying green was read as coverage until the mutation itself was checked. Both
are the same lesson as #15's floating tile: **a test you have not watched fail
is not evidence.** Every assertion here was watched failing against a
deliberate mutation of the line it depends on: arming removed, arm-and-fire
collapsed into one tick, `ANSWER` returned to `UNKNOWN_ACTION`, the `promptId`
check bypassed, the illegal-default fallback removed, the unraised handler made
to accept anything, `isTickDue` blinded, and the header substituted rather than
merged.

**Not done, deliberately: prompt payload redaction.** `rotate_tile`'s payload
is public by design — the ghost tile is drawn for every seat. `choose_card`
will not be, and `redactFor` currently passes `pending` through whole. That is
M3's problem, and inventing the rule now, with no kind to test it against,
would be guessing. It is listed under "Next actions" rather than left implicit.

240 tests, thirteen files.

**Verified by driving a real game in a browser** with `PROMPT_TIMEOUT_SECONDS=20`
so the clock is observable: four seats — two scripted websocket clients and
**two browser tabs, one on `localhost` and one on `127.0.0.1`**, which are
different origins and therefore hold different `localStorage`, so each keeps
its own seat. That is what made the watcher side observable for the first time:
the prompted seat sees `Placing: Bent Corridor 0:15` with rotate controls, and
the other tab simultaneously sees `Placer is placing the Scullery Hatch… 0:03`
with **zero** buttons. Letting one expire placed the tile on the default
rotation, logged the timeout, and left the top bar still reading "Your turn" —
the behaviour the whole item buys. Answering normally still works. The
synthetic-click quirk from #18 recurred and was again worked around with
dispatched `MouseEvent`s.

### The event log

The last M2 item, and the one that makes the previous seven legible: until
now the reducer's narration reached the screen as `seat_0 moved to
ground:0,1`. Every one of the seventeen `GameEvent` kinds now has prose, seat
ids and content ids resolve to names, and chat shares the scroller — one
conversation, since "Ana moved to the Ballroom" and "wait, don't" are a
single thread and splitting them into two columns would be inventing a
problem.

The narration moved out of `store.ts` into `packages/client/src/log/`, split
so that the part worth testing is testable: `narrate.ts` is pure — event plus
a snapshot-derived context in, one line out — and `LogPanel.tsx` holds only
the DOM wiring vitest's `node` environment cannot reach (D6). A component
that decided its own wording would be a component whose wording is untested.

Five decisions worth recording:

- **Narration never prints a drawn card id.** `drew_card` reads "Ana drew an
  Omen card". Events are broadcast to every seat unredacted, so an id in the
  narration would leak through the log exactly what `redactFor` exists to
  protect — and the log is the one surface where it would be leaked to
  everyone at once, permanently, in writing. No card exists yet; the rule is
  in place before the first one does, because the alternative is discovering
  it in M3 with a card on the table.
- **Trait changes read as printed values, not track indices.** "Might 4" is a
  slot number. The context carries each seat's `charId` so index 3 resolves
  through `character.tracks`, and index 0 says "the skull" rather than a
  value — the slot that has none. Falls back to the index where the explorer
  is unknown, which is honest rather than wrong.
- **The context is built from the snapshot that arrived _with_ the events.**
  The server sends `snapshot` then `events` for one version, so the board
  already holds the room a `moved` event names. That ordering is what makes
  `PlacedId → room name` possible at all; it would be the wrong way round for
  an event describing something the same reduction removed, which is noted in
  the code as the thing to watch for.
- **A line is attributed to a seat separately from its text.** `game_started`
  is not Ana's line because she is first in the turn order, so it gets no
  colour swatch; `haunt_begun` belongs to the traitor. Colour is never the
  only cue — the name is inside the text (docs/07-ui.md#76).
- **The log scroller pins to the bottom, except when you have scrolled up.**
  A log that always jumps to the newest line takes history away from whoever
  is reading it, and a turn clock is exactly when someone is catching up.
  Sending a message re-pins you, since otherwise you type something and never
  see it arrive.

**`EVENT_TYPES`, and a test that was proving nothing.** The first draft
claimed a total `Record<EventType, GameEvent>` of samples made a missing
narration a compile error, the same trick `PROMPT_HANDLERS` uses. It does
not: `packages/client/tsconfig.json` **excludes test files**, and vitest
transpiles without typechecking, so the annotation was decoration and the
sweep really iterated "every event somebody remembered". `shared` now exports
a runtime `EVENT_TYPES` list, checked against the union in both directions at
compile time — a variant missing from the list fails one assertion, a typo in
the list fails the other — and the test sweeps that. Both directions were
watched failing: adding an `item_dropped` variant errored in `events.ts` and
in `narrate.ts`'s exhaustiveness check, and misspelling a list entry errored
too.

`narrate` itself is exhaustive by a `never` assignment rather than by a
`default` that returns the bare event name. That default is how `moved` and
`discovered` each shipped once as debug output; a new event kind is now a
build failure instead of a line that reads `drew_card`.

**One layout bug found by looking, not by testing.** The log column capped
its list at 640px against a board viewport fixed at 560 — already the taller
column before this item, and the compose row made the overshoot plain: the
whole page scrolled, pushing the top bar and its turn clock off screen. The
cap is now 560, tied in a comment to the constant it has to match.

258 tests, fourteen files. Eighteen are the narration's own; every one was
watched failing against a deliberate mutation of the line it depends on —
seat ids instead of names, `PlacedId`s instead of room names, track indices
instead of printed values, the card id printed, a kind returned to the bare
name, a table-wide event attributed to a seat, the lobby seat list winning
over `state.players`, attack damage attributed to the wrong side, and the
`EVENT_TYPES` sweep reduced to the samples list.

**Verified by driving a real game in a browser** — three seats, one browser
plus two scripted websocket clients. The lobby now carries the panel too,
which is where `joined` and `char_chosen` are narrated and where waiting for
a table to fill makes chat worth having; both read correctly, with the right
colour swatch per seat. Then in the game: a move ("Ana moved to the Foyer"), a
discovery ("Ana discovered the Echo Chamber"), `game_started` with the turn
order in names and no swatch, and — by killing both bots — "Cal disconnected"
/ "Ben disconnected" arriving while the view was deliberately scrolled up,
which stayed put rather than jumping. A message sent from that scrolled
position jumped back to the bottom. Chat appears exactly once for its sender,
confirming the no-local-echo decision. The synthetic-click quirk from #18 and
#19 recurred and was again worked around with dispatched `MouseEvent`s.

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

| #   | Deviation                                                                             | Why                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Redaction test written in M0, not M1                                                  | The deck plumbing already existed; shipping a snapshot path without the leak test was not worth the ordering purity.                                                                                                                                                                                                                                                                                                     |
| 2   | `START_GAME` goes straight to `explore`, skipping `setup`                             | Characters are chosen in the lobby, so `setup` had nothing to do. The phase remains declared for later use.                                                                                                                                                                                                                                                                                                              |
| 3   | Invariant 1 keys off board emptiness, not a phase list                                | "Every living player is on the board once the board exists" stays correct after M2 places tiles; a phase list would have needed editing.                                                                                                                                                                                                                                                                                 |
| 4   | Property tests use our own seeded RNG, not fast-check                                 | Same properties, no extra dependency, failures reproducible from a printed seed. Revisit if shrinking becomes worth it.                                                                                                                                                                                                                                                                                                  |
| 5   | Vite 8 / vitest 4 / zod 4 / React 19 instead of the versions implied at planning time | Starting fresh, the older majors carried a known dev-server advisory. Current majors audit clean.                                                                                                                                                                                                                                                                                                                        |
| 6   | The host is the earliest-**joined** connected seat, not the longest-**connected** one | "Longest-connected" needs a clock, and the engine may not read one. Join order is already encoded in the seat id, so this is deterministic and free. It also behaves better: the role returns to the original host when they reconnect instead of drifting to whoever has been online longest since.                                                                                                                     |
| 7   | A removal vote may be cast immediately; only its EFFECT waits for the grace period    | Gating the vote itself would need a clock inside `getLegalActions`, which must stay pure. Voting early and resolving late is the same rule from the player's side, and keeps legality clock-free.                                                                                                                                                                                                                        |
| 8   | The renderer shipped **before** `movement.ts`, not after it as M2 planned             | A board is a pure function of `BoardState` and `Content`; it never needed the movement graph. Going early settled tile size, floor tints, and rotation against real pixels a milestone-slice sooner, and `reachable` arriving as a prop keeps the later wiring to a caller change.                                                                                                                                       |
| 9   | Tile colour derives from the **floor**, not from the per-tile `art.bg` in 07-ui       | Three tints read better than 44 hand-picked colours and cost no authoring. `art.bg` still wins where content supplies it, so nothing is closed off — and no fixture sets it today, so the documented path was decorative as written.                                                                                                                                                                                     |
| 10  | A second accent token, `--accent-on-parchment`                                        | `--accent: #c8703c` measures 2.65:1 on the ground tint and fails 07-ui's own 4.5:1 rule. Chrome keeps `--accent`; anything on a tile uses `#9c4a16`. 07.6 predicted this surface would be the one that failed.                                                                                                                                                                                                           |
| 11  | `TILE = 150`, not the 120 stated in 07-ui                                             | At 120 a room name lands near 8px once the symbol badge and door notches take their bites. Everything scales from the constant, so it stays cheap to revisit.                                                                                                                                                                                                                                                            |
| 12  | The room name renders **outside** the rotated frame, rather than counter-rotating     | Same result — upright text over a rotated tile — with one transform instead of two.                                                                                                                                                                                                                                                                                                                                      |
| 13  | `Colour` lives in `shared/ids.ts`, not derived from content's `ColourSchema`          | Domain enums already live there beside `Floor`/`Dir`/`Trait`. A client-local copy made the client the only package with an opinion about which colours exist; a content test now asserts the two never drift.                                                                                                                                                                                                            |
| 14  | Rotation choices are **deduplicated by effective doors** before the prompt is raised  | Four "legal" rotations of a four-door tile are the same room. A prompt with no consequence is worse than no prompt, and the dedupe is what makes roadmap question 7's auto-apply fire on symmetric tiles rather than one-door tiles only.                                                                                                                                                                                |
| 15  | Passed-over tiles reshuffle the **whole** remaining deck, not just themselves back in | The deck's order is hidden either way, so the two are the same information to every player. One line instead of ten. A draw that passed nothing over leaves the RNG untouched, so ordinary discoveries do not perturb later rolls.                                                                                                                                                                                       |
| 16  | A pending prompt offers `ROTATE_TILE`; the generic `ANSWER` is offered for nothing    | `getLegalActions` previously returned `ANSWER { answer: null }`, which `reduce` rejects — a legal action the reducer refuses, green only because no prompt could be raised. It now enumerates real choices, and offers nothing for a kind it cannot enumerate.                                                                                                                                                           |
| 17  | Deck **drawability** is derived from content + board, never read off `state.tileDeck` | The deck's order is redacted; its composition is not, and cannot be — content and the board are both public. Deriving it is what lets one legality function answer identically on the server and on a client that holds only a redacted snapshot.                                                                                                                                                                        |
| 18  | `pending.deadline` is armed by `TICK`, not "set by the server" as 04-data-model says  | The reducer is the only mutator, and the engine may not read a clock. A deadline written outside the action log would not survive replay. `now` still comes from the server — in the action — which is the part of the doc that matters. Same mechanism as `turnDeadline`.                                                                                                                                               |
| 19  | A prompt gets its **own** budget (`timers.promptMs`), not a slice of the turn's       | A turn is spent by the seat taking it; a prompt blocks every seat at the table. Sharing the turn's clock meant one undecided rotation cost a whole ten-minute turn. 60 s is a guess, like the other two, and joins open question 2's playtest list.                                                                                                                                                                      |
| 20  | The log panel renders in the **lobby** as well as the game, which 07-ui does not show | `joined` and `char_chosen` are narrated only in the lobby, so without it they scrolled past into a log nobody would see until the game began — and waiting for a table to fill is when chat is most wanted. One component, two callers; only the height cap differs.                                                                                                                                                     |
| 21  | Event narration and chat share **one** scroller rather than two regions               | 07-ui says "interleaved with chat", and they are one conversation: "Ana moved to the Ballroom" and "wait, don't" belong next to each other. They stay distinguishable by weight and colour, never by colour alone — a chat line carries its speaker's name in the text.                                                                                                                                                  |
| 22  | `drew_card` narration omits the card id entirely                                      | Events are broadcast unredacted to every seat, so an id in the log leaks to everyone at once and in writing. Narration does not need it: the reveal is its own UI in M3. The rule is set before the first card exists, rather than after.                                                                                                                                                                                |
| 23  | Trait tracks are **9 slots** (index 0-8), not the 8 assumed in M0/M1/M2               | The 8-slot shape was a guess made before any real character card had been checked against it. Confirmed wrong against a real card during M3 content prep: printed tracks run 8 numbered values plus the skull, nine total. `TrackSchema`, `StartIndexSchema`, invariant 5, the 12 placeholder characters, and the two docs that stated "8-slot" are all updated together so nothing is left disagreeing with the others. |

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

1. **Answer roadmap open question 3** — whether any redistributable room set
   exists — before hand-entering 44 tiles and ~65 cards from a physical copy.
   Ten minutes of looking against hours of transcription, and M3 is the
   milestone that needs the cards.
2. **Start M3 with the `Effect` interpreter**, not with content. It is the
   piece the haunt system is built on, the prompt lifecycle it suspends
   through now exists, and the roadmap's own risk table says not to rush it.
3. **Decide what a prompt payload reveals, in M3.** `redactFor` passes
   `pending` through whole. Correct for `rotate_tile`, whose payload is drawn
   on everyone's board anyway; wrong the moment `choose_card` puts card
   identities in a payload. The rule belongs with the first kind that needs
   it, not before.
4. **Decide whether `GameEvent`s need redacting too**, with the same card.
   `broadcastState` sends one event array to every seat, and the log now
   narrates from it. Narration already refuses to print a card id
   (deviation 22), but that is a convention in one function rather than a
   guarantee in the transport — the moment an event carries something only
   one seat should know, the fix belongs beside `redactFor`, not in the
   wording.
5. **Confirm the turn-timer defaults with a real playtest** (roadmap open
   question 2). Ten minutes, ninety seconds, and now sixty seconds for a
   prompt are still guesses; they are at least guesses that something reads.

## Metrics

Rough, for trend only.

|                     | M0                    | M1                    | M2                    |
| ------------------- | --------------------- | --------------------- | --------------------- |
| Tests               | 49                    | 88                    | 258                   |
| Packages            | 5                     | 5                     | 5                     |
| Haunts implemented  | 0 / 50                | 0 / 50                | 0 / 50                |
| Room tiles authored | 0 / 44                | 0 / 44                | 44 / 44 (placeholder) |
| Cards authored      | 0 / ~65               | 0 / ~65               | 0 / ~65               |
| Characters authored | 12 / 12 (placeholder) | 12 / 12 (placeholder) | 12 / 12 (placeholder) |
