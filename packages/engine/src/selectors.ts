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
  type SeatId,
  type Trait,
} from '@bahoth/shared';
import type { Content } from '@bahoth/content';

/** The host is the first seat in join order; ties never happen. */
export function getHostSeat(state: GameState): SeatId | null {
  const seats = Object.keys(state.players).sort();
  return seats[0] ?? null;
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
  const players = Object.values(state.players);
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

  // A pending prompt blocks everything except the seat that must answer it.
  if (state.pending) {
    return state.pending.seatId === seat
      ? [{ t: 'ANSWER', seat, promptId: state.pending.id, answer: null }]
      : [];
  }

  const actions: GameAction[] = [];

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

  // Skip dead players; if everyone is dead, fall back to the same seat rather
  // than looping forever.
  for (let step = 1; step <= order.length; step++) {
    const candidate = order[(i + step) % order.length];
    if (candidate && !state.players[candidate]?.isDead) return candidate;
  }
  return from;
}
