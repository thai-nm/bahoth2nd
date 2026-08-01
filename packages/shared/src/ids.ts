/**
 * Primitive id types. See docs/04-data-model.md#41-primitives.
 *
 * These are branded-by-convention string aliases rather than nominal types:
 * the ergonomic cost of true branding is not worth it while the surface is
 * this small, but the aliases still document intent at every call site.
 */

export type SeatId = string;
export type RoomCode = string;
export type TileId = string;
export type CardId = string;
export type PlacedId = string;
export type CharId = string;
export type MonsterId = string;
export type HauntId = number;

export type Floor = 'basement' | 'ground' | 'upper';
export type Dir = 'n' | 'e' | 's' | 'w';
export type Rotation = 0 | 90 | 180 | 270;
export type Trait = 'speed' | 'might' | 'sanity' | 'knowledge';
export type DeckKind = 'item' | 'event' | 'omen';
/** The six explorer colours. Mirrored by ColourSchema in packages/content/src/schemas.ts — content.test.ts asserts the two never drift. */
export type Colour = 'red' | 'green' | 'blue' | 'white' | 'purple' | 'yellow';

export const FLOORS: readonly Floor[] = ['basement', 'ground', 'upper'];
export const DIRS: readonly Dir[] = ['n', 'e', 's', 'w'];
export const ROTATIONS: readonly Rotation[] = [0, 90, 180, 270];
export const TRAITS: readonly Trait[] = ['speed', 'might', 'sanity', 'knowledge'];
export const DECK_KINDS: readonly DeckKind[] = ['item', 'event', 'omen'];
export const COLOURS: readonly Colour[] = [
  'red',
  'green',
  'blue',
  'white',
  'purple',
  'yellow',
];

/** Speed and Might. Physical damage is assigned across these. */
export const PHYSICAL_TRAITS: readonly Trait[] = ['speed', 'might'];
/** Sanity and Knowledge. Mental damage is assigned across these. */
export const MENTAL_TRAITS: readonly Trait[] = ['sanity', 'knowledge'];

/**
 * Room codes avoid vowels so they cannot accidentally spell words, and drop
 * the glyphs that are ambiguous in most fonts (I/1, O/0, S/5).
 */
export const ROOM_CODE_ALPHABET = 'BCDFGHJKLMNPQRTVWXYZ2346789';
export const ROOM_CODE_LENGTH = 5;
