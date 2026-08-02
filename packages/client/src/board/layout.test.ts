import { describe, expect, it } from 'vitest';
import { DIR_ORDER, OPPOSITE, cellKey, neighbourCell } from '@bahoth/shared';
import type { BoardState, Dir, Floor, PlacedTile, Rotation } from '@bahoth/shared';
import { fixtureContent } from '@bahoth/content';
import { checkInvariants, createInitialState } from '@bahoth/engine';
import {
  MAX_ZOOM,
  MIN_ZOOM,
  TILE,
  boardBounds,
  clampZoom,
  fitTransform,
  openDoorways,
  tileViewsForFloor,
} from './layout.js';
import { buildPreviewBoard } from '../screens/BoardPreview.js';

const content = fixtureContent();

/** A BoardState from bare placements. `index` is left empty on purpose — layout.ts never reads it. */
function makeBoard(
  placements: ReadonlyArray<Omit<PlacedTile, 'discoveredBy' | 'flags'>>,
): BoardState {
  const placed: Record<string, PlacedTile> = {};
  for (const p of placements) {
    placed[p.id] = { ...p, discoveredBy: null, flags: {} };
  }
  return { placed, index: { basement: {}, ground: {}, upper: {} } };
}

/** The fixture's five starting tiles, as PlacedTile — id mirrors tileId, same convention as BoardPreview. */
function fixtureLayoutBoard(): BoardState {
  return makeBoard(
    content.house.layout.map((p) => ({
      id: p.tileId,
      tileId: p.tileId,
      floor: p.floor,
      x: p.x,
      y: p.y,
      rotation: p.rotation,
    })),
  );
}

describe('tileViewsForFloor', () => {
  it('returns only the requested floor', () => {
    const board = fixtureLayoutBoard();
    const ground = tileViewsForFloor(board, content, 'ground');
    const upper = tileViewsForFloor(board, content, 'upper');
    const basement = tileViewsForFloor(board, content, 'basement');

    expect(ground.map((v) => v.placedId).sort()).toEqual(
      ['tile.entrance_hall', 'tile.foyer', 'tile.grand_staircase'].sort(),
    );
    expect(upper.map((v) => v.placedId)).toEqual(['tile.upper_landing']);
    expect(basement.map((v) => v.placedId)).toEqual(['tile.basement_landing']);
  });

  it('returns EFFECTIVE doors, not the printed ones, for a rotated tile', () => {
    // tile.entrance_hall prints a single north door. Rotated 90 clockwise it
    // should show up east instead, per rotateDoors (packages/shared/src/geometry.ts).
    const printed = content.tilesById['tile.entrance_hall']?.doors;
    expect(printed).toEqual({ n: true, e: false, s: false, w: false });

    const board = makeBoard([
      {
        id: 'p1',
        tileId: 'tile.entrance_hall',
        floor: 'ground',
        x: 0,
        y: 0,
        rotation: 90 as Rotation,
      },
    ]);
    const [view] = tileViewsForFloor(board, content, 'ground');
    expect(view?.doors).toEqual({ n: false, e: true, s: false, w: false });
    expect(view?.doors).not.toEqual(printed);
  });
});

describe('boardBounds', () => {
  it('covers the fixture starting layout', () => {
    const board = fixtureLayoutBoard();
    const ground = tileViewsForFloor(board, content, 'ground');
    // entrance_hall (0,2), foyer (0,1), grand_staircase (0,0) — a vertical
    // three-tile column, so bounds should be one tile wide, three tall.
    expect(boardBounds(ground)).toEqual({
      minX: 0,
      minY: 0,
      maxX: TILE,
      maxY: 3 * TILE,
      width: TILE,
      height: 3 * TILE,
    });
  });

  it('does not throw and produces no NaN for an empty floor', () => {
    const board = fixtureLayoutBoard();
    // Nothing is placed on a floor the fixture never touches directly in this test.
    const views = tileViewsForFloor(makeBoard([]), content, 'basement');
    expect(views).toEqual([]);
    const bounds = boardBounds(views);
    expect(bounds).toEqual({ minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 });
    for (const v of Object.values(bounds)) expect(Number.isNaN(v)).toBe(false);
    void board;
  });
});

describe('openDoorways', () => {
  it('returns exactly the doors facing empty cells, and excludes a door that meets a neighbour', () => {
    // Two all-doored basement tiles, A north of B. A's south door meets B's
    // north door, so neither of those two should appear as an open doorway;
    // A's other 3 doors and B's other 3 doors should.
    const board = makeBoard([
      {
        id: 'A',
        tileId: 'tile.slate_undercroft',
        floor: 'basement',
        x: 0,
        y: 0,
        rotation: 0,
      },
      {
        id: 'B',
        tileId: 'tile.echo_chamber',
        floor: 'basement',
        x: 0,
        y: 1,
        rotation: 0,
      },
    ]);
    const views = tileViewsForFloor(board, content, 'basement');
    const doorways = openDoorways(views);

    expect(doorways).toHaveLength(6);
    expect(doorways.some((d) => d.placedId === 'A' && d.dir === 's')).toBe(false);
    expect(doorways.some((d) => d.placedId === 'B' && d.dir === 'n')).toBe(false);
    for (const dir of ['n', 'e', 'w'] as Dir[]) {
      expect(doorways.some((d) => d.placedId === 'A' && d.dir === dir)).toBe(true);
    }
    for (const dir of ['e', 's', 'w'] as Dir[]) {
      expect(doorways.some((d) => d.placedId === 'B' && d.dir === dir)).toBe(true);
    }
  });

  it('produces nothing for an empty floor', () => {
    expect(openDoorways([])).toEqual([]);
  });

  it('re-evaluates open vs occupied against EFFECTIVE (rotated) doors, not printed ones', () => {
    // tile.entrance_hall prints a single north door. Rotated 90 it faces
    // east instead (asserted above in tileViewsForFloor), so a tile placed
    // to its east should close that doorway, while a tile placed to its
    // (still-open, printed) north should NOT — proof that occupancy here is
    // checked against the rotated doors layout.ts computes, not the raw
    // content. Exercised for a rotation on each of the four cardinal exits
    // by rotating which one lines up with the occupied neighbour.
    for (const rotation of [0, 90, 180, 270] as Rotation[]) {
      const board = makeBoard([
        { id: 'p1', tileId: 'tile.entrance_hall', floor: 'ground', x: 0, y: 0, rotation },
        // A neighbour directly east of p1, occupying whichever cell the
        // rotated door happens to face when rotation === 90.
        { id: 'p2', tileId: 'tile.foyer', floor: 'ground', x: 1, y: 0, rotation: 0 },
      ]);
      const views = tileViewsForFloor(board, content, 'ground');
      const doorways = openDoorways(views);
      const p1 = views.find((v) => v.placedId === 'p1')!;
      const effectiveDir = DIR_ORDER.find((d) => p1.doors[d]);
      expect(effectiveDir).toBeDefined();

      if (effectiveDir === 'e') {
        // The door faces the occupied neighbour: no open doorway there.
        expect(doorways.some((d) => d.placedId === 'p1')).toBe(false);
      } else {
        // The door faces an empty cell: it is an open doorway.
        expect(doorways.some((d) => d.placedId === 'p1' && d.dir === effectiveDir)).toBe(
          true,
        );
      }
    }
  });
});

describe('fitTransform', () => {
  it('centres the content in the viewport, scaling down a floor bigger than the viewport', () => {
    // Large enough that the natural-size clamp does not kick in, so this
    // exercises the actual scale-to-fit arithmetic rather than the clamp.
    const { tx, ty, k } = fitTransform(3000, 4500, 1000, 800, 20);
    expect(k).toBeCloseTo(Math.min(960 / 3000, 760 / 4500));
    expect(tx).toBeCloseTo((1000 - 3000 * k) / 2);
    expect(ty).toBeCloseTo((800 - 4500 * k) / 2);
  });

  it('clamps at 1.0 for a small board rather than blowing it up', () => {
    const { tx, ty, k } = fitTransform(TILE, TILE, 1000, 800, 20);
    expect(k).toBe(1);
    expect(tx).toBe((1000 - TILE) / 2);
    expect(ty).toBe((800 - TILE) / 2);
  });

  it('does not throw or produce NaN for an empty (zero-size) floor', () => {
    const { tx, ty, k } = fitTransform(0, 0, 1000, 800, 20);
    expect(Number.isNaN(tx)).toBe(false);
    expect(Number.isNaN(ty)).toBe(false);
    expect(Number.isNaN(k)).toBe(false);
    expect(k).toBe(1);
  });
});

describe('clampZoom', () => {
  it('clamps below the minimum and above the maximum', () => {
    expect(clampZoom(0.01)).toBe(MIN_ZOOM);
    expect(clampZoom(50)).toBe(MAX_ZOOM);
    expect(clampZoom(1)).toBe(1);
  });
});

describe('the BoardPreview board', () => {
  it('has every effective door meeting its neighbour, on every floor', () => {
    // A preview whose doors do not meet is worse than no preview at all —
    // this is the tripwire that keeps it honest as the fixture evolves.
    const board = buildPreviewBoard(content);
    for (const floor of ['basement', 'ground', 'upper'] as Floor[]) {
      const views = tileViewsForFloor(board, content, floor);
      const byCell = new Map(views.map((v) => [cellKey(v.x, v.y), v]));
      for (const v of views) {
        for (const dir of ['n', 'e', 's', 'w'] as Dir[]) {
          const [nx, ny] = neighbourCell(v.x, v.y, dir);
          const neighbour = byCell.get(cellKey(nx, ny));
          if (!neighbour) continue; // No tile there yet: an open doorway, not a mismatch.
          expect(
            v.doors[dir],
            `${v.placedId} ${dir} vs its ${OPPOSITE[dir]} neighbour ${neighbour.placedId}`,
          ).toBe(neighbour.doors[OPPOSITE[dir]]);
        }
      }
    }
  });

  it("is fully reachable from each floor's landing, walking only through matching door pairs", () => {
    // The door-alignment test above only inspects OCCUPIED neighbours, so a
    // tile with no neighbours at all — disconnected from the rest of the
    // house — passes it trivially. That is exactly the bug a first draft of
    // this preview had (sunken_cistern floating two cells off the board): a
    // tile nobody can walk to is not a preview of a house. This test walks
    // the door graph from each floor's declared landing and asserts every
    // placed tile on that floor is reached.
    const board = buildPreviewBoard(content);
    for (const floor of ['basement', 'ground', 'upper'] as Floor[]) {
      const views = tileViewsForFloor(board, content, floor);
      const byCell = new Map(views.map((v) => [cellKey(v.x, v.y), v]));

      const landingTileId = content.house.landings[floor];
      const landing = views.find((v) => v.tileId === landingTileId);
      expect(landing, `${floor} has no landing placed in the preview`).toBeDefined();
      if (!landing) continue;

      const visited = new Set<string>([landing.placedId]);
      const queue = [landing];
      for (let i = 0; i < queue.length; i++) {
        const current = queue[i];
        if (!current) continue;
        for (const dir of ['n', 'e', 's', 'w'] as Dir[]) {
          if (!current.doors[dir]) continue; // Closed on this side: no edge, matched or not.
          const [nx, ny] = neighbourCell(current.x, current.y, dir);
          const next = byCell.get(cellKey(nx, ny));
          if (!next || visited.has(next.placedId)) continue;
          visited.add(next.placedId);
          queue.push(next);
        }
      }

      const unreached = views
        .filter((v) => !visited.has(v.placedId))
        .map((v) => v.placedId);
      expect(unreached, `${floor} tiles unreachable from its landing`).toEqual([]);
    }
  });

  it('satisfies the engine invariants — a board it would accept, not just a comment claiming one', () => {
    // invariants.ts check 3b requires placed[key].id === placedIdFor(floor,
    // x, y); BoardPreview used to mint bare tile ids instead, which nothing
    // in this file's other tests would ever catch because they never ask the
    // engine. The cheapest honest version: build a real initial state and
    // attach this board to it, then let checkInvariants judge it.
    const state = createInitialState({ seed: 1, content });
    const withBoard = { ...state, board: buildPreviewBoard(content) };
    expect(checkInvariants(withBoard)).toEqual([]);
  });

  it('touches all three floors, both a rotated tile and an open doorway', () => {
    const board = buildPreviewBoard(content);
    const byFloor = (floor: Floor) => tileViewsForFloor(board, content, floor);
    expect(byFloor('basement').length).toBeGreaterThan(0);
    expect(byFloor('ground').length).toBeGreaterThan(0);
    expect(byFloor('upper').length).toBeGreaterThan(0);

    const allViews = [...byFloor('basement'), ...byFloor('ground'), ...byFloor('upper')];
    expect(allViews.some((v) => v.rotation !== 0)).toBe(true);

    const symbols = new Set(allViews.map((v) => v.symbol));
    expect(symbols.has('item')).toBe(true);
    expect(symbols.has('event')).toBe(true);
    expect(symbols.has('omen')).toBe(true);

    const doorwayCount = (['basement', 'ground', 'upper'] as Floor[]).reduce(
      (n, floor) => n + openDoorways(byFloor(floor)).length,
      0,
    );
    expect(doorwayCount).toBeGreaterThan(0);
  });
});
