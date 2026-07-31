/**
 * The three property tests from docs/10-testing-and-ops.md#property-tests-worth-having.
 *
 * Driven by our own seeded RNG rather than fast-check: the properties are
 * identical, there is no extra dependency, and a failure is reproducible from
 * the seed printed in the assertion message. Swap in fast-check later if
 * shrinking becomes worth the dep.
 */

import { describe, expect, it } from 'vitest';
import { fixtureContent } from '@bahoth/content';
import { reduce } from './reduce.js';
import { createInitialState } from './setup.js';
import { checkInvariants } from './invariants.js';
import { getLegalActions } from './selectors.js';
import { makeRng, nextInt } from './rng.js';
import type { GameAction, GameState, RngState } from '@bahoth/shared';

const content = fixtureContent();

interface Walk {
  state: GameState;
  log: GameAction[];
}

/**
 * Walk the game by repeatedly picking a uniformly random legal action from a
 * random seat. Seats are joined first so the walk has somewhere to start.
 */
function randomWalk(seed: number, steps: number): Walk {
  let rng: RngState = makeRng(seed ^ 0x5eed);
  let state = createInitialState({ seed, content });
  const log: GameAction[] = [];

  const names = ['Ana', 'Ben', 'Cal', 'Dot', 'Eli', 'Fay'];
  const [playerCount, r0] = nextInt(rng, 4); // 0..3 -> 3..6 players
  rng = r0;
  for (let i = 0; i < playerCount + 3; i++) {
    const action: GameAction = { t: 'JOIN', seat: `seat_${i}`, name: names[i]! };
    const res = reduce(state, action, content);
    if (!res.error) {
      state = res.state;
      log.push(action);
    }
  }

  for (let step = 0; step < steps; step++) {
    const seats = Object.keys(state.players);
    if (seats.length === 0) break;

    const [si, r1] = nextInt(rng, seats.length);
    rng = r1;
    const seat = seats[si]!;

    const legal = getLegalActions(state, seat, content);
    if (legal.length === 0) continue;

    const [ai, r2] = nextInt(rng, legal.length);
    rng = r2;
    const action = legal[ai]!;

    const res = reduce(state, action, content);
    if (res.error) {
      // A legal action must never be rejected. That is itself a bug.
      throw new Error(
        `seed ${seed} step ${step}: getLegalActions offered ${action.t} but reduce rejected it (${res.error.code}: ${res.error.message})`,
      );
    }
    state = res.state;
    log.push(action);

    const problems = checkInvariants(state);
    if (problems.length > 0) {
      throw new Error(
        `seed ${seed} step ${step} after ${action.t}: ${problems.join('; ')}`,
      );
    }
  }

  return { state, log };
}

describe('property: invariants always hold', () => {
  it('survives 500 random legal actions across many seeds', () => {
    for (let seed = 1; seed <= 25; seed++) {
      expect(() => randomWalk(seed, 500)).not.toThrow();
    }
  });
});

describe('property: illegal actions never change state', () => {
  it('leaves the state structurally identical on rejection', () => {
    // A grab-bag of actions that are wrong in different ways: wrong phase,
    // wrong seat, unimplemented, unknown seat.
    const candidates = (state: GameState): GameAction[] => {
      const seats = Object.keys(state.players);
      const out: GameAction[] = [
        { t: 'START_GAME', seat: 'seat_0' },
        { t: 'START_GAME', seat: 'nobody' },
        { t: 'END_TURN', seat: 'nobody' },
        { t: 'MOVE', seat: seats[0] ?? 'seat_0', to: 'nowhere' },
        {
          t: 'ATTACK',
          seat: seats[0] ?? 'seat_0',
          target: { kind: 'seat', seatId: 'x' },
          trait: 'might',
        },
        { t: 'CHOOSE_CHAR', seat: seats[0] ?? 'seat_0', charId: 'char.does_not_exist' },
      ];
      for (const s of seats) out.push({ t: 'END_TURN', seat: s });
      return out;
    };

    for (let seed = 1; seed <= 20; seed++) {
      const { state } = randomWalk(seed, 60);
      for (const action of candidates(state)) {
        const before = JSON.stringify(state);
        const res = reduce(state, action, content);
        if (res.error) {
          expect(JSON.stringify(res.state), `seed ${seed}, action ${action.t}`).toBe(
            before,
          );
          expect(res.events).toEqual([]);
          expect(res.state.version).toBe(state.version);
        }
      }
    }
  });
});

describe('property: replay is exact', () => {
  it('reproduces the final state byte-for-byte from the action log', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const { state, log } = randomWalk(seed, 300);

      let replayed = createInitialState({ seed, content });
      for (const action of log) {
        const res = reduce(replayed, action, content);
        expect(res.error, `seed ${seed}: replaying ${action.t} failed`).toBeUndefined();
        replayed = res.state;
      }

      expect(JSON.stringify(replayed), `seed ${seed}`).toBe(JSON.stringify(state));
    }
  });
});
