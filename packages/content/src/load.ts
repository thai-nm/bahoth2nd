/**
 * Content loading and validation.
 *
 * The build must succeed and the test suite must pass with placeholder content
 * only, so CI never needs the real files (docs/01-overview.md).
 */

import { ContentFileSchema, type Content, type ContentFile } from './schemas.js';
import { hashContent } from './hash.js';

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

  return {
    hash: hashContent(file),
    characters: file.characters,
    charactersById,
  };
}

/**
 * Cross-references that a per-field schema cannot express. These are the
 * tripwires for transcription errors while entering content by hand
 * (docs/10-testing-and-ops.md#content-validation-tests).
 */
function assertCoherent(file: ContentFile, source: string): void {
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
