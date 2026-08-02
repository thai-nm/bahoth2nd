/**
 * The generic `PendingPrompt` lifecycle: the prompt's own clock, the `ANSWER`
 * action, and what happens to a kind nothing raises yet.
 *
 * `rotate_tile` is the only kind that can actually be raised today, so it is
 * the vehicle for most of this — but the assertions are about the generic
 * machinery underneath it, not about discovery, which `discovery.test.ts` and
 * `reduce.test.ts` already cover.
 */

import { describe, expect, it } from 'vitest';
import {
  buildContent,
  fixtureContent,
  type Content,
  type House,
  type Tile,
} from '@bahoth/content';
import {
  PROMPT_KINDS,
  isRotateTilePayload,
  placedIdFor,
  type Doors,
  type GameState,
  type PendingPrompt,
  type PromptKind,
  type Rotation,
} from '@bahoth/shared';
import { reduce } from './reduce.js';
import { startedGame } from './testing.js';
import { getLegalActions } from './selectors.js';
import { checkInvariants } from './invariants.js';
import {
  PROMPT_HANDLERS,
  armPromptDeadline,
  legalAnswersFor,
  promptExpired,
  validateAnswer,
} from './prompts.js';

const T0 = 1_700_000_000_000;

function dtile(id: string, doors: Partial<Doors>, opts: Partial<Tile> = {}): Tile {
  return {
    id,
    name: id,
    doors: { n: false, e: false, s: false, w: false, ...doors },
    floors: ['ground'],
    symbol: null,
    copies: 1,
    staticLinks: [],
    onEnter: [],
    ...opts,
  };
}

const LAND_B = dtile('tile.p_land_b', { n: true }, { floors: ['basement'] });
const LAND_U = dtile('tile.p_land_u', { n: true }, { floors: ['upper'] });
const FILL_B = dtile('tile.p_fill_b', { n: true }, { floors: ['basement'] });
const FILL_U = dtile('tile.p_fill_u', { n: true }, { floors: ['upper'] });

/** One ground room, one ground-legal deck tile: the draw is forced. */
function promptContent(start: Tile, ...deckTiles: Tile[]): Content {
  const tiles = [start, ...deckTiles, LAND_B, LAND_U, FILL_B, FILL_U];
  const house: House = {
    layout: [
      { tileId: start.id, floor: 'ground', x: 0, y: 0, rotation: 0 },
      { tileId: LAND_B.id, floor: 'basement', x: 0, y: 0, rotation: 0 },
      { tileId: LAND_U.id, floor: 'upper', x: 0, y: 0, rotation: 0 },
    ],
    startTile: start.id,
    landings: { basement: LAND_B.id, ground: start.id, upper: LAND_U.id },
  };
  return buildContent(
    { characters: fixtureContent().characters, tiles, house },
    'prompts.test.ts',
  );
}

const START_1DOOR = dtile('tile.p_start', { n: true });
// Adjacent doors, so two distinct rotations put a door back on the entry and
// a prompt is actually raised rather than auto-applied.
const CORNER = dtile('tile.p_corner', { n: true, e: true });

/** A game paused on a raised `rotate_tile` prompt. */
function raised(): { state: GameState; seat: string; content: Content } {
  const c = promptContent(START_1DOOR, CORNER);
  const g = startedGame({ content: c });
  const seat = g.state.activeSeat!;
  const res = reduce(g.state, { t: 'MOVE_THROUGH', seat, dir: 'n' }, c);
  if (res.error) throw new Error(`expected a prompt, got ${res.error.code}`);
  if (!res.state.pending) throw new Error('expected a prompt to be raised');
  return { state: res.state, seat, content: c };
}

// --- the prompt's own clock -------------------------------------------------

describe('prompt deadlines', () => {
  it('is raised unarmed, then armed by the next TICK against timers.promptMs', () => {
    const { state, content } = raised();
    expect(state.pending!.deadline).toBeNull();

    const armed = reduce(state, { t: 'TICK', now: T0 }, content);
    expect(armed.error).toBeUndefined();
    expect(armed.state.pending!.deadline).toBe(T0 + state.timers.promptMs);
  });

  it('does not arm and fire on the same TICK', () => {
    const { state, content } = raised();
    // The prompt survives the tick that armed it, whatever promptMs is — with
    // a budget of 0 an arm-then-test-in-one-pass would resolve it instantly,
    // which reads to a player as a prompt that expired before they saw it.
    const zero: GameState = { ...state, timers: { ...state.timers, promptMs: 0 } };
    const armed = reduce(zero, { t: 'TICK', now: T0 }, content);
    expect(armed.state.pending).not.toBeNull();
    expect(armed.state.pending!.deadline).toBe(T0);

    // The NEXT tick at the same instant does fire it.
    const fired = reduce(armed.state, { t: 'TICK', now: T0 }, content);
    expect(fired.state.pending).toBeNull();
  });

  it('does not re-arm an already-armed prompt', () => {
    const { state, content } = raised();
    const armed = reduce(state, { t: 'TICK', now: T0 }, content);
    const deadline = armed.state.pending!.deadline;

    const later = reduce(armed.state, { t: 'TICK', now: T0 + 1000 }, content);
    expect(later.state.pending!.deadline).toBe(deadline);
  });

  it('resolves on the default answer past the deadline, and the tile lands', () => {
    const { state, seat, content } = raised();
    const armed = reduce(state, { t: 'TICK', now: T0 }, content);
    const def = armed.state.pending!.defaultAnswer as Rotation;

    const fired = reduce(
      armed.state,
      { t: 'TICK', now: armed.state.pending!.deadline! },
      content,
    );
    expect(fired.error).toBeUndefined();
    expect(fired.state.pending).toBeNull();

    // The anti-vanish property, now on the prompt's own clock rather than only
    // the turn clock: the tile came off the deck when the prompt was raised,
    // so a timeout that merely dropped `pending` would lose it.
    const newId = placedIdFor('ground', 0, -1);
    expect(fired.state.board.placed[newId]?.rotation).toBe(def);
    expect(fired.state.players[seat]!.location).toBe(newId);
    expect(checkInvariants(fired.state)).toEqual([]);
  });

  it('times out WITHIN the turn: play resumes and the turn does not end', () => {
    // This is the behaviour the whole item buys. Before the prompt had its own
    // clock, an unanswered prompt could only be resolved by the turn clock
    // expiring — so one unanswered decision cost the seat its entire turn.
    const { state, seat, content } = raised();
    const armed = reduce(state, { t: 'TICK', now: T0 }, content);
    expect(armed.state.turnDeadline).toBe(T0 + armed.state.timers.turnMs);
    expect(armed.state.pending!.deadline!).toBeLessThan(armed.state.turnDeadline!);

    const fired = reduce(
      armed.state,
      { t: 'TICK', now: armed.state.pending!.deadline! },
      content,
    );
    expect(fired.state.pending).toBeNull();
    expect(fired.state.activeSeat).toBe(seat);
    expect(fired.state.turnDeadline).toBe(armed.state.turnDeadline);
    expect(fired.state.players[seat]!.movesLeft).toBeGreaterThanOrEqual(0);
  });

  it('resolves before the deadline is reached only when it has actually passed', () => {
    const { state, content } = raised();
    const armed = reduce(state, { t: 'TICK', now: T0 }, content);
    const justBefore = reduce(
      armed.state,
      { t: 'TICK', now: armed.state.pending!.deadline! - 1 },
      content,
    );
    expect(justBefore.state.pending).not.toBeNull();
  });
});

// --- ANSWER -----------------------------------------------------------------

describe('ANSWER', () => {
  it('places the tile identically to the ROTATE_TILE that means the same thing', () => {
    const { state, seat, content } = raised();
    const payload = state.pending!.payload;
    if (!isRotateTilePayload(payload)) throw new Error('expected a RotateTilePayload');
    const rotation = payload.legalRotations[0]!;

    const viaRotate = reduce(state, { t: 'ROTATE_TILE', seat, rotation }, content);
    const viaAnswer = reduce(
      state,
      { t: 'ANSWER', seat, promptId: state.pending!.id, answer: rotation },
      content,
    );

    expect(viaRotate.error).toBeUndefined();
    expect(viaAnswer.error).toBeUndefined();
    // Two doors, one room: byte-identical results, or the generic path is a
    // second implementation of discovery rather than the same one.
    expect(viaAnswer.state).toEqual(viaRotate.state);
    expect(viaAnswer.events).toEqual(viaRotate.events);
  });

  it('rejects an answer aimed at a prompt that is no longer the pending one', () => {
    const { state, seat, content } = raised();
    const payload = state.pending!.payload;
    if (!isRotateTilePayload(payload)) throw new Error('expected a RotateTilePayload');

    // The whole reason `promptId` is on the action: a client answering the
    // prompt it SAW must not land on the prompt that replaced it in flight.
    const stale = reduce(
      state,
      {
        t: 'ANSWER',
        seat,
        promptId: `${state.pending!.id}_stale`,
        answer: payload.legalRotations[0]!,
      },
      content,
    );
    expect(stale.error?.code).toBe('PROMPT_MISMATCH');
    expect(stale.state).toBe(state);
  });

  it('rejects an answer that is not a legal answer, leaving the prompt standing', () => {
    const { state, seat, content } = raised();
    const payload = state.pending!.payload;
    if (!isRotateTilePayload(payload)) throw new Error('expected a RotateTilePayload');
    const illegal = ([0, 90, 180, 270] as const).find(
      (r) => !payload.legalRotations.includes(r),
    )!;

    const res = reduce(
      state,
      { t: 'ANSWER', seat, promptId: state.pending!.id, answer: illegal },
      content,
    );
    expect(res.error?.code).toBe('ILLEGAL_MOVE');
    expect(res.state).toBe(state);

    // And an answer of the wrong TYPE entirely, which is what `answer:
    // unknown` makes reachable over the wire.
    const nonsense = reduce(
      state,
      { t: 'ANSWER', seat, promptId: state.pending!.id, answer: { rotation: 90 } },
      content,
    );
    expect(nonsense.error?.code).toBe('ILLEGAL_MOVE');
    expect(nonsense.state).toBe(state);
  });

  it('rejects an answer from a seat that does not own the prompt', () => {
    const { state, seat, content } = raised();
    const other = Object.keys(state.players).find((s) => s !== seat)!;
    const payload = state.pending!.payload;
    if (!isRotateTilePayload(payload)) throw new Error('expected a RotateTilePayload');

    const res = reduce(
      state,
      {
        t: 'ANSWER',
        seat: other,
        promptId: state.pending!.id,
        answer: payload.legalRotations[0]!,
      },
      content,
    );
    expect(res.error?.code).toBe('PROMPT_MISMATCH');
    expect(res.state).toBe(state);
  });

  it('rejects an answer when nothing is pending', () => {
    const c = promptContent(START_1DOOR, CORNER);
    const g = startedGame({ content: c });
    const seat = g.state.activeSeat!;
    const res = reduce(
      g.state,
      { t: 'ANSWER', seat, promptId: 'prompt_0', answer: 0 },
      c,
    );
    expect(res.error?.code).toBe('PROMPT_PENDING');
    expect(res.state).toBe(g.state);
  });

  it('ROTATE_TILE is refused against a prompt of another kind', () => {
    const { state, seat, content } = raised();
    const confused: GameState = {
      ...state,
      pending: { ...state.pending!, kind: 'confirm' },
    };
    const res = reduce(confused, { t: 'ROTATE_TILE', seat, rotation: 0 }, content);
    expect(res.error?.code).toBe('PROMPT_MISMATCH');
  });
});

// --- kinds nothing raises yet ------------------------------------------------

describe('prompt kinds that do not exist yet', () => {
  /** A prompt of a kind no code raises, planted directly into state. */
  function planted(state: GameState, kind: PromptKind, seat: string): GameState {
    const pending: PendingPrompt = {
      id: 'prompt_planted',
      seatId: seat,
      kind,
      payload: { anything: true },
      deadline: null,
      defaultAnswer: 'whatever',
    };
    return { ...state, pending };
  }

  const unraised = PROMPT_KINDS.filter((k) => k !== 'rotate_tile');

  it('has a handler for every declared kind', () => {
    // The type system already forces this — `PROMPT_HANDLERS` is a total
    // Record<PromptKind, …>, so a new kind is a compile error. This asserts
    // the runtime consequence anyway: a kind whose handler was somehow missing
    // would throw inside `validateAnswer` rather than refuse an answer.
    for (const kind of PROMPT_KINDS) {
      expect(PROMPT_HANDLERS[kind]).toBeDefined();
    }
  });

  it.each(unraised)('offers no legal action and accepts no answer: %s', (kind) => {
    const { state, seat, content } = raised();
    const s = planted(state, kind, seat);

    expect(getLegalActions(s, seat, content)).toEqual([]);
    const res = reduce(
      s,
      { t: 'ANSWER', seat, promptId: 'prompt_planted', answer: 'whatever' },
      content,
      { strictInvariants: false },
    );
    expect(res.error?.code).toBe('ILLEGAL_MOVE');
  });

  it.each(unraised)('clears rather than wedging the room when it expires: %s', (kind) => {
    const { state, seat, content } = raised();
    const s = planted(state, kind, seat);

    const armed = reduce(s, { t: 'TICK', now: T0 }, content, {
      strictInvariants: false,
    });
    expect(armed.state.pending!.deadline).toBe(T0 + s.timers.promptMs);

    const fired = reduce(
      armed.state,
      { t: 'TICK', now: T0 + s.timers.promptMs },
      content,
      { strictInvariants: false },
    );
    // No resume step exists for these, so clearing is the only coherent
    // outcome — but it must actually happen, or the room is blocked forever
    // by a prompt nobody can answer (D5's shape).
    expect(fired.state.pending).toBeNull();
  });
});

// --- default answers --------------------------------------------------------

describe('resolving on the default', () => {
  it('falls back to a legal answer rather than losing a drawn tile', () => {
    // Invariant 7 says a rotate_tile default is always among its
    // legalRotations, so this state is unreachable through `reduce`. The point
    // is that the timeout path must not be the code that finds that out: for
    // rotate_tile, "the default was not legal, so clear the prompt" means a
    // tile that came off the deck and landed nowhere.
    const { state, seat, content } = raised();
    const corrupted: GameState = {
      ...state,
      pending: { ...state.pending!, defaultAnswer: 'not a rotation' },
    };

    const armed = reduce(corrupted, { t: 'TICK', now: T0 }, content, {
      strictInvariants: false,
    });
    const fired = reduce(
      armed.state,
      { t: 'TICK', now: T0 + corrupted.timers.promptMs },
      content,
      { strictInvariants: false },
    );

    expect(fired.state.pending).toBeNull();
    const newId = placedIdFor('ground', 0, -1);
    expect(fired.state.board.placed[newId]).toBeDefined();
    expect(fired.state.players[seat]!.location).toBe(newId);
  });

  it('a default answer is one the seat could have chosen', () => {
    // The property that makes a timeout defensible: it never does something no
    // player was offered.
    const { state, seat, content } = raised();
    const offered = getLegalActions(state, seat, content)
      .filter((a) => a.t === 'ROTATE_TILE')
      .map((a) => (a as { rotation: Rotation }).rotation);

    expect(offered).toContain(state.pending!.defaultAnswer as Rotation);
    expect(validateAnswer(state.pending!, state.pending!.defaultAnswer)).toBe(true);
  });
});

// --- the pure helpers -------------------------------------------------------

describe('prompts.ts helpers', () => {
  it('armPromptDeadline returns the state by reference when there is nothing to arm', () => {
    const { state, content } = raised();
    const noPrompt: GameState = { ...state, pending: null };
    // By reference, not merely equal: that is what lets `reduce` tell an inert
    // TICK from a live one and decline to log it.
    expect(armPromptDeadline(noPrompt, T0)).toBe(noPrompt);

    const already = armPromptDeadline(state, T0);
    expect(armPromptDeadline(already, T0 + 5000)).toBe(already);
    void content;
  });

  it('promptExpired is false while unarmed, however late it gets', () => {
    const { state } = raised();
    expect(state.pending!.deadline).toBeNull();
    expect(promptExpired(state.pending!, T0 + 10 ** 9)).toBe(false);
  });

  it('legalAnswersFor enumerates rotations and refuses to guess for the rest', () => {
    const { state } = raised();
    const payload = state.pending!.payload;
    if (!isRotateTilePayload(payload)) throw new Error('expected a RotateTilePayload');
    expect(legalAnswersFor(state.pending!)).toEqual(payload.legalRotations);

    // null, not [] — "cannot be enumerated" is a different fact from "there
    // are no choices", and getLegalActions treats them the same only because
    // both must offer nothing.
    expect(legalAnswersFor({ ...state.pending!, kind: 'confirm' })).toBeNull();
  });
});
