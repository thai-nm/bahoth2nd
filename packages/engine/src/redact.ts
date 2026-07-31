/**
 * Hidden-information redaction. See docs/06-networking.md#64-redaction.
 *
 * Two rules hold the line here:
 *
 *   1. Redaction is SUBTRACTIVE ONLY. It never invents or reorders data, so a
 *      redacted state is still a valid GameState with fields cleared, and the
 *      client's rendering code is unaware redaction exists.
 *   2. A test asserts no redacted snapshot contains a card id still in a draw
 *      pile. See redact.test.ts — do not delete it.
 *
 * Deliberately NOT redacted, because the physical game is open information:
 * players' items and omens, all trait values, board layout, discard piles,
 * and omensDrawn.
 */

import { DECK_KINDS, type DeckState, type GameState, type SeatId } from '@bahoth/shared';

/**
 * @param seat the viewer, or null for a spectator with no seat.
 */
export function redactFor(state: GameState, seat: SeatId | null): GameState {
  const decks = {} as GameState['decks'];
  for (const kind of DECK_KINDS) {
    const deck = state.decks[kind];
    const redacted: DeckState = {
      // Card identities in the draw pile are hidden; the count is not, since
      // "18 rooms left" is public information at the table anyway.
      draw: [],
      drawCount: deck.draw.length,
      discard: [...deck.discard],
      inPlay: [...deck.inPlay],
    };
    decks[kind] = redacted;
  }

  // Omit `rng` by destructuring rather than assigning undefined: knowing the
  // seed predicts every future roll, and exactOptionalPropertyTypes means an
  // explicit `undefined` is not the same as an absent key.
  const { rng: _rng, ...rest } = state;
  return {
    ...rest,
    decks,
    haunt: redactHaunt(state, seat),
  };
}

function redactHaunt(state: GameState, seat: SeatId | null): GameState['haunt'] {
  const haunt = state.haunt;
  if (!haunt) return null;
  // Until the reveal completes, the haunt's identity is hidden from everyone.
  // Per-side instruction text is served over a separate authenticated route
  // rather than embedded in the snapshot (M4).
  if (!haunt.revealed) {
    return { ...haunt, hauntId: 0, traitorSeat: null };
  }
  // After the reveal, who the traitor is becomes public — that is the whole
  // point of the reveal — so only the seat's own view needs no special case.
  void seat;
  return { ...haunt };
}

/** True if `state` looks like it has already been redacted. */
export function isRedacted(state: GameState): boolean {
  return state.rng === undefined;
}
