import path from 'node:path';

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Environment variable ${name} must be a number, got ${raw}`);
  }
  return parsed;
}

function str(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : raw;
}

const root = process.cwd();

export const config = {
  port: num('PORT', 8080),
  /** Real content. Absent in dev and CI, where placeholder fixtures are used. */
  contentDir: str('CONTENT_DIR', path.join(root, 'content')),
  /** Per-room append-only action logs, used for crash recovery. */
  dataDir: str('DATA_DIR', path.join(root, 'data')),
  /** Static client bundle; served only if it exists. */
  clientDir: str('CLIENT_DIR', path.join(root, 'packages/client/dist')),

  roomTtlMs: num('ROOM_TTL_HOURS', 4) * 60 * 60 * 1000,
  /** Turn budget for a connected player. Baked into a room's state at creation. */
  turnTimeoutMs: num('TURN_TIMEOUT_SECONDS', 600) * 1000,
  /** The shorter budget once the active seat has dropped. */
  disconnectTimeoutMs: num('DISCONNECT_TIMEOUT_SECONDS', 90) * 1000,
  /** How long a seat must be gone before a majority vote can remove it. */
  removeGraceMs: num('REMOVE_GRACE_SECONDS', 600) * 1000,
  /**
   * How often the server checks rooms for a due deadline. This is the
   * granularity of the turn clock, not its cost: a TICK is only applied to a
   * room that actually has something due.
   */
  tickIntervalMs: num('TICK_INTERVAL_MS', 1000),

  rateLimitPerSecond: num('RATE_LIMIT_PER_SECOND', 20),
  rateLimitBurst: num('RATE_LIMIT_BURST', 50),

  logLevel: str('LOG_LEVEL', 'info'),
} as const;

export type Config = typeof config;
