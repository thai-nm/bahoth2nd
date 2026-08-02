/**
 * The movement graph: connections, reachability, no-backtrack, and the
 * MOVE/START_GAME/END_TURN plumbing that spends and restores the budget.
 * See docs/02-rules-model.md#movement-graph and #24-turn-structure.
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
  cellKey,
  placedIdFor,
  type BoardState,
  type Doors,
  type Floor,
  type GameState,
  type Rotation,
  type StaticLink,
} from '@bahoth/shared';
import { beginTurnFor, findPath, getConnections, getReachable } from './movement.js';
import { reduce } from './reduce.js';
import { createInitialState } from './setup.js';
import { checkInvariants } from './invariants.js';
import { getLegalActions, traitValue } from './selectors.js';
import { playGame, startedGame } from './testing.js';

const content = fixtureContent();

// --- test content builders --------------------------------------------------

function tile(id: string, doors: Partial<Doors>, opts: Partial<Tile> = {}): Tile {
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

function place(
  tileId: string,
  x: number,
  y: number,
  rotation: Rotation = 0,
  floor: Floor = 'ground',
) {
  return { tileId, floor, x, y, rotation };
}

/** Fixed landings so every custom house passes the loader's coherence checks. */
const BASEMENT_LANDING = tile('tile.t_basement', { n: true }, { floors: ['basement'] });
const UPPER_LANDING = tile('tile.t_upper', { n: true }, { floors: ['upper'] });
/** A drawable tile for every floor, so buildContent's "nothing to draw" check passes. */
const SPARE = tile(
  'tile.t_spare',
  { n: true },
  { floors: ['basement', 'ground', 'upper'] },
);

/**
 * A small house for graph tests the fixture content cannot express (rotation,
 * dangling links, custom door layouts). Reuses the fixture's characters so
 * `startedGame` still has six colours to seat players from.
 */
function buildTestContent(
  groundTiles: Tile[],
  layout: ReturnType<typeof place>[],
  startTileId: string,
): Content {
  const tiles = [...groundTiles, BASEMENT_LANDING, UPPER_LANDING, SPARE];
  const house: House = {
    layout: [
      ...layout,
      place(BASEMENT_LANDING.id, 0, 0, 0, 'basement'),
      place(UPPER_LANDING.id, 0, 0, 0, 'upper'),
    ],
    startTile: startTileId,
    landings: {
      basement: BASEMENT_LANDING.id,
      ground: startTileId,
      upper: UPPER_LANDING.id,
    },
  };
  return buildContent(
    { characters: content.characters, tiles, house },
    'movement.test.ts',
  );
}

function boardOf(
  ...entries: { tileId: string; floor: Floor; x: number; y: number; rotation: Rotation }[]
) {
  const placed: BoardState['placed'] = {};
  const index: BoardState['index'] = { basement: {}, ground: {}, upper: {} };
  for (const e of entries) {
    const id = placedIdFor(e.floor, e.x, e.y);
    placed[id] = { id, ...e, discoveredBy: null, flags: {} };
    index[e.floor][cellKey(e.x, e.y)] = id;
  }
  return { placed, index };
}

function stateWithBoard(c: Content, board: BoardState): GameState {
  return { ...createInitialState({ seed: 1, content: c }), board };
}

// --- the movement graph ------------------------------------------------------

describe('getConnections', () => {
  it('connects adjacent cells when both sides have a door on the shared edge', () => {
    const a = tile('tile.a', { e: true });
    const b = tile('tile.b', { w: true });
    const c = buildTestContent([a, b], [place(a.id, 0, 0), place(b.id, 1, 0)], a.id);
    const s = stateWithBoard(
      c,
      boardOf(
        { tileId: a.id, floor: 'ground', x: 0, y: 0, rotation: 0 },
        { tileId: b.id, floor: 'ground', x: 1, y: 0, rotation: 0 },
      ),
    );
    expect(getConnections(s, placedIdFor('ground', 0, 0), c)).toContain(
      placedIdFor('ground', 1, 0),
    );
  });

  it('does not connect adjacent cells when only one side has a door', () => {
    const a = tile('tile.a', { e: true });
    // b has a door, just not on the shared edge (w).
    const b = tile('tile.b', { n: true });
    const c = buildTestContent([a, b], [place(a.id, 0, 0), place(b.id, 1, 0)], a.id);
    const s = stateWithBoard(
      c,
      boardOf(
        { tileId: a.id, floor: 'ground', x: 0, y: 0, rotation: 0 },
        { tileId: b.id, floor: 'ground', x: 1, y: 0, rotation: 0 },
      ),
    );
    expect(getConnections(s, placedIdFor('ground', 0, 0), c)).not.toContain(
      placedIdFor('ground', 1, 0),
    );
  });

  it('applies rotation: the same tile placed at 90 degrees connects a different neighbour', () => {
    // x has a single door printed on n. North of x is `north`, east is `east`.
    const x = tile('tile.x', { n: true });
    const north = tile('tile.north', { s: true });
    const east = tile('tile.east', { w: true });
    const layout = [
      place(x.id, 0, 0, 0),
      place(north.id, 0, -1, 0),
      place(east.id, 1, 0, 0),
    ];

    const unrotated = buildTestContent([x, north, east], layout, x.id);
    const sUnrotated = stateWithBoard(
      unrotated,
      boardOf(
        { tileId: x.id, floor: 'ground', x: 0, y: 0, rotation: 0 },
        { tileId: north.id, floor: 'ground', x: 0, y: -1, rotation: 0 },
        { tileId: east.id, floor: 'ground', x: 1, y: 0, rotation: 0 },
      ),
    );
    expect(getConnections(sUnrotated, placedIdFor('ground', 0, 0), unrotated)).toEqual([
      placedIdFor('ground', 0, -1),
    ]);

    // At rotation 90, x's printed `n` door ends up on `e` (rotateDoors), so it
    // now faces `east` instead of `north`. This is the case that silently
    // passes if rotateDoors is forgotten in the movement graph.
    const rotatedLayout = [
      place(x.id, 0, 0, 90),
      place(north.id, 0, -1, 0),
      place(east.id, 1, 0, 0),
    ];
    const rotated = buildTestContent([x, north, east], rotatedLayout, x.id);
    const sRotated = stateWithBoard(
      rotated,
      boardOf(
        { tileId: x.id, floor: 'ground', x: 0, y: 0, rotation: 90 },
        { tileId: north.id, floor: 'ground', x: 0, y: -1, rotation: 0 },
        { tileId: east.id, floor: 'ground', x: 1, y: 0, rotation: 0 },
      ),
    );
    expect(getConnections(sRotated, placedIdFor('ground', 0, 0), rotated)).toEqual([
      placedIdFor('ground', 1, 0),
    ]);
  });

  it('a two-way to_tile link is traversable from both ends, declared on only one', () => {
    const g = startedGame();
    const entrance = placedIdFor('ground', 0, 2);
    const basement = placedIdFor('basement', 0, 0);
    // Declared only on the entrance hall in fixtures/tiles.json.
    expect(getConnections(g.state, entrance, content)).toContain(basement);
    expect(getConnections(g.state, basement, content)).toContain(entrance);
  });

  it('a to_floor link arrives at that floor landing', () => {
    const lift = tile(
      'tile.lift',
      { n: true },
      {
        staticLinks: [
          {
            kind: 'to_floor',
            floor: 'upper',
            landing: UPPER_LANDING.id,
            twoWay: true,
          } satisfies StaticLink,
        ],
      },
    );
    const north = tile('tile.north', { s: true });
    const c = buildTestContent(
      [lift, north],
      [place(lift.id, 0, 0), place(north.id, 0, -1)],
      lift.id,
    );
    const s = stateWithBoard(
      c,
      boardOf(
        { tileId: lift.id, floor: 'ground', x: 0, y: 0, rotation: 0 },
        { tileId: north.id, floor: 'ground', x: 0, y: -1, rotation: 0 },
        { tileId: UPPER_LANDING.id, floor: 'upper', x: 0, y: 0, rotation: 0 },
      ),
    );
    expect(getConnections(s, placedIdFor('ground', 0, 0), c)).toContain(
      placedIdFor('upper', 0, 0),
    );
  });

  it('an oneway_drop is traversable down and not back', () => {
    const chute = tile(
      'tile.chute',
      { n: true },
      {
        staticLinks: [
          { kind: 'oneway_drop', floor: 'basement', effects: [] } satisfies StaticLink,
        ],
      },
    );
    const c = buildTestContent([chute], [place(chute.id, 0, 0)], chute.id);
    const s = stateWithBoard(
      c,
      boardOf(
        { tileId: chute.id, floor: 'ground', x: 0, y: 0, rotation: 0 },
        { tileId: BASEMENT_LANDING.id, floor: 'basement', x: 0, y: 0, rotation: 0 },
      ),
    );
    expect(getConnections(s, placedIdFor('ground', 0, 0), c)).toContain(
      placedIdFor('basement', 0, 0),
    );
    expect(getConnections(s, placedIdFor('basement', 0, 0), c)).not.toContain(
      placedIdFor('ground', 0, 0),
    );
  });

  it('a link whose target is not on the board is inert, not a crash', () => {
    const dangling = tile('tile.dangling_target', { n: true });
    const source = tile(
      'tile.dangling_source',
      { n: true },
      {
        staticLinks: [
          { kind: 'to_tile', target: dangling.id, twoWay: true } satisfies StaticLink,
        ],
      },
    );
    // `dangling` is declared and content-valid but never placed in the layout
    // — it goes to the draw deck instead.
    const c = buildTestContent([source, dangling], [place(source.id, 0, 0)], source.id);
    const s = stateWithBoard(
      c,
      boardOf({ tileId: source.id, floor: 'ground', x: 0, y: 0, rotation: 0 }),
    );
    expect(() => getConnections(s, placedIdFor('ground', 0, 0), c)).not.toThrow();
    expect(getConnections(s, placedIdFor('ground', 0, 0), c)).toEqual([]);
  });

  it('no tile is ever its own neighbour, and the result has no duplicates', () => {
    const g = startedGame();
    for (const id of Object.keys(g.state.board.placed)) {
      const conns = getConnections(g.state, id, content);
      expect(conns).not.toContain(id);
      expect(new Set(conns).size).toBe(conns.length);
    }
  });
});

// --- reachability and no-backtrack ------------------------------------------

describe('getReachable / findPath', () => {
  it('movesLeft = 1 reaches exactly the direct neighbours', () => {
    const g = startedGame();
    const seat = g.state.activeSeat!;
    const start = g.state.players[seat]!.location!;
    const state = {
      ...g.state,
      players: {
        ...g.state.players,
        [seat]: { ...g.state.players[seat]!, movesLeft: 1 },
      },
    };
    expect(new Set(getReachable(state, seat, content))).toEqual(
      new Set(getConnections(state, start, content)),
    );
  });

  it('movesLeft = 2 reaches two steps out', () => {
    const g = startedGame();
    const seat = g.state.activeSeat!;
    const start = g.state.players[seat]!.location!;
    const state = {
      ...g.state,
      players: {
        ...g.state.players,
        [seat]: { ...g.state.players[seat]!, movesLeft: 2 },
      },
    };
    const oneStep = getConnections(state, start, content);
    // At least one direct neighbour has a further neighbour reachable only at
    // depth 2 — the fixture entrance hall -> foyer -> {staircase, sides}.
    const twoStepOnly = getReachable(state, seat, content).filter(
      (id) => !oneStep.includes(id),
    );
    expect(twoStepOnly.length).toBeGreaterThan(0);
  });

  it('movesLeft = 0 reaches nothing, and getLegalActions offers no MOVE', () => {
    const g = startedGame();
    const seat = g.state.activeSeat!;
    const state = {
      ...g.state,
      players: {
        ...g.state.players,
        [seat]: { ...g.state.players[seat]!, movesLeft: 0 },
      },
    };
    expect(getReachable(state, seat, content)).toEqual([]);
    expect(getLegalActions(state, seat, content).some((a) => a.t === 'MOVE')).toBe(false);
  });

  it('cannot move straight back into cameFrom, but can reach it around a loop of length >= 2', () => {
    // A 4-cell ring: A-B-C-D-A, all on the ground floor.
    const a = tile('tile.ring_a', { e: true, s: true });
    const b = tile('tile.ring_b', { w: true, s: true });
    const cc = tile('tile.ring_c', { n: true, w: true });
    const d = tile('tile.ring_d', { n: true, e: true });
    const layout = [
      place(a.id, 0, 0),
      place(b.id, 1, 0),
      place(cc.id, 1, 1),
      place(d.id, 0, 1),
    ];
    const c = buildTestContent([a, b, cc, d], layout, a.id);

    const g = startedGame({ content: c });
    const seat = g.state.activeSeat!;
    const idA = placedIdFor('ground', 0, 0);
    const idB = placedIdFor('ground', 1, 0);
    const idC = placedIdFor('ground', 1, 1);
    const idD = placedIdFor('ground', 0, 1);

    // Stand the seat in B, having just come from A. With only 1 movement
    // point, A is unreachable — not because of distance, but because it is
    // the room just left (no-backtrack).
    const short = {
      ...g.state,
      players: {
        ...g.state.players,
        [seat]: { ...g.state.players[seat]!, location: idB, cameFrom: idA, movesLeft: 1 },
      },
    };
    expect(getReachable(short, seat, c)).not.toContain(idA);

    // With enough budget to walk the long way around (B -> C -> D -> A = 3
    // steps), reaching A is legal: the ruling only forbids the *immediate*
    // backtrack, not a return via a loop of length >= 2.
    const budgeted = {
      ...short,
      players: { ...short.players, [seat]: { ...short.players[seat]!, movesLeft: 3 } },
    };
    expect(getReachable(budgeted, seat, c)).toContain(idA);
    expect(findPath(budgeted, seat, idA, c)).toEqual([idC, idD, idA]);
  });

  it('reaching a dead-end off the start room by looping around costs the full path, not one backtrack step', () => {
    // Ring S-D-B-A-S, plus a dead-end C hanging off S:
    //
    //   C(-1,0) - S(0,0) - D(1,0)
    //               |         |
    //             A(0,1) - B(1,1)
    //
    // Standing in S having just come from C, the only legal way back to C is
    // all the way around the ring (S-D-B-A-S-C, 5 steps) — stepping straight
    // back into C is the no-backtrack rule's whole point. The BFS re-enters S
    // partway through that loop, from a `cameFrom` other than the player's
    // real one, and that used to be enough to make the reconstructed path
    // think C was one step away (D6 in docs/11-progress.md).
    const s = tile('tile.ring_s', { e: true, s: true, w: true });
    const d = tile('tile.ring_d', { s: true, w: true });
    const b = tile('tile.ring_b', { n: true, w: true });
    const a = tile('tile.ring_a', { n: true, e: true });
    const cc = tile('tile.dead_end_c', { e: true });
    const layout = [
      place(s.id, 0, 0),
      place(d.id, 1, 0),
      place(b.id, 1, 1),
      place(a.id, 0, 1),
      place(cc.id, -1, 0),
    ];
    const c = buildTestContent([s, d, b, a, cc], layout, s.id);

    const g = startedGame({ content: c });
    const seat = g.state.activeSeat!;
    const idS = placedIdFor('ground', 0, 0);
    const idD = placedIdFor('ground', 1, 0);
    const idB = placedIdFor('ground', 1, 1);
    const idA = placedIdFor('ground', 0, 1);
    const idC = placedIdFor('ground', -1, 0);

    const state = {
      ...g.state,
      players: {
        ...g.state.players,
        [seat]: {
          ...g.state.players[seat]!,
          location: idS,
          cameFrom: idC,
          movesLeft: 5,
        },
      },
    };

    // C is genuinely reachable — the long way round — and getReachable must
    // still say so.
    expect(getReachable(state, seat, c)).toContain(idC);
    // The reconstructed path must be the legal 5-step loop, never the
    // 1-step backtrack into cameFrom.
    const path = findPath(state, seat, idC, c);
    expect(path).toEqual([idD, idB, idA, idS, idC]);

    // And the player-visible consequence: MOVE spends the full cost.
    const r = reduce(state, { t: 'MOVE', seat, to: idC }, c);
    expect(r.error).toBeUndefined();
    expect(r.state.players[seat]?.location).toBe(idC);
    expect(r.state.players[seat]?.movesLeft).toBe(0);
    expect(r.events.filter((e) => e.t === 'moved')).toHaveLength(5);
  });

  it('the current location is never in getReachable', () => {
    const g = startedGame();
    const seat = g.state.activeSeat!;
    const start = g.state.players[seat]!.location!;
    expect(getReachable(g.state, seat, content)).not.toContain(start);
  });

  it('findPath agrees with getReachable for every reachable target, and is null otherwise', () => {
    const g = startedGame();
    const seat = g.state.activeSeat!;
    const state = {
      ...g.state,
      players: {
        ...g.state.players,
        [seat]: { ...g.state.players[seat]!, movesLeft: 3 },
      },
    };
    const reachable = new Set(getReachable(state, seat, content));

    for (const id of Object.keys(state.board.placed)) {
      const path = findPath(state, seat, id, content);
      if (reachable.has(id)) {
        expect(path).not.toBeNull();
        expect(path!.at(-1)).toBe(id);
      } else {
        expect(path).toBeNull();
      }
    }
  });

  it('returns [] / null for a seat with no location, dead, removed, or movesLeft 0', () => {
    const g = startedGame();
    const seat = g.state.activeSeat!;
    const base = g.state.players[seat]!;

    for (const patch of [
      { location: null },
      { isDead: true },
      { removed: true },
      { movesLeft: 0 },
    ]) {
      const state = {
        ...g.state,
        players: { ...g.state.players, [seat]: { ...base, ...patch } },
      };
      expect(getReachable(state, seat, content)).toEqual([]);
      expect(findPath(state, seat, placedIdFor('ground', 0, 1), content)).toBeNull();
    }
  });
});

// --- beginTurnFor -------------------------------------------------------------

describe('beginTurnFor', () => {
  it('sets movesLeft to the current Speed value and clears cameFrom', () => {
    const g = startedGame();
    const seat = g.state.activeSeat!;
    const state = {
      ...g.state,
      players: {
        ...g.state.players,
        [seat]: {
          ...g.state.players[seat]!,
          movesLeft: 0,
          cameFrom: placedIdFor('ground', 0, 1),
        },
      },
    };
    const next = beginTurnFor(state, seat, content);
    expect(next.players[seat]?.movesLeft).toBe(traitValue(state, seat, 'speed', content));
    expect(next.players[seat]?.cameFrom).toBeNull();
  });
});

// --- START_GAME / END_TURN / MOVE via the reducer ----------------------------

describe('board setup at START_GAME', () => {
  it('places every layout tile, board.index matches board.placed, and invariants pass', () => {
    const g = startedGame();
    expect(Object.keys(g.state.board.placed)).toHaveLength(content.house.layout.length);
    let indexed = 0;
    for (const floor of ['basement', 'ground', 'upper'] as const) {
      indexed += Object.keys(g.state.board.index[floor]).length;
    }
    expect(indexed).toBe(content.house.layout.length);
    expect(checkInvariants(g.state)).toEqual([]);
  });

  it('stands every explorer in the start tile', () => {
    const g = startedGame();
    const startLayout = content.house.layout.find(
      (t) => t.tileId === content.house.startTile,
    )!;
    const startId = placedIdFor(startLayout.floor, startLayout.x, startLayout.y);
    for (const p of Object.values(g.state.players)) {
      expect(p.location).toBe(startId);
    }
  });

  it("gives the first active seat's movesLeft its character's printed Speed; everyone else gets 0", () => {
    const g = startedGame();
    const first = g.state.activeSeat!;
    expect(g.state.players[first]?.movesLeft).toBe(
      traitValue(g.state, first, 'speed', content),
    );
    expect(g.state.players[first]?.movesLeft).toBeGreaterThan(0);
    for (const p of Object.values(g.state.players)) {
      if (p.seatId === first) continue;
      expect(p.movesLeft).toBe(0);
    }
  });
});

describe('END_TURN and the movement budget', () => {
  it("gives the next seat its Speed and clears the previous seat's cameFrom", () => {
    const g = startedGame();
    const active = g.state.activeSeat!;
    const to = getReachable(g.state, active, content)[0]!;
    const moved = reduce(g.state, { t: 'MOVE', seat: active, to }, content);
    expect(moved.error).toBeUndefined();
    expect(moved.state.players[active]?.cameFrom).not.toBeNull();

    const ended = reduce(moved.state, { t: 'END_TURN', seat: active }, content);
    expect(ended.error).toBeUndefined();
    const next = ended.state.activeSeat!;
    expect(ended.state.players[next]?.movesLeft).toBe(
      traitValue(ended.state, next, 'speed', content),
    );
    expect(ended.state.players[active]?.cameFrom).toBeNull();
  });
});

describe('MOVE', () => {
  it('walks a multi-step path, decrementing movesLeft and emitting one moved event per step', () => {
    const g = startedGame();
    const active = g.state.activeSeat!;
    const start = g.state.players[active]!.location!;
    const grandStaircase = placedIdFor('ground', 0, 0);
    const path = findPath(g.state, active, grandStaircase, content);
    expect(path).not.toBeNull(); // entrance_hall -> foyer -> grand_staircase, 2 steps
    expect(path).toHaveLength(2);

    const before = g.state.players[active]!.movesLeft;
    const r = reduce(g.state, { t: 'MOVE', seat: active, to: grandStaircase }, content);
    expect(r.error).toBeUndefined();
    expect(r.state.players[active]?.location).toBe(grandStaircase);
    expect(r.state.players[active]?.movesLeft).toBe(before - path!.length);

    const movedEvents = r.events.filter((e) => e.t === 'moved');
    expect(movedEvents).toHaveLength(path!.length);
    expect(movedEvents[0]).toEqual({
      t: 'moved',
      seat: active,
      from: start,
      to: path![0],
    });
  });

  it('rejects a MOVE outside explore/haunt with WRONG_PHASE', () => {
    const g = playGame({ players: ['Ana', 'Ben', 'Cal'] });
    const seat = 'seat_0';
    const r = reduce(
      g.state,
      { t: 'MOVE', seat, to: placedIdFor('ground', 0, 1) },
      content,
    );
    expect(r.error?.code).toBe('WRONG_PHASE');
  });

  it('rejects an out-of-turn MOVE with NOT_YOUR_TURN', () => {
    const g = startedGame();
    const other = g.state.turnOrder.find((s) => s !== g.state.activeSeat)!;
    const target = g.state.players[other]!.location!;
    const r = reduce(g.state, { t: 'MOVE', seat: other, to: target }, content);
    expect(r.error?.code).toBe('NOT_YOUR_TURN');
  });

  it('rejects a MOVE to a tile that is not placed with ILLEGAL_MOVE', () => {
    const g = startedGame();
    const active = g.state.activeSeat!;
    const r = reduce(g.state, { t: 'MOVE', seat: active, to: 'ground:99,99' }, content);
    expect(r.error?.code).toBe('ILLEGAL_MOVE');
  });

  it('rejects an unreachable MOVE (movesLeft exhausted) with ILLEGAL_MOVE', () => {
    const g = startedGame();
    const active = g.state.activeSeat!;
    const state = {
      ...g.state,
      players: {
        ...g.state.players,
        [active]: { ...g.state.players[active]!, movesLeft: 0 },
      },
    };
    const r = reduce(
      state,
      { t: 'MOVE', seat: active, to: placedIdFor('ground', 0, 0) },
      content,
    );
    expect(r.error?.code).toBe('ILLEGAL_MOVE');
  });

  it('rejects a MOVE from a dead player with ILLEGAL_MOVE', () => {
    const g = startedGame();
    const active = g.state.activeSeat!;
    const state = {
      ...g.state,
      players: {
        ...g.state.players,
        [active]: { ...g.state.players[active]!, isDead: true },
      },
    };
    const target = getReachable(g.state, active, content)[0]!;
    const r = reduce(state, { t: 'MOVE', seat: active, to: target }, content);
    expect(r.error?.code).toBe('ILLEGAL_MOVE');
  });

  it('rejects a MOVE while a prompt is pending with PROMPT_PENDING', () => {
    const g = startedGame();
    const active = g.state.activeSeat!;
    const state: GameState = {
      ...g.state,
      pending: {
        id: 'p1',
        seatId: active,
        kind: 'confirm',
        payload: null,
        deadline: null,
        defaultAnswer: null,
      },
    };
    const target = getReachable(g.state, active, content)[0]!;
    const r = reduce(state, { t: 'MOVE', seat: active, to: target }, content);
    expect(r.error?.code).toBe('PROMPT_PENDING');
  });
});

describe('turn budget on removal and concede', () => {
  const T0 = 1_700_000_000_000;

  it('restores the budget to the new active seat when the active seat is removed by vote', () => {
    const g = startedGame({ players: ['Ana', 'Ben', 'Cal', 'Dot'] });
    const absent = g.state.activeSeat!;
    let s = reduce(g.state, { t: 'DISCONNECT', seat: absent, at: T0 }, content).state;
    for (const voter of Object.keys(s.players)) {
      if (voter === absent) continue;
      s = reduce(
        s,
        { t: 'VOTE_REMOVE', seat: voter, target: absent, vote: true },
        content,
      ).state;
    }
    s = reduce(s, { t: 'TICK', now: T0 + s.timers.removeGraceMs }, content).state;

    expect(s.players[absent]?.removed).toBe(true);
    const newActive = s.activeSeat!;
    expect(newActive).not.toBe(absent);
    expect(s.players[newActive]?.movesLeft).toBe(
      traitValue(s, newActive, 'speed', content),
    );
  });

  it('restores the budget to the new active seat when the active seat concedes', () => {
    const g = startedGame();
    const active = g.state.activeSeat!;
    const r = reduce(g.state, { t: 'CONCEDE', seat: active }, content);
    expect(r.error).toBeUndefined();
    const newActive = r.state.activeSeat!;
    expect(newActive).not.toBe(active);
    expect(r.state.players[newActive]?.movesLeft).toBe(
      traitValue(r.state, newActive, 'speed', content),
    );
  });
});

/**
 * The generic statement of what `findPath` owes `getReachable`, checked
 * exhaustively over every board, budget, and `cameFrom` these tests can build.
 *
 * D6 was one instance of this property failing — a path that was one
 * illegal step instead of five legal ones — and it took a hand-built ring with
 * a dead-end to notice. Asserting the property itself rather than that one
 * shape is what makes the next instance fail loudly instead of being found in
 * review.
 */
describe('property: every path getReachable promises is a legal path', () => {
  /** Each consecutive pair connected, no immediate backtrack, within budget. */
  function assertLegalPath(
    state: GameState,
    seat: string,
    to: string,
    c: Content,
    label: string,
  ): void {
    const player = state.players[seat]!;
    const path = findPath(state, seat, to, c);
    expect(path, `${label}: reachable but no path`).not.toBeNull();
    expect(path!.length, `${label}: path longer than the budget`).toBeLessThanOrEqual(
      player.movesLeft,
    );
    expect(path!.length, `${label}: empty path`).toBeGreaterThan(0);
    expect(path!.at(-1), `${label}: path does not end at the target`).toBe(to);

    let pos = player.location!;
    let cameFrom = player.cameFrom;
    for (const [i, step] of path!.entries()) {
      expect(
        getConnections(state, pos, c),
        `${label}: step ${i} (${pos} -> ${step}) is not a connection`,
      ).toContain(step);
      expect(step, `${label}: step ${i} backtracks into ${cameFrom}`).not.toBe(cameFrom);
      cameFrom = pos;
      pos = step;
    }
  }

  /** Every board these tests build, plus the fixture house. */
  function boards(): { label: string; content: Content; state: GameState }[] {
    const out: { label: string; content: Content; state: GameState }[] = [];

    const g = startedGame();
    out.push({ label: 'fixture house', content, state: g.state });

    // A 4-cell ring with a dead-end hanging off one corner: the shape whose
    // loop back through the start room produced D6.
    const s = tile('tile.p_s', { e: true, s: true, w: true });
    const d = tile('tile.p_d', { s: true, w: true });
    const b = tile('tile.p_b', { n: true, w: true });
    const a = tile('tile.p_a', { n: true, e: true });
    const dead = tile('tile.p_dead', { e: true });
    const layout = [
      place(s.id, 0, 0),
      place(d.id, 1, 0),
      place(b.id, 1, 1),
      place(a.id, 0, 1),
      place(dead.id, -1, 0),
    ];
    const ringContent = buildTestContent([s, d, b, a, dead], layout, s.id);
    out.push({
      label: 'ring with a dead-end',
      content: ringContent,
      state: stateWithBoard(ringContent, boardOf(...layout.map((l) => ({ ...l })))),
    });

    return out;
  }

  it('holds for every budget and every cameFrom on every board', () => {
    for (const { label, content: c, state: base } of boards()) {
      const rooms = Object.keys(base.board.placed);
      // A seat to drive; the fixture game already has one, the hand-built
      // boards need one planted.
      const seat = base.activeSeat ?? 'seat_0';

      for (const location of rooms) {
        // Every plausible history: arrived from nowhere, or from any room.
        for (const cameFrom of [null, ...rooms.filter((r) => r !== location)]) {
          for (let movesLeft = 0; movesLeft <= 6; movesLeft++) {
            const player = {
              ...(base.players[seat] ?? {
                seatId: seat,
                name: 'P',
                charId: null,
                traits: { speed: 1, might: 1, sanity: 1, knowledge: 1 },
                items: [],
                omens: [],
                isTraitor: false,
                isDead: false,
                connected: true,
                disconnectedAt: null,
                removed: false,
                hasAttackedThisTurn: false,
                flags: {},
              }),
              location,
              cameFrom,
              movesLeft,
            };
            const state: GameState = {
              ...base,
              players: { ...base.players, [seat]: player },
            };

            const reachable = getReachable(state, seat, c);
            expect(
              reachable,
              `${label}: the current room is a destination`,
            ).not.toContain(location);

            for (const to of reachable) {
              assertLegalPath(
                state,
                seat,
                to,
                c,
                `${label} @${location} from ${cameFrom} with ${movesLeft}`,
              );
            }
          }
        }
      }
    }
  });
});
