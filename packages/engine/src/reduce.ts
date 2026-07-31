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
  activePlayers,
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

  // Accepted but inert: a TICK with nothing due, a RECONNECT for a seat that
  // never dropped. Bumping the version would make nothing look like something
  // — the server logs, broadcasts, and refreshes room activity on every
  // accepted action, so a periodic TICK would keep an idle room alive forever
  // and grow its log without bound.
  if (result.state === state) {
    return { state, events: result.events };
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
    case 'VOTE_REMOVE':
      return voteRemove(state, action.seat, action.target, action.vote);
    case 'DISCONNECT':
      return setConnected(state, action.seat, false, action.at);
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
    disconnectedAt: null,
    removed: false,
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

  const players = activePlayers(state);
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
  const nextPlayers: Record<SeatId, PlayerState> = { ...state.players };
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
      // Unarmed: the engine cannot read a clock, so the first TICK of the turn
      // sets the deadline.
      turnDeadline: null,
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
    // The clock is disarmed, not re-armed: the next TICK arms it with the
    // budget that suits whoever is now active.
    state: { ...state, players, activeSeat: next, round, turnDeadline: null },
    events: [
      { t: 'turn_ended', seat },
      { t: 'turn_started', seat: next, round },
    ],
  };
}

// --- connection ------------------------------------------------------------

function setConnected(
  state: GameState,
  seat: SeatId,
  connected: boolean,
  at?: number,
): ReduceResult {
  const player = state.players[seat];
  if (!player) return fail('UNKNOWN_SEAT', `No such seat: ${seat}`);
  if (player.connected === connected) {
    return { state, events: [] };
  }

  // Coming back cancels every vote against you outright. Half a vote left
  // standing from an outage an hour ago should not help remove you later.
  const removeVotes = { ...state.removeVotes };
  if (connected) delete removeVotes[seat];

  const next: GameState = {
    ...state,
    removeVotes,
    players: {
      ...state.players,
      [seat]: { ...player, connected, disconnectedAt: connected ? null : (at ?? null) },
    },
    // The active seat's connection state chooses which budget applies, so a
    // drop or return mid-turn disarms the clock and the next TICK re-arms it
    // with the right one. Dropping shortens the turn to 90s; coming back
    // restores the full budget.
    turnDeadline: state.activeSeat === seat ? null : state.turnDeadline,
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

/**
 * Cast or withdraw a vote to remove an absent seat.
 *
 * Voting is deliberately clock-free so legality stays pure: the table may vote
 * the moment somebody drops, but the vote only *takes effect* once the grace
 * period has passed, which `tick` decides. See `resolveRemovals`.
 */
function voteRemove(
  state: GameState,
  seat: SeatId,
  target: SeatId,
  vote: boolean,
): ReduceResult {
  if (state.phase === 'game_over') return fail('GAME_OVER', 'The game is already over');

  const voter = state.players[seat];
  if (!voter) return fail('UNKNOWN_SEAT', `No such seat: ${seat}`);
  const victim = state.players[target];
  if (!victim) return fail('UNKNOWN_SEAT', `No such seat: ${target}`);

  if (seat === target) return fail('ILLEGAL_MOVE', 'You cannot vote to remove yourself');
  if (voter.removed) return fail('ILLEGAL_MOVE', 'A removed seat does not vote');
  if (victim.removed) return fail('ILLEGAL_MOVE', `${victim.name} is already removed`);
  if (victim.connected) {
    return fail('ILLEGAL_MOVE', `${victim.name} is still here`);
  }

  const current = state.removeVotes[target] ?? [];
  const has = current.includes(seat);
  if (has === vote) return { state, events: [] };

  const nextVoters = vote ? [...current, seat].sort() : current.filter((s) => s !== seat);
  const removeVotes = { ...state.removeVotes };
  if (nextVoters.length === 0) delete removeVotes[target];
  else removeVotes[target] = nextVoters;

  return {
    state: { ...state, removeVotes },
    events: [
      {
        t: 'log',
        text: vote
          ? `${voter.name} voted to remove ${victim.name} (${nextVoters.length}/${votesNeeded(state, target)})`
          : `${voter.name} withdrew their vote to remove ${victim.name}`,
      },
    ],
  };
}

/** Seats entitled to vote on removing `target`: present, playing, not the target. */
function eligibleVoters(state: GameState, target: SeatId): SeatId[] {
  return Object.values(state.players)
    .filter((p) => p.seatId !== target && p.connected && !p.removed && !p.isDead)
    .map((p) => p.seatId);
}

/** A strict majority of those entitled to vote. */
function votesNeeded(state: GameState, target: SeatId): number {
  return Math.floor(eligibleVoters(state, target).length / 2) + 1;
}

/**
 * Apply any removal whose votes have carried AND whose grace period has run
 * out. Both conditions are checked here, at tick time, rather than when the
 * vote is cast — the engine has no clock of its own, and the grace period is
 * the whole point of the feature.
 */
function resolveRemovals(state: GameState, now: number): ReduceResult {
  let next = state;
  const events: GameEvent[] = [];

  for (const target of Object.keys(state.removeVotes)) {
    const victim = next.players[target];
    const voters = (next.removeVotes[target] ?? []).filter((s) => {
      const v = next.players[s];
      return v?.connected === true && !v.removed && !v.isDead;
    });

    if (!victim || victim.removed || victim.connected) continue;
    if (victim.disconnectedAt === null) continue;
    if (now - victim.disconnectedAt < next.timers.removeGraceMs) continue;
    if (voters.length < votesNeeded(next, target)) continue;

    const removeVotes = { ...next.removeVotes };
    delete removeVotes[target];

    // nextSeatInOrder needs a seat still in the order to walk from, so the
    // successor is chosen before the removal is applied — but against `next`,
    // not `state`. A tick that carries two removals at once has already marked
    // the first one, and walking the original order would hand the turn to a
    // seat this same tick removed.
    const wasActive = next.activeSeat === target;
    const following = wasActive ? nextSeatInOrder(next, target) : null;

    // The explorer stays exactly where it is, holding what it holds. It simply
    // stops taking turns (docs/06-networking.md#disconnection-behaviour).
    next = {
      ...next,
      removeVotes,
      players: { ...next.players, [target]: { ...victim, removed: true } },
      turnOrder: next.turnOrder.filter((s) => s !== target),
    };

    if (wasActive) {
      next = {
        ...next,
        activeSeat:
          following === null || following === target
            ? (next.turnOrder[0] ?? null)
            : following,
        turnDeadline: null,
      };
    }

    events.push({
      t: 'log',
      text: `${victim.name} was removed by vote after leaving the game`,
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

/** Whether a turn clock should be running at all. */
function turnClockRuns(state: GameState): boolean {
  return (
    (state.phase === 'explore' || state.phase === 'haunt') && state.activeSeat !== null
  );
}

/**
 * How long the active seat gets. A seat that has dropped gets the short budget
 * — the game does not pause for an absent player
 * (docs/06-networking.md#disconnection-behaviour).
 */
function turnBudget(state: GameState): number {
  const active = state.activeSeat === null ? undefined : state.players[state.activeSeat];
  return active?.connected === false ? state.timers.disconnectedMs : state.timers.turnMs;
}

/**
 * Server-originated clock tick: the engine's only knowledge of time.
 *
 * `now` is carried in the action rather than read from a clock, so the engine
 * stays pure and a replayed log reproduces the same deadlines
 * (docs/05-engine.md#52-actions). A TICK does three things, in order:
 *
 *   1. resolves a prompt whose own deadline has passed;
 *   2. arms the turn clock if it is not running yet — this is why the first
 *      TICK of a turn changes state even though nothing has expired;
 *   3. ends the turn if the turn clock has expired.
 *
 * A TICK with nothing to do returns the state unchanged, by reference, so the
 * server neither logs it nor counts it as room activity.
 */
function tick(state: GameState, now: number): ReduceResult {
  let next = state;
  const events: GameEvent[] = [];

  // A seat that dropped before `at` was recorded (an action log written by an
  // older build) gets its clock started here rather than becoming unremovable.
  for (const p of Object.values(next.players)) {
    if (!p.connected && p.disconnectedAt === null) {
      next = {
        ...next,
        players: { ...next.players, [p.seatId]: { ...p, disconnectedAt: now } },
      };
    }
  }

  const removals = resolveRemovals(next, now);
  next = removals.state;
  events.push(...removals.events);

  const pending = next.pending;
  if (pending && pending.deadline !== null && now >= pending.deadline) {
    // M2 gives each prompt kind a real default answer; until prompts exist,
    // clearing is the whole behaviour.
    next = { ...next, pending: null };
    events.push({
      t: 'log',
      text: 'A decision timed out and was resolved automatically',
    });
  }

  if (!turnClockRuns(next)) {
    // Disarm a clock left over from a phase that no longer has turns.
    if (next.turnDeadline !== null) next = { ...next, turnDeadline: null };
    return { state: next, events };
  }

  if (next.turnDeadline === null) {
    return { state: { ...next, turnDeadline: now + turnBudget(next) }, events };
  }

  if (now < next.turnDeadline) {
    return { state: next, events };
  }

  // Expired. Clear any prompt still blocking the turn — an unanswered prompt
  // must not be able to hold the room open past the deadline — and pass play on.
  const seat = next.activeSeat!;
  if (next.pending) next = { ...next, pending: null };

  const ended = endTurn(next, seat);
  if (ended.error) {
    // Nothing legal to do; disarm rather than spin on an expired deadline.
    return { state: { ...next, turnDeadline: null }, events };
  }

  return {
    state: ended.state,
    events: [
      ...events,
      { t: 'log', text: `${next.players[seat]?.name ?? seat} ran out of time` },
      ...ended.events,
    ],
  };
}
