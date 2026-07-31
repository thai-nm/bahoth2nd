/**
 * Read-only selectors, safe to import from the client.
 * See docs/05-engine.md#57-legality-and-how-the-client-uses-it.
 *
 * getLegalActions is the ONLY source of truth for what a seat may do. The
 * client uses it to enable controls; the server uses it to reject everything
 * else. Never write a second, client-side "can I do this?" check.
 */

import {
  MAX_PLAYERS,
  MIN_PLAYERS,
  type CharId,
  type GameAction,
  type GameState,
  type PlayerState,
  type SeatId,
  type Trait,
} from '@bahoth/shared';
import type { Content } from '@bahoth/content';

/**
 * Seat ids are `seat_<n>` assigned in join order, so ordering by that number
 * IS join order. Compared numerically rather than lexically so the ordering
 * does not silently invert at seat_10 if MAX_PLAYERS ever grows.
 */
function compareSeats(a: SeatId, b: SeatId): number {
  const na = Number(a.slice(a.lastIndexOf('_') + 1));
  const nb = Number(b.slice(b.lastIndexOf('_') + 1));
  if (Number.isNaN(na) || Number.isNaN(nb)) return a < b ? -1 : a > b ? 1 : 0;
  return na - nb;
}

/**
 * The host is the earliest-joined seat that is currently connected, falling
 * back to the earliest-joined seat when nobody is. Without the connection
 * check a host who drops takes the lobby with them: nobody else can start.
 *
 * [06-networking](../../../docs/06-networking.md#disconnection-behaviour) says
 * "longest-connected", which would need a clock the engine is not allowed to
 * read. Earliest-joined-among-connected is the deterministic stand-in, and it
 * behaves better anyway — the role returns to the original host when they come
 * back rather than drifting to whoever has been online longest since.
 */
export function getHostSeat(state: GameState): SeatId | null {
  const seats = Object.keys(state.players)
    .filter((s) => !state.players[s]?.removed)
    .sort(compareSeats);
  return seats.find((s) => state.players[s]?.connected) ?? seats[0] ?? null;
}

/** Seats still taking part: everyone the table has not voted out. */
export function activePlayers(state: GameState): PlayerState[] {
  return Object.values(state.players).filter((p) => !p.removed);
}

export function traitValue(
  state: GameState,
  seat: SeatId,
  trait: Trait,
  content: Content,
): number {
  const player = state.players[seat];
  if (!player?.charId) return 0;
  const character = content.charactersById[player.charId];
  if (!character) return 0;
  const value = character.tracks[trait][player.traits[trait]];
  return value ?? 0;
}

export function isCharacterTaken(
  state: GameState,
  charId: CharId,
  exceptSeat?: SeatId,
): boolean {
  return Object.values(state.players).some(
    (p) => p.charId === charId && p.seatId !== exceptSeat,
  );
}

/** Characters whose colour is already claimed by another seat. */
export function takenColours(
  state: GameState,
  content: Content,
  exceptSeat?: SeatId,
): Set<string> {
  const colours = new Set<string>();
  for (const p of Object.values(state.players)) {
    if (p.seatId === exceptSeat || !p.charId) continue;
    const c = content.charactersById[p.charId];
    if (c) colours.add(c.colour);
  }
  return colours;
}

export function canStart(state: GameState): boolean {
  // A seat voted out in the lobby does not hold the game up.
  const players = activePlayers(state);
  return (
    state.phase === 'lobby' &&
    players.length >= MIN_PLAYERS &&
    players.length <= MAX_PLAYERS &&
    players.every((p) => p.charId !== null)
  );
}

export function getLegalActions(
  state: GameState,
  seat: SeatId,
  content: Content,
): GameAction[] {
  const player = state.players[seat];
  if (!player) return [];
  // A seat the table has voted out is a spectator with a body on the board.
  if (player.removed) return [];

  // A pending prompt blocks everything except the seat that must answer it.
  if (state.pending) {
    return state.pending.seatId === seat
      ? [{ t: 'ANSWER', seat, promptId: state.pending.id, answer: null }]
      : [];
  }

  const actions: GameAction[] = [];

  // Voting on an absent seat is available in every live phase, including the
  // lobby, where a seat that never comes back would otherwise block the start.
  // The vote is clock-free; the grace period is enforced when it resolves.
  if (state.phase !== 'game_over') {
    for (const other of Object.values(state.players)) {
      if (other.seatId === seat || other.connected || other.removed) continue;
      const voted = state.removeVotes[other.seatId]?.includes(seat) ?? false;
      actions.push({ t: 'VOTE_REMOVE', seat, target: other.seatId, vote: !voted });
    }
  }

  switch (state.phase) {
    case 'lobby': {
      const claimed = takenColours(state, content, seat);
      for (const c of content.characters) {
        if (isCharacterTaken(state, c.id, seat)) continue;
        if (claimed.has(c.colour)) continue;
        actions.push({ t: 'CHOOSE_CHAR', seat, charId: c.id });
      }
      if (player.charId) actions.push({ t: 'CHOOSE_CHAR', seat, charId: null });
      if (canStart(state) && getHostSeat(state) === seat) {
        actions.push({ t: 'START_GAME', seat });
      }
      break;
    }

    case 'explore':
    case 'haunt': {
      if (state.activeSeat === seat && !player.isDead) {
        actions.push({ t: 'END_TURN', seat });
      }
      break;
    }

    case 'setup':
    case 'haunt_reveal':
    case 'game_over':
      break;
  }

  return actions;
}

/**
 * Structural equality on actions, used to check membership in getLegalActions.
 * Actions are small flat JSON objects, so a stable stringify is sufficient and
 * far clearer than a hand-written comparator per action type.
 */
export function isLegalAction(
  state: GameState,
  action: GameAction,
  content: Content,
): boolean {
  if (!('seat' in action)) return false;
  const legal = getLegalActions(state, action.seat, content);
  return legal.some((a) => sameAction(a, action));
}

function sameAction(a: GameAction, b: GameAction): boolean {
  if (a.t !== b.t) return false;
  // ANSWER carries an opaque payload that legality cannot enumerate; matching
  // on the prompt id is the meaningful check.
  if (a.t === 'ANSWER' && b.t === 'ANSWER') return a.promptId === b.promptId;
  return JSON.stringify(a) === JSON.stringify(b);
}

export function nextSeatInOrder(state: GameState, from: SeatId): SeatId | null {
  const order = state.turnOrder;
  if (order.length === 0) return null;
  const i = order.indexOf(from);
  if (i === -1) return order[0] ?? null;

  // Skip dead and removed players; if nobody is left, fall back to the same
  // seat rather than looping forever.
  for (let step = 1; step <= order.length; step++) {
    const candidate = order[(i + step) % order.length];
    const p = candidate ? state.players[candidate] : undefined;
    if (candidate && p && !p.isDead && !p.removed) return candidate;
  }
  return from;
}
