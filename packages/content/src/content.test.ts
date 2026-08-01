/**
 * Content validation tests (docs/10-testing-and-ops.md#content-validation-tests).
 *
 * Two jobs. The first half is a tripwire for transcription errors: counts and
 * cross-references over the fixture, which will be re-run against real content
 * the moment it exists. The second half asserts that every coherence check
 * actually rejects the mistake it claims to catch — a validator nobody has
 * seen fail is not a validator.
 */

import { describe, expect, it } from 'vitest';
import charactersJson from '../fixtures/characters.json' with { type: 'json' };
import tilesJson from '../fixtures/tiles.json' with { type: 'json' };
import { COLOURS } from '@bahoth/shared';
import { buildContent, ContentError } from './load.js';
import { fixtureContent } from './fixtures.js';
import { ColourSchema, FloorSchema } from './schemas.js';

/** Content before validation is exactly as untyped as the JSON it came from. */
type Raw = Record<string, any>;

/** A fresh mutable copy of the fixture, as it arrives before validation. */
function raw(): Raw {
  return structuredClone({ ...charactersJson, ...tilesJson }) as Raw;
}

function tileIn(file: Raw, id: string): Raw {
  const tile = file.tiles.find((t: Raw) => t.id === id);
  if (!tile) throw new Error(`fixture has no ${id}; this test needs updating`);
  return tile;
}

function expectRejected(file: Raw, match: RegExp): void {
  expect(() => buildContent(file, 'test')).toThrow(ContentError);
  expect(() => buildContent(file, 'test')).toThrow(match);
}

describe('the fixture house', () => {
  const content = fixtureContent();

  it('has the expected component counts', () => {
    // The tripwire. 44 room tiles, plus the three starting rooms and the two
    // landings, is the shape docs/02-rules-model.md#21 describes.
    expect(content.house.layout).toHaveLength(5);
    expect(content.deckTiles).toHaveLength(44);
    expect(content.tiles).toHaveLength(49);
    expect(content.characters).toHaveLength(12);
  });

  it('gives every explorer somewhere to start', () => {
    const start = content.house.layout.find((p) => p.tileId === content.house.startTile);
    expect(start).toBeDefined();
    expect(start?.floor).toBe('ground');
  });

  it('can discover a room on every floor', () => {
    for (const floor of FloorSchema.options) {
      const legal = content.deckTiles.filter((id) =>
        content.tilesById[id]?.floors.includes(floor),
      );
      expect(legal.length, `no drawable tile for the ${floor}`).toBeGreaterThan(0);
    }
  });

  it('resolves every static link', () => {
    const links = content.tiles.flatMap((t) => t.staticLinks.map((l) => [t, l] as const));
    // The graph is only interesting if the content actually exercises it.
    expect(links.length).toBeGreaterThanOrEqual(4);
    const kinds = new Set(links.map(([, l]) => l.kind));
    expect(kinds).toEqual(new Set(['to_tile', 'to_floor', 'oneway_drop']));

    for (const [tile, link] of links) {
      if (link.kind === 'to_tile') {
        expect(
          content.tilesById[link.target],
          `${tile.id} -> ${link.target}`,
        ).toBeDefined();
      } else if (link.kind === 'to_floor') {
        expect(link.landing).toBe(content.house.landings[link.floor]);
      } else {
        expect(tile.floors).not.toContain(link.floor);
      }
    }
  });

  it('gives every tile a door and a legal floor to sit on', () => {
    for (const tile of content.tiles) {
      expect(Object.values(tile.doors).some(Boolean), `${tile.id} has no door`).toBe(
        true,
      );
      expect(tile.floors.length).toBeGreaterThan(0);
    }
    for (const placed of content.house.layout) {
      expect(content.tilesById[placed.tileId]?.floors).toContain(placed.floor);
    }
  });

  it('leaves the deck unshuffled and one entry per copy', () => {
    const file = raw();
    tileIn(file, 'tile.bare_room').copies = 3;
    const built = buildContent(file, 'test');

    expect(built.deckTiles).toHaveLength(46);
    expect(built.deckTiles.filter((id) => id === 'tile.bare_room')).toHaveLength(3);
    // File order, so a given content bundle always deals the same deck before
    // the engine's seeded shuffle touches it.
    const again = raw();
    tileIn(again, 'tile.bare_room').copies = 3;
    expect(built.deckTiles).toEqual(buildContent(again, 'test').deckTiles);
  });

  it('keeps no pre-placed tile in the deck', () => {
    for (const placed of content.house.layout) {
      expect(content.deckTiles).not.toContain(placed.tileId);
    }
  });
});

describe('the content hash', () => {
  it('is stable for identical input and moves when a tile changes', () => {
    const a = buildContent(raw(), 'test');
    const b = buildContent(raw(), 'test');
    expect(a.hash).toBe(b.hash);

    const changed = raw();
    tileIn(changed, 'tile.long_hallway').doors.e = true;
    expect(buildContent(changed, 'test').hash).not.toBe(a.hash);
  });
});

describe('the Colour enum', () => {
  it('matches @bahoth/shared COLOURS exactly', () => {
    // Colour is a domain enum, not a content or rendering concern, so it is
    // hand-written once in packages/shared/src/ids.ts (docs/03-architecture.md
    // #dependency-rules) rather than derived from this schema. This is the
    // tripwire: add a colour here without updating shared (or vice versa) and
    // this fails loudly instead of the client silently disagreeing.
    expect(ColourSchema.options).toEqual(COLOURS);
  });
});

describe('coherence checks reject', () => {
  it('a duplicate tile id', () => {
    const file = raw();
    file.tiles.push(structuredClone(tileIn(file, 'tile.bare_room')));
    expectRejected(file, /Duplicate tile id/);
  });

  it('a tile with no doors', () => {
    const file = raw();
    tileIn(file, 'tile.bare_room').doors = { n: false, e: false, s: false, w: false };
    expectRejected(file, /has no doors/);
  });

  it('a tile that lists a floor twice', () => {
    const file = raw();
    tileIn(file, 'tile.bare_room').floors = ['ground', 'ground'];
    expectRejected(file, /lists a floor twice/);
  });

  it('a link to a tile that does not exist', () => {
    const file = raw();
    tileIn(file, 'tile.hidden_stair').staticLinks = [
      { kind: 'to_tile', target: 'tile.nowhere', twoWay: true },
    ];
    expectRejected(file, /links to unknown tile/);
  });

  it('a link from a tile to itself', () => {
    const file = raw();
    tileIn(file, 'tile.hidden_stair').staticLinks = [
      { kind: 'to_tile', target: 'tile.hidden_stair', twoWay: true },
    ];
    expectRejected(file, /links to itself/);
  });

  it('a floor link that disagrees with the house about the landing', () => {
    const file = raw();
    tileIn(file, 'tile.rattling_lift').staticLinks = [
      { kind: 'to_floor', floor: 'upper', landing: 'tile.foyer', twoWay: true },
    ];
    expectRejected(file, /the house declares/);
  });

  it('a drop onto a floor the tile may itself be placed on', () => {
    const file = raw();
    tileIn(file, 'tile.coal_slide').floors = ['basement', 'ground'];
    expectRejected(file, /which it may also be placed on/);
  });

  it('a floor with nothing drawable on it', () => {
    const file = raw();
    for (const tile of file.tiles as Raw[]) {
      if (tile.floors.includes('upper')) {
        tile.floors = tile.floors.filter((f: string) => f !== 'upper');
      }
      if (tile.floors.length === 0) tile.floors = ['ground'];
    }
    // The upper landing has to stay upstairs or the layout fails first.
    tileIn(file, 'tile.upper_landing').floors = ['upper'];
    expectRejected(file, /No drawable tile may be placed on the upper/);
  });

  it('an empty deck', () => {
    const file = raw();
    file.tiles = file.tiles.filter((t: Raw) =>
      file.house.layout.some((p: Raw) => p.tileId === t.id),
    );
    expectRejected(file, /tile deck is empty/);
  });

  it('a starting layout that places a tile it has never heard of', () => {
    const file = raw();
    file.house.layout[0].tileId = 'tile.nowhere';
    expectRejected(file, /places unknown tile/);
  });

  it('a starting layout that places one tile twice', () => {
    const file = raw();
    file.house.layout.push({ ...file.house.layout[0], x: 9, y: 9 });
    expectRejected(file, /more than once/);
  });

  it('a starting tile on a floor it does not allow', () => {
    const file = raw();
    file.house.layout[0].floor = 'upper';
    expectRejected(file, /which it does not allow/);
  });

  it('two starting tiles in one cell', () => {
    const file = raw();
    file.house.layout[1].x = file.house.layout[0].x;
    file.house.layout[1].y = file.house.layout[0].y;
    expectRejected(file, /share the cell/);
  });

  it('a pre-placed tile that declares extra copies', () => {
    const file = raw();
    tileIn(file, 'tile.foyer').copies = 2;
    expectRejected(file, /declares 2 copies/);
  });

  it('a start tile that is not on the board', () => {
    const file = raw();
    file.house.startTile = 'tile.bare_room';
    expectRejected(file, /the starting layout does not place/);
  });

  it('a landing that is not pre-placed on its own floor', () => {
    const file = raw();
    file.house.landings.upper = 'tile.foyer';
    // Keep the lift's link agreeing with the house so this is the only fault.
    tileIn(file, 'tile.rattling_lift').staticLinks = [];
    expectRejected(file, /is not pre-placed on the upper/);
  });

  it('a character who starts on the skull', () => {
    const file = raw();
    file.characters[0].start.might = 0;
    expectRejected(file, /failed validation/);
  });
});
