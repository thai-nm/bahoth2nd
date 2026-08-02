/**
 * Discovery mechanics tested in isolation from the reducer: `legalRotations`
 * and `drawTile` are pure and have no `pending`/event plumbing to fake, so
 * they get their own file rather than living entirely inside reduce.test.ts.
 * See docs/02-rules-model.md#24 step 3 and its [RULING] on the draw.
 */

import { describe, expect, it } from 'vitest';
import { buildContent, fixtureContent, type Content, type Tile } from '@bahoth/content';
import { DIRS, rotateDoors, type Doors, type Rotation } from '@bahoth/shared';
import { makeRng } from './rng.js';
import { drawTile, legalRotations } from './discovery.js';

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

const content = fixtureContent();

describe('legalRotations', () => {
  it('gives exactly one rotation for a one-door tile, entered from any side', () => {
    const t = tile('tile.one_door', { n: true });
    for (const entry of DIRS) {
      const rots = legalRotations(t, entry);
      expect(rots).toHaveLength(1);
      // Not hardcoding which rotation — assert the actual property: after
      // that rotation, the tile really has a door on `entry`.
      expect(rotateDoors(t.doors, rots[0]!)[entry]).toBe(true);
    }
  });

  it('dedupes a four-door tile down to exactly one rotation', () => {
    const t = tile('tile.four_door', { n: true, e: true, s: true, w: true });
    for (const entry of DIRS) {
      const rots = legalRotations(t, entry);
      expect(rots).toHaveLength(1);
    }
  });

  it('collapses an opposite-door tile to one rotation (180-degree symmetric)', () => {
    // A door on n and s is unchanged by a 180-degree turn — n and s swap,
    // but the effective set {n,s} comes back identical — so only one
    // distinct rotation survives the dedup, same as the four-door tile.
    // (This is why the two-DISTINCT-rotation case below needs adjacent
    // doors, not opposite ones: opposite doors are 180-symmetric and can
    // never produce two different effective door sets.)
    const t = tile('tile.through_hall', { n: true, s: true });
    // Every direction is a legal entry (rotate 90 degrees and the doors face
    // e/w instead), but the dedup still collapses each to one rotation.
    for (const entry of DIRS) {
      expect(legalRotations(t, entry)).toHaveLength(1);
    }
  });

  it('gives two distinct rotations for an adjacent two-door tile on either door', () => {
    // Doors on n and e have no rotational symmetry: the four rotations
    // produce four distinct door sets ({n,e}, {e,s}, {s,w}, {w,n}). Entered
    // from n, both the 0-degree set ({n,e}) and the 270-degree set ({w,n})
    // put a door on n, and they are genuinely different placements.
    const t = tile('tile.corner', { n: true, e: true });
    const rots = legalRotations(t, 'n');
    expect(rots).toHaveLength(2);
    expect(new Set(rots).size).toBe(2);
    for (const r of rots) {
      expect(rotateDoors(t.doors, r).n).toBe(true);
    }
  });

  it('is never empty for any fixture tile at any entry direction', () => {
    // A property, since moveThrough relies on this exact fact: every tile
    // that can be drawn has at least one door, and legalRotations must
    // always find a way to face it at the entry (assertTilesCoherent
    // already rejects a tile with no doors at all).
    for (const t of content.tiles) {
      for (const entry of DIRS) {
        expect(
          legalRotations(t, entry).length,
          `${t.id} entered from ${entry}`,
        ).toBeGreaterThan(0);
      }
    }
  });
});

describe('drawTile', () => {
  // Three preplaced landings (one per floor, so buildContent's coherence
  // checks pass) plus deck tiles covering every floor, so content.deckTiles
  // itself is never empty on any floor — a separate requirement from the
  // literal `deck` arrays each test hands to `drawTile` below.
  const landG = tile('tile.land_ground', { n: true }, { floors: ['ground'] });
  const landB = tile('tile.land_basement', { n: true }, { floors: ['basement'] });
  const landU = tile('tile.land_upper', { n: true }, { floors: ['upper'] });
  const bDeck = tile('tile.basement_only', { n: true }, { floors: ['basement'] });
  const uDeck = tile('tile.upper_only', { n: true }, { floors: ['upper'] });
  const b = tile('tile.ground_1', { n: true }, { floors: ['ground'] });
  const c = tile('tile.ground_2', { n: true }, { floors: ['ground'] });
  const d = tile('tile.ground_3', { n: true }, { floors: ['ground'] });
  const groundContent: Content = buildContent(
    {
      characters: fixtureContent().characters,
      tiles: [landG, landB, landU, bDeck, uDeck, b, c, d],
      house: {
        layout: [
          { tileId: landG.id, floor: 'ground', x: 0, y: 0, rotation: 0 as Rotation },
          { tileId: landB.id, floor: 'basement', x: 0, y: 0, rotation: 0 as Rotation },
          { tileId: landU.id, floor: 'upper', x: 0, y: 0, rotation: 0 as Rotation },
        ],
        startTile: landG.id,
        landings: { basement: landB.id, ground: landG.id, upper: landU.id },
      },
    },
    'discovery.test.ts',
  );

  it('skips a tile illegal on the floor and returns the first legal one', () => {
    const rng = makeRng(1);
    const draw = drawTile([bDeck.id, b.id, c.id], 'ground', groundContent, rng);
    expect(draw).not.toBeNull();
    expect(draw!.tileId).toBe(b.id);
  });

  it('keeps the passed-over tiles in the returned deck, minus the drawn one', () => {
    const rng = makeRng(1);
    const deck = [bDeck.id, bDeck.id, b.id, c.id];
    const draw = drawTile(deck, 'ground', groundContent, rng);
    expect(draw).not.toBeNull();
    expect(draw!.tileId).toBe(b.id);
    // Multiset preserved: two copies of the passed-over tile plus `c`
    // (never reached) remain; `b` (drawn) is gone.
    expect([...draw!.deck].sort()).toEqual([bDeck.id, bDeck.id, c.id].sort());
  });

  it('does not burn a random number on a plain top-of-deck draw', () => {
    const rng = makeRng(1);
    const draw = drawTile([b.id, c.id, d.id], 'ground', groundContent, rng);
    expect(draw).not.toBeNull();
    expect(draw!.rng).toEqual(rng);
  });

  it('burns randomness when it has to reshuffle passed-over tiles', () => {
    const rng = makeRng(1);
    const draw = drawTile([bDeck.id, b.id, c.id], 'ground', groundContent, rng);
    expect(draw).not.toBeNull();
    expect(draw!.rng).not.toEqual(rng);
  });

  it('returns null when no tile in the deck may go on the floor', () => {
    const rng = makeRng(1);
    const draw = drawTile([bDeck.id], 'upper', groundContent, rng);
    expect(draw).toBeNull();
  });
});
