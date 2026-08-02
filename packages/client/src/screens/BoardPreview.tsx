/**
 * Dev-only board preview (docs/07-ui.md#73-board-rendering).
 *
 * The movement graph now exists (`getReachable`, wired in Game.tsx), so this
 * screen is no longer standing in for one. It stays because it renders with
 * no server and no engine at all — a plain BoardState built by hand — which
 * is worth having for pure rendering work: tile size, floor tints, rotation,
 * and door notches can be judged without creating a room. The fixture's five
 * starting tiles plus enough extra placements touch all three floors, both a
 * rotated tile and an open doorway, and all three card symbols.
 *
 * `buildPreviewBoard` is exported separately from the component so
 * layout.test.ts can assert its doors actually meet their neighbours
 * (see "the BoardPreview board" in that file) without importing React.
 */

import { useMemo, useState } from 'react';
import type {
  BoardState,
  Colour,
  Floor,
  PlacedId,
  PlacedTile,
  Rotation,
} from '@bahoth/shared';
import { FLOORS, cellKey, placedIdFor } from '@bahoth/shared';
import type { Content } from '@bahoth/content';
import { fixtureContent } from '@bahoth/content';
import { Board } from '../board/Board.js';
import type { Pawn } from '../board/Board.js';
import { FloorTabs } from '../board/FloorTabs.js';

/**
 * A hand-placed tile. Its PlacedId is minted the same way the engine mints
 * one — `placedIdFor(floor, x, y)` — rather than the tile id standing in for
 * it. Invariant 3b (packages/engine/src/invariants.ts) requires exactly that
 * agreement, and nothing here reaches the engine to catch a drift by itself.
 */
interface Placement {
  tileId: string;
  floor: Floor;
  x: number;
  y: number;
  rotation: Rotation;
}

/**
 * Extra placements beyond the fixture's starting layout (entrance hall,
 * foyer, grand staircase, and the two landings). Every door here has been
 * checked by hand against rotateDoors so it meets the neighbour it faces —
 * see the comment on each tile. layout.test.ts re-checks this mechanically
 * so it cannot silently rot as the fixture content changes.
 */
const EXTRA_PLACEMENTS: readonly Placement[] = [
  // North of the foyer's east door (true) — needs a door on its own west
  // side, which tile.mud_room only has once rotated 90 (n,e,s,w -> w,n,e,s).
  { tileId: 'tile.mud_room', floor: 'ground', x: 1, y: 1, rotation: 90 },

  // North of the basement landing's north door (true) — root_cellar prints
  // n+e only, so it needs its south door, which rotating 180 gives it. Its
  // two printed doors are always adjacent (n+e, e+s, s+w, or w+n depending on
  // rotation), so this tile can NEVER show both a north and a south door at
  // once — it is a dead end for anything trying to continue north from here.
  { tileId: 'tile.root_cellar', floor: 'basement', x: 0, y: -1, rotation: 180 },
  // East of the landing's east door (true) — fungal_grotto prints n only, so
  // it needs its west door, which rotating 270 gives it. Also the omen symbol.
  { tileId: 'tile.fungal_grotto', floor: 'basement', x: 1, y: 0, rotation: 270 },
  // West of the landing's west door (true, otherwise unused) — sunken_cistern
  // prints opposite n+s doors, so rotating 90 turns that pair into e+w: e
  // meets the landing, w is left open. This is deliberately NOT chained off
  // root_cellar (which a first draft did, at (0,-2)) — root_cellar can never
  // expose a north door while its south door holds the landing connection
  // (see above), so a tile placed there is unreachable, not merely rotated
  // wrong. Every placed tile must be reachable from its floor's landing;
  // layout.test.ts walks the door graph from each landing and asserts this.
  { tileId: 'tile.sunken_cistern', floor: 'basement', x: -1, y: 0, rotation: 90 },

  // North of the upper landing's north door (true) — linen_press prints a
  // bare south door already, no rotation needed. Also the item symbol.
  { tileId: 'tile.linen_press', floor: 'upper', x: 0, y: -1, rotation: 0 },
  // East of the landing's east door (true) — moth_closet prints e only, so it
  // needs its west door, which rotating 180 gives it. Also the omen symbol.
  { tileId: 'tile.moth_closet', floor: 'upper', x: 1, y: 0, rotation: 180 },
];

export function buildPreviewBoard(content: Content): BoardState {
  const placements: Placement[] = [
    ...content.house.layout.map((p) => ({
      tileId: p.tileId,
      floor: p.floor,
      x: p.x,
      y: p.y,
      rotation: p.rotation,
    })),
    ...EXTRA_PLACEMENTS,
  ];

  const placed: Record<string, PlacedTile> = {};
  const index: BoardState['index'] = { basement: {}, ground: {}, upper: {} };
  for (const p of placements) {
    const id = placedIdFor(p.floor, p.x, p.y);
    placed[id] = {
      id,
      tileId: p.tileId,
      floor: p.floor,
      x: p.x,
      y: p.y,
      rotation: p.rotation,
      discoveredBy: null,
      flags: {},
    };
    index[p.floor][cellKey(p.x, p.y)] = id;
  }
  return { placed, index };
}

/**
 * A few pawns scattered around the preview so fan-out and colour pairing are
 * visible. Keyed by tileId, not by the derived PlacedId string — resolved
 * against the actual placements below, so a coordinate change in
 * EXTRA_PLACEMENTS cannot silently orphan a pawn onto an id nobody placed.
 */
const PREVIEW_PAWNS: ReadonlyArray<{
  tileId: string;
  colour: Colour;
  initial: string;
  isMe: boolean;
}> = [
  { tileId: 'tile.entrance_hall', colour: 'red', initial: 'O', isMe: true },
  { tileId: 'tile.entrance_hall', colour: 'blue', initial: 'V', isMe: false },
  { tileId: 'tile.foyer', colour: 'yellow', initial: 'M', isMe: false },
];

/**
 * Stand-in for `getReachable` — this screen has no engine to ask. Keyed by
 * tileId for the same reason as PREVIEW_PAWNS above; resolved to real
 * PlacedIds against the board this preview actually built.
 */
const PREVIEW_REACHABLE: Record<Floor, readonly string[]> = {
  ground: ['tile.foyer', 'tile.mud_room'],
  basement: ['tile.root_cellar'],
  upper: ['tile.linen_press'],
};

/** The placement for a given tile id, or undefined if this preview never placed one. */
function placementFor(board: BoardState, tileId: string): PlacedTile | undefined {
  return Object.values(board.placed).find((p) => p.tileId === tileId);
}

export function BoardPreview() {
  const content = fixtureContent();
  const [board] = useState(() => buildPreviewBoard(content));
  const [floor, setFloor] = useState<Floor>('ground');

  const pawnsByFloor = useMemo(() => {
    const byFloor: Record<Floor, Pawn[]> = { basement: [], ground: [], upper: [] };
    for (const pawn of PREVIEW_PAWNS) {
      const placement = placementFor(board, pawn.tileId);
      if (!placement) continue;
      byFloor[placement.floor].push({
        placedId: placement.id,
        colour: pawn.colour,
        initial: pawn.initial,
        isMe: pawn.isMe,
      });
    }
    return byFloor;
  }, [board]);

  const reachableByFloor = useMemo(() => {
    const byFloor: Record<Floor, PlacedId[]> = { basement: [], ground: [], upper: [] };
    for (const f of FLOORS) {
      for (const tileId of PREVIEW_REACHABLE[f]) {
        const placement = placementFor(board, tileId);
        if (placement) byFloor[f].push(placement.id);
      }
    }
    return byFloor;
  }, [board]);

  return (
    <main className="screen">
      <h1 className="title title--sm">Board preview (dev only)</h1>
      <p className="subtitle">
        Hand-built board, no server, no engine. Reachability and move handlers are stubs.
      </p>
      <FloorTabs active={floor} onSelect={setFloor} pawnsByFloor={pawnsByFloor} />
      <Board
        board={board}
        content={content}
        floor={floor}
        pawns={pawnsByFloor[floor]}
        reachable={reachableByFloor[floor]}
        onMoveTo={(placedId) => console.log('MOVE ->', placedId)}
        onMoveThrough={(placedId, dir) => console.log('MOVE_THROUGH ->', placedId, dir)}
      />
    </main>
  );
}
