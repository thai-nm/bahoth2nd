/**
 * WebSocket gateway. See docs/06-networking.md.
 *
 * Every frame is zod-validated before it is looked at. An invalid frame closes
 * the socket; a valid frame carrying an illegal action gets a polite error and
 * the socket stays open.
 */

import type { WebSocket, WebSocketServer } from 'ws';
import {
  ClientMessageSchema,
  MAX_FRAME_BYTES,
  type ClientMessage,
  type ErrorCode,
  type GameEvent,
  type ServerMessage,
} from '@bahoth/shared';
import { redactFor } from '@bahoth/engine';
import type { Content } from '@bahoth/content';
import type { Room, RoomManager, Seat } from './rooms.js';
import { config } from './config.js';
import { log } from './log.js';

interface Conn {
  ws: WebSocket;
  room: Room | null;
  seat: Seat | null;
  /** Name and resume token from `hello`, held until a room is chosen. */
  pendingName: string | null;
  pendingToken: string | undefined;
  /** Token bucket for rate limiting. */
  tokens: number;
  lastRefill: number;
}

export class Gateway {
  private conns = new Map<WebSocket, Conn>();

  constructor(
    private readonly wss: WebSocketServer,
    private readonly rooms: RoomManager,
    private readonly content: Content,
  ) {
    this.wss.on('connection', (ws) => this.onConnection(ws));
  }

  /**
   * Drive the turn clock. Called on an interval; safe to call at any rate.
   *
   * The engine is pure and cannot read a clock, so time only reaches it as the
   * `now` on a `TICK` action. This is where that happens — and it happens only
   * for rooms with something actually due, so an idle room is free.
   */
  sweepTimers(now = Date.now()): void {
    for (const room of this.rooms.all()) {
      if (!this.rooms.isTickDue(room, now)) continue;
      const before = room.state.version;
      const result = this.rooms.apply(room, { t: 'TICK', now });
      if (!result.ok || room.state.version === before) continue;
      this.broadcastState(room, result.events);
    }
  }

  private onConnection(ws: WebSocket): void {
    const conn: Conn = {
      ws,
      room: null,
      seat: null,
      pendingName: null,
      pendingToken: undefined,
      tokens: config.rateLimitBurst,
      lastRefill: Date.now(),
    };
    this.conns.set(ws, conn);

    ws.on('message', (raw: Buffer) => {
      try {
        this.onMessage(conn, raw);
      } catch (err) {
        log.error('unhandled error handling message', {
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
        this.send(ws, { t: 'error', code: 'INTERNAL', message: 'Internal error' });
      }
    });

    ws.on('close', () => this.onClose(conn));
    ws.on('error', (err) => log.warn('socket error', { error: err.message }));
  }

  private onMessage(conn: Conn, raw: Buffer): void {
    if (raw.length > MAX_FRAME_BYTES) {
      this.close(conn, 1009, 'Frame too large');
      return;
    }
    if (!this.allow(conn)) {
      this.send(conn.ws, { t: 'error', code: 'RATE_LIMITED', message: 'Slow down' });
      return;
    }

    let parsed: ClientMessage;
    try {
      const json: unknown = JSON.parse(raw.toString('utf8'));
      const result = ClientMessageSchema.safeParse(json);
      if (!result.success) {
        this.send(conn.ws, {
          t: 'error',
          code: 'BAD_MESSAGE',
          message: result.error.issues[0]?.message ?? 'Malformed message',
        });
        return;
      }
      parsed = result.data;
    } catch {
      this.close(conn, 1003, 'Malformed JSON');
      return;
    }

    this.handle(conn, parsed);
  }

  private handle(conn: Conn, msg: ClientMessage): void {
    switch (msg.t) {
      case 'ping':
        this.send(conn.ws, { t: 'pong' });
        return;

      case 'hello': {
        // The content hash check turns the worst class of bug in a data-driven
        // game into a clear error at join time.
        if (msg.contentHash && msg.contentHash !== this.content.hash) {
          this.send(conn.ws, {
            t: 'error',
            code: 'CONTENT_MISMATCH',
            message: 'Your game data is out of date. Reload the page.',
          });
          return;
        }
        conn.pendingName = msg.name;
        conn.pendingToken = msg.token;
        this.send(conn.ws, {
          t: 'welcome',
          seatId: null,
          token: null,
          contentHash: this.content.hash,
        });
        return;
      }

      case 'create': {
        const room = this.rooms.create();
        this.joinRoom(conn, room);
        return;
      }

      case 'join': {
        const room = this.rooms.get(msg.code);
        if (!room) {
          this.send(conn.ws, {
            t: 'error',
            code: 'ROOM_NOT_FOUND',
            message: `No room with code ${msg.code}`,
          });
          return;
        }
        this.joinRoom(conn, room);
        return;
      }

      case 'leave': {
        this.leaveRoom(conn);
        this.send(conn.ws, { t: 'left' });
        return;
      }

      case 'action': {
        const { room, seat } = conn;
        if (!room || !seat) {
          this.send(conn.ws, {
            t: 'error',
            code: 'NO_ROOM',
            message: 'Join a room first',
          });
          return;
        }

        // Idempotency: a reconnecting client may replay unacked actions.
        if (msg.seq <= seat.lastSeq) {
          this.send(conn.ws, { t: 'ack', seq: msg.seq });
          return;
        }

        // A client may only act as its own seat.
        if (msg.action.seat !== seat.seatId) {
          this.send(conn.ws, {
            t: 'error',
            seq: msg.seq,
            code: 'ILLEGAL_ACTION',
            message: 'You cannot act for another seat',
          });
          return;
        }

        const result = this.rooms.apply(room, msg.action);
        if (!result.ok) {
          log.info('illegal action', {
            code: room.code,
            seat: seat.seatId,
            action: msg.action.t,
            error: result.error?.code,
          });
          this.send(conn.ws, {
            t: 'error',
            seq: msg.seq,
            code: 'ILLEGAL_ACTION',
            message: result.error?.message ?? 'Illegal action',
          });
          return;
        }

        seat.lastSeq = msg.seq;
        this.send(conn.ws, { t: 'ack', seq: msg.seq });
        this.broadcastState(room, result.events);
        return;
      }

      case 'chat': {
        const { room, seat } = conn;
        if (!room || !seat) return;
        this.broadcast(room, {
          t: 'chat',
          seatId: seat.seatId,
          text: msg.text,
          at: Date.now(),
        });
        return;
      }
    }
  }

  private joinRoom(conn: Conn, room: Room): void {
    const name = conn.pendingName ?? 'Explorer';
    const seat = this.rooms.claimSeat(room, name, conn.pendingToken);
    if (!seat) {
      const code: ErrorCode =
        room.state.phase === 'lobby' ? 'ROOM_FULL' : 'GAME_ALREADY_STARTED';
      this.send(conn.ws, {
        t: 'error',
        code,
        message:
          code === 'ROOM_FULL' ? 'That room is full' : 'That game has already started',
      });
      return;
    }

    conn.room = room;
    conn.seat = seat;

    this.send(conn.ws, {
      t: 'welcome',
      seatId: seat.seatId,
      token: seat.token,
      contentHash: this.content.hash,
    });

    // JOIN is idempotent in the engine: it seats a new player, or marks an
    // existing one reconnected.
    const events: GameEvent[] = [];
    const joined = this.rooms.apply(room, { t: 'JOIN', seat: seat.seatId, name });
    if (joined.ok) events.push(...joined.events);
    const reconnected = this.rooms.apply(room, { t: 'RECONNECT', seat: seat.seatId });
    if (reconnected.ok) events.push(...reconnected.events);

    this.broadcastRoom(room);
    this.broadcastState(room, events);
    log.info('seat joined', { code: room.code, seat: seat.seatId, name });
  }

  private leaveRoom(conn: Conn): void {
    const { room, seat } = conn;
    if (!room || !seat) return;

    const at = Date.now();
    seat.connected = false;
    seat.disconnectedAt = at;
    conn.room = null;
    conn.seat = null;

    // `at` goes into the action, and therefore into the log: it is when the
    // removal grace period starts counting.
    const result = this.rooms.apply(room, { t: 'DISCONNECT', seat: seat.seatId, at });
    this.broadcastRoom(room);
    this.broadcastState(room, result.ok ? result.events : []);
  }

  private onClose(conn: Conn): void {
    this.leaveRoom(conn);
    this.conns.delete(conn.ws);
  }

  // --- broadcasting --------------------------------------------------------

  /**
   * Send every connected seat its own redacted snapshot, then the events for
   * the same version. The snapshot is always the truth; events only drive
   * animation and the log (docs/03-architecture.md#33-the-core-loop).
   */
  private broadcastState(room: Room, events: GameEvent[]): void {
    for (const conn of this.conns.values()) {
      if (conn.room !== room) continue;
      const view = redactFor(room.state, conn.seat?.seatId ?? null);
      this.send(conn.ws, { t: 'snapshot', version: room.state.version, state: view });
      if (events.length > 0) {
        this.send(conn.ws, { t: 'events', version: room.state.version, events });
      }
    }
  }

  private broadcastRoom(room: Room): void {
    const msg: ServerMessage = {
      t: 'room',
      code: room.code,
      seats: this.rooms.publicSeats(room),
      hostSeatId: this.rooms.hostSeatId(room),
    };
    this.broadcast(room, msg);
  }

  private broadcast(room: Room, msg: ServerMessage): void {
    for (const conn of this.conns.values()) {
      if (conn.room === room) this.send(conn.ws, msg);
    }
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify(msg));
  }

  private close(conn: Conn, code: number, reason: string): void {
    try {
      conn.ws.close(code, reason);
    } catch {
      // Socket already gone.
    }
  }

  // --- rate limiting -------------------------------------------------------

  private allow(conn: Conn): boolean {
    const now = Date.now();
    const elapsed = (now - conn.lastRefill) / 1000;
    conn.lastRefill = now;
    conn.tokens = Math.min(
      config.rateLimitBurst,
      conn.tokens + elapsed * config.rateLimitPerSecond,
    );
    if (conn.tokens < 1) return false;
    conn.tokens -= 1;
    return true;
  }
}
