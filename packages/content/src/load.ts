/**
 * Content loading and validation.
 *
 * The build must succeed and the test suite must pass with placeholder content
 * only, so CI never needs the real files (docs/01-overview.md).
 */

import {
  ContentFileSchema,
  FloorSchema,
  type Content,
  type ContentFile,
  type Tile,
} from './schemas.js';
import { hashContent } from './hash.js';

/**
 * Content is authored one file per part and validated as one object, because
 * the coherence checks cross-reference between parts — a tile's `to_floor`
 * link has to agree with the house's landings. Adding a part here is what
 * makes the server look for it in CONTENT_DIR.
 */
export const CONTENT_PARTS = ['characters', 'tiles'] as const;

export class ContentError extends Error {
  constructor(
    message: string,
    readonly source: string,
  ) {
    super(`${message} (source: ${source})`);
    this.name = 'ContentError';
  }
}

/**
 * Validate a raw parsed content object and index it. Pure — no filesystem
 * access, so this is safe to call from the client with fetched JSON.
 */
export function buildContent(raw: unknown, source = 'unknown'): Content {
  const parsed = ContentFileSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 10)
      .map((i) => `  ${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('\n');
    throw new ContentError(`Content failed validation:\n${issues}`, source);
  }

  const file: ContentFile = parsed.data;
  assertCoherent(file, source);

  const charactersById: Record<string, (typeof file.characters)[number]> = {};
  for (const c of file.characters) charactersById[c.id] = c;

  const tilesById: Record<string, Tile> = {};
  for (const t of file.tiles) tilesById[t.id] = t;

  return {
    hash: hashContent(file),
    characters: file.characters,
    charactersById,
    tiles: file.tiles,
    tilesById,
    house: file.house,
    deckTiles: buildTileDeck(file),
  };
}

/**
 * The tile draw deck: every tile that is not already on the board, one entry
 * per printed copy, in file order. Deliberately unshuffled — shuffling belongs
 * to the engine, with the seeded RNG that lives in state.
 */
function buildTileDeck(file: ContentFile): string[] {
  const preplaced = new Set(file.house.layout.map((p) => p.tileId));
  const deck: string[] = [];
  for (const tile of file.tiles) {
    if (preplaced.has(tile.id)) continue;
    for (let i = 0; i < tile.copies; i++) deck.push(tile.id);
  }
  return deck;
}

/**
 * Cross-references that a per-field schema cannot express. These are the
 * tripwires for transcription errors while entering content by hand
 * (docs/10-testing-and-ops.md#content-validation-tests).
 */
function assertCoherent(file: ContentFile, source: string): void {
  assertCharactersCoherent(file, source);
  assertTilesCoherent(file, source);
  assertHouseCoherent(file, source);
}

function assertCharactersCoherent(file: ContentFile, source: string): void {
  const seen = new Set<string>();
  for (const c of file.characters) {
    if (seen.has(c.id)) throw new ContentError(`Duplicate character id: ${c.id}`, source);
    seen.add(c.id);

    for (const [trait, track] of Object.entries(c.tracks)) {
      const startIndex = c.start[trait as keyof typeof c.start];
      if (track[startIndex] === null || track[startIndex] === undefined) {
        throw new ContentError(
          `Character ${c.id} starts ${trait} at index ${startIndex}, which is not a playable slot`,
          source,
        );
      }
    }
  }
}

function assertTilesCoherent(file: ContentFile, source: string): void {
  const byId = new Map<string, Tile>();
  for (const tile of file.tiles) {
    if (byId.has(tile.id))
      throw new ContentError(`Duplicate tile id: ${tile.id}`, source);
    byId.set(tile.id, tile);

    // A tile with no doors can never be entered: discovery would have to place
    // it against a doorway it cannot meet at any rotation.
    if (!Object.values(tile.doors).some(Boolean)) {
      throw new ContentError(`Tile ${tile.id} has no doors`, source);
    }
    if (new Set(tile.floors).size !== tile.floors.length) {
      throw new ContentError(`Tile ${tile.id} lists a floor twice`, source);
    }
  }

  for (const tile of file.tiles) {
    for (const link of tile.staticLinks) {
      switch (link.kind) {
        case 'to_tile': {
          if (link.target === tile.id) {
            throw new ContentError(`Tile ${tile.id} links to itself`, source);
          }
          if (!byId.has(link.target)) {
            throw new ContentError(
              `Tile ${tile.id} links to unknown tile ${link.target}`,
              source,
            );
          }
          break;
        }
        case 'to_floor': {
          const declared = file.house.landings[link.floor];
          if (link.landing !== declared) {
            throw new ContentError(
              `Tile ${tile.id} treats ${link.landing} as the ${link.floor} landing, but the house declares ${declared ?? 'none'}`,
              source,
            );
          }
          break;
        }
        case 'oneway_drop': {
          // Dropping onto a floor the tile may itself occupy is a link from a
          // room to itself, on any game where it lands there.
          if (tile.floors.includes(link.floor)) {
            throw new ContentError(
              `Tile ${tile.id} drops to the ${link.floor}, which it may also be placed on`,
              source,
            );
          }
          break;
        }
      }
    }
  }

  // A floor with no legal tile deadlocks the first discovery made on it: the
  // search runs the whole deck, finds nothing, and there is no rule for that.
  const deck = buildTileDeck(file);
  if (deck.length === 0) throw new ContentError('The tile deck is empty', source);
  for (const floor of FloorSchema.options) {
    if (!deck.some((id) => byId.get(id)?.floors.includes(floor))) {
      throw new ContentError(`No drawable tile may be placed on the ${floor}`, source);
    }
  }
}

function assertHouseCoherent(file: ContentFile, source: string): void {
  const byId = new Map(file.tiles.map((t) => [t.id, t]));
  const cells = new Set<string>();
  const placedIds = new Set<string>();

  for (const placed of file.house.layout) {
    const tile = byId.get(placed.tileId);
    if (!tile) {
      throw new ContentError(
        `The starting layout places unknown tile ${placed.tileId}`,
        source,
      );
    }
    if (placedIds.has(placed.tileId)) {
      throw new ContentError(
        `The starting layout places ${placed.tileId} more than once`,
        source,
      );
    }
    placedIds.add(placed.tileId);

    if (!tile.floors.includes(placed.floor)) {
      throw new ContentError(
        `The starting layout places ${placed.tileId} on the ${placed.floor}, which it does not allow`,
        source,
      );
    }
    // A pre-placed tile is never in the deck, so its extra copies would not be
    // drawable — they would simply disappear.
    if (tile.copies !== 1) {
      throw new ContentError(
        `Pre-placed tile ${placed.tileId} declares ${tile.copies} copies`,
        source,
      );
    }

    const cell = `${placed.floor}:${placed.x},${placed.y}`;
    if (cells.has(cell)) {
      throw new ContentError(`Two starting tiles share the cell ${cell}`, source);
    }
    cells.add(cell);
  }

  if (!placedIds.has(file.house.startTile)) {
    throw new ContentError(
      `Explorers start in ${file.house.startTile}, which the starting layout does not place`,
      source,
    );
  }

  for (const floor of FloorSchema.options) {
    const landing = file.house.landings[floor];
    if (landing === undefined) {
      throw new ContentError(`The ${floor} declares no landing`, source);
    }
    const placed = file.house.layout.find((p) => p.tileId === landing);
    if (!placed || placed.floor !== floor) {
      throw new ContentError(
        `The ${floor} landing ${landing} is not pre-placed on the ${floor}`,
        source,
      );
    }
  }
}
