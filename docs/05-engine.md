# 05 — Game Engine

`packages/engine` is the whole game, expressed as pure functions. It has no
network code, no timers, no logging, and no dependency on Node or the DOM. If
you can't run it in a test with a hard-coded seed and get byte-identical
output every time, something is wrong.

## 5.1 Public surface

```ts
// The only mutator.
export function reduce(
  state: GameState,
  action: GameAction,
  content: Content,
): ReduceResult;

export interface ReduceResult {
  state: GameState; // new state; input is never mutated
  events: GameEvent[]; // narration + animation hints
  error?: RuleError; // set iff the action was illegal; state unchanged
}

// Read-only helpers, safe to use in the client.
export function getLegalActions(s: GameState, seat: SeatId, c: Content): GameAction[];
export function getReachable(s: GameState, seat: SeatId, c: Content): PlacedId[];
export function getConnections(s: GameState, from: PlacedId, c: Content): PlacedId[];
export function traitValue(s: GameState, seat: SeatId, t: Trait, c: Content): number;
export function checkWinConditions(s: GameState, c: Content): GameResult | null;
export function redactFor(s: GameState, seat: SeatId | null): GameState;
```

`reduce` returning an `error` rather than throwing is deliberate: illegal
actions are routine (a client with a stale snapshot, a double-click) and must
not take down a room.

## 5.2 Actions

Actions are the complete vocabulary of things that can change the game.
Everything a player can do, plus a small number of server-originated actions.

```ts
type GameAction =
  // lobby / setup
  | { t: 'JOIN'; seat: SeatId; name: string }
  | { t: 'CHOOSE_CHAR'; seat: SeatId; charId: CharId }
  | { t: 'START_GAME'; seat: SeatId }
  // exploration & haunt turns
  | { t: 'MOVE'; seat: SeatId; to: PlacedId }
  | { t: 'MOVE_THROUGH'; seat: SeatId; dir: Dir } // may discover
  | { t: 'ROTATE_TILE'; seat: SeatId; rotation: Rotation } // answers prompt
  | { t: 'USE_ITEM'; seat: SeatId; cardId: CardId; target?: TargetRef }
  | { t: 'TRADE'; seat: SeatId; to: SeatId; cardIds: CardId[] }
  | { t: 'DROP'; seat: SeatId; cardIds: CardId[] }
  | { t: 'ROOM_ACTION'; seat: SeatId; actionId: string }
  | { t: 'ATTACK'; seat: SeatId; target: TargetRef; trait: Trait }
  | { t: 'ASSIGN_DAMAGE'; seat: SeatId; alloc: Partial<Record<Trait, number>> }
  | { t: 'END_TURN'; seat: SeatId }
  // generic prompt answers
  | { t: 'ANSWER'; seat: SeatId; promptId: string; answer: unknown }
  // server-originated
  | { t: 'TICK'; now: number } // resolves expired prompts
  | { t: 'DISCONNECT'; seat: SeatId }
  | { t: 'RECONNECT'; seat: SeatId }
  | { t: 'CONCEDE'; seat: SeatId };
```

Two design notes:

- **`MOVE` vs `MOVE_THROUGH`.** Moving to a known room references its
  `PlacedId`. Moving through an unexplored doorway references a direction,
  because the destination does not exist yet. Keeping these separate avoids a
  nullable target and makes discovery an explicit code path.
- **`TICK` is an action, not a timer callback.** The server sends it; the
  engine stays pure and replay stays deterministic because `now` is recorded
  in the log.

## 5.3 Events

Events are the reducer's narration. They drive the text log, animations, and
sound. They are _not_ state.

```ts
type GameEvent =
  | { t: 'moved'; seat: SeatId; from: PlacedId; to: PlacedId }
  | { t: 'discovered'; seat: SeatId; placed: PlacedTile }
  | { t: 'drew_card'; seat: SeatId; deck: DeckKind; cardId: CardId }
  | { t: 'rolled'; seat: SeatId; dice: number[]; total: number; reason: string }
  | { t: 'trait_changed'; seat: SeatId; trait: Trait; from: number; to: number }
  | { t: 'haunt_roll'; total: number; needed: number; triggered: boolean }
  | { t: 'haunt_begun'; hauntId: HauntId; traitor: SeatId | null }
  | { t: 'attacked'; seat: SeatId; target: TargetRef; result: AttackResult }
  | { t: 'died'; seat: SeatId }
  | { t: 'game_over'; result: GameResult }
  | { t: 'log'; text: string }; // haunt scripts' free-form line
```

Rule of thumb: **if the client could compute it by diffing two snapshots, it
still gets an event** — because the diff loses the _reason_, and the reason is
what the log and the animations need.

## 5.4 Determinism and RNG

The engine never calls `Math.random()`. A seeded PRNG lives _inside_ the
state:

```ts
interface RngState {
  seed: number;
  counter: number;
}
```

`nextInt(rng, n)` returns `[value, newRngState]`. The implementation is
`mulberry32` seeded with `hash(seed, counter)` — small, fast, deterministic
across platforms, and adequate for a board game. The room's seed is generated
once by the server at game creation and written into the initial state.

Consequences we get for free:

- The action log plus the initial state fully reproduce any game. Bug reports
  become "here's the JSONL, replay it".
- Crash recovery is replay (see [03-architecture.md](03-architecture.md#34-server-process-model)).
- Tests can pin a seed and assert on exact dice results.

Dice are always rolled through one helper so the events are uniform:

```ts
function rollDice(rng: RngState, count: number): [number[], number, RngState];
// faces are drawn from [0,0,1,1,2,2]
```

## 5.5 Structure of the reducer

`reduce` is a thin dispatcher; the work lives in per-phase modules.

```
engine/src/
├── reduce.ts               # dispatch + invariant check + event collection
├── phases/
│   ├── lobby.ts
│   ├── setup.ts
│   ├── explore.ts
│   ├── hauntReveal.ts
│   └── haunt.ts
├── systems/
│   ├── movement.ts         # graph, reachability, discovery, tile placement
│   ├── cards.ts            # draw, resolve, discard, reshuffle
│   ├── traits.ts           # index arithmetic, clamping, death detection
│   ├── combat.ts           # attack resolution, damage assignment
│   ├── prompts.ts          # PendingPrompt lifecycle + timeout defaults
│   └── effects.ts          # the shared Effect interpreter (see doc 08)
├── selectors/              # pure reads, exported to the client
├── rng.ts
└── invariants.ts
```

The `effects.ts` interpreter is shared by card effects, room effects, and
haunt rules. Getting one vocabulary of effects reused across all three is what
keeps the content data-driven instead of drowning in bespoke code.

## 5.6 Worked example: discovering a room

`MOVE_THROUGH { dir: 'n' }` while in the Foyer, with nothing north of it:

1. **Validate.** Active seat? Phase allows movement? `movesLeft > 0`? Does the
   current tile have a door on `n` after rotation? Is the target cell empty?
2. **Draw a tile.** Take the first tile in the floor's tile deck whose
   `floors` includes the current floor. Shuffle the passed-over tiles back
   using the state RNG. _(This is the [RULING] from doc 02.)_
3. **Prompt for rotation.** Compute the rotations that put a door on the
   south edge (facing back into the Foyer). If exactly one is legal, apply it.
   Otherwise set `pending = { kind: 'rotate_tile', seatId, payload: { tileId,
legalRotations } }` and stop. The next accepted action is `ROTATE_TILE`.
4. **Place.** Write into `board.placed` and `board.index`. Emit `discovered`.
5. **Move the explorer.** Decrement `movesLeft`, set `cameFrom`, emit `moved`.
6. **Resolve `onEnter`** effects from the tile.
7. **Draw a card** if the tile has a symbol. Emit `drew_card`. Set
   `movesLeft = 0`. Resolve the card's `onDraw` effects.
8. **Haunt roll** if the card was an omen: increment `omensDrawn`, roll six
   dice, emit `haunt_roll`; if triggered, transition to `haunt_reveal`.
9. **Check win conditions**, check death, run invariants.

Note that steps 3 and 7 can each suspend the turn on a prompt. The reducer
handles this by making prompt-resolution re-enter the same pipeline at the
step after the one that suspended — the resume point is stored in
`pending.payload`. Keep that resume state small and explicit; do not attempt
generators or coroutines.

## 5.7 Legality, and how the client uses it

`getLegalActions(state, seat, content)` returns the full set of actions the
seat may take right now. The client uses it to enable/disable controls; the
server uses the same predicate to reject anything else.

Because it is one function, a UI bug can never let a player attempt an illegal
move, and a legality bug shows up identically on both sides — which makes it
findable. Never write a second, client-side "can I do this?" check.

## 5.8 Testing the engine

Covered fully in [10-testing-and-ops.md](10-testing-and-ops.md), but the shape
matters here: because `reduce` is pure and RNG lives in state, the natural
test is a **scripted game** — an array of actions and a seed, run through the
reducer, asserting on the resulting state and events. Regression tests for
rules bugs are two lines each. Invest in a `playGame([...actions])` helper on
day one.
