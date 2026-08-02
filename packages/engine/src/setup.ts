import type { GameState, SeatId, TurnTimers } from '@bahoth/shared';
import type { Content } from '@bahoth/content';
import { makeRng } from './rng.js';

/**
 * Ten minutes for a player who is here, ninety seconds for one who is not.
 * The long budget exists so nobody loses a turn to a clock they did not know
 * about; the short one exists so a seat that dropped cannot stall the room
 * (docs/06-networking.md#disconnection-behaviour).
 *
 * A prompt gets a minute — far less than a turn, because it blocks every seat
 * at the table rather than only the one spending it.
 */
export const DEFAULT_TIMERS: TurnTimers = {
  turnMs: 10 * 60 * 1000,
  disconnectedMs: 90 * 1000,
  promptMs: 60 * 1000,
  removeGraceMs: 10 * 60 * 1000,
};

export interface CreateStateOptions {
  seed: number;
  content: Content;
  timers?: TurnTimers;
}

export function createInitialState({
  seed,
  content,
  timers = DEFAULT_TIMERS,
}: CreateStateOptions): GameState {
  return {
    version: 0,
    contentHash: content.hash,
    rng: makeRng(seed),
    phase: 'lobby',
    players: {},
    turnOrder: [],
    activeSeat: null,
    round: 0,
    timers,
    removeVotes: {},
    turnDeadline: null,
    board: {
      placed: {},
      index: { basement: {}, ground: {}, upper: {} },
    },
    // Built at START_GAME, not here — same reason the board is: content
    // could not be shuffled before the game exists, and nothing reads it in
    // the lobby.
    tileDeck: [],
    decks: {
      item: { draw: [], discard: [], inPlay: [] },
      event: { draw: [], discard: [], inPlay: [] },
      omen: { draw: [], discard: [], inPlay: [] },
    },
    omensDrawn: 0,
    haunt: null,
    pending: null,
    monsters: {},
    tokens: [],
    result: null,
  };
}

export function makeSeatId(index: number): SeatId {
  return `seat_${index}`;
}
