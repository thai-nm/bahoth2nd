/**
 * Wire protocol. See docs/06-networking.md.
 *
 * Every frame in both directions is validated against these schemas before it
 * is looked at. An invalid frame closes the socket; a valid frame carrying an
 * illegal *action* gets a polite error and the socket stays open.
 */

import { z } from 'zod';
import type { GameAction } from './actions.js';
import type { GameEvent } from './events.js';
import type { GameState } from './state.js';
import type { RoomCode, SeatId } from './ids.js';

export const WS_PATH = '/ws';
export const MAX_FRAME_BYTES = 64 * 1024;
export const MAX_NAME_LENGTH = 24;
export const MAX_CHAT_LENGTH = 500;

export const MIN_PLAYERS = 3;
export const MAX_PLAYERS = 6;

const TraitSchema = z.enum(['speed', 'might', 'sanity', 'knowledge']);
const DirSchema = z.enum(['n', 'e', 's', 'w']);
const RotationSchema = z.union([
  z.literal(0),
  z.literal(90),
  z.literal(180),
  z.literal(270),
]);

const TargetRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('seat'), seatId: z.string() }),
  z.object({ kind: z.literal('monster'), monsterId: z.string() }),
]);

/**
 * Only client-originatable actions appear here. TICK, DISCONNECT, and
 * RECONNECT are server-originated and are deliberately absent, so a client
 * cannot forge them.
 */
export const GameActionSchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('JOIN'),
    seat: z.string(),
    name: z.string().max(MAX_NAME_LENGTH),
  }),
  z.object({
    t: z.literal('CHOOSE_CHAR'),
    seat: z.string(),
    charId: z.string().nullable(),
  }),
  z.object({ t: z.literal('START_GAME'), seat: z.string() }),
  z.object({ t: z.literal('MOVE'), seat: z.string(), to: z.string() }),
  z.object({ t: z.literal('MOVE_THROUGH'), seat: z.string(), dir: DirSchema }),
  z.object({ t: z.literal('ROTATE_TILE'), seat: z.string(), rotation: RotationSchema }),
  z.object({
    t: z.literal('USE_ITEM'),
    seat: z.string(),
    cardId: z.string(),
    target: TargetRefSchema.optional(),
  }),
  z.object({
    t: z.literal('TRADE'),
    seat: z.string(),
    to: z.string(),
    cardIds: z.array(z.string()).max(32),
  }),
  z.object({
    t: z.literal('DROP'),
    seat: z.string(),
    cardIds: z.array(z.string()).max(32),
  }),
  z.object({ t: z.literal('ROOM_ACTION'), seat: z.string(), actionId: z.string() }),
  z.object({
    t: z.literal('ATTACK'),
    seat: z.string(),
    target: TargetRefSchema,
    trait: TraitSchema,
  }),
  z.object({
    t: z.literal('ASSIGN_DAMAGE'),
    seat: z.string(),
    alloc: z.record(TraitSchema, z.number().int().min(0).max(8)),
  }),
  z.object({ t: z.literal('END_TURN'), seat: z.string() }),
  z.object({
    t: z.literal('ANSWER'),
    seat: z.string(),
    promptId: z.string(),
    answer: z.unknown(),
  }),
  z.object({
    t: z.literal('VOTE_REMOVE'),
    seat: z.string(),
    target: z.string(),
    vote: z.boolean(),
  }),
  z.object({ t: z.literal('CONCEDE'), seat: z.string() }),
]);

export const RoomCodeSchema = z
  .string()
  .length(5)
  .regex(/^[A-Z0-9]+$/);

export const ClientMessageSchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('hello'),
    token: z.string().max(128).optional(),
    name: z.string().min(1).max(MAX_NAME_LENGTH),
    contentHash: z.string().max(128),
  }),
  z.object({ t: z.literal('create') }),
  z.object({ t: z.literal('join'), code: RoomCodeSchema }),
  z.object({ t: z.literal('leave') }),
  z.object({
    t: z.literal('action'),
    seq: z.number().int().min(0),
    action: GameActionSchema,
  }),
  z.object({ t: z.literal('chat'), text: z.string().min(1).max(MAX_CHAT_LENGTH) }),
  z.object({ t: z.literal('ping') }),
]);

export type ClientMessage = z.infer<typeof ClientMessageSchema>;

export type ErrorCode =
  | 'BAD_MESSAGE'
  | 'NO_ROOM'
  | 'ROOM_FULL'
  | 'ROOM_NOT_FOUND'
  | 'GAME_ALREADY_STARTED'
  | 'CONTENT_MISMATCH'
  | 'RATE_LIMITED'
  | 'ILLEGAL_ACTION'
  | 'INTERNAL';

export interface PublicSeat {
  seatId: SeatId;
  name: string;
  connected: boolean;
  charId: string | null;
}

/**
 * Server -> client. Declared as an interface union rather than inferred from
 * zod because GameState is a large structural type that we do not want to
 * re-declare as a schema; the client trusts the server's shape.
 */
export type ServerMessage =
  // seatId/token are null until a room is joined: `hello` only establishes the
  // content hash and remembers the name the client wants to use.
  | { t: 'welcome'; seatId: SeatId | null; token: string | null; contentHash: string }
  | { t: 'room'; code: RoomCode; seats: PublicSeat[]; hostSeatId: SeatId }
  | { t: 'snapshot'; version: number; state: GameState }
  | { t: 'events'; version: number; events: GameEvent[] }
  | { t: 'ack'; seq: number }
  | { t: 'error'; seq?: number; code: ErrorCode; message: string }
  | { t: 'chat'; seatId: SeatId; text: string; at: number }
  | { t: 'pong' }
  | { t: 'left' };

/** One entry of the append-only per-room action log. */
export interface LoggedAction {
  v: number;
  action: GameAction;
  at: number;
}
