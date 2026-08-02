/**
 * The `PendingPrompt` lifecycle, generically: raising one, arming its clock,
 * deciding whether an answer is a legal answer, and enumerating the answers a
 * seat may give. See docs/04-data-model.md#pendingprompt and
 * docs/05-engine.md#55, which names this file.
 *
 * What is deliberately NOT here is *resumption*. Answering a prompt re-enters
 * the reducer pipeline at the step that suspended (docs/05-engine.md#56), and
 * that pipeline is `reduce.ts`. Splitting resumption out would buy a circular
 * import and nothing else. So: this file decides whether an answer is
 * acceptable, `reduce.ts` decides what happens next.
 *
 * The rule that keeps the two halves honest is that a prompt is only ever
 * validated in one place. `ANSWER`, `ROTATE_TILE`, and a timed-out prompt
 * resolving on its `defaultAnswer` all pass through `validateAnswer` — a
 * default answer that no player could have chosen is a bug that only ever
 * shows up on a clock nobody is watching.
 */

import {
  isRotateTilePayload,
  type GameState,
  type PendingPrompt,
  type PromptKind,
  type Rotation,
  type SeatId,
} from '@bahoth/shared';

/**
 * Everything the generic machinery needs to know about one kind of prompt.
 *
 * `legalAnswers` returning `null` means "this kind's answers cannot be
 * enumerated" — a free-form answer, not an empty set of choices. The
 * distinction matters to `getLegalActions`, which must offer nothing rather
 * than offer an action `reduce` would then reject (docs/05-engine.md#57).
 */
export interface PromptHandler {
  /** Whether `answer` is one this prompt would accept. */
  validate(payload: unknown, answer: unknown): boolean;
  /** The answers a seat may give, or null when they cannot be enumerated. */
  legalAnswers(payload: unknown): unknown[] | null;
}

/**
 * A kind that nothing raises yet. Its validator refuses everything, which is
 * the safe direction: an unraisable kind that somehow appears in state gets
 * cleared by the timeout path rather than accepting an arbitrary answer into
 * a resume step that does not exist.
 *
 * These land properly with the code that raises them — a validator written
 * now, against a payload shape nobody has designed, would be a check that
 * cannot fail and therefore is not a check (D1's family).
 */
const unraised: PromptHandler = {
  validate: () => false,
  legalAnswers: () => null,
};

/**
 * Typed as a total `Record<PromptKind, …>` on purpose: adding a kind to
 * `PromptKind` in `shared` without deciding how it validates is then a
 * compile error, rather than a prompt that silently accepts nothing and times
 * out into a branch nobody wrote.
 */
export const PROMPT_HANDLERS: Record<PromptKind, PromptHandler> = {
  rotate_tile: {
    validate(payload, answer) {
      if (!isRotateTilePayload(payload)) return false;
      return (
        typeof answer === 'number' && payload.legalRotations.includes(answer as Rotation)
      );
    },
    legalAnswers(payload) {
      if (!isRotateTilePayload(payload)) return [];
      return [...payload.legalRotations];
    },
  },
  assign_damage: unraised, // M3, with combat
  choose_target: unraised, // M3, with the effect interpreter
  choose_card: unraised, // M3, with the decks
  choose_room: unraised, // M3, with the effect interpreter
  confirm: unraised, // M4, with the haunt
};

/** Whether `answer` is one this prompt would accept. */
export function validateAnswer(prompt: PendingPrompt, answer: unknown): boolean {
  return PROMPT_HANDLERS[prompt.kind].validate(prompt.payload, answer);
}

/** The answers this prompt may be given, or null when they are not enumerable. */
export function legalAnswersFor(prompt: PendingPrompt): unknown[] | null {
  return PROMPT_HANDLERS[prompt.kind].legalAnswers(prompt.payload);
}

/**
 * Build a prompt. The id is derived from the state's version rather than
 * minted from a counter or a random source, so a replayed log produces the
 * same ids — a client that answers `promptId` has to be talking about the same
 * prompt after recovery as before it.
 *
 * `deadline` starts null: the engine may not read a clock, so the prompt's own
 * clock is armed by the next `TICK` (see `armPromptDeadline`).
 */
export function raisePrompt(
  state: GameState,
  prompt: {
    seatId: SeatId;
    kind: PromptKind;
    payload: unknown;
    defaultAnswer: unknown;
  },
): PendingPrompt {
  return {
    id: `prompt_${state.version}`,
    seatId: prompt.seatId,
    kind: prompt.kind,
    payload: prompt.payload,
    deadline: null,
    defaultAnswer: prompt.defaultAnswer,
  };
}

/**
 * Arm an unarmed prompt clock, returning the state unchanged (by reference)
 * when there is nothing to arm.
 *
 * Same shape as the turn clock: armed by the first `TICK` after the prompt is
 * raised rather than when it is raised, because raising happens inside an
 * action that carries no `now`. Returning by reference is what lets `reduce`
 * tell an inert `TICK` from a live one and decline to log it.
 */
export function armPromptDeadline(state: GameState, now: number): GameState {
  const pending = state.pending;
  if (!pending || pending.deadline !== null) return state;
  return { ...state, pending: { ...pending, deadline: now + state.timers.promptMs } };
}

/** Whether this prompt's own clock has run out. */
export function promptExpired(prompt: PendingPrompt, now: number): boolean {
  return prompt.deadline !== null && now >= prompt.deadline;
}
