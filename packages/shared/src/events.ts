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
