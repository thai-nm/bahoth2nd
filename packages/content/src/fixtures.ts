/**
 * Placeholder content, committed and used whenever a real CONTENT_DIR is
 * absent. Invented names and stats — see docs/01-overview.md.
 */

import charactersJson from '../fixtures/characters.json' with { type: 'json' };
import { buildContent } from './load.js';
import type { Content } from './schemas.js';

let cached: Content | null = null;

export function fixtureContent(): Content {
  cached ??= buildContent(charactersJson, 'fixtures');
  return cached;
}
