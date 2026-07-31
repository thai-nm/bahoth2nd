/**
 * The scripted-game helper. See docs/10-testing-and-ops.md#the-scripted-game-helper.
 *
 * Because reduce is pure and the RNG lives in state, a test is just a seed and
 * a list of actions. A rules regression test is then two lines, and a bug
 * report's action log IS a test case.
 *
 * Shipped in src (not test/) so the server can reuse `replay` for crash
 * recovery — the recovery path and the test path are then the same code.
 */

import type { GameAction, GameEvent, GameState, RuleError } from '@bahoth/shared';
import type { Content } from '@bahoth/content';
import { fixtureContent } from '@bahoth/content';
import { reduce, type ReduceOptions } from './reduce.js';
import { createInitialState, makeSeatId } from './setup.js';

export interface PlayGameOptions {
  seed?: number;
  content?: Content;
  /** Convenience: JOINs these names as seat_0..seat_N before running `actions`. */
  players?: string[];
  actions?: GameAction[];
  reduceOptions?: ReduceOptions;
}

export interface PlayGameResult {
  state: GameState;
  events: GameEvent[];
  /** Errors are collected rather than thrown, so a test can assert on them. */
  errors: { action: GameAction; error: RuleError }[];
  content: Content;
  seats: string[];
  /** Every accepted action, in order — the same shape as the server's log. */
  accepted: GameAction[];
}

export function playGame(options: PlayGameOptions = {}): PlayGameResult {
  const content = options.content ?? fixtureContent();
  const seed = options.seed ?? 1;
  const names = options.players ?? [];

  const seats = names.map((_, i) => makeSeatId(i));
  const joins: GameAction[] = names.map((name, i) => ({
    t: 'JOIN',
    seat: makeSeatId(i),
    name,
  }));

  const script = [...joins, ...(options.actions ?? [])];

  let state = createInitialState({ seed, content });
  const events: GameEvent[] = [];
  const errors: PlayGameResult['errors'] = [];
  const accepted: GameAction[] = [];

  for (const action of script) {
    const result = reduce(state, action, content, options.reduceOptions);
    if (result.error) {
      errors.push({ action, error: result.error });
      continue;
    }
    state = result.state;
    events.push(...result.events);
    accepted.push(action);
  }

  return { state, events, errors, content, seats, accepted };
}

/**
 * Replay an action log from a fresh initial state. Used by tests and by the
 * server's crash recovery — if these ever diverge, replay is broken.
 */
export function replay(
  actions: GameAction[],
  options: { seed: number; content: Content; reduceOptions?: ReduceOptions },
): { state: GameState; errors: { action: GameAction; error: RuleError }[] } {
  let state = createInitialState({ seed: options.seed, content: options.content });
  const errors: { action: GameAction; error: RuleError }[] = [];
  for (const action of actions) {
    const result = reduce(state, action, options.content, options.reduceOptions);
    if (result.error) {
      errors.push({ action, error: result.error });
      continue;
    }
    state = result.state;
  }
  return { state, errors };
}

/** Convenience for the common "3 players, game started" starting point. */
export function startedGame(overrides: PlayGameOptions = {}): PlayGameResult {
  const players = overrides.players ?? ['Ana', 'Ben', 'Cal'];
  const content = overrides.content ?? fixtureContent();

  // One character per COLOUR — two characters sharing a colour cannot both be
  // in play, so naively taking the first N would deadlock the lobby.
  const seenColours = new Set<string>();
  const charIds: string[] = [];
  for (const c of content.characters) {
    if (seenColours.has(c.colour)) continue;
    seenColours.add(c.colour);
    charIds.push(c.id);
    if (charIds.length === players.length) break;
  }

  return playGame({
    ...overrides,
    players,
    content,
    actions: [
      ...players.map((_, i) => ({
        t: 'CHOOSE_CHAR' as const,
        seat: makeSeatId(i),
        charId: charIds[i] ?? null,
      })),
      { t: 'START_GAME', seat: makeSeatId(0) },
      ...(overrides.actions ?? []),
    ],
  });
}
