/**
 * Pure derivation of pawns from game state (docs/07-ui.md#72-game-layout,
 * #77-client-state-and-data-flow: "no component holds derived game state in
 * local useState"). `Game.tsx` calls this on every render; nothing here
 * touches the DOM, so it is testable under vitest's `node` environment with
 * no jsdom and no testing-library — see the repo-wide note in
 * vitest.config.ts.
 */

import type { BoardState, Floor, GameState, PlacedId, SeatId } from '@bahoth/shared';
import type { Content } from '@bahoth/content';
import type { Pawn } from './Board.js';

/**
 * One pawn per living, placed explorer, plus which floor it is on.
 *
 * - A player with `location === null` (never placed, e.g. still in the
 *   lobby) has no pawn.
 * - A `location` pointing at a tile absent from `board.placed` is skipped
 *   rather than thrown on: a redacted or stale snapshot can legitimately
 *   describe a location the client hasn't been told about yet, and a corpse
 *   in the render loop is worse than a missing pawn.
 * - `isDead` players are skipped — a corpse is not on the board
 *   (docs/02-rules-model.md#29). `removed` players are NOT skipped: a
 *   removed explorer explicitly "stays exactly where it is ... an inert
 *   body rather than a corpse" (docs/04-data-model.md, `PlayerState`).
 *   Swapping these two checks is exactly the kind of thing the D-series
 *   defects are made of, so keep them as two separate, named conditions
 *   rather than folding them into one guard.
 * - `colour` comes from the character, not the player: a seat with no
 *   character chosen, or an unrecognised `charId` (again, a stale/redacted
 *   snapshot), is skipped — there is no honest colour to draw it in.
 * - Order is deterministic: `state.turnOrder` first (the order players
 *   actually act in), then any player somehow not in it, so the pawn fan in
 *   a shared room is stable between renders instead of following
 *   `Object.values`' insertion order.
 */
export function pawnsFromState(
  state: GameState,
  content: Content,
  mySeat: SeatId | null,
): { byFloor: Record<Floor, Pawn[]>; all: Pawn[] } {
  const byFloor: Record<Floor, Pawn[]> = { basement: [], ground: [], upper: [] };
  const all: Pawn[] = [];

  const orderedSeats: SeatId[] = [...state.turnOrder];
  for (const seatId of Object.keys(state.players)) {
    if (!orderedSeats.includes(seatId)) orderedSeats.push(seatId);
  }

  for (const seatId of orderedSeats) {
    const player = state.players[seatId];
    if (!player) continue;
    if (player.isDead) continue; // a corpse is not on the board.
    if (player.location === null) continue;

    const placed = state.board.placed[player.location];
    if (!placed) continue; // location points at a tile this snapshot doesn't have.

    const character = player.charId ? content.charactersById[player.charId] : null;
    if (!character) continue; // no character chosen, or an id this content bundle lacks.

    const initial = pawnInitial(character.name, player.name);

    const pawn: Pawn = {
      placedId: placed.id,
      colour: character.colour,
      initial,
      isMe: seatId === mySeat,
    };
    byFloor[placed.floor].push(pawn);
    all.push(pawn);
  }

  return { byFloor, all };
}

/**
 * A leading article carries no identity, so it is dropped before taking the
 * initial. Found by looking at the real screen rather than at a test: every
 * placeholder explorer is named "The <something>", so taking the raw first
 * letter drew three pawns all reading "T", distinguishable only by colour —
 * which is precisely the job the letter was there to do. Real content
 * ("Ox Bellows") is unaffected either way, so this is not placeholder-only
 * scaffolding: it is the rule that happens to be right for both.
 *
 * Falls back to the player's own name if stripping leaves nothing.
 */
export function pawnInitial(characterName: string, playerName: string): string {
  const stripped = characterName.replace(/^(the|a|an)\s+/i, '').trim();
  const source = stripped || characterName.trim() || playerName.trim();
  return (source[0] ?? '?').toUpperCase();
}

/** The floor a placed tile sits on, or null if it is not on the board. */
export function floorOf(board: BoardState, placedId: PlacedId | null): Floor | null {
  if (placedId === null) return null;
  return board.placed[placedId]?.floor ?? null;
}
