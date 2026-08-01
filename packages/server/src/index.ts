/**
 * Entry point. One process serves the static client bundle and the WebSocket
 * endpoint on one port — one container, one port, no CORS, no reverse proxy
 * (docs/03-architecture.md#35-build-and-deploy-shape).
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { WS_PATH } from '@bahoth/shared';
import { config } from './config.js';
import { log } from './log.js';
import { loadContent } from './content.js';
import { RoomManager } from './rooms.js';
import { Gateway } from './gateway.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

export function createServer() {
  const content = loadContent();
  const rooms = new RoomManager(content);

  const { recovered, discarded } = rooms.recover();
  if (recovered || discarded) {
    log.info('recovery complete', { recovered, discarded });
  }

  const startedAt = Date.now();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (url.pathname === '/healthz') {
      return json(res, 200, {
        ok: true,
        rooms: rooms.count(),
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
        contentHash: content.hash,
      });
    }

    if (url.pathname === '/api/content') {
      // Every field the schema validates, because the client rebuilds the
      // bundle from this payload and compares hashes. An omitted part would
      // hash differently and lock every client out of every room.
      return json(res, 200, {
        hash: content.hash,
        characters: content.characters,
        tiles: content.tiles,
        house: content.house,
      });
    }

    return serveStatic(url.pathname, res);
  });

  const wss = new WebSocketServer({ server, path: WS_PATH, maxPayload: 64 * 1024 });
  const gateway = new Gateway(wss, rooms, content);

  const evictTimer = setInterval(() => rooms.evictIdle(), 5 * 60 * 1000);
  evictTimer.unref();

  // The turn clock. Cheap by construction: the sweep only issues a TICK to a
  // room that has a deadline due.
  const tickTimer = setInterval(() => gateway.sweepTimers(), config.tickIntervalMs);
  tickTimer.unref();

  return { server, rooms, content, wss, gateway };
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function serveStatic(pathname: string, res: http.ServerResponse): void {
  if (!fs.existsSync(config.clientDir)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Client bundle not built. Run `npm run build -w @bahoth/client`.');
    return;
  }

  // Resolve inside clientDir and verify containment: a request for
  // /../../etc/passwd must not escape the served directory.
  const requested = pathname === '/' ? '/index.html' : pathname;
  const resolved = path.resolve(config.clientDir, `.${requested}`);
  const root = path.resolve(config.clientDir);
  const safe = resolved === root || resolved.startsWith(root + path.sep);

  const file =
    safe && fs.existsSync(resolved) && fs.statSync(resolved).isFile()
      ? resolved
      : path.join(root, 'index.html'); // SPA fallback

  const body = fs.readFileSync(file);
  res.writeHead(200, {
    'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
    'content-length': body.length,
  });
  res.end(body);
}

// Only listen when run directly, so tests can import createServer without
// binding a port.
const isMain =
  process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`;
if (isMain) {
  const { server, rooms } = createServer();
  server.listen(config.port, () => {
    log.info('listening', { port: config.port });
  });

  const shutdown = (signal: string) => {
    log.info('shutting down', { signal });
    rooms.closeAll();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
