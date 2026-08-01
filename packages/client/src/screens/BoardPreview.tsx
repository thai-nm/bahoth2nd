/**
 * Dev-only board preview (docs/07-ui.md#73-board-rendering).
 *
 * The movement graph does not exist yet (M2 prerequisite work only), so there
 * is no real game to render the board against. This screen fabricates a
 * BoardState by hand — the fixture's five starting tiles plus enough extra
 * placements to touch all three floors, both a rotated tile and an open
 * doorway, and all three card symbols — so tile size, floor tints, rotation,
 * and door notches can be judged before anything else is built.
 *
 * `buildPreviewBoard` is exported separately from the component so
 * layout.test.ts can assert its doors actually meet their neighbours
 * (see "the BoardPreview board" in that file) without importing React.
 */

import { useState } from 'react';
import type { BoardState, Floor, PlacedTile, Rotation } from '@bahoth/shared';
import { cellKey } from '@bahoth/shared';
import type { Content } from '@bahoth/content';
import { fixtureContent } from '@bahoth/content';
import { Board } from '../board/Board.js';
import { FloorTabs } from '../board/FloorTabs.js';
import type { Colour } from '../board/colour.js';

/** A hand-placed tile. `id` doubles as the PlacedId — one instance per tile in this preview. */
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
  // n+e only, so it needs its south door, which rotating 180 gives it.
  { tileId: 'tile.root_cellar', floor: 'basement', x: 0, y: -1, rotation: 180 },
  // East of the landing's east door (true) — fungal_grotto prints n only, so
  // it needs its west door, which rotating 270 gives it. Also the omen symbol.
  { tileId: 'tile.fungal_grotto', floor: 'basement', x: 1, y: 0, rotation: 270 },
  // Deliberately unconnected to anything else: two open doorways (n, s) and
  // the event symbol, at no risk of a door mismatch since it has no neighbours.
  { tileId: 'tile.sunken_cistern', floor: 'basement', x: 0, y: -3, rotation: 0 },

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
    // One copy of each tile in this preview, so the tile id doubles as a
    // stable PlacedId — there is no engine here to mint instance ids.
    const id = p.tileId;
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

/** A few pawns scattered around the preview so fan-out and colour pairing are visible. */
const PREVIEW_PAWNS: ReadonlyArray<{
  placedId: string;
  colour: Colour;
  initial: string;
  isMe: boolean;
}> = [
  { placedId: 'tile.entrance_hall', colour: 'red', initial: 'O', isMe: true },
  { placedId: 'tile.entrance_hall', colour: 'blue', initial: 'V', isMe: false },
  { placedId: 'tile.foyer', colour: 'yellow', initial: 'M', isMe: false },
];

/** Reachable is a prop once getReachable exists (docs/07-ui.md#73); hardcoded here in the meantime. */
const PREVIEW_REACHABLE: Record<Floor, readonly string[]> = {
  ground: ['tile.foyer', 'tile.mud_room'],
  basement: ['tile.root_cellar'],
  upper: ['tile.linen_press'],
};

export function BoardPreview() {
  const content = fixtureContent();
  const [board] = useState(() => buildPreviewBoard(content));
  const [floor, setFloor] = useState<Floor>('ground');

  type PreviewPawn = (typeof PREVIEW_PAWNS)[number];
  const pawnsByFloor: Record<Floor, PreviewPawn[]> = {
    basement: [],
    ground: [],
    upper: [],
  };
  for (const pawn of PREVIEW_PAWNS) {
    const placement = board.placed[pawn.placedId];
    if (placement) pawnsByFloor[placement.floor].push(pawn);
  }

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
        reachable={PREVIEW_REACHABLE[floor]}
        onMoveTo={(placedId) => console.log('MOVE ->', placedId)}
        onMoveThrough={(placedId, dir) => console.log('MOVE_THROUGH ->', placedId, dir)}
      />
    </main>
  );
}
