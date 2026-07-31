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

export type PromptKind =
  | 'rotate_tile'
  | 'assign_damage'
  | 'choose_target'
  | 'choose_card'
  | 'choose_room'
  | 'confirm';

export interface PendingPrompt {
  id: string;
  seatId: SeatId;
  kind: PromptKind;
  payload: unknown;
  /** ms epoch, written by the server so the engine never reads a clock. */
  deadline: number | null;
  defaultAnswer: unknown;
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
  board: BoardState;
  decks: Record<DeckKind, DeckState>;
  omensDrawn: number;
  haunt: HauntState | null;
  pending: PendingPrompt | null;
  monsters: Record<MonsterId, MonsterState>;
  tokens: TokenState[];
  result: GameResult | null;
}
