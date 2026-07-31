# 04 — Data Model

All types live in `packages/shared/src/types/`. Content schemas live in
`packages/content/src/schemas/` as zod schemas that _infer_ their TypeScript
types, so there is exactly one definition of each shape.

## 4.1 Primitives

```ts
type SeatId = string; // stable per player per room, e.g. "seat_3"
type RoomCode = string; // 5 chars, uppercase, no vowels (avoids words)
type TileId = string; // content id, e.g. "tile.ballroom"
type CardId = string; // content id, e.g. "omen.spear"
type PlacedId = string; // instance id of a tile on the board
type CharId = string; // content id, e.g. "char.ox_bellows"
type HauntId = number; // 1..50

type Floor = 'basement' | 'ground' | 'upper';
type Dir = 'n' | 'e' | 's' | 'w';
type Rotation = 0 | 90 | 180 | 270;
type Trait = 'speed' | 'might' | 'sanity' | 'knowledge';
type DeckKind = 'item' | 'event' | 'omen';
```

## 4.2 Game state

`GameState` is the single serialisable object the server owns. It must be
plain JSON — no class instances, no `Map`, no `Set`, no `Date`. That
constraint is what makes snapshots, the action log, replay, and time-travel
debugging all fall out for free.

```ts
interface GameState {
  version: number; // increments on every reduction
  contentHash: string;
  rng: RngState; // see 05-engine.md
  phase: Phase;
  players: Record<SeatId, PlayerState>;
  turnOrder: SeatId[];
  activeSeat: SeatId | null; // null in the lobby and after game over
  round: number;
  timers: TurnTimers; // fixed at room creation, never read from config later
  turnDeadline: number | null; // ms epoch; armed by the first TICK of a turn
  removeVotes: Record<SeatId, SeatId[]>; // target -> seats voting to remove it
  board: BoardState;
  decks: Record<DeckKind, DeckState>;
  omensDrawn: number;
  haunt: HauntState | null;
  pending: PendingPrompt | null; // blocks the game awaiting one decision
  monsters: Record<MonsterId, MonsterState>;
  tokens: TokenState[]; // haunt-specific board markers
  result: GameResult | null;
}
```

### TurnTimers

```ts
interface TurnTimers {
  turnMs: number; // budget for a connected player's turn
  disconnectedMs: number; // the shorter budget once the active seat has dropped
  removeGraceMs: number; // how long a seat must be gone before votes take effect
}
```

The budgets live in state rather than being read from server config at tick
time, and are recorded in the action log's header alongside the seed. A room
whose config changed under it would otherwise diverge from its own log on
replay.

`turnDeadline` is armed by the first `TICK` of a turn, not when the turn
starts: the engine may not read a clock, so a `TICK` is the only way time
enters it. A drop or a return by the active seat disarms it, and the next tick
re-arms it against whichever budget now applies.

`removeVotes` is public — a show of hands at the table, not a secret ballot.

### Phase

```ts
type Phase =
  | 'lobby' // seats filling, host can start
  | 'setup' // choosing explorers
  | 'explore' // pre-haunt turn loop
  | 'haunt_reveal' // traitor determination + haunt setup
  | 'haunt' // post-haunt turn loop
  | 'game_over';
```

### PlayerState

```ts
interface PlayerState {
  seatId: SeatId;
  name: string;
  charId: CharId | null;
  traits: Record<Trait, number>; // INDEX into the track, not the value
  location: PlacedId | null;
  movesLeft: number;
  cameFrom: PlacedId | null; // enforces the no-backtrack ruling
  items: CardId[];
  omens: CardId[];
  isTraitor: boolean;
  isDead: boolean;
  connected: boolean;
  disconnectedAt: number | null; // ms epoch of the drop; the grace period runs from here
  removed: boolean; // voted out by the table — NOT the same as dead
  hasAttackedThisTurn: boolean;
  flags: Record<string, number | boolean | string>; // haunt scratch space
}
```

`removed` is not `isDead`. A removed explorer stays exactly where it is,
holding what it holds, and is simply no longer in `turnOrder` — an inert body
rather than a corpse. Reconnecting does not undo removal, but it does cancel
every open vote against a seat that has not been removed yet.

`flags` is the pressure valve for haunt-specific per-player bookkeeping ("has
the key", "is cursed", "turns until transformation"). Haunt content declares
which flags it uses; the engine treats them as opaque.

### BoardState

```ts
interface BoardState {
  placed: Record<PlacedId, PlacedTile>;
  index: Record<Floor, Record<string, PlacedId>>; // "x,y" -> PlacedId
}

interface PlacedTile {
  id: PlacedId;
  tileId: TileId;
  floor: Floor;
  x: number;
  y: number;
  rotation: Rotation;
  discoveredBy: SeatId | null;
  flags: Record<string, number | boolean | string>;
}
```

The `index` is denormalised for O(1) adjacency lookups. It is derived data and
must be rebuilt identically during replay — the reducer maintains it, nothing
else writes to it.

### DeckState

```ts
interface DeckState {
  draw: CardId[]; // order matters, index 0 is the top
  discard: CardId[];
  inPlay: CardId[]; // held by players or on the board
}
```

### PendingPrompt

Several rules require a player decision mid-resolution: choosing tile
rotation, assigning damage, picking a target, choosing which item to drop.
Rather than sprinkling continuations through the reducer, the engine sets
`state.pending` and refuses all actions except the one that answers it.

```ts
interface PendingPrompt {
  id: string;
  seatId: SeatId; // who must answer
  kind:
    | 'rotate_tile'
    | 'assign_damage'
    | 'choose_target'
    | 'choose_card'
    | 'choose_room'
    | 'confirm';
  payload: unknown; // narrowed per kind
  deadline: number | null; // ms epoch; server auto-answers past this
  defaultAnswer: unknown; // what the timeout picks
}
```

`deadline` is a plain number and is _set by the server_ and written into the
state, so replay stays deterministic — the engine never reads a clock.

## 4.3 Content schemas

Content files live under `content/` and are validated on load. Failing
validation is a hard startup error with the offending path printed.

### Tile

```ts
const TileSchema = z.object({
  id: z.string(),
  name: z.string(),
  doors: z.object({ n: z.boolean(), e: z.boolean(), s: z.boolean(), w: z.boolean() }),
  floors: z.array(FloorSchema).min(1), // where it may be placed
  symbol: z.enum(['item', 'event', 'omen']).nullable(),
  copies: z.number().int().min(1).default(1),
  staticLinks: z.array(StaticLinkSchema).default([]),
  onEnter: z.array(EffectSchema).default([]),
  rules: z.array(TriggerRuleSchema).default([]),
  art: z.object({ bg: z.string(), icon: z.string().optional() }).optional(),
});
```

`doors` is in the tile's **unrotated** frame. Effective doors are
`rotateDoors(tile.doors, placed.rotation)`.

### Static links

Special connections that ignore adjacency (staircases, elevator, chute):

```ts
type StaticLink =
  | { kind: 'to_tile'; target: TileId; twoWay: boolean }
  | { kind: 'to_floor'; floor: Floor; landing: TileId; twoWay: boolean }
  | { kind: 'oneway_drop'; floor: Floor; effects: Effect[] };
```

Expressing the Grand Staircase, the Stairs from Basement, the Coal Chute, and
the Mystic Elevator as data rather than `if (tileId === ...)` branches in the
movement code is the single highest-leverage decision in the content model.

### Character

```ts
const CharacterSchema = z.object({
  id: z.string(),
  name: z.string(),
  colour: z.enum(['red', 'green', 'blue', 'white', 'purple', 'yellow']),
  tracks: z.object({
    speed: TrackSchema,
    might: TrackSchema,
    sanity: TrackSchema,
    knowledge: TrackSchema,
  }),
  start: z.object({
    speed: Idx,
    might: Idx,
    sanity: Idx,
    knowledge: Idx,
  }),
});

// exactly 8 entries; index 0 is the skull, encoded as null
const TrackSchema = z.array(z.number().nullable()).length(8);
const Idx = z.number().int().min(1).max(7);
```

Two characters share each colour; only one of a colour may be in play.

### Card

```ts
const CardSchema = z.object({
  id: z.string(),
  deck: z.enum(['item', 'event', 'omen']),
  name: z.string(),
  text: z.string(), // flavour/rules text, displayed
  keepInPlay: z.boolean().default(false),
  isWeapon: z.boolean().default(false),
  isCompanion: z.boolean().default(false),
  onDraw: z.array(EffectSchema).default([]),
  onUse: z.array(EffectSchema).default([]),
  rules: z.array(TriggerRuleSchema).default([]),
  needsPrompt: PromptSpecSchema.optional(),
});
```

### Haunt table

```ts
const HauntTableSchema = z.record(
  z.string(), // omen card id
  z.record(z.string(), z.number().int().min(1).max(50)), // tile id -> haunt
);
```

Haunt definitions themselves are documented in
[08-haunt-system.md](08-haunt-system.md).

## 4.4 Derived values, and where they live

Anything computable from `GameState` is a **selector in `engine`**, never a
field in state. In particular:

- current trait _values_ (`track[index]`)
- the movement graph and reachable set
- legal actions for a seat
- whether a win condition is met

Storing these would create two sources of truth and break replay. The one
exception is `BoardState.index`, which is a pure cache of `placed` and is
rebuilt by the same reducer path during replay.

## 4.5 Invariants

Asserted in development builds after every reduction (`engine/src/invariants.ts`):

1. Every `PlayerState.location` refers to an existing `PlacedId`, or is null
   only during `lobby`/`setup` or after death.
2. `board.index` exactly matches the contents of `board.placed`.
3. No two placed tiles share a `(floor, x, y)`.
4. Every `CardId` appears exactly once across `draw`, `discard`, and `inPlay`
   for its deck.
5. All trait indices are integers in `[0, 7]`, **and a living player who has
   chosen an explorer is never on index 0** — index 0 is the skull. A range
   check that the wrong value happens to satisfy is not a check; see D1 in
   [11-progress](11-progress.md#fixed-defects).
6. `activeSeat` is in `turnOrder`, and there is an `activeSeat` during any
   phase that has turns.
   - **6b.** `turnDeadline` is armed only while somebody is actually taking a
     turn. A deadline left armed in the lobby or after game over would expire
     against a seat that is no longer active.
   - **6c.** A removed seat is out of the rotation entirely: never in
     `turnOrder`, never the `activeSeat`.
   - **6d.** Votes refer to real seats; nobody votes twice, and nobody votes to
     remove themselves.
7. If `pending` is set, `pending.seatId` refers to a real seat.

Invariant failures throw in dev and in tests, and are logged-and-reported in
production without crashing the room.
