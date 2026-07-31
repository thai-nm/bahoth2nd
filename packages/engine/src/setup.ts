import type { GameState, SeatId } from '@bahoth/shared';
import type { Content } from '@bahoth/content';
import { makeRng } from './rng.js';

export interface CreateStateOptions {
  seed: number;
  content: Content;
}

export function createInitialState({ seed, content }: CreateStateOptions): GameState {
  return {
    version: 0,
    contentHash: content.hash,
    rng: makeRng(seed),
    phase: 'lobby',
    players: {},
    turnOrder: [],
    activeSeat: null,
    round: 0,
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
