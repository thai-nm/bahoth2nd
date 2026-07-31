/**
 * Server-side content loading. The server is authoritative for content, and
 * serves the same bundle to clients over GET /api/content so the hashes match.
 */

import fs from 'node:fs';
import path from 'node:path';
import { buildContent, fixtureContent, type Content } from '@bahoth/content';
import { config } from './config.js';
import { log } from './log.js';

let loaded: Content | null = null;

export function loadContent(): Content {
  if (loaded) return loaded;

  const file = path.join(config.contentDir, 'characters.json');
  if (fs.existsSync(file)) {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    // A content error here is fatal and deliberately so: starting with content
    // the operator did not intend is worse than not starting.
    loaded = buildContent(raw, file);
    log.info('content loaded', { source: file, hash: loaded.hash });
  } else {
    loaded = fixtureContent();
    log.warn('using placeholder content', {
      reason: `${file} not found`,
      hash: loaded.hash,
    });
  }
  return loaded;
}
