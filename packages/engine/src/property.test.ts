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
  /** Whether a `rotate_tile` prompt was ever raised during the walk. */
  sawRotatePrompt: boolean;
}

/** Fixed epoch for the walk's fake clock. Any value; it only has to advance. */
const WALK_T0 = 1_700_000_000_000;

/**
 * Walk the game by repeatedly picking a uniformly random legal action from a
 * random seat. Seats are joined first so the walk has somewhere to start.
 *
 * One in four steps issues a SERVER-originated action instead — disconnect,
 * reconnect, or a tick on a fake clock that only ever moves forward. Those
 * never appear in getLegalActions (a client cannot forge them), so without
 * this the walk could never reach a disconnected seat, an expired turn, or a
 * removal vote, and the invariant checker would never see any of it.
 */
function randomWalk(seed: number, steps: number): Walk {
  let rng: RngState = makeRng(seed ^ 0x5eed);
  let state = createInitialState({ seed, content });
  const log: GameAction[] = [];
  let clock = WALK_T0;
  let sawRotatePrompt = false;

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

    // The clock advances by 0-4 minutes a step, so both turn expiry (90s /
    // 10min) and the removal grace period (10min) are reachable.
    const [jump, rc] = nextInt(rng, 240);
    rng = rc;
    clock += jump * 1000;

    let action: GameAction;
    const [roll, r2] = nextInt(rng, 4);
    rng = r2;
    const fromLegal = roll !== 0;
    if (roll === 0) {
      const [kind, r3] = nextInt(rng, 3);
      rng = r3;
      action =
        kind === 0
          ? { t: 'TICK', now: clock }
          : kind === 1
            ? { t: 'DISCONNECT', seat, at: clock }
            : { t: 'RECONNECT', seat };
    } else {
      const legal = getLegalActions(state, seat, content);
      if (legal.length === 0) continue;
      const [ai, r3] = nextInt(rng, legal.length);
      rng = r3;
      action = legal[ai]!;
    }

    const res = reduce(state, action, content);
    if (res.error) {
      // A legal action must never be rejected. That is itself a bug. Server
      // actions are not offered by getLegalActions, so they are not held to
      // this — though in practice none of them can fail either.
      if (!fromLegal) continue;
      throw new Error(
        `seed ${seed} step ${step}: getLegalActions offered ${action.t} but reduce rejected it (${res.error.code}: ${res.error.message})`,
      );
    }
    state = res.state;
    log.push(action);
    if (state.pending?.kind === 'rotate_tile') sawRotatePrompt = true;

    const problems = checkInvariants(state);
    if (problems.length > 0) {
      throw new Error(
        `seed ${seed} step ${step} after ${action.t}: ${problems.join('; ')}`,
      );
    }
  }

  return { state, log, sawRotatePrompt };
}

describe('property: invariants always hold', () => {
  it('survives 500 random legal actions across many seeds', () => {
    for (let seed = 1; seed <= 25; seed++) {
      expect(() => randomWalk(seed, 500)).not.toThrow();
    }
  });

  it('actually reaches the states it claims to cover', () => {
    // A walk that never disconnects anyone would pass every assertion above
    // while testing none of the disconnect, turn-clock, or removal machinery.
    // This asserts the generator's reach, so that coverage cannot quietly
    // disappear when the walk or the legality rules change.
    let disconnected = 0;
    let armedClock = 0;
    let votes = 0;
    let removals = 0;
    // M2: at least one walk must reach a discovery (a placed tile that was
    // not part of the starting layout) and at least one must raise a
    // rotate_tile prompt — MOVE_THROUGH/ROTATE_TILE are now offered by
    // getLegalActions, and this is the same reach-check discipline applied
    // to them.
    let discovered = 0;
    let rotatePrompted = 0;
    const startingTileIds = new Set(content.house.layout.map((t) => t.tileId));

    for (let seed = 1; seed <= 25; seed++) {
      const { state, log, sawRotatePrompt } = randomWalk(seed, 500);
      if (Object.values(state.players).some((p) => !p.connected)) disconnected++;
      if (state.turnDeadline !== null) armedClock++;
      if (log.some((a) => a.t === 'VOTE_REMOVE')) votes++;
      if (Object.values(state.players).some((p) => p.removed)) removals++;
      if (Object.values(state.board.placed).some((t) => !startingTileIds.has(t.tileId))) {
        discovered++;
      }
      if (sawRotatePrompt) rotatePrompted++;
    }

    expect(disconnected, 'no walk produced a disconnected seat').toBeGreaterThan(0);
    expect(armedClock, 'no walk armed the turn clock').toBeGreaterThan(0);
    expect(votes, 'no walk cast a removal vote').toBeGreaterThan(0);
    expect(removals, 'no walk carried a removal through').toBeGreaterThan(0);
    expect(discovered, 'no walk placed a tile it did not start with').toBeGreaterThan(0);
    expect(rotatePrompted, 'no walk raised a rotate_tile prompt').toBeGreaterThan(0);
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
