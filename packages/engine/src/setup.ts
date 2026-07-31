import type { GameState, SeatId, TurnTimers } from '@bahoth/shared';
import type { Content } from '@bahoth/content';
import { makeRng } from './rng.js';

/**
 * Ten minutes for a player who is here, ninety seconds for one who is not.
 * The long budget exists so nobody loses a turn to a clock they did not know
 * about; the short one exists so a seat that dropped cannot stall the room
 * (docs/06-networking.md#disconnection-behaviour).
 */
export const DEFAULT_TIMERS: TurnTimers = {
  turnMs: 10 * 60 * 1000,
  disconnectedMs: 90 * 1000,
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
    turnDeadline: null,
    board: {
      placed: {},
      index: { basement: {}, ground: {}, upper: {} },
    },
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
