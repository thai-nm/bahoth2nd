/**
 * Event narration for the log panel (docs/07-ui.md#72: "event narration
 * generated from `GameEvent`s").
 *
 * Everything here is pure: a `GameEvent` plus a snapshot-derived context in,
 * one `LogEntry` out. Nothing touches the DOM or the store, so it is testable
 * under vitest's `node` environment like `layout.ts` and `pawns.ts` — see the
 * repo-wide note in vitest.config.ts, and D6 in docs/11-progress.md for why
 * the *component* wiring deliberately stays thin.
 *
 * The context is data rather than a bag of injected lookup functions, because
 * every caller builds it from the same three things the store already holds
 * (state, seats, content) and a test wants to write it down literally.
 */

import type {
  CharId,
  GameEvent,
  GameState,
  PlacedId,
  PlacedTile,
  PublicSeat,
  SeatId,
  TargetRef,
  Trait,
} from '@bahoth/shared';
import type { Content } from '@bahoth/content';

/**
 * Where a line came from. The log interleaves reducer narration with chat
 * (docs/07-ui.md#72), and the two must stay visually distinguishable: a
 * player typing "Ox died" is not the game saying it.
 */
export type LogKind = 'event' | 'chat';

export interface LogEntry {
  id: number;
  kind: LogKind;
  /**
   * The seat this line is *about* (an event) or *from* (a chat message), so
   * the panel can colour it and the local player's own lines can be marked.
   * Null for table-wide narration: the game starting, the haunt roll.
   */
  seat: SeatId | null;
  text: string;
  /** ms epoch. Chat carries the server's; events are stamped on arrival. */
  at: number;
}

export interface NarrationContext {
  /** Seat display names, best effort — falls back to the raw seat id. */
  names: Record<SeatId, string>;
  /** Chosen explorer per seat, for resolving trait indices to printed values. */
  chars: Record<SeatId, CharId | null>;
  /** The board, for resolving a `PlacedId` to the room's name. */
  placed: Record<PlacedId, PlacedTile>;
  content: Content | null;
}

/**
 * Build the context from what the store holds.
 *
 * Names come from `state.players` first and the lobby's `PublicSeat` list
 * second: once a game is running the state is the authority, but events fire
 * in the lobby too, before `state.players` has everyone. Neither source is
 * complete on its own.
 *
 * A note on time: this describes the state *after* the events being narrated,
 * because the server sends `snapshot` before `events` for the same version
 * (`broadcastState` in packages/server/src/gateway.ts). That is the right way
 * round for everything narrated here — a `moved` event's destination room is
 * on the board by then, and a `char_chosen`'s explorer is chosen. It would be
 * the wrong way round for an event that describes something the same
 * reduction then removed; none exists today, and the one to watch for is a
 * future "item destroyed", which would have to carry its own name.
 */
export function contextFrom(
  state: GameState | null,
  seats: PublicSeat[],
  content: Content | null,
): NarrationContext {
  const names: Record<SeatId, string> = {};
  const chars: Record<SeatId, CharId | null> = {};

  for (const seat of seats) {
    names[seat.seatId] = seat.name;
    chars[seat.seatId] = seat.charId;
  }
  for (const [seatId, player] of Object.entries(state?.players ?? {})) {
    names[seatId] = player.name;
    chars[seatId] = player.charId;
  }

  return { names, chars, placed: state?.board.placed ?? {}, content };
}

const TRAIT_NAMES: Record<Trait, string> = {
  speed: 'Speed',
  might: 'Might',
  sanity: 'Sanity',
  knowledge: 'Knowledge',
};

const DECK_NAMES: Record<string, string> = {
  item: 'an Item',
  event: 'an Event',
  omen: 'an Omen',
};

function seatName(ctx: NarrationContext, seat: SeatId): string {
  return ctx.names[seat] ?? seat;
}

/** A room's printed name, from the board plus content; the id if either is missing. */
function roomName(ctx: NarrationContext, id: PlacedId): string {
  const tileId = ctx.placed[id]?.tileId;
  if (tileId === undefined) return id;
  return ctx.content?.tilesById[tileId]?.name ?? tileId;
}

function tileName(ctx: NarrationContext, tileId: string): string {
  return ctx.content?.tilesById[tileId]?.name ?? tileId;
}

function charName(ctx: NarrationContext, charId: CharId): string {
  return ctx.content?.charactersById[charId]?.name ?? charId;
}

function targetName(ctx: NarrationContext, target: TargetRef): string {
  return target.kind === 'seat' ? seatName(ctx, target.seatId) : target.monsterId;
}

/**
 * A trait index rendered as the value printed on the track.
 *
 * Traits are stored as indices into an 8-slot track, and the index is
 * meaningless to a player — "Might 3" is a slot number, not a number of dice.
 * docs/07-ui.md#72 makes the same point about the rail's strips: players
 * reason in printed values. Falls back to the index when the explorer is
 * unknown, which is honest rather than wrong.
 */
function trackValue(
  ctx: NarrationContext,
  seat: SeatId,
  trait: Trait,
  index: number,
): string {
  if (index === 0) return 'the skull';
  const charId = ctx.chars[seat];
  const value = charId ? ctx.content?.charactersById[charId]?.tracks[trait][index] : null;
  return value === null || value === undefined ? String(index) : String(value);
}

/**
 * The seat a line is about, for colouring. Deliberately separate from the
 * text: an event with no single owner (`game_started`, `haunt_roll`) gets
 * null rather than an arbitrary seat.
 */
function seatOf(e: GameEvent): SeatId | null {
  switch (e.t) {
    case 'game_started':
    case 'haunt_roll':
    case 'game_over':
    case 'log':
      return null;
    case 'haunt_begun':
      return e.traitor;
    default:
      return e.seat;
  }
}

/**
 * The narration itself. Exhaustive by construction: the `never` assignment in
 * the default branch makes adding a `GameEvent` variant without narrating it
 * a **compile error**, the same reasoning as `PROMPT_HANDLERS` being a total
 * `Record<PromptKind, …>` (docs/11-progress.md, "the generic half"). The
 * previous version of this function fell through to the bare event name,
 * which is how `moved` and `discovered` each shipped once as debug output.
 */
export function narrate(e: GameEvent, ctx: NarrationContext): string {
  switch (e.t) {
    case 'joined':
      return `${e.name} joined`;

    case 'char_chosen':
      return e.charId
        ? `${seatName(ctx, e.seat)} is ${charName(ctx, e.charId)}`
        : `${seatName(ctx, e.seat)} cleared their choice`;

    case 'game_started':
      return `The game begins. Turn order: ${e.turnOrder
        .map((s) => seatName(ctx, s))
        .join(' → ')}`;

    case 'turn_started':
      return `Round ${e.round} — ${seatName(ctx, e.seat)}'s turn`;

    case 'turn_ended':
      return `${seatName(ctx, e.seat)} ended their turn`;

    case 'moved':
      // `from` is null the first time a player is placed on the board, which
      // is a placement rather than a move and should not read as one.
      return e.from === null
        ? `${seatName(ctx, e.seat)} starts in the ${roomName(ctx, e.to)}`
        : `${seatName(ctx, e.seat)} moved to the ${roomName(ctx, e.to)}`;

    case 'discovered':
      return `${seatName(ctx, e.seat)} discovered the ${tileName(ctx, e.placed.tileId)}`;

    case 'drew_card':
      // Deliberately NOT the card id. The log is read by every seat, and a
      // draw is the drawer's information until they play it; printing the id
      // here would leak through narration what redaction exists to protect.
      // The reveal is its own UI (docs/07-ui.md#74, "Card reveal") in M3.
      return `${seatName(ctx, e.seat)} drew ${DECK_NAMES[e.deck] ?? `a ${e.deck}`} card`;

    case 'rolled':
      // Faces rather than a bare total, because "rolled 3" hides whether that
      // was lucky. The dice *graphics* (docs/07-ui.md#74) are M3's job.
      return `${seatName(ctx, e.seat)} rolled ${e.total} (${e.dice.join(' ')}) for ${e.reason}`;

    case 'trait_changed': {
      const name = seatName(ctx, e.seat);
      const trait = TRAIT_NAMES[e.trait];
      const from = trackValue(ctx, e.seat, e.trait, e.from);
      const to = trackValue(ctx, e.seat, e.trait, e.to);
      const verb = e.to > e.from ? 'rose' : 'fell';
      return `${name}'s ${trait} ${verb} from ${from} to ${to}`;
    }

    case 'haunt_roll':
      return e.triggered
        ? `Haunt roll: ${e.total} against ${e.needed} — the haunt begins`
        : `Haunt roll: ${e.total} against ${e.needed} — the house holds`;

    case 'haunt_begun':
      return e.traitor === null
        ? `The haunt begins: ${e.hauntId}`
        : `The haunt begins: ${e.hauntId}. ${seatName(ctx, e.traitor)} is the traitor`;

    case 'attacked': {
      const name = seatName(ctx, e.seat);
      const target = targetName(ctx, e.target);
      const { attackerTotal, defenderTotal, winner, damage } = e.result;
      const scores = `${attackerTotal} to ${defenderTotal}`;
      if (winner === 'tie') return `${name} attacked ${target} — ${scores}, no effect`;
      const loser = winner === 'attacker' ? target : name;
      return `${name} attacked ${target} — ${scores}, ${loser} takes ${damage}`;
    }

    case 'died':
      return `${seatName(ctx, e.seat)} has died`;

    case 'connection_changed':
      return `${seatName(ctx, e.seat)} ${e.connected ? 'reconnected' : 'disconnected'}`;

    case 'game_over':
      return `Game over — ${e.result.reason}`;

    case 'log':
      return e.text;

    default: {
      // Unreachable while the switch is exhaustive; this line is what makes
      // "exhaustive" a compiler-checked claim rather than a comment.
      const never: never = e;
      return String((never as { t: string }).t);
    }
  }
}

/** One `GameEvent` as a log entry, ready to render. */
export function entryFor(
  e: GameEvent,
  ctx: NarrationContext,
  id: number,
  at: number,
): LogEntry {
  return { id, kind: 'event', seat: seatOf(e), text: narrate(e, ctx), at };
}
