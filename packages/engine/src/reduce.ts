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
  OPPOSITE,
  TRAITS,
  cellKey,
  isRotateTilePayload,
  neighbourCell,
  placedIdFor,
  rotateDoors,
  type BoardState,
  type Dir,
  type GameAction,
  type GameEvent,
  type GameState,
  type PendingPrompt,
  type PlacedId,
  type PlacedTile,
  type PlayerState,
  type Rotation,
  type RotateTilePayload,
  type RuleError,
  type RuleErrorCode,
  type SeatId,
} from '@bahoth/shared';
import type { Character, Content } from '@bahoth/content';
import { checkInvariants } from './invariants.js';
import { drawTile, legalRotations } from './discovery.js';
import {
  armPromptDeadline,
  legalAnswersFor,
  promptExpired,
  raisePrompt,
  validateAnswer,
} from './prompts.js';
import {
  activePlayers,
  canStart,
  getHostSeat,
  isCharacterTaken,
  nextSeatInOrder,
  takenColours,
} from './selectors.js';
import { beginTurnFor, findPath } from './movement.js';
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
      return startGame(state, action.seat, content);
    case 'END_TURN':
      return endTurn(state, action.seat, content);
    case 'VOTE_REMOVE':
      return voteRemove(state, action.seat, action.target, action.vote);
    case 'DISCONNECT':
      return setConnected(state, action.seat, false, action.at);
    case 'RECONNECT':
      return setConnected(state, action.seat, true);
    case 'TICK':
      return tick(state, action.now, content);
    case 'CONCEDE':
      return concede(state, action.seat, content);
    case 'MOVE':
      return move(state, action.seat, action.to, content);
    case 'MOVE_THROUGH':
      return moveThrough(state, action.seat, action.dir, content);
    case 'ROTATE_TILE':
      return rotateTile(state, action.seat, action.rotation, content);
    case 'ANSWER':
      return answerPrompt(state, action.seat, action.promptId, action.answer, content);

    // Declared in the protocol, implemented in later milestones.
    case 'USE_ITEM':
    case 'TRADE':
    case 'DROP':
    case 'ROOM_ACTION':
    case 'ATTACK':
    case 'ASSIGN_DAMAGE':
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

/**
 * Place every layout tile and stand every explorer in the start tile
 * (D-e). Ids are cell-derived (`placedIdFor`) rather than counted, so this
 * cannot desync from `board.index` — invariant 3b checks the two agree.
 */
function placeStartingLayout(content: Content): BoardState {
  const placed: BoardState['placed'] = {};
  const index: BoardState['index'] = { basement: {}, ground: {}, upper: {} };
  for (const t of content.house.layout) {
    const id = placedIdFor(t.floor, t.x, t.y);
    placed[id] = {
      id,
      tileId: t.tileId,
      floor: t.floor,
      x: t.x,
      y: t.y,
      rotation: t.rotation,
      discoveredBy: null,
      flags: {},
    };
    index[t.floor][cellKey(t.x, t.y)] = id;
  }
  return { placed, index };
}

function startGame(state: GameState, seat: SeatId, content: Content): ReduceResult {
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

  const [turnOrder, rngAfterOrder] = shuffle(
    rng,
    players.map((p) => p.seatId),
  );
  // Turn order first, then the tile deck — the ordering is fixed so replay
  // reproduces the same deck every time (docs/05-engine.md#54).
  const [tileDeck, nextRng] = shuffle(rngAfterOrder, content.deckTiles);

  const board = placeStartingLayout(content);
  const startLayout = content.house.layout.find(
    (t) => t.tileId === content.house.startTile,
  );
  // The loader guarantees startTile names a pre-placed tile
  // (assertHouseCoherent), so this is never undefined for content that
  // passed buildContent.
  const startId: PlacedId = placedIdFor(
    startLayout!.floor,
    startLayout!.x,
    startLayout!.y,
  );

  // Trait indices are already set from each character's printed starting slot
  // by CHOOSE_CHAR. Every explorer stands in the Entrance Hall to start
  // (docs/02-rules-model.md#23-the-house).
  const nextPlayers: Record<SeatId, PlayerState> = { ...state.players };
  for (const p of players) {
    nextPlayers[p.seatId] = { ...p, location: startId, cameFrom: null };
  }

  const first = turnOrder[0] ?? null;
  let nextState: GameState = {
    ...state,
    rng: nextRng,
    // Straight to `explore`: characters are chosen in the lobby, so the
    // `setup` phase has nothing to do.
    phase: 'explore',
    players: nextPlayers,
    turnOrder,
    activeSeat: first,
    round: 1,
    // Unarmed: the engine cannot read a clock, so the first TICK of the turn
    // sets the deadline.
    turnDeadline: null,
    board,
    tileDeck,
  };
  // Only the first active seat gets a movement budget this turn (D-f);
  // everyone else keeps the movesLeft: 0 they were seeded with in makePlayer.
  if (first) nextState = beginTurnFor(nextState, first, content);

  return {
    state: nextState,
    events: [
      { t: 'game_started', turnOrder },
      ...(first ? [{ t: 'turn_started', seat: first, round: 1 } as GameEvent] : []),
    ],
  };
}

// --- turn loop -------------------------------------------------------------

/**
 * `MOVE { to }` (D-g). `to` may be anywhere `getReachable` offers, not just
 * an adjacent room — docs/07-ui.md has the client highlight `getReachable()`
 * and issue `MOVE` on a click, so the engine has to walk a shortest legal
 * path itself. One `moved` event per room entered (D-b), so the log and any
 * future animation see each step; the known limitation (which of several
 * equal-length paths gets walked becomes player-visible once M3 gives rooms
 * `onEnter` effects) is recorded in docs/11-progress.md.
 */
function move(
  state: GameState,
  seat: SeatId,
  to: PlacedId,
  content: Content,
): ReduceResult {
  if (!['explore', 'haunt'].includes(state.phase)) {
    return fail('WRONG_PHASE', `Cannot move during ${state.phase}`);
  }
  const player = state.players[seat];
  if (!player) return fail('UNKNOWN_SEAT', `No such seat: ${seat}`);
  if (state.activeSeat !== seat) return fail('NOT_YOUR_TURN', 'It is not your turn');
  if (state.pending) return fail('PROMPT_PENDING', 'Answer the pending prompt first');
  if (player.isDead || player.removed || player.location === null) {
    return fail('ILLEGAL_MOVE', `${seat} cannot move`);
  }
  if (!state.board.placed[to]) return fail('ILLEGAL_MOVE', `No such room: ${to}`);
  if (to === player.location) return fail('ILLEGAL_MOVE', 'Already there');

  const path = findPath(state, seat, to, content);
  if (!path) {
    return fail(
      'ILLEGAL_MOVE',
      `${to} is not reachable with ${player.movesLeft} move(s) left`,
    );
  }

  let nextState = state;
  const events: GameEvent[] = [];
  let from = player.location;
  for (const step of path) {
    const p = nextState.players[seat]!;
    nextState = {
      ...nextState,
      players: {
        ...nextState.players,
        [seat]: { ...p, location: step, cameFrom: from, movesLeft: p.movesLeft - 1 },
      },
    };
    events.push({ t: 'moved', seat, from, to: step });
    from = step;
  }

  return { state: nextState, events };
}

/**
 * `MOVE_THROUGH { dir }` — the other half of movement, alongside `MOVE`
 * (docs/02-rules-model.md#24 step 3 and its [RULING] on the draw;
 * docs/05-engine.md#56, steps 1-3 of the worked example). Draws a tile off
 * the deck and either places it immediately, when only one rotation puts a
 * door back on `dir` (docs/09-roadmap.md open question 7: auto-apply), or
 * raises a `rotate_tile` prompt for the seat to choose among the rest.
 *
 * The tile is off the deck from the moment `drawTile` succeeds, whether or
 * not a prompt follows — which is why every place that can otherwise drop
 * `pending` (see `tick`, below) has to resolve a `rotate_tile` prompt rather
 * than discard it. A dropped prompt would be a drawn tile that vanished.
 */
function moveThrough(
  state: GameState,
  seat: SeatId,
  dir: Dir,
  content: Content,
): ReduceResult {
  if (!['explore', 'haunt'].includes(state.phase)) {
    return fail('WRONG_PHASE', `Cannot move during ${state.phase}`);
  }
  const player = state.players[seat];
  if (!player) return fail('UNKNOWN_SEAT', `No such seat: ${seat}`);
  if (state.activeSeat !== seat) return fail('NOT_YOUR_TURN', 'It is not your turn');
  if (state.pending) return fail('PROMPT_PENDING', 'Answer the pending prompt first');
  if (player.isDead || player.removed || player.location === null) {
    return fail('ILLEGAL_MOVE', `${seat} cannot move`);
  }
  if (player.movesLeft <= 0) {
    return fail('ILLEGAL_MOVE', `${seat} has no moves left`);
  }

  const location = state.board.placed[player.location];
  const tileDef = location && content.tilesById[location.tileId];
  if (!location || !tileDef) {
    return fail('ILLEGAL_MOVE', `${seat} is standing on an unrecognised tile`);
  }

  const doors = rotateDoors(tileDef.doors, location.rotation);
  if (!doors[dir]) {
    return fail('ILLEGAL_MOVE', `No doorway ${dir} from ${location.id}`);
  }

  const [nx, ny] = neighbourCell(location.x, location.y, dir);
  if (state.board.index[location.floor][cellKey(nx, ny)]) {
    // This is exactly the client bug this check catches: the cell is already
    // built, so the right action is MOVE, not MOVE_THROUGH.
    return fail(
      'ILLEGAL_MOVE',
      `${cellKey(nx, ny)} on the ${location.floor} is already built — use MOVE instead`,
    );
  }

  const rng = state.rng;
  if (!rng) {
    return fail('INVARIANT_VIOLATION', 'Cannot draw a tile from a redacted state');
  }
  const draw = drawTile(state.tileDeck, location.floor, content, rng);
  if (!draw) {
    return fail(
      'ILLEGAL_MOVE',
      `No room left that can be built on the ${location.floor}`,
    );
  }

  // The tile is committed from here: it is off the deck in `withDraw`
  // regardless of which path below actually places it.
  const withDraw: GameState = { ...state, tileDeck: draw.deck, rng: draw.rng };
  const drawnTileDef = content.tilesById[draw.tileId]!;
  const rots = legalRotations(drawnTileDef, OPPOSITE[dir]);
  const payload: RotateTilePayload = {
    tileId: draw.tileId,
    floor: location.floor,
    x: nx,
    y: ny,
    from: location.id,
    dir,
    legalRotations: rots,
  };

  if (rots.length === 1) {
    // No decision to make (open question 7: auto-apply).
    return finishDiscovery(withDraw, seat, payload, rots[0]!, content);
  }

  // `deadline` starts null and is armed by the next TICK (prompts.ts), for the
  // same reason the turn clock is: this action carries no `now`.
  const pending: PendingPrompt = raisePrompt(state, {
    seatId: seat,
    kind: 'rotate_tile',
    payload,
    defaultAnswer: rots[0]!,
  });

  return {
    state: { ...withDraw, pending },
    events: [
      // docs/07-ui.md#73 asks for exactly this line for the other players.
      { t: 'log', text: `${player.name} is placing the ${drawnTileDef.name}…` },
    ],
  };
}

/**
 * Land a drawn tile and step the explorer through the doorway. Shared by the
 * auto-apply path in `moveThrough`, `ROTATE_TILE`, and default-answer
 * resolution in `tick` (`resolvePromptWithDefault`) — three ways to reach the
 * same finish line, one function that draws it.
 *
 * `content` is unused today but kept in the signature for the effects this
 * seam will need: onEnter effects, the card draw and its `movesLeft = 0`, and
 * the haunt roll are steps 6-8 of the worked example
 * (docs/05-engine.md#56) and are explicitly out of scope for this PR — a
 * discovered tile with a symbol draws nothing yet. That is M3's seam, not
 * this one's.
 */
function finishDiscovery(
  state: GameState,
  seat: SeatId,
  payload: RotateTilePayload,
  rotation: Rotation,
  _content: Content,
): ReduceResult {
  const id = placedIdFor(payload.floor, payload.x, payload.y);

  // Guard the cell one more time. Nothing can occupy it between the prompt
  // being raised and being answered today — a pending prompt blocks every
  // other action — but that is a fact about today's rules, not a property of
  // this function. Clear the prompt without double-placing if it ever does.
  if (state.board.index[payload.floor][cellKey(payload.x, payload.y)]) {
    return { state: { ...state, pending: null }, events: [] };
  }

  const placed: PlacedTile = {
    id,
    tileId: payload.tileId,
    floor: payload.floor,
    x: payload.x,
    y: payload.y,
    rotation,
    discoveredBy: seat,
    flags: {},
  };

  const board: BoardState = {
    placed: { ...state.board.placed, [id]: placed },
    index: {
      ...state.board.index,
      [payload.floor]: {
        ...state.board.index[payload.floor],
        [cellKey(payload.x, payload.y)]: id,
      },
    },
  };

  const player = state.players[seat]!;
  const players = {
    ...state.players,
    [seat]: {
      ...player,
      location: id,
      cameFrom: payload.from,
      movesLeft: player.movesLeft - 1,
    },
  };

  return {
    state: { ...state, board, players, pending: null },
    events: [
      { t: 'discovered', seat, placed },
      { t: 'moved', seat, from: payload.from, to: id },
    ],
  };
}

/**
 * Resume the pipeline at the step a prompt suspended (docs/05-engine.md#56).
 *
 * The one place a prompt turns back into game state, reached by all four
 * callers: `ANSWER`, `ROTATE_TILE`, a prompt timing out on its own clock, and
 * a prompt whose owner is leaving. `answer` has already been through
 * `validateAnswer` at every one of them — including the timeout, so a default
 * answer cannot do something no player could have chosen.
 *
 * A kind with no resume step clears the prompt. That is safe for every kind
 * that exists today because none of them can be raised; it stops being safe
 * the moment one is, which is why `PROMPT_HANDLERS` is a total record — a new
 * kind cannot reach this switch without the compiler asking about it.
 */
function resumePrompt(
  state: GameState,
  prompt: PendingPrompt,
  answer: unknown,
  content: Content,
): ReduceResult {
  if (prompt.kind === 'rotate_tile' && isRotateTilePayload(prompt.payload)) {
    return finishDiscovery(
      state,
      prompt.seatId,
      prompt.payload,
      answer as Rotation,
      content,
    );
  }
  return { state: { ...state, pending: null }, events: [] };
}

/**
 * The single gate every player-supplied answer passes through.
 *
 * `promptId` is null for `ROTATE_TILE`, which carries no id, and a real id for
 * `ANSWER`. Checking it is the whole reason the field exists: a client
 * answering the prompt it *saw* must not land on the prompt that replaced it
 * while its message was in flight. `ROTATE_TILE` cannot make that check and
 * keeps its previous behaviour rather than gaining a field the protocol does
 * not carry.
 */
function answerPrompt(
  state: GameState,
  seat: SeatId,
  promptId: string | null,
  answer: unknown,
  content: Content,
): ReduceResult {
  const pending = state.pending;
  if (!pending) return fail('PROMPT_PENDING', 'There is no prompt to answer');
  if (pending.seatId !== seat) {
    return fail('PROMPT_MISMATCH', 'This is not your prompt to answer');
  }
  if (promptId !== null && promptId !== pending.id) {
    return fail('PROMPT_MISMATCH', `Prompt ${promptId} is not the prompt now pending`);
  }
  if (!validateAnswer(pending, answer)) {
    return fail('ILLEGAL_MOVE', `Not a legal answer to a ${pending.kind} prompt`);
  }

  return resumePrompt(state, pending, answer, content);
}

/**
 * `ROTATE_TILE { rotation }`: the seat's answer to a `rotate_tile` prompt.
 * Sugar over `ANSWER` — the kind check is what keeps its error codes specific,
 * everything after it is the generic path.
 */
function rotateTile(
  state: GameState,
  seat: SeatId,
  rotation: Rotation,
  content: Content,
): ReduceResult {
  if (state.pending && state.pending.kind !== 'rotate_tile') {
    return fail('PROMPT_MISMATCH', 'The pending prompt is not a tile rotation');
  }
  return answerPrompt(state, seat, null, rotation, content);
}

function endTurn(state: GameState, seat: SeatId, content: Content): ReduceResult {
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

  // The clock is disarmed, not re-armed: the next TICK arms it with the
  // budget that suits whoever is now active. beginTurnFor gives `next` its
  // Speed-based movement budget (D-f) — this is one of the call sites the
  // plan requires so a seat can never silently end up unable to move.
  let nextState: GameState = {
    ...state,
    players,
    activeSeat: next,
    round,
    turnDeadline: null,
  };
  nextState = beginTurnFor(nextState, next, content);

  return {
    state: nextState,
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
function resolveRemovals(state: GameState, now: number, content: Content): ReduceResult {
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

    // If the seat about to be removed owns the pending prompt, resolve it on
    // its default BEFORE the removal — while it is still a normal player, so
    // `finishDiscovery` writes a coherent state (it expects a seat that is
    // still in `turnOrder` and not yet `removed`). Left unresolved, the
    // prompt becomes unanswerable the instant this seat is `removed`
    // (`getLegalActions` returns `[]` early for a removed seat, full stop),
    // and the tile it carries sits in limbo until the turn clock expires —
    // D5's shape (docs/11-progress.md): a reachable state whose only escape
    // is a clock. This PR is what makes a prompt reachable at all, so it is
    // also what has to close this hole.
    if (next.pending?.seatId === target) {
      const resolved = resolvePromptWithDefault(next, content);
      next = resolved.state;
      events.push(...resolved.events);
    }
    const freshVictim = next.players[target]!;

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
      players: { ...next.players, [target]: { ...freshVictim, removed: true } },
      turnOrder: next.turnOrder.filter((s) => s !== target),
    };

    if (wasActive) {
      const newActive =
        following === null || following === target
          ? (next.turnOrder[0] ?? null)
          : following;
      next = { ...next, activeSeat: newActive, turnDeadline: null };
      // The removed seat's turn budget dies with it; the seat that inherits
      // the turn gets its own (D-f) — otherwise it would be stuck at
      // whatever movesLeft: 0 it had while merely waiting its turn.
      if (newActive) next = beginTurnFor(next, newActive, content);
    }

    events.push({
      t: 'log',
      text: `${freshVictim.name} was removed by vote after leaving the game`,
    });
  }

  return { state: next, events };
}

function concede(state: GameState, seat: SeatId, content: Content): ReduceResult {
  const player = state.players[seat];
  if (!player) return fail('UNKNOWN_SEAT', `No such seat: ${seat}`);
  if (state.phase === 'game_over') return fail('GAME_OVER', 'The game is already over');

  // If this seat owns the pending prompt, resolve it on its default BEFORE
  // it leaves — see the matching comment in `resolveRemovals`, which reaches
  // the same hole from the removal-vote side rather than concede.
  let working = state;
  const priorEvents: GameEvent[] = [];
  if (working.pending?.seatId === seat) {
    const resolved = resolvePromptWithDefault(working, content);
    working = resolved.state;
    priorEvents.push(...resolved.events);
  }
  // Re-read: resolving the prompt may have moved this seat (finishDiscovery
  // updates location/cameFrom/movesLeft), and spreading the stale `player`
  // below would silently revert that.
  const playerNow = working.players[seat]!;

  const remaining = Object.values(working.players).filter(
    (p) => p.seatId !== seat && !p.isDead,
  );
  if (remaining.length === 0) {
    return {
      state: {
        ...working,
        phase: 'game_over',
        result: { outcome: 'abandoned', winners: [], reason: 'Everyone conceded' },
      },
      events: [
        ...priorEvents,
        { t: 'log', text: `${playerNow.name} conceded` },
        {
          t: 'game_over',
          result: { outcome: 'abandoned', winners: [], reason: 'Everyone conceded' },
        },
      ],
    };
  }

  const nextActive =
    working.activeSeat === seat ? nextSeatInOrder(working, seat) : working.activeSeat;
  const finalActive = nextActive === seat ? (remaining[0]?.seatId ?? null) : nextActive;

  let nextState: GameState = {
    ...working,
    players: { ...working.players, [seat]: { ...playerNow, isDead: true } },
    turnOrder: working.turnOrder.filter((s) => s !== seat),
    activeSeat: finalActive,
  };
  // Only re-arm the budget when the conceding seat was the one whose turn it
  // was (D-f) — a concede by someone else must not touch the active seat's
  // movesLeft mid-turn.
  if (working.activeSeat === seat && finalActive) {
    nextState = beginTurnFor(nextState, finalActive, content);
  }

  return {
    state: nextState,
    events: [...priorEvents, { t: 'log', text: `${playerNow.name} conceded` }],
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
 * Apply a prompt's own `defaultAnswer` and clear it. The prompt is always
 * cleared, whichever branch runs — a prompt must never simply be able to
 * outlive the thing it is blocking.
 *
 * For `rotate_tile` this finishes the discovery on `defaultAnswer` rather
 * than dropping it: the tile is already off the deck the moment the prompt
 * was raised (see `moveThrough`), so discarding `pending` here would make
 * content vanish — an explorer stuck mid-doorway, a tile that is nowhere.
 *
 * The default goes through `validateAnswer` like any other answer, so a
 * timeout can only ever do something the seat could have chosen. If the
 * default is somehow not legal — invariant 7 says it cannot be for
 * `rotate_tile`, but this function must not be the place that finds out — the
 * first enumerable legal answer stands in, because for a `rotate_tile` prompt
 * "clear it instead" means losing a drawn tile.
 */
function resolvePromptWithDefault(state: GameState, content: Content): ReduceResult {
  const pending = state.pending;
  if (!pending) return { state, events: [] };

  let answer = pending.defaultAnswer;
  if (!validateAnswer(pending, answer)) {
    const fallback = legalAnswersFor(pending)?.[0];
    if (fallback === undefined) return { state: { ...state, pending: null }, events: [] };
    answer = fallback;
  }

  return resumePrompt(state, pending, answer, content);
}

/**
 * Server-originated clock tick: the engine's only knowledge of time.
 *
 * `now` is carried in the action rather than read from a clock, so the engine
 * stays pure and a replayed log reproduces the same deadlines
 * (docs/05-engine.md#52-actions). A TICK does three things, in order:
 *
 *   1. arms an unarmed prompt clock, or resolves a prompt whose deadline has
 *      passed on its `defaultAnswer` — never both in one tick;
 *   2. arms the turn clock if it is not running yet — this is why the first
 *      TICK of a turn changes state even though nothing has expired;
 *   3. ends the turn if the turn clock has expired.
 *
 * The prompt clock is much shorter than the turn clock (`timers.promptMs`),
 * because a prompt blocks every seat at the table and a turn blocks only the
 * seat spending it. A prompt therefore times out *within* a turn: play resumes
 * on the default answer and the turn carries on, rather than the whole turn
 * being forfeited to one unanswered decision.
 *
 * A TICK with nothing to do returns the state unchanged, by reference, so the
 * server neither logs it nor counts it as room activity.
 */
function tick(state: GameState, now: number, content: Content): ReduceResult {
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

  const removals = resolveRemovals(next, now, content);
  next = removals.state;
  events.push(...removals.events);

  // A prompt gets its own clock, armed here because raising it happened inside
  // an action that carried no `now`. Arming and expiring are deliberately
  // separate ticks: arming to `now + promptMs` and then testing `now >=
  // deadline` in the same pass would fire instantly whenever `promptMs` is 0,
  // and would read as "the prompt expired before anyone saw it".
  const armed = armPromptDeadline(next, now);
  const wasUnarmed = armed !== next;
  next = armed;

  const pending = next.pending;
  if (pending && !wasUnarmed && promptExpired(pending, now)) {
    const resolved = resolvePromptWithDefault(next, content);
    next = resolved.state;
    events.push(...resolved.events);
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

  // Expired. Resolve any prompt still blocking the turn on its default answer
  // — an unanswered prompt must not be able to hold the room open past the
  // deadline — and pass play on. Resolving rather than dropping matters here
  // exactly as it does above: the explorer walks through the door on the
  // default rotation, THEN the turn ends, so the drawn tile is not a silent
  // content leak.
  const seat = next.activeSeat!;
  if (next.pending) {
    const resolved = resolvePromptWithDefault(next, content);
    next = resolved.state;
    events.push(...resolved.events);
  }

  const ended = endTurn(next, seat, content);
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
