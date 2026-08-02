/**
 * The authoritative game state. See docs/04-data-model.md#42-game-state.
 *
 * GameState must remain plain JSON: no class instances, no Map, no Set, no
 * Date. That single constraint is what makes snapshots, the action log,
 * replay, and crash recovery all fall out for free.
 */

import type {
  CardId,
  CharId,
  DeckKind,
  Dir,
  Floor,
  HauntId,
  MonsterId,
  PlacedId,
  Rotation,
  SeatId,
  TileId,
  Trait,
} from './ids.js';

export type Phase =
  'lobby' | 'setup' | 'explore' | 'haunt_reveal' | 'haunt' | 'game_over';

/** Deterministic PRNG state, carried inside GameState. See docs/05-engine.md#54. */
export interface RngState {
  seed: number;
  counter: number;
}

/**
 * Turn clock budgets, fixed when the room is created and carried in state.
 *
 * They live here rather than being read from server config at tick time so
 * that replaying an action log reproduces the same deadlines — a room whose
 * timers changed under it would diverge from its own log. The log header
 * records them alongside the seed.
 */
export interface TurnTimers {
  /** Budget for a connected player's turn. */
  turnMs: number;
  /** The shorter budget once the active seat has dropped. */
  disconnectedMs: number;
  /**
   * How long a seat gets to answer a `PendingPrompt` before it resolves on its
   * own `defaultAnswer`. Much shorter than `turnMs`, because a prompt blocks
   * the whole table rather than just its owner
   * (docs/06-networking.md#disconnection-behaviour).
   */
  promptMs: number;
  /**
   * How long a seat must be gone before the table's votes to remove it take
   * effect. Long, because coming back from a dead laptop should be possible
   * (docs/06-networking.md#disconnection-behaviour).
   */
  removeGraceMs: number;
}

export type FlagValue = number | boolean | string;
export type Flags = Record<string, FlagValue>;

export interface PlayerState {
  seatId: SeatId;
  name: string;
  charId: CharId | null;
  /**
   * INDEX into the character's 8-slot trait track, never the printed value.
   * See docs/02-rules-model.md#22-explorers-and-traits.
   */
  traits: Record<Trait, number>;
  location: PlacedId | null;
  movesLeft: number;
  cameFrom: PlacedId | null;
  items: CardId[];
  omens: CardId[];
  isTraitor: boolean;
  isDead: boolean;
  connected: boolean;
  /** ms epoch of the drop, or null while connected. Written by the server. */
  disconnectedAt: number | null;
  /**
   * Voted out by the table after being gone too long. Not the same as dead:
   * the explorer stays on the board as an inert body holding its items, it is
   * simply no longer taking turns.
   */
  removed: boolean;
  hasAttackedThisTurn: boolean;
  flags: Flags;
}

export interface PlacedTile {
  id: PlacedId;
  tileId: TileId;
  floor: Floor;
  x: number;
  y: number;
  rotation: Rotation;
  discoveredBy: SeatId | null;
  flags: Flags;
}

export interface BoardState {
  placed: Record<PlacedId, PlacedTile>;
  /** Denormalised `"x,y" -> PlacedId` lookup. Derived; only the reducer writes it. */
  index: Record<Floor, Record<string, PlacedId>>;
}

export interface DeckState {
  /** Order matters; index 0 is the top of the deck. Redacted for clients. */
  draw: CardId[];
  discard: CardId[];
  inPlay: CardId[];
  /** Present only on redacted states, where `draw` has been emptied. */
  drawCount?: number;
}

/**
 * Every kind of decision the engine can suspend on. Declared as a value so
 * both the engine's handler table and its tests can iterate the full set —
 * a kind that exists in the type but that nothing has taught the prompt
 * machinery about is exactly the gap this list closes.
 */
export const PROMPT_KINDS = [
  'rotate_tile',
  'assign_damage',
  'choose_target',
  'choose_card',
  'choose_room',
  'confirm',
] as const;

export type PromptKind = (typeof PROMPT_KINDS)[number];

export interface PendingPrompt {
  id: string;
  seatId: SeatId;
  kind: PromptKind;
  payload: unknown;
  /**
   * ms epoch after which the prompt resolves on `defaultAnswer`, or null while
   * the clock is not armed yet.
   *
   * Armed by the first `TICK` after the prompt is raised, exactly as
   * `turnDeadline` is: the engine may not read a clock, so `now` has to arrive
   * in an action, and arriving in an action is also what makes a replayed log
   * reproduce the same deadline. docs/04-data-model.md calls this "set by the
   * server", which is true of where `now` comes from and not of who writes the
   * field — the reducer is still the only mutator.
   */
  deadline: number | null;
  defaultAnswer: unknown;
}

/**
 * `PendingPrompt.payload` when `kind === 'rotate_tile'`. Carries everything
 * needed to finish the discovery, because the prompt IS the resume point
 * (docs/05-engine.md#56: "keep that resume state small and explicit").
 */
export interface RotateTilePayload {
  /** The tile already drawn off the deck — it is committed, not re-drawable. */
  tileId: TileId;
  /** Where it will land. */
  floor: Floor;
  x: number;
  y: number;
  /** The room being left, and the direction moved out of it. */
  from: PlacedId;
  dir: Dir;
  /** Rotations that put a door on the edge facing `from`. Never empty. */
  legalRotations: Rotation[];
}

/**
 * Narrows `PendingPrompt.payload` without either side importing engine
 * internals: shared owns the shape, invariants.ts and the client both need
 * to check it, and neither should have to import from `@bahoth/engine`.
 */
export function isRotateTilePayload(p: unknown): p is RotateTilePayload {
  if (typeof p !== 'object' || p === null) return false;
  const r = p as Record<string, unknown>;
  return (
    typeof r.tileId === 'string' &&
    typeof r.floor === 'string' &&
    typeof r.x === 'number' &&
    typeof r.y === 'number' &&
    typeof r.from === 'string' &&
    typeof r.dir === 'string' &&
    Array.isArray(r.legalRotations) &&
    r.legalRotations.length > 0
  );
}

export interface MonsterState {
  id: MonsterId;
  def: string;
  location: PlacedId | null;
  isDead: boolean;
  flags: Flags;
}

export interface TokenState {
  id: string;
  token: string;
  location: PlacedId | null;
  flags: Flags;
}

export interface HauntState {
  hauntId: HauntId;
  traitorSeat: SeatId | null;
  revealed: boolean;
  /** Seats that have acknowledged their private instructions. */
  acknowledged: SeatId[];
}

export type GameOutcome = 'heroes' | 'traitor' | 'draw' | 'abandoned';

export interface GameResult {
  outcome: GameOutcome;
  winners: SeatId[];
  reason: string;
}

export interface GameState {
  version: number;
  contentHash: string;
  /** Removed by redactFor: knowing the seed predicts every future roll. */
  rng?: RngState;
  phase: Phase;
  players: Record<SeatId, PlayerState>;
  turnOrder: SeatId[];
  activeSeat: SeatId | null;
  round: number;
  timers: TurnTimers;
  /**
   * Open votes to remove an absent seat, as target -> the seats voting for it.
   * Public: this is a show of hands at the table, not a secret ballot.
   */
  removeVotes: Record<SeatId, SeatId[]>;
  /**
   * ms epoch at which the active seat's turn expires, or null when no turn
   * clock is running. Armed by the first `TICK` of a turn — the engine never
   * reads a clock, so it cannot set this until a `TICK` tells it the time.
   */
  turnDeadline: number | null;
  board: BoardState;
  /**
   * The room tiles left to discover, index 0 is the top. Shuffled from
   * `content.deckTiles` at START_GAME with the in-state RNG. Redacted for
   * clients (docs/06-networking.md#64: "Tile deck order — same treatment").
   */
  tileDeck: TileId[];
  /** Present only on redacted states, where `tileDeck` has been emptied. */
  tileDeckCount?: number;
  decks: Record<DeckKind, DeckState>;
  omensDrawn: number;
  haunt: HauntState | null;
  pending: PendingPrompt | null;
  monsters: Record<MonsterId, MonsterState>;
  tokens: TokenState[];
  result: GameResult | null;
}
