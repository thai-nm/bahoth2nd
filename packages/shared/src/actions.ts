/**
 * The complete vocabulary of things that can change the game.
 * See docs/05-engine.md#52-actions.
 *
 * M0 implements only the lobby/turn subset; the rest are declared here so the
 * protocol schema and the reducer's exhaustiveness checks are stable from the
 * start. Unimplemented actions are rejected with UNKNOWN_ACTION.
 */

import type { CardId, CharId, Dir, PlacedId, Rotation, SeatId, Trait } from './ids.js';

export type TargetRef =
  { kind: 'seat'; seatId: SeatId } | { kind: 'monster'; monsterId: string };

export type GameAction =
  // lobby / setup
  | { t: 'JOIN'; seat: SeatId; name: string }
  | { t: 'CHOOSE_CHAR'; seat: SeatId; charId: CharId | null }
  | { t: 'START_GAME'; seat: SeatId }
  // turn loop
  | { t: 'MOVE'; seat: SeatId; to: PlacedId }
  | { t: 'MOVE_THROUGH'; seat: SeatId; dir: Dir }
  | { t: 'ROTATE_TILE'; seat: SeatId; rotation: Rotation }
  // `| undefined` is deliberate: zod's inferred optionals include it, and
  // under exactOptionalPropertyTypes an absent key and an explicit undefined
  // are different types. This is what actually arrives on the wire.
  | { t: 'USE_ITEM'; seat: SeatId; cardId: CardId; target?: TargetRef | undefined }
  | { t: 'TRADE'; seat: SeatId; to: SeatId; cardIds: CardId[] }
  | { t: 'DROP'; seat: SeatId; cardIds: CardId[] }
  | { t: 'ROOM_ACTION'; seat: SeatId; actionId: string }
  | { t: 'ATTACK'; seat: SeatId; target: TargetRef; trait: Trait }
  | { t: 'ASSIGN_DAMAGE'; seat: SeatId; alloc: Partial<Record<Trait, number>> }
  | { t: 'END_TURN'; seat: SeatId }
  /** Vote for, or withdraw a vote for, removing a seat that has gone away. */
  | { t: 'VOTE_REMOVE'; seat: SeatId; target: SeatId; vote: boolean }
  // generic prompt answer
  | { t: 'ANSWER'; seat: SeatId; promptId: string; answer: unknown }
  // server-originated
  | { t: 'TICK'; now: number }
  // `at` is the ms epoch of the drop: the engine cannot read a clock, and the
  // removal grace period has to be measured from somewhere. Optional because
  // an action log written before it existed has none — the next TICK starts
  // the clock in that case rather than leaving the seat unremovable.
  | { t: 'DISCONNECT'; seat: SeatId; at?: number | undefined }
  | { t: 'RECONNECT'; seat: SeatId }
  | { t: 'CONCEDE'; seat: SeatId };

export type ActionType = GameAction['t'];

/** Narrow a GameAction by its tag. */
export type ActionOf<T extends ActionType> = Extract<GameAction, { t: T }>;

export type RuleErrorCode =
  | 'NOT_YOUR_TURN'
  | 'WRONG_PHASE'
  | 'UNKNOWN_SEAT'
  | 'UNKNOWN_ACTION'
  | 'PROMPT_PENDING'
  | 'PROMPT_MISMATCH'
  | 'ILLEGAL_MOVE'
  | 'NOT_ENOUGH_PLAYERS'
  | 'TOO_MANY_PLAYERS'
  | 'CHARACTER_TAKEN'
  | 'CHARACTER_REQUIRED'
  | 'NOT_HOST'
  | 'GAME_OVER'
  | 'INVARIANT_VIOLATION';

export interface RuleError {
  code: RuleErrorCode;
  message: string;
}
