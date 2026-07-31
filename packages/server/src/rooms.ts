/**
 * Room lifecycle and the authoritative reduction path.
 * See docs/03-architecture.md#34-server-process-model.
 *
 * One process, rooms in an in-memory Map. Each room's action log is flushed to
 * DATA_DIR as JSONL; on boot, logs younger than the eviction window are
 * replayed through the engine to rebuild state. That works precisely BECAUSE
 * the engine is deterministic — crash recovery without a database.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  MAX_PLAYERS,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  type GameAction,
  type GameEvent,
  type GameState,
  type LoggedAction,
  type PublicSeat,
  type RoomCode,
  type RuleError,
  type SeatId,
  type TurnTimers,
} from '@bahoth/shared';
import { createInitialState, getHostSeat, makeSeatId, reduce } from '@bahoth/engine';
import type { Content } from '@bahoth/content';
import { config } from './config.js';
import { log } from './log.js';

export interface Seat {
  seatId: SeatId;
  token: string;
  name: string;
  connected: boolean;
  lastSeq: number;
  disconnectedAt: number | null;
}

export interface Room {
  code: RoomCode;
  seed: number;
  seats: Map<SeatId, Seat>;
  state: GameState;
  log: LoggedAction[];
  createdAt: number;
  lastActivityAt: number;
  logStream: fs.WriteStream | null;
}

export interface ApplyResult {
  ok: boolean;
  error?: RuleError;
  events: GameEvent[];
}

export class RoomManager {
  private rooms = new Map<RoomCode, Room>();

  constructor(private readonly content: Content) {
    fs.mkdirSync(config.dataDir, { recursive: true });
  }

  // --- lifecycle -----------------------------------------------------------

  /**
   * Turn budgets are fixed per room at creation and recorded in the log
   * header, so a room replayed after a config change reproduces the deadlines
   * it actually ran with rather than today's.
   */
  private timers(): TurnTimers {
    return {
      turnMs: config.turnTimeoutMs,
      disconnectedMs: config.disconnectTimeoutMs,
    };
  }

  create(): Room {
    const code = this.uniqueCode();
    const seed = crypto.randomInt(0, 2 ** 31);
    const timers = this.timers();
    const room: Room = {
      code,
      seed,
      seats: new Map(),
      state: createInitialState({ seed, content: this.content, timers }),
      log: [],
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      logStream: null,
    };
    this.openLog(room, { fresh: true });
    this.rooms.set(code, room);
    log.info('room created', { code, seed });
    return room;
  }

  get(code: RoomCode): Room | undefined {
    return this.rooms.get(code.toUpperCase());
  }

  count(): number {
    return this.rooms.size;
  }

  all(): Room[] {
    return [...this.rooms.values()];
  }

  /**
   * Whether this room has a deadline the engine needs to be told about — an
   * unarmed turn clock, an expired turn, or an expired prompt.
   *
   * The server checks this cheaply on an interval and only then issues a
   * `TICK`, so a room costs one logged action to arm a turn's clock and one
   * more only if that turn actually times out. Ticking unconditionally would
   * write a log line per room per second.
   */
  isTickDue(room: Room, now: number): boolean {
    const s = room.state;
    const pending = s.pending;
    if (pending && pending.deadline !== null && now >= pending.deadline) return true;
    if (s.phase !== 'explore' && s.phase !== 'haunt') return s.turnDeadline !== null;
    if (s.activeSeat === null) return false;
    return s.turnDeadline === null || now >= s.turnDeadline;
  }

  private uniqueCode(): RoomCode {
    for (let attempt = 0; attempt < 50; attempt++) {
      let code = '';
      for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
        code += ROOM_CODE_ALPHABET[crypto.randomInt(0, ROOM_CODE_ALPHABET.length)];
      }
      if (!this.rooms.has(code)) return code;
    }
    throw new Error('Could not allocate a unique room code');
  }

  // --- seats ---------------------------------------------------------------

  /**
   * Resume an existing seat by token, or claim a new one. Returns null if the
   * room is full or the game has started and the token is unknown.
   */
  claimSeat(room: Room, name: string, token?: string): Seat | null {
    if (token) {
      for (const seat of room.seats.values()) {
        // Constant-time compare: tokens are the only credential in the system.
        if (
          seat.token.length === token.length &&
          crypto.timingSafeEqual(Buffer.from(seat.token), Buffer.from(token))
        ) {
          seat.connected = true;
          seat.disconnectedAt = null;
          return seat;
        }
      }
    }

    if (room.state.phase !== 'lobby') return null;
    if (room.seats.size >= MAX_PLAYERS) return null;

    const seatId = makeSeatId(room.seats.size);
    const seat: Seat = {
      seatId,
      token: crypto.randomBytes(32).toString('base64url'),
      name,
      connected: true,
      lastSeq: -1,
      disconnectedAt: null,
    };
    room.seats.set(seatId, seat);
    return seat;
  }

  publicSeats(room: Room): PublicSeat[] {
    return [...room.seats.values()].map((s) => ({
      seatId: s.seatId,
      name: s.name,
      connected: s.connected,
      charId: room.state.players[s.seatId]?.charId ?? null,
    }));
  }

  hostSeatId(room: Room): SeatId {
    return getHostSeat(room.state) ?? [...room.seats.keys()][0] ?? '';
  }

  // --- the authoritative reduction path ------------------------------------

  /**
   * Apply one action. Serial by construction: this method contains no `await`,
   * so a room's reductions cannot interleave (docs/06-networking.md#65).
   */
  apply(room: Room, action: GameAction): ApplyResult {
    const result = reduce(room.state, action, this.content, {
      strictInvariants: false,
      onInvariantViolation: (problems) => {
        // Log and report rather than crash the room: a wrong board is bad, a
        // dead server mid-game is worse.
        log.error('invariant violation', { code: room.code, problems, action: action.t });
      },
    });

    if (result.error) {
      return { ok: false, error: result.error, events: [] };
    }

    // Accepted but inert — the engine returns the state by reference when
    // nothing changed. Logging it would grow the log without bound under the
    // periodic tick, and touching lastActivityAt would make an empty room
    // immortal.
    if (result.state === room.state) {
      return { ok: true, events: result.events };
    }

    room.state = result.state;
    room.lastActivityAt = Date.now();

    const entry: LoggedAction = {
      v: room.state.version,
      action,
      at: room.lastActivityAt,
    };
    room.log.push(entry);
    room.logStream?.write(`${JSON.stringify(entry)}\n`);

    return { ok: true, events: result.events };
  }

  // --- persistence ---------------------------------------------------------

  private logPath(code: RoomCode): string {
    return path.join(config.dataDir, `${code}.jsonl`);
  }

  private openLog(room: Room, { fresh }: { fresh: boolean }): void {
    const file = this.logPath(room.code);
    if (fresh) {
      // The header carries what replay needs and the actions do not: the seed,
      // and the turn budgets this room was created with.
      fs.writeFileSync(
        file,
        `${JSON.stringify({
          header: true,
          seed: room.seed,
          code: room.code,
          createdAt: room.createdAt,
          timers: room.state.timers,
        })}\n`,
      );
    }
    room.logStream = fs.createWriteStream(file, { flags: 'a' });
  }

  /**
   * Rebuild rooms from their action logs. Called once at boot.
   * Logs older than the eviction window are deleted rather than replayed.
   */
  recover(): { recovered: number; discarded: number } {
    let recovered = 0;
    let discarded = 0;

    let files: string[];
    try {
      files = fs.readdirSync(config.dataDir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      return { recovered: 0, discarded: 0 };
    }

    for (const file of files) {
      const full = path.join(config.dataDir, file);
      try {
        const lines = fs.readFileSync(full, 'utf8').split('\n').filter(Boolean);
        const header = JSON.parse(lines[0] ?? '{}') as {
          header?: boolean;
          seed?: number;
          code?: string;
          createdAt?: number;
          timers?: TurnTimers;
        };
        if (!header.header || typeof header.seed !== 'number' || !header.code) {
          throw new Error('missing or malformed header');
        }

        const createdAt = header.createdAt ?? 0;
        if (Date.now() - createdAt > config.roomTtlMs) {
          fs.unlinkSync(full);
          discarded++;
          continue;
        }

        const entries = lines.slice(1).map((l) => JSON.parse(l) as LoggedAction);
        // Pre-timer logs have no header timers; today's config is the only
        // sensible stand-in for those.
        let state = createInitialState({
          seed: header.seed,
          content: this.content,
          timers: header.timers ?? this.timers(),
        });
        const seats = new Map<SeatId, Seat>();

        for (const entry of entries) {
          const result = reduce(state, entry.action, this.content, {
            strictInvariants: false,
          });
          if (result.error) {
            log.warn('replay rejected an action', {
              code: header.code,
              action: entry.action.t,
              error: result.error.code,
            });
            continue;
          }
          state = result.state;
        }

        // Seats are reconstructed from the recovered state. Tokens cannot be
        // recovered — they are secrets we never wrote down — so every player
        // must re-claim a seat.
        for (const seatId of Object.keys(state.players)) {
          const player = state.players[seatId]!;
          seats.set(seatId, {
            seatId,
            token: crypto.randomBytes(32).toString('base64url'),
            name: player.name,
            connected: false,
            lastSeq: -1,
            disconnectedAt: Date.now(),
          });
        }

        const room: Room = {
          code: header.code,
          seed: header.seed,
          seats,
          state,
          log: entries,
          createdAt,
          lastActivityAt: Date.now(),
          logStream: null,
        };
        this.openLog(room, { fresh: false });
        this.rooms.set(room.code, room);

        // The process died, so nobody is connected any more. That is a real
        // state change and it goes through apply() so it is APPENDED TO THE
        // LOG — recovering without logging would leave state and log
        // disagreeing, and the next recovery would produce a different state.
        for (const seatId of Object.keys(room.state.players)) {
          if (room.state.players[seatId]?.connected) {
            this.apply(room, { t: 'DISCONNECT', seat: seatId });
          }
        }

        recovered++;
        log.info('room recovered', {
          code: room.code,
          actions: entries.length,
          version: state.version,
        });
      } catch (err) {
        log.error('failed to recover room log', {
          file,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { recovered, discarded };
  }

  /** Evict idle rooms. Called on an interval by the server. */
  evictIdle(now = Date.now()): number {
    let evicted = 0;
    for (const [code, room] of this.rooms) {
      if (now - room.lastActivityAt <= config.roomTtlMs) continue;
      room.logStream?.end();
      this.rooms.delete(code);
      try {
        fs.unlinkSync(this.logPath(code));
      } catch {
        // Already gone; nothing to do.
      }
      evicted++;
      log.info('room evicted', { code });
    }
    return evicted;
  }

  closeAll(): void {
    for (const room of this.rooms.values()) room.logStream?.end();
  }
}
