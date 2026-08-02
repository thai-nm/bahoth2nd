import { describe, expect, it } from 'vitest';
import {
  DELTA,
  DIR_ORDER,
  OPPOSITE,
  cellKey,
  doorDirs,
  neighbourCell,
  placedIdFor,
  rotateDoors,
} from './geometry.js';
import { ROTATIONS } from './ids.js';
import type { Doors } from './geometry.js';

/** Every door combination, keyed by treating DIR_ORDER as bits of `mask`. */
function doorsFromMask(mask: number): Doors {
  const out: Doors = { n: false, e: false, s: false, w: false };
  DIR_ORDER.forEach((dir, i) => {
    out[dir] = (mask & (1 << i)) !== 0;
  });
  return out;
}

const ALL_MASKS = Array.from({ length: 16 }, (_, i) => i);

describe('geometry', () => {
  it('rotateDoors(d, 0) returns an equal but distinct object', () => {
    const d: Doors = { n: true, e: false, s: true, w: false };
    const out = rotateDoors(d, 0);
    expect(out).toEqual(d);
    expect(out).not.toBe(d);
    out.n = false;
    expect(d.n).toBe(true);
  });

  it('rotates a single door clockwise at 90: n->e->s->w->n', () => {
    expect(rotateDoors({ n: true, e: false, s: false, w: false }, 90)).toEqual({
      n: false,
      e: true,
      s: false,
      w: false,
    });
    expect(rotateDoors({ n: false, e: true, s: false, w: false }, 90)).toEqual({
      n: false,
      e: false,
      s: true,
      w: false,
    });
    expect(rotateDoors({ n: false, e: false, s: true, w: false }, 90)).toEqual({
      n: false,
      e: false,
      s: false,
      w: true,
    });
    expect(rotateDoors({ n: false, e: false, s: false, w: true }, 90)).toEqual({
      n: true,
      e: false,
      s: false,
      w: false,
    });
  });

  it('four successive 90-degree rotations return the original, for every door combination', () => {
    for (const mask of ALL_MASKS) {
      const original = doorsFromMask(mask);
      let d = original;
      for (let i = 0; i < 4; i++) d = rotateDoors(d, 90);
      expect(d).toEqual(original);
    }
  });

  it('180 and 270 compose from repeated 90s, for every door combination', () => {
    for (const mask of ALL_MASKS) {
      const d = doorsFromMask(mask);
      expect(rotateDoors(d, 180)).toEqual(rotateDoors(rotateDoors(d, 90), 90));
      expect(rotateDoors(d, 270)).toEqual(
        rotateDoors(rotateDoors(rotateDoors(d, 90), 90), 90),
      );
    }
  });

  it('preserves the door count under every rotation, for every door combination', () => {
    for (const mask of ALL_MASKS) {
      const d = doorsFromMask(mask);
      const count = doorDirs(d).length;
      for (const rotation of ROTATIONS) {
        expect(doorDirs(rotateDoors(d, rotation))).toHaveLength(count);
      }
    }
  });

  it('OPPOSITE is an involution for every direction', () => {
    for (const dir of DIR_ORDER) {
      expect(OPPOSITE[OPPOSITE[dir]]).toBe(dir);
    }
  });

  it('neighbourCell there and back through OPPOSITE returns the original cell', () => {
    for (const dir of DIR_ORDER) {
      const [nx, ny] = neighbourCell(3, -2, dir);
      const back = neighbourCell(nx, ny, OPPOSITE[dir]);
      expect(back).toEqual([3, -2]);
    }
  });

  it('DELTA follows +x east, +y south', () => {
    expect(DELTA.n).toEqual([0, -1]);
    expect(DELTA.s).toEqual([0, 1]);
  });

  it('cellKey matches the "x,y" format BoardState.index uses', () => {
    expect(cellKey(3, -2)).toBe('3,-2');
  });

  it('placedIdFor derives an id from the cell, distinct across floors', () => {
    expect(placedIdFor('ground', 0, 2)).toBe('ground:0,2');
    // Same cell, different floor: distinct ids, since a floor is an
    // independent grid (docs/02-rules-model.md#23-the-house).
    expect(placedIdFor('basement', 0, 2)).not.toBe(placedIdFor('ground', 0, 2));
  });
});
