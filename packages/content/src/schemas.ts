/**
 * Content schemas. See docs/04-data-model.md#43-content-schemas.
 *
 * M0 defines only what the lobby needs (characters). Tiles, cards, haunts,
 * and the haunt table arrive in M2/M3/M4. The zod schemas are the single
 * definition — TypeScript types are inferred from them, never written twice.
 */

import { z } from 'zod';

export const FloorSchema = z.enum(['basement', 'ground', 'upper']);
export const TraitSchema = z.enum(['speed', 'might', 'sanity', 'knowledge']);
export const ColourSchema = z.enum(['red', 'green', 'blue', 'white', 'purple', 'yellow']);

/**
 * Exactly 8 slots. Index 0 is the skull and is encoded as null — an explorer
 * whose trait index reaches 0 is dead, so that slot never has a value.
 */
export const TrackSchema = z
  .array(z.number().nullable())
  .length(8)
  .refine((t) => t[0] === null, { message: 'Track index 0 must be null (the skull)' })
  .refine((t) => t.slice(1).every((v) => typeof v === 'number'), {
    message: 'Track indices 1-7 must all be numbers',
  });

const StartIndexSchema = z.number().int().min(1).max(7);

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

export const ContentFileSchema = z.object({
  characters: z.array(CharacterSchema).min(1),
});

export type Character = z.infer<typeof CharacterSchema>;
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
}
