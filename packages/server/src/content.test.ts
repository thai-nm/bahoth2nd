/**
 * The content endpoint.
 *
 * The client rebuilds the whole bundle from this payload and compares hashes
 * before it may join a room (docs/06-networking.md#67-content-hash-check), so
 * a part the server forgets to serve is not a missing feature — it is every
 * client locked out of every room. That is what this test is here to catch.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { buildContent } from '@bahoth/content';

// config.ts reads process.env at import time, so this must happen before the
// server module is imported.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bahoth-content-test-'));
process.env.DATA_DIR = dataDir;
process.env.LOG_LEVEL = 'error';

const { createServer } = await import('./index.js');

describe('GET /api/content', () => {
  let server: Server;
  let rooms: ReturnType<typeof createServer>['rooms'];
  let url: string;

  beforeAll(async () => {
    ({ server, rooms } = createServer());
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    url = `http://127.0.0.1:${port}/api/content`;
  });

  afterAll(async () => {
    rooms.closeAll();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('serves a payload that rebuilds to the same hash', async () => {
    const res = await fetch(url);
    expect(res.status).toBe(200);
    const raw = (await res.json()) as { hash: string };

    // Exactly what the client does with it.
    const rebuilt = buildContent(raw, 'test');
    expect(rebuilt.hash).toBe(raw.hash);
    expect(rebuilt.tiles.length).toBeGreaterThan(0);
    expect(rebuilt.house.startTile).toBeTruthy();
  });
});
