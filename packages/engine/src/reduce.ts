/**
 * The only mutator. See docs/05-engine.md#51-public-surface.
 *
 * `reduce` returns an error rather than throwing, because illegal actions are
 * routine — a client with a stale snapshot, a double-click — and must not take
 * down a room.
 *
 * M0 implements the lobby and the bare turn loop. Movement, cards, and the
 * haunt arrive in M2-M4; unimplemented actions return UNKNOWN_ACTION so the
 * protocol is stable but nothing pretends to work.
 */

import {
  MAX_PLAYERS,
  MIN_PLAYERS,
  TRAITS,
  type GameAction,
  type GameEvent,
  type GameState,
  type PlayerState,
  type RuleError,
  type RuleErrorCode,
  type SeatId,
} from '@bahoth/shared';
import type { Character, Content } from '@bahoth/content';
import { checkInvariants } from './invariants.js';
import {
  canStart,
  getHostSeat,
  isCharacterTaken,
  nextSeatInOrder,
  takenColours,
} from './selectors.js';
import { shuffle } from './rng.js';

export interface ReduceResult {
  state: GameState;
  events: GameEvent[];
  error?: RuleError;
}

export interface ReduceOptions {
  /** Throw on invariant violations instead of reporting them. Default true in tests. */
  strictInvariants?: boolean;
  onInvariantViolation?: (problems: string[], state: GameState) => void;
}

export function reduce(
  state: GameState,
  action: GameAction,
  content: Content,
  options: ReduceOptions = {},
): ReduceResult {
  const result = dispatch(state, action, content);

  if (result.error) {
    // On rejection the state is returned untouched, byte for byte.
    return { state, events: [], error: result.error };
  }

  const problems = checkInvariants(result.state);
  if (problems.length > 0) {
    options.onInvariantViolation?.(problems, result.state);
    if (options.strictInvariants !== false) {
      return {
        state,
        events: [],
        error: { code: 'INVARIANT_VIOLATION', message: problems.join('; ') },
      };
    }
  }

  return { ...result, state: { ...result.state, version: state.version + 1 } };
}

function fail(code: RuleErrorCode, message: string): ReduceResult {
  return { state: {} as GameState, events: [], error: { code, message } };
}

function dispatch(state: GameState, action: GameAction, content: Content): ReduceResult {
  switch (action.t) {
    case 'JOIN':
      return join(state, action.seat, action.name);
    case 'CHOOSE_CHAR':
      return chooseChar(state, action.seat, action.charId, content);
    case 'START_GAME':
      return startGame(state, action.seat);
    case 'END_TURN':
      return endTurn(state, action.seat);
    case 'DISCONNECT':
      return setConnected(state, action.seat, false);
    case 'RECONNECT':
      return setConnected(state, action.seat, true);
    case 'TICK':
      return tick(state, action.now);
    case 'CONCEDE':
      return concede(state, action.seat);

    // Declared in the protocol, implemented in later milestones.
    case 'MOVE':
    case 'MOVE_THROUGH':
    case 'ROTATE_TILE':
    case 'USE_ITEM':
    case 'TRADE':
    case 'DROP':
    case 'ROOM_ACTION':
    case 'ATTACK':
    case 'ASSIGN_DAMAGE':
    case 'ANSWER':
      return fail(
        'UNKNOWN_ACTION',
        `${action.t} is not implemented until a later milestone`,
      );
  }
}

// --- lobby -----------------------------------------------------------------

/**
 * Trait indices for a chosen character, or all-zero for a seat with none.
 *
 * Index 0 is the skull — the death slot — so an explorer must never sit there
 * while alive. The starting slot is printed on the character card and lives in
 * `character.start` (docs/02-rules-model.md#22-explorers-and-traits).
 */
function startingTraits(character: Character | undefined): PlayerState['traits'] {
  const traits = {} as PlayerState['traits'];
  for (const t of TRAITS) traits[t] = character?.start[t] ?? 0;
  return traits;
}

function makePlayer(seatId: SeatId, name: string): PlayerState {
  const traits = startingTraits(undefined);
  return {
    seatId,
    name,
    charId: null,
    traits,
    location: null,
    movesLeft: 0,
    cameFrom: null,
    items: [],
    omens: [],
    isTraitor: false,
    isDead: false,
    connected: true,
    hasAttackedThisTurn: false,
    flags: {},
  };
}

function join(state: GameState, seat: SeatId, name: string): ReduceResult {
  const existing = state.players[seat];
  if (existing) {
    // Re-joining an existing seat is a reconnect, not an error.
    return setConnected(state, seat, true);
  }
  if (state.phase !== 'lobby') {
    return fail('WRONG_PHASE', 'The game has already started');
  }
  if (Object.keys(state.players).length >= MAX_PLAYERS) {
    return fail('TOO_MANY_PLAYERS', `A game seats at most ${MAX_PLAYERS} players`);
  }

  return {
    state: { ...state, players: { ...state.players, [seat]: makePlayer(seat, name) } },
    events: [{ t: 'joined', seat, name }],
  };
}

function chooseChar(
  state: GameState,
  seat: SeatId,
  charId: string | null,
  content: Content,
): ReduceResult {
  if (state.phase !== 'lobby')
    return fail('WRONG_PHASE', 'Characters are chosen in the lobby');
  const player = state.players[seat];
  if (!player) return fail('UNKNOWN_SEAT', `No such seat: ${seat}`);

  let character: Character | undefined;
  if (charId !== null) {
    character = content.charactersById[charId];
    if (!character) return fail('UNKNOWN_ACTION', `No such character: ${charId}`);
    if (isCharacterTaken(state, charId, seat)) {
      return fail('CHARACTER_TAKEN', `${character.name} is already taken`);
    }
    if (takenColours(state, content, seat).has(character.colour)) {
      return fail(
        'CHARACTER_TAKEN',
        `Another explorer has already claimed ${character.colour}`,
      );
    }
  }

  // Traits are seeded here rather than at START_GAME so that a seat's indices
  // are never out of step with its character — clearing the choice puts them
  // back to zero, and no state where a character is chosen has skull indices.
  return {
    state: {
      ...state,
      players: {
        ...state.players,
        [seat]: { ...player, charId, traits: startingTraits(character) },
      },
    },
    events: [{ t: 'char_chosen', seat, charId }],
  };
}

function startGame(state: GameState, seat: SeatId): ReduceResult {
  if (state.phase !== 'lobby') return fail('WRONG_PHASE', 'The game has already started');
  if (getHostSeat(state) !== seat)
    return fail('NOT_HOST', 'Only the host can start the game');

  const players = Object.values(state.players);
  if (players.length < MIN_PLAYERS) {
    return fail('NOT_ENOUGH_PLAYERS', `Need at least ${MIN_PLAYERS} players`);
  }
  if (!canStart(state)) {
    return fail('CHARACTER_REQUIRED', 'Every player must choose an explorer first');
  }

  const rng = state.rng;
  if (!rng)
    return fail('INVARIANT_VIOLATION', 'Cannot start a game from a redacted state');

  const [turnOrder, nextRng] = shuffle(
    rng,
    players.map((p) => p.seatId),
  );

  // Trait indices are already set from each character's printed starting slot
  // by CHOOSE_CHAR. Real starting positions and the Entrance Hall arrive in M2;
  // until then players have no location, which the invariants allow outside
  // explore/haunt.
  const nextPlayers: Record<SeatId, PlayerState> = {};
  for (const p of players) {
    nextPlayers[p.seatId] = { ...p };
  }

  const first = turnOrder[0] ?? null;
  return {
    state: {
      ...state,
      rng: nextRng,
      // Straight to `explore`: characters are chosen in the lobby, so the
      // `setup` phase has nothing to do. The starting tiles and player
      // placement arrive in M2.
      phase: 'explore',
      players: nextPlayers,
      turnOrder,
      activeSeat: first,
      round: 1,
    },
    events: [
      { t: 'game_started', turnOrder },
      ...(first ? [{ t: 'turn_started', seat: first, round: 1 } as GameEvent] : []),
    ],
  };
}

// --- turn loop -------------------------------------------------------------

function endTurn(state: GameState, seat: SeatId): ReduceResult {
  if (!['explore', 'haunt'].includes(state.phase)) {
    return fail('WRONG_PHASE', `Cannot end a turn during ${state.phase}`);
  }
  if (state.activeSeat !== seat) return fail('NOT_YOUR_TURN', 'It is not your turn');
  if (state.pending) return fail('PROMPT_PENDING', 'Answer the pending prompt first');

  const next = nextSeatInOrder(state, seat);
  if (!next) return fail('INVARIANT_VIOLATION', 'No seat to pass the turn to');

  // A round completes when the turn wraps back to the front of the order.
  const wrapped = state.turnOrder.indexOf(next) <= state.turnOrder.indexOf(seat);
  const round = wrapped ? state.round + 1 : state.round;

  const player = state.players[seat];
  const players = player
    ? {
        ...state.players,
        [seat]: { ...player, hasAttackedThisTurn: false, cameFrom: null },
      }
    : state.players;

  return {
    state: { ...state, players, activeSeat: next, round },
    events: [
      { t: 'turn_ended', seat },
      { t: 'turn_started', seat: next, round },
    ],
  };
}

// --- connection ------------------------------------------------------------

function setConnected(state: GameState, seat: SeatId, connected: boolean): ReduceResult {
  const player = state.players[seat];
  if (!player) return fail('UNKNOWN_SEAT', `No such seat: ${seat}`);
  if (player.connected === connected) {
    return { state, events: [] };
  }

  const next: GameState = {
    ...state,
    players: { ...state.players, [seat]: { ...player, connected } },
  };

  // The host is derived from connection state, so a drop or a return can move
  // it. Nothing is stored; the event exists so the change is visible in the
  // log rather than the Start button quietly appearing on someone else's
  // screen.
  const events: GameEvent[] = [{ t: 'connection_changed', seat, connected }];
  const before = getHostSeat(state);
  const after = getHostSeat(next);
  if (after !== null && after !== before) {
    events.push({
      t: 'log',
      text: `${next.players[after]?.name ?? after} is now the host`,
    });
  }

  return { state: next, events };
}

function concede(state: GameState, seat: SeatId): ReduceResult {
  const player = state.players[seat];
  if (!player) return fail('UNKNOWN_SEAT', `No such seat: ${seat}`);
  if (state.phase === 'game_over') return fail('GAME_OVER', 'The game is already over');

  const remaining = Object.values(state.players).filter(
    (p) => p.seatId !== seat && !p.isDead,
  );
  if (remaining.length === 0) {
    return {
      state: {
        ...state,
        phase: 'game_over',
        result: { outcome: 'abandoned', winners: [], reason: 'Everyone conceded' },
      },
      events: [
        { t: 'log', text: `${player.name} conceded` },
        {
          t: 'game_over',
          result: { outcome: 'abandoned', winners: [], reason: 'Everyone conceded' },
        },
      ],
    };
  }

  const nextActive =
    state.activeSeat === seat ? nextSeatInOrder(state, seat) : state.activeSeat;

  return {
    state: {
      ...state,
      players: { ...state.players, [seat]: { ...player, isDead: true } },
      turnOrder: state.turnOrder.filter((s) => s !== seat),
      activeSeat: nextActive === seat ? (remaining[0]?.seatId ?? null) : nextActive,
    },
    events: [{ t: 'log', text: `${player.name} conceded` }],
  };
}

/**
 * Server-originated clock tick. Resolves expired prompts with their default
 * answer. `now` is carried in the action so the engine never reads a clock and
 * replay stays deterministic (docs/05-engine.md#52-actions).
 */
function tick(state: GameState, now: number): ReduceResult {
  const pending = state.pending;
  if (!pending || pending.deadline === null || now < pending.deadline) {
    return { state, events: [] };
  }
  // M0 has no prompt kinds yet; clearing is the correct default behaviour and
  // the real per-kind defaults land with the prompt system in M2.
  return {
    state: { ...state, pending: null },
    events: [{ t: 'log', text: 'A decision timed out and was resolved automatically' }],
  };
}
