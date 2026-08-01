/**
 * Server-side content loading. The server is authoritative for content, and
 * serves the same bundle to clients over GET /api/content so the hashes match.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  buildContent,
  fixtureContent,
  ContentError,
  CONTENT_PARTS,
  type Content,
} from '@bahoth/content';
import { config } from './config.js';
import { log } from './log.js';

let loaded: Content | null = null;

export function loadContent(): Content {
  if (loaded) return loaded;

  const files = CONTENT_PARTS.map((part) => ({
    part,
    file: path.join(config.contentDir, `${part}.json`),
  }));
  const present = files.filter(({ file }) => fs.existsSync(file));

  if (present.length === 0) {
    loaded = fixtureContent();
    log.warn('using placeholder content', {
      reason: `no content files in ${config.contentDir}`,
      hash: loaded.hash,
    });
    return loaded;
  }

  // Half a content directory is a mistake, not a configuration. Filling the
  // gap with placeholders would seat real explorers in an invented house and
  // say nothing about it.
  if (present.length !== files.length) {
    const missing = files.filter(({ file }) => !fs.existsSync(file)).map((f) => f.file);
    throw new ContentError(
      `Content directory is incomplete; missing ${missing.join(', ')}`,
      config.contentDir,
    );
  }

  const raw: Record<string, unknown> = {};
  for (const { file } of files) {
    Object.assign(raw, JSON.parse(fs.readFileSync(file, 'utf8')) as object);
  }

  // A content error here is fatal and deliberately so: starting with content
  // the operator did not intend is worse than not starting.
  loaded = buildContent(raw, config.contentDir);
  log.info('content loaded', {
    source: config.contentDir,
    parts: CONTENT_PARTS.join(','),
    hash: loaded.hash,
  });
  return loaded;
}
