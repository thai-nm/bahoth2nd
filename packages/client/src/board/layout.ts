/**
 * Pure board layout math. No DOM access — this module is unit-tested under
 * vitest's `node` environment and is shared, in spirit, between the renderer
 * and any future debug tooling that wants tile positions without a browser.
 *
 * The movement graph (`getReachable`, adjacency, connectivity) does not exist
 * yet and nothing here may depend on it. Reachability is a prop the caller
 * supplies (see Board.tsx); this module only turns placed tiles into pixel
 * geometry.
 */

import { DELTA, DIR_ORDER, cellKey, neighbourCell, rotateDoors } from '@bahoth/shared';
import type {
  BoardState,
  Dir,
  Doors,
  Floor,
  PlacedId,
  Rotation,
  TileId,
} from '@bahoth/shared';
import type { Content, Tile } from '@bahoth/content';

/** Fixed tile size in px; zoom is a `scale()` on the world, not a size change. */
export const TILE = 150;
export const MIN_ZOOM = 0.4;
export const MAX_ZOOM = 2.0;

export interface TileView {
  placedId: PlacedId;
  tileId: TileId;
  name: string;
  x: number;
  y: number;
  rotation: Rotation;
  /** rotateDoors(tile.doors, placed.rotation) — never re-derive this downstream. */
  doors: Doors;
  symbol: 'item' | 'event' | 'omen' | null;
  floors: Floor[];
  /** Cross-floor badge text, e.g. "basement", for tiles with a staticLink off this floor. */
  links: string[];
  /** Pixel position in the same raw grid-scaled space boardBounds/fitTransform work in. */
  px: number;
  py: number;
}

/**
 * One TileView per tile placed on `floor`. Doors are already rotated
 * (docs/04-data-model.md#tile: "Effective doors are rotateDoors(tile.doors,
 * placed.rotation)") so nothing downstream ever touches rotation again.
 */
export function tileViewsForFloor(
  board: BoardState,
  content: Content,
  floor: Floor,
): TileView[] {
  const views: TileView[] = [];
  for (const placed of Object.values(board.placed)) {
    if (placed.floor !== floor) continue;
    const tile = content.tilesById[placed.tileId];
    if (!tile) continue; // Coherent content never hits this; defensive against hand-built test boards.

    views.push({
      placedId: placed.id,
      tileId: placed.tileId,
      name: tile.name,
      x: placed.x,
      y: placed.y,
      rotation: placed.rotation,
      doors: rotateDoors(tile.doors, placed.rotation),
      symbol: tile.symbol,
      floors: tile.floors,
      links: crossFloorLinks(tile, placed.floor, board),
      px: placed.x * TILE,
      py: placed.y * TILE,
    });
  }
  return views;
}

/**
 * Which floors a tile's staticLinks lead to, excluding the floor it is
 * actually sitting on. `to_tile` links can only be resolved once the target
 * is itself on the board — "a link whose target is not on the board yet is
 * simply inert" (docs/04-data-model.md#static-links) — so an unplaced target
 * contributes nothing rather than guessing.
 */
function crossFloorLinks(tile: Tile, ownFloor: Floor, board: BoardState): string[] {
  const floors = new Set<Floor>();
  for (const link of tile.staticLinks) {
    let dest: Floor | null = null;
    if (link.kind === 'to_floor' || link.kind === 'oneway_drop') {
      dest = link.floor;
    } else {
      const target = Object.values(board.placed).find((p) => p.tileId === link.target);
      dest = target?.floor ?? null;
    }
    if (dest !== null && dest !== ownFloor) floors.add(dest);
  }
  return Array.from(floors);
}

/**
 * The pixel bounding box of a set of views, in the same coordinate space as
 * their px/py. An empty floor (nothing placed there yet) returns a
 * zero-sized box rather than +/-Infinity or NaN.
 */
export function boardBounds(views: TileView[]): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
} {
  if (views.length === 0) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const v of views) {
    minX = Math.min(minX, v.px);
    minY = Math.min(minY, v.py);
    maxX = Math.max(maxX, v.px + TILE);
    maxY = Math.max(maxY, v.py + TILE);
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

/**
 * A door on a placed tile facing a cell with no tile in it — the arrow the
 * player clicks to MOVE_THROUGH into an undiscovered room. Occupancy is
 * computed from the same `views` list the caller already has, not from
 * `board.index`, so this stays usable against hand-built test boards that
 * never bothered to populate that derived field.
 */
export function openDoorways(
  views: TileView[],
): Array<{ placedId: PlacedId; dir: Dir; px: number; py: number }> {
  const occupied = new Set(views.map((v) => cellKey(v.x, v.y)));
  const out: Array<{ placedId: PlacedId; dir: Dir; px: number; py: number }> = [];
  for (const v of views) {
    for (const dir of DIR_ORDER) {
      if (!v.doors[dir]) continue;
      const [nx, ny] = neighbourCell(v.x, v.y, dir);
      if (occupied.has(cellKey(nx, ny))) continue;

      const [dx, dy] = DELTA[dir];
      out.push({
        placedId: v.placedId,
        dir,
        px: v.px + TILE / 2 + dx * (TILE / 2),
        py: v.py + TILE / 2 + dy * (TILE / 2),
      });
    }
  }
  return out;
}

/**
 * Centre a `width`x`height` content box inside a `viewW`x`viewH` viewport
 * with `pad` px of breathing room, never scaling above 1.0 — a small floor
 * sits at natural size rather than being blown up to fill the screen.
 *
 * Callers combine this with boardBounds().minX/minY (which is not
 * necessarily 0,0) to get the final translate.
 */
export function fitTransform(
  width: number,
  height: number,
  viewW: number,
  viewH: number,
  pad: number,
): { tx: number; ty: number; k: number } {
  if (width <= 0 || height <= 0) {
    // Empty floor: nothing to fit around. Centre the viewport on itself
    // rather than dividing by zero.
    return { tx: viewW / 2, ty: viewH / 2, k: 1 };
  }
  const availW = Math.max(viewW - 2 * pad, 0);
  const availH = Math.max(viewH - 2 * pad, 0);
  const k = Math.min(1, availW / width, availH / height);
  return { tx: (viewW - width * k) / 2, ty: (viewH - height * k) / 2, k };
}

export function clampZoom(k: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));
}
