/**
 * Content schemas. See docs/04-data-model.md#43-content-schemas.
 *
 * M0 defined what the lobby needs (characters); M2 adds the house (tiles and
 * the starting layout). Cards, haunts, and the haunt table arrive in M3/M4.
 * The zod schemas are the single definition — TypeScript types are inferred
 * from them, never written twice.
 */

import { z } from 'zod';

export const FloorSchema = z.enum(['basement', 'ground', 'upper']);
export const TraitSchema = z.enum(['speed', 'might', 'sanity', 'knowledge']);
export const ColourSchema = z.enum(['red', 'green', 'blue', 'white', 'purple', 'yellow']);
export const DirSchema = z.enum(['n', 'e', 's', 'w']);
export const SymbolSchema = z.enum(['item', 'event', 'omen']);
export const RotationSchema = z.union([
  z.literal(0),
  z.literal(90),
  z.literal(180),
  z.literal(270),
]);

/**
 * Effects are content, but the vocabulary that interprets them is M3 work
 * (docs/05-engine.md#55-structure-of-the-reducer). Until the interpreter
 * exists there is nothing honest to validate against, so effects are carried
 * opaquely rather than validated against a union that is still being
 * designed. M3 replaces this with the real discriminated union; the fixtures
 * declare no effects in the meantime, so nothing is being waved through.
 */
export const EffectSchema = z.unknown();

/**
 * Exactly 9 slots. Index 0 is the skull and is encoded as null — an explorer
 * whose trait index reaches 0 is dead, so that slot never has a value.
 */
export const TrackSchema = z
  .array(z.number().nullable())
  .length(9)
  .refine((t) => t[0] === null, { message: 'Track index 0 must be null (the skull)' })
  .refine((t) => t.slice(1).every((v) => typeof v === 'number'), {
    message: 'Track indices 1-8 must all be numbers',
  });

const StartIndexSchema = z.number().int().min(1).max(8);

export const CharacterSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  colour: ColourSchema,
  tracks: z.object({
    speed: TrackSchema,
    might: TrackSchema,
    sanity: TrackSchema,
    knowledge: TrackSchema,
  }),
  start: z.object({
    speed: StartIndexSchema,
    might: StartIndexSchema,
    sanity: StartIndexSchema,
    knowledge: StartIndexSchema,
  }),
});

/**
 * Connections that ignore grid adjacency: the staircases, the lift, the
 * one-way drop. Expressing these as data rather than `if (tileId === ...)`
 * branches inside the movement code is the highest-leverage decision in the
 * content model (docs/04-data-model.md#static-links).
 *
 * `twoWay` describes the link, not the pair of tiles: one declaration on
 * either tile is enough, and the movement graph reads it from both ends.
 */
export const StaticLinkSchema = z.discriminatedUnion('kind', [
  /** Joins this tile to another specific tile, wherever either one ends up. */
  z.object({
    kind: z.literal('to_tile'),
    target: z.string().min(1),
    twoWay: z.boolean(),
  }),
  /** Joins this tile to whichever tile that floor's layout designates its landing. */
  z.object({
    kind: z.literal('to_floor'),
    floor: FloorSchema,
    landing: z.string().min(1),
    twoWay: z.boolean(),
  }),
  /** You may go down it and you may not come back — the chute. */
  z.object({
    kind: z.literal('oneway_drop'),
    floor: FloorSchema,
    effects: z.array(EffectSchema).default([]),
  }),
]);

/**
 * A room tile as printed, in its **unrotated** frame. Effective doors are
 * `rotateDoors(tile.doors, placed.rotation)` — the tile never stores its own
 * rotation, the placement does.
 */
export const TileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  doors: z.object({
    n: z.boolean(),
    e: z.boolean(),
    s: z.boolean(),
    w: z.boolean(),
  }),
  /** Floors this tile may be placed on. A drawn tile illegal here is passed over. */
  floors: z.array(FloorSchema).min(1),
  symbol: SymbolSchema.nullable(),
  copies: z.number().int().min(1).default(1),
  staticLinks: z.array(StaticLinkSchema).default([]),
  onEnter: z.array(EffectSchema).default([]),
  art: z.object({ bg: z.string(), icon: z.string().optional() }).optional(),
});

/**
 * A tile that is on the board before anyone moves: the entrance, the foyer,
 * the staircase, and the two landings.
 *
 * Coordinates are integer grid cells per floor, with **+x east and +y south**
 * — screen order, so the renderer and the movement graph agree without a flip.
 * A door on `n` therefore faces the cell at `y - 1`.
 */
export const StartingTileSchema = z.object({
  tileId: z.string().min(1),
  floor: FloorSchema,
  x: z.number().int(),
  y: z.number().int(),
  rotation: RotationSchema,
});

export const HouseSchema = z.object({
  layout: z.array(StartingTileSchema).min(1),
  /** Where every explorer starts. Must be one of the pre-placed tiles. */
  startTile: z.string().min(1),
  /**
   * The tile each floor's `to_floor` links arrive at. Declared rather than
   * inferred so a floor cannot silently end up with two candidate landings.
   */
  landings: z.record(FloorSchema, z.string().min(1)),
});

export const ContentFileSchema = z.object({
  characters: z.array(CharacterSchema).min(1),
  tiles: z.array(TileSchema).min(1),
  house: HouseSchema,
});

export type Character = z.infer<typeof CharacterSchema>;
export type Tile = z.infer<typeof TileSchema>;
export type StaticLink = z.infer<typeof StaticLinkSchema>;
export type StartingTile = z.infer<typeof StartingTileSchema>;
export type House = z.infer<typeof HouseSchema>;
export type ContentFile = z.infer<typeof ContentFileSchema>;

/**
 * The loaded, indexed content bundle handed to the engine. `hash` identifies
 * this exact content so a client with different data is refused at join time
 * rather than desyncing later (docs/06-networking.md#67-content-hash-check).
 */
export interface Content {
  hash: string;
  characters: Character[];
  charactersById: Record<string, Character>;
  tiles: Tile[];
  tilesById: Record<string, Tile>;
  house: House;
  /**
   * The draw deck as tile ids, one entry per copy, in file order: every tile
   * that is not pre-placed. Shuffling is the engine's job with the in-state
   * RNG, so this stays a deterministic list rather than a shuffled one.
   */
  deckTiles: string[];
}
