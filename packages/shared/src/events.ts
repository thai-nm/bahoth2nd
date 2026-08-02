/**
 * The reducer's narration. See docs/05-engine.md#53-events.
 *
 * Events drive the text log, animations, and sound. They are NOT state: a
 * client that misses them still renders the board correctly from the next
 * snapshot. They exist because a snapshot diff loses the *reason* a thing
 * happened, and the reason is exactly what the log needs.
 */

import type { GameResult, PlacedTile } from './state.js';
import type {
  CardId,
  CharId,
  DeckKind,
  HauntId,
  PlacedId,
  SeatId,
  Trait,
} from './ids.js';
import type { TargetRef } from './actions.js';

export interface AttackResult {
  attackerTotal: number;
  defenderTotal: number;
  winner: 'attacker' | 'defender' | 'tie';
  damage: number;
}

export type GameEvent =
  | { t: 'joined'; seat: SeatId; name: string }
  | { t: 'char_chosen'; seat: SeatId; charId: CharId | null }
  | { t: 'game_started'; turnOrder: SeatId[] }
  | { t: 'turn_started'; seat: SeatId; round: number }
  | { t: 'turn_ended'; seat: SeatId }
  | { t: 'moved'; seat: SeatId; from: PlacedId | null; to: PlacedId }
  | { t: 'discovered'; seat: SeatId; placed: PlacedTile }
  | { t: 'drew_card'; seat: SeatId; deck: DeckKind; cardId: CardId }
  | { t: 'rolled'; seat: SeatId; dice: number[]; total: number; reason: string }
  | { t: 'trait_changed'; seat: SeatId; trait: Trait; from: number; to: number }
  | { t: 'haunt_roll'; total: number; needed: number; triggered: boolean }
  | { t: 'haunt_begun'; hauntId: HauntId; traitor: SeatId | null }
  | { t: 'attacked'; seat: SeatId; target: TargetRef; result: AttackResult }
  | { t: 'died'; seat: SeatId }
  | { t: 'connection_changed'; seat: SeatId; connected: boolean }
  | { t: 'game_over'; result: GameResult }
  | { t: 'log'; text: string };

export type EventType = GameEvent['t'];

/**
 * Every event type, at runtime.
 *
 * The union above is type-only, so nothing can iterate it — and "the log
 * narrates every event" is precisely the kind of claim a test must be able to
 * iterate rather than take on trust. The two assertions below make this list
 * and the union check each other in **both** directions at compile time: a
 * variant added to the union and not to the list fails the first, and a typo
 * in the list fails the second. A one-directional check would let the list
 * quietly fall behind, which is the failure the list exists to prevent.
 */
export const EVENT_TYPES = [
  'joined',
  'char_chosen',
  'game_started',
  'turn_started',
  'turn_ended',
  'moved',
  'discovered',
  'drew_card',
  'rolled',
  'trait_changed',
  'haunt_roll',
  'haunt_begun',
  'attacked',
  'died',
  'connection_changed',
  'game_over',
  'log',
] as const;

/** Errors with the offending member's name when `T` is not `never`. */
type AssertNever<T extends never> = T;

// Every union member appears in the list…
export type _AllEventTypesListed = AssertNever<
  Exclude<EventType, (typeof EVENT_TYPES)[number]>
>;
// …and every list entry is a real union member (catches a typo in the list,
// which would otherwise satisfy the check above while narrating nothing).
const _eventTypesAreReal: readonly EventType[] = EVENT_TYPES;
void _eventTypesAreReal;
