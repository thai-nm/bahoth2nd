/**
 * Structural invariants. See docs/04-data-model.md#45-invariants.
 *
 * Checked after every reduction in dev and in tests. In production the caller
 * logs and reports rather than crashing the room — a wrong board is bad, a
 * dead server mid-game is worse.
 */

import { DECK_KINDS, FLOORS, TRAITS, type GameState } from '@bahoth/shared';

export class InvariantError extends Error {
  constructor(
    message: string,
    readonly state: GameState,
  ) {
    super(`Invariant violated: ${message}`);
    this.name = 'InvariantError';
  }
}

export function checkInvariants(state: GameState): string[] {
  const problems: string[] = [];

  // 1. Locations refer to real tiles, and every living player is on the board
  //    once the board exists. Keyed off board emptiness rather than a phase
  //    list so this stays correct once M2 places the starting tiles.
  const boardExists = Object.keys(state.board.placed).length > 0;
  for (const p of Object.values(state.players)) {
    if (p.location !== null && !state.board.placed[p.location]) {
      problems.push(`player ${p.seatId} is at unknown tile ${p.location}`);
    }
    if (p.location === null && boardExists && !p.isDead) {
      problems.push(`player ${p.seatId} is not on the board during phase ${state.phase}`);
    }
  }

  // 2. The board index exactly matches board.placed.
  let indexed = 0;
  for (const floor of FLOORS) {
    const floorIndex = state.board.index[floor];
    for (const [key, placedId] of Object.entries(floorIndex)) {
      indexed++;
      const tile = state.board.placed[placedId];
      if (!tile) {
        problems.push(`index ${floor}[${key}] points at missing tile ${placedId}`);
        continue;
      }
      if (tile.floor !== floor || `${tile.x},${tile.y}` !== key) {
        problems.push(`index ${floor}[${key}] disagrees with tile ${placedId}`);
      }
    }
  }
  const placedCount = Object.keys(state.board.placed).length;
  if (indexed !== placedCount) {
    problems.push(`index has ${indexed} entries but ${placedCount} tiles are placed`);
  }

  // 3. No two tiles share a cell. (Implied by 2 given the index is keyed by
  //    cell, but checked directly so a bad index cannot mask a real overlap.)
  const cells = new Set<string>();
  for (const tile of Object.values(state.board.placed)) {
    const key = `${tile.floor}:${tile.x},${tile.y}`;
    if (cells.has(key)) problems.push(`two tiles occupy ${key}`);
    cells.add(key);
  }

  // 4. Every card appears exactly once across draw / discard / inPlay.
  for (const kind of DECK_KINDS) {
    const deck = state.decks[kind];
    const all = [...deck.draw, ...deck.discard, ...deck.inPlay];
    const seen = new Set<string>();
    for (const id of all) {
      if (seen.has(id)) problems.push(`card ${id} appears twice in the ${kind} deck`);
      seen.add(id);
    }
  }

  // 5. Trait indices are integers in [0, 7], and a living explorer is never on
  //    index 0 — that slot is the skull. Range alone is not enough: all-zero
  //    traits are in range and mean every explorer is nominally dead.
  for (const p of Object.values(state.players)) {
    for (const trait of TRAITS) {
      const v = p.traits[trait];
      if (!Number.isInteger(v) || v < 0 || v > 7) {
        problems.push(
          `player ${p.seatId} has ${trait} index ${v}, expected an integer in [0,7]`,
        );
        continue;
      }
      if (v === 0 && p.charId !== null && !p.isDead) {
        problems.push(`living player ${p.seatId} has ${trait} on the skull (index 0)`);
      }
    }
  }

  // 6. Turn order is coherent.
  for (const seatId of state.turnOrder) {
    if (!state.players[seatId])
      problems.push(`turnOrder references unknown seat ${seatId}`);
  }
  if (new Set(state.turnOrder).size !== state.turnOrder.length) {
    problems.push('turnOrder contains duplicates');
  }
  if (state.activeSeat !== null && !state.turnOrder.includes(state.activeSeat)) {
    problems.push(`activeSeat ${state.activeSeat} is not in turnOrder`);
  }
  if (state.activeSeat === null && ['explore', 'haunt'].includes(state.phase)) {
    problems.push(`no activeSeat during phase ${state.phase}`);
  }

  // 6b. A turn clock only runs while somebody is taking a turn. A deadline
  //     left armed in the lobby or after game over would expire against a
  //     seat that is no longer active.
  if (
    state.turnDeadline !== null &&
    (state.activeSeat === null || !['explore', 'haunt'].includes(state.phase))
  ) {
    problems.push(`turnDeadline is armed during phase ${state.phase}`);
  }

  // 7. A pending prompt targets a real seat.
  if (state.pending && !state.players[state.pending.seatId]) {
    problems.push(`pending prompt targets unknown seat ${state.pending.seatId}`);
  }

  return problems;
}

export function assertInvariants(state: GameState): void {
  const problems = checkInvariants(state);
  if (problems.length > 0) {
    throw new InvariantError(problems.join('; '), state);
  }
}
