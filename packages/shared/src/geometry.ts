/**
 * Rotation and grid primitives. See docs/04-data-model.md#tile and
 * docs/04-data-model.md#the-house.
 *
 * The movement graph (engine) and the board renderer (client) both need to
 * turn a tile's unrotated doors into effective doors and walk from a cell to
 * its neighbour. Putting the math here, rather than in either consumer,
 * is what guarantees they can never disagree about where a door points.
 */

import type { Dir, Floor, PlacedId, Rotation } from './ids.js';

export type Doors = Record<Dir, boolean>;

/** Clockwise, matching Rotation. */
export const DIR_ORDER: readonly Dir[] = ['n', 'e', 's', 'w'];

export const OPPOSITE: Readonly<Record<Dir, Dir>> = {
  n: 's',
  e: 'w',
  s: 'n',
  w: 'e',
};

/** +x east, +y south — screen order. See docs/04-data-model.md#the-house. */
export const DELTA: Readonly<Record<Dir, readonly [number, number]>> = {
  n: [0, -1],
  e: [1, 0],
  s: [0, 1],
  w: [-1, 0],
};

/** One 90-degree clockwise step: what is on `n` moves to `e`. */
function stepClockwise(doors: Doors): Doors {
  return { n: doors.w, e: doors.n, s: doors.e, w: doors.s };
}

/**
 * A tile stores its doors in the unrotated frame; the placement stores the
 * rotation (docs/04-data-model.md#tile). Rotation is clockwise, so at 90 a
 * door on `n` ends up on `e` — applying stepClockwise once per 90 degrees.
 */
export function rotateDoors(doors: Doors, rotation: Rotation): Doors {
  let out: Doors = { n: doors.n, e: doors.e, s: doors.s, w: doors.w };
  for (let steps = rotation / 90; steps > 0; steps--) {
    out = stepClockwise(out);
  }
  return out;
}

export function doorDirs(doors: Doors): Dir[] {
  return DIR_ORDER.filter((dir) => doors[dir]);
}

export function neighbourCell(x: number, y: number, dir: Dir): [number, number] {
  const [dx, dy] = DELTA[dir];
  return [x + dx, y + dy];
}

/** Must match the key format BoardState.index uses (packages/shared/src/state.ts). */
export function cellKey(x: number, y: number): string {
  return `${x},${y}`;
}

/**
 * A placed tile's id is derived from its cell rather than stored as a
 * counter in state. Invariant 3 already forbids two tiles sharing a cell, so
 * cell-derived ids are unique by a check that already runs on every
 * reduction — no sequence to get out of step on replay, and the id is
 * readable in a log (docs/04-data-model.md#the-house).
 */
export function placedIdFor(floor: Floor, x: number, y: number): PlacedId {
  return `${floor}:${x},${y}`;
}
