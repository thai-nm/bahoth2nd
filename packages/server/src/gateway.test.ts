/**
 * Server protocol tests: real sockets against a real server on an ephemeral
 * port. Covers the M0 exit criteria — seats join, turns pass, a client
 * reconnects with state intact, and a restarted process recovers the room
 * from its action log.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import type { GameAction, ServerMessage } from '@bahoth/shared';

// config.ts reads process.env at import time, so this must happen before the
// server module is imported.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bahoth-test-'));
process.env.DATA_DIR = dataDir;
process.env.LOG_LEVEL = 'error';

const { createServer } = await import('./index.js');

interface Harness {
  url: string;
  close: () => Promise<void>;
  rooms: ReturnType<typeof createServer>['rooms'];
  gateway: ReturnType<typeof createServer>['gateway'];
}

async function startServer(): Promise<Harness> {
  const { server, rooms, gateway } = createServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}/ws`,
    rooms,
    gateway,
    close: () =>
      new Promise<void>((resolve) => {
        rooms.closeAll();
        server.close(() => resolve());
      }),
  };
}

/** A test client that records every message it receives. */
class Client {
  readonly received: ServerMessage[] = [];
  private seq = 0;
  private cursor = 0;

  private constructor(private readonly ws: WebSocket) {}

  static async connect(url: string): Promise<Client> {
    const ws = new WebSocket(url);
    const client = new Client(ws);
    ws.on('message', (raw: Buffer) => {
      client.received.push(JSON.parse(raw.toString()) as ServerMessage);
    });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    return client;
  }

  send(msg: unknown): void {
    this.ws.send(JSON.stringify(msg));
  }

  action(action: GameAction): void {
    this.send({ t: 'action', seq: this.seq++, action });
  }

  /**
   * Wait for a message matching `t`, optionally satisfying `where`.
   *
   * Scanning resumes from a monotonic cursor rather than from index 0, so an
   * await cannot be satisfied by a message the test already consumed. Without
   * this, a predicate like `activeSeat !== seat` matches a stale lobby
   * snapshot and the test races ahead of the server.
   */
  async next<T extends ServerMessage['t']>(
    t: T,
    where?: (m: Extract<ServerMessage, { t: T }>) => boolean,
    timeoutMs = 2000,
  ): Promise<Extract<ServerMessage, { t: T }>> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      while (this.cursor < this.received.length) {
        const m = this.received[this.cursor++]!;
        if (m.t === t) {
          const typed = m as Extract<ServerMessage, { t: T }>;
          if (!where || where(typed)) return typed;
        }
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(
      `timed out waiting for "${t}"; received: ${this.received.map((m) => m.t).join(', ')}`,
    );
  }

  latestSnapshot(): Extract<ServerMessage, { t: 'snapshot' }> | undefined {
    for (let i = this.received.length - 1; i >= 0; i--) {
      const m = this.received[i]!;
      if (m.t === 'snapshot') return m;
    }
    return undefined;
  }

  /**
   * Wait until this client's CURRENT view satisfies `pred`. Unlike next(),
   * this does not consume from the cursor — it asks "is the world in this
   * state yet?", which is the right question for assertions about state, and
   * is re-askable.
   */
  async waitForState(
    pred: (m: Extract<ServerMessage, { t: 'snapshot' }>) => boolean,
    timeoutMs = 2000,
  ): Promise<Extract<ServerMessage, { t: 'snapshot' }>> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const snap = this.latestSnapshot();
      if (snap && pred(snap)) return snap;
      await new Promise((r) => setTimeout(r, 5));
    }
    const snap = this.latestSnapshot();
    throw new Error(
      `timed out waiting for state; latest version=${snap?.version} phase=${snap?.state.phase} activeSeat=${snap?.state.activeSeat}`,
    );
  }

  /** The token this client was issued, used to test resume-after-disconnect. */
  token(): string {
    const welcome = this.received.find((m) => m.t === 'welcome' && m.token);
    return welcome?.t === 'welcome' ? (welcome.token ?? '') : '';
  }

  close(): void {
    this.ws.close();
  }
}

async function hello(client: Client, name: string, token?: string): Promise<void> {
  client.send({ t: 'hello', name, contentHash: '', ...(token ? { token } : {}) });
  await client.next('welcome');
}

let harness: Harness;

beforeAll(async () => {
  harness = await startServer();
});

afterAll(async () => {
  await harness.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const openClients: Client[] = [];
afterEach(() => {
  for (const c of openClients.splice(0)) c.close();
});

async function connect(name: string, token?: string): Promise<Client> {
  const c = await Client.connect(harness.url);
  openClients.push(c);
  await hello(c, name, token);
  return c;
}

describe('lobby over the wire', () => {
  it('creates a room and seats three players', async () => {
    const host = await connect('Ana');
    host.send({ t: 'create' });
    const welcome = await host.next('welcome', (m) => m.seatId !== null);
    const room = await host.next('room');

    expect(welcome.seatId).toBe('seat_0');
    expect(welcome.token).toBeTruthy();
    expect(room.code).toHaveLength(5);

    const ben = await connect('Ben');
    ben.send({ t: 'join', code: room.code });
    await ben.next('welcome', (m) => m.seatId === 'seat_1');

    const cal = await connect('Cal');
    cal.send({ t: 'join', code: room.code });
    await cal.next('welcome', (m) => m.seatId === 'seat_2');

    const snap = await host.waitForState(
      (m) => Object.keys(m.state.players).length === 3,
    );
    expect(Object.keys(snap.state.players)).toEqual(['seat_0', 'seat_1', 'seat_2']);
  });

  it('rejects an unknown room code', async () => {
    const c = await connect('Lost');
    c.send({ t: 'join', code: 'ZZZZZ' });
    const err = await c.next('error');
    expect(err.code).toBe('ROOM_NOT_FOUND');
  });

  it('refuses a content hash mismatch', async () => {
    const c = await Client.connect(harness.url);
    openClients.push(c);
    c.send({ t: 'hello', name: 'Stale', contentHash: 'not-the-right-hash' });
    const err = await c.next('error');
    expect(err.code).toBe('CONTENT_MISMATCH');
  });

  it('rejects a malformed message without dropping the socket', async () => {
    const c = await connect('Odd');
    c.send({ t: 'join', code: 'lowercase' });
    const err = await c.next('error');
    expect(err.code).toBe('BAD_MESSAGE');
    // Socket still usable.
    c.send({ t: 'ping' });
    await c.next('pong');
  });

  it('refuses to let a client act for another seat', async () => {
    const host = await connect('Ana');
    host.send({ t: 'create' });
    const room = await host.next('room');

    const ben = await connect('Ben');
    ben.send({ t: 'join', code: room.code });
    await ben.next('welcome', (m) => m.seatId === 'seat_1');

    ben.action({ t: 'CHOOSE_CHAR', seat: 'seat_0', charId: null });
    const err = await ben.next('error');
    expect(err.code).toBe('ILLEGAL_ACTION');
    expect(err.message).toMatch(/another seat/i);
  });
});

describe('a full M0 game', () => {
  async function threePlayerGame() {
    const host = await connect('Ana');
    host.send({ t: 'create' });
    const room = await host.next('room');

    const ben = await connect('Ben');
    ben.send({ t: 'join', code: room.code });
    await ben.next('welcome', (m) => m.seatId === 'seat_1');

    const cal = await connect('Cal');
    cal.send({ t: 'join', code: room.code });
    await cal.next('welcome', (m) => m.seatId === 'seat_2');

    return { host, ben, cal, room };
  }

  it('starts, passes turns, and survives a reconnect', async () => {
    const { host, ben, cal, room } = await threePlayerGame();

    // Pick colour-distinct characters. Fixture ids are stable.
    host.action({ t: 'CHOOSE_CHAR', seat: 'seat_0', charId: 'char.green_a' });
    ben.action({ t: 'CHOOSE_CHAR', seat: 'seat_1', charId: 'char.red_a' });
    cal.action({ t: 'CHOOSE_CHAR', seat: 'seat_2', charId: 'char.blue_a' });

    await host.waitForState((m) =>
      Object.values(m.state.players).every((p) => p.charId !== null),
    );

    host.action({ t: 'START_GAME', seat: 'seat_0' });
    const started = await host.waitForState((m) => m.state.phase === 'explore');
    const order = started.state.turnOrder;
    expect(order).toHaveLength(3);

    const bySeat = { seat_0: host, seat_1: ben, seat_2: cal } as Record<string, Client>;

    // Pass a full round. Each step waits for the snapshot that actually makes
    // the seat active, rather than trusting a cached one.
    for (const seat of order) {
      const client = bySeat[seat]!;
      const mine = await client.waitForState((m) => m.state.activeSeat === seat);
      expect(mine.state.phase).toBe('explore');
      client.action({ t: 'END_TURN', seat });
      await client.waitForState((m) => m.state.version > mine.version);
    }

    const afterRound = await host.waitForState((m) => m.state.round === 2);
    expect(afterRound.state.activeSeat).toBe(order[0]);

    // Reconnect: Ben drops and returns with his token.
    const benToken = ben.token();
    expect(benToken).toBeTruthy();

    ben.close();
    await host.next('room', (m) =>
      m.seats.some((s) => s.seatId === 'seat_1' && !s.connected),
    );

    const benAgain = await connect('Ben', benToken);
    benAgain.send({ t: 'join', code: room.code });
    const resumed = await benAgain.next('welcome', (m) => m.seatId === 'seat_1');
    expect(resumed.seatId).toBe('seat_1');

    const resumedSnap = await benAgain.waitForState((m) => m.state.phase === 'explore');
    expect(resumedSnap.state.round).toBe(2);
    expect(resumedSnap.state.phase).toBe('explore');
    expect(resumedSnap.state.players['seat_1']?.connected).toBe(true);
  });
});

describe('host transfer over the wire', () => {
  it('hands the room to the next seat when the host drops, and back on return', async () => {
    const host = await connect('Ana');
    host.send({ t: 'create' });
    const room = await host.next('room');
    expect(room.hostSeatId).toBe('seat_0');

    const ben = await connect('Ben');
    ben.send({ t: 'join', code: room.code });
    await ben.next('welcome', (m) => m.seatId === 'seat_1');

    const cal = await connect('Cal');
    cal.send({ t: 'join', code: room.code });
    await cal.next('welcome', (m) => m.seatId === 'seat_2');

    host.action({ t: 'CHOOSE_CHAR', seat: 'seat_0', charId: 'char.green_a' });
    ben.action({ t: 'CHOOSE_CHAR', seat: 'seat_1', charId: 'char.red_a' });
    cal.action({ t: 'CHOOSE_CHAR', seat: 'seat_2', charId: 'char.blue_a' });
    await ben.waitForState((m) =>
      Object.values(m.state.players).every((p) => p.charId !== null),
    );

    // The host walks out of the room.
    const hostToken = host.token();
    host.close();

    const transferred = await ben.next('room', (m) => m.hostSeatId === 'seat_1');
    expect(transferred.hostSeatId).toBe('seat_1');

    // The room is not stranded: the new host can start the game.
    ben.action({ t: 'START_GAME', seat: 'seat_1' });
    const started = await ben.waitForState((m) => m.state.phase === 'explore');
    expect(started.state.turnOrder).toHaveLength(3);

    // And the role goes back when the original host reconnects.
    const hostAgain = await connect('Ana', hostToken);
    hostAgain.send({ t: 'join', code: room.code });
    await hostAgain.next('welcome', (m) => m.seatId === 'seat_0');
    const returned = await ben.next('room', (m) => m.hostSeatId === 'seat_0');
    expect(returned.hostSeatId).toBe('seat_0');
  });
});

describe('the turn clock over the wire', () => {
  /**
   * The sweep is driven with an explicit `now` rather than by waiting on the
   * wall clock. It is the same code path the interval calls — isTickDue, then
   * apply, then broadcast — so nothing is stubbed, and the test does not have
   * to sleep for a real turn budget.
   */
  async function startedRoom() {
    const host = await connect('Ana');
    host.send({ t: 'create' });
    const room = await host.next('room');

    const ben = await connect('Ben');
    ben.send({ t: 'join', code: room.code });
    await ben.next('welcome', (m) => m.seatId === 'seat_1');

    const cal = await connect('Cal');
    cal.send({ t: 'join', code: room.code });
    await cal.next('welcome', (m) => m.seatId === 'seat_2');

    host.action({ t: 'CHOOSE_CHAR', seat: 'seat_0', charId: 'char.green_a' });
    ben.action({ t: 'CHOOSE_CHAR', seat: 'seat_1', charId: 'char.red_a' });
    cal.action({ t: 'CHOOSE_CHAR', seat: 'seat_2', charId: 'char.blue_a' });
    await host.waitForState((m) =>
      Object.values(m.state.players).every((p) => p.charId !== null),
    );

    host.action({ t: 'START_GAME', seat: 'seat_0' });
    await host.waitForState((m) => m.state.phase === 'explore');
    return { host, ben, cal, room, live: harness.rooms.get(room.code)! };
  }

  it('arms on the first sweep and broadcasts the deadline', async () => {
    const { host, live } = await startedRoom();
    expect(live.state.turnDeadline).toBeNull();

    const now = Date.now();
    harness.gateway.sweepTimers(now);

    expect(live.state.turnDeadline).toBe(now + live.state.timers.turnMs);
    const snap = await host.waitForState((m) => m.state.turnDeadline !== null);
    expect(snap.state.turnDeadline).toBe(live.state.turnDeadline);
  });

  it('costs nothing while no deadline is due', async () => {
    const { live } = await startedRoom();
    const now = Date.now();
    harness.gateway.sweepTimers(now);

    const version = live.state.version;
    const logLength = live.log.length;
    for (let i = 1; i <= 5; i++) harness.gateway.sweepTimers(now + i * 100);

    // Five sweeps, nothing due: no version bump and not one line of log. The
    // interval runs every second for the life of a room, so an inert sweep
    // being free is the difference between a stable log and an unbounded one.
    expect(live.state.version).toBe(version);
    expect(live.log.length).toBe(logLength);
  });

  it('ends the turn of a player who has dropped', async () => {
    const { host, ben, cal, live } = await startedRoom();
    const stalled = live.state.activeSeat!;
    const bySeat: Record<string, Client> = { seat_0: host, seat_1: ben, seat_2: cal };
    // Turn order is shuffled, so the stalled seat is whoever it is. Watch from
    // a seat that is definitely still connected.
    const watcher = Object.entries(bySeat).find(([seat]) => seat !== stalled)![1];

    // The active player walks away. Before this fix the room stopped here,
    // permanently: nobody else could act and no clock was running.
    bySeat[stalled]!.close();
    await watcher.waitForState((m) => m.state.players[stalled]?.connected === false);

    const now = Date.now();
    harness.gateway.sweepTimers(now);
    // The short budget applies, not the ten-minute one.
    expect(live.state.turnDeadline).toBe(now + live.state.timers.disconnectedMs);
    expect(live.state.timers.disconnectedMs).toBeLessThan(live.state.timers.turnMs);

    harness.gateway.sweepTimers(live.state.turnDeadline!);
    expect(live.state.activeSeat).not.toBe(stalled);

    // A seat that is still present sees the turn move on.
    const moved = await watcher.waitForState((m) => m.state.activeSeat !== stalled);
    expect(moved.state.activeSeat).toBe(live.state.activeSeat);
  });

  it('does not run a clock in the lobby', async () => {
    const host = await connect('Solo');
    host.send({ t: 'create' });
    const room = await host.next('room');
    const live = harness.rooms.get(room.code)!;

    const version = live.state.version;
    harness.gateway.sweepTimers(Date.now() + 60 * 60 * 1000);
    expect(live.state.turnDeadline).toBeNull();
    expect(live.state.version).toBe(version);
  });

  /**
   * The prompt clock, over the wire. A `confirm` prompt is planted rather than
   * driven through a real discovery: whether the fixture house happens to
   * offer a tile with two legal rotations is not what these assertions are
   * about, and a kind nothing raises is the harsher case anyway — it is the
   * one with no resume step to fall back on.
   */
  it('arms an unarmed prompt clock on the sweep, then resolves it', async () => {
    const { host, live } = await startedRoom();
    const seat = live.state.activeSeat!;

    // Arm the TURN clock first, so it is not what makes the sweep below fire.
    // Without this the test passes even with `isTickDue` blind to prompts:
    // a freshly started room has an unarmed turn clock, which is due on its
    // own and drags the prompt's arming along with it.
    harness.gateway.sweepTimers(Date.now());
    expect(live.state.turnDeadline).not.toBeNull();

    live.state = {
      ...live.state,
      pending: {
        id: 'prompt_planted',
        seatId: seat,
        kind: 'confirm',
        payload: null,
        deadline: null,
        defaultAnswer: true,
      },
    };

    // The server has to notice a prompt that has no deadline yet: the engine
    // may not read a clock, so without a TICK the prompt sits unarmed forever
    // and the whole prompt clock is dead code.
    const now = Date.now();
    harness.gateway.sweepTimers(now);
    expect(live.state.pending?.deadline).toBe(now + live.state.timers.promptMs);

    // The deadline reaches the client, which is what lets it show a countdown.
    const snap = await host.waitForState(
      (m) =>
        m.state.pending?.deadline !== null && m.state.pending?.deadline !== undefined,
    );
    expect(snap.state.pending?.deadline).toBe(live.state.pending?.deadline);

    harness.gateway.sweepTimers(live.state.pending!.deadline!);
    expect(live.state.pending).toBeNull();
    // The turn is still that seat's: a prompt times out inside a turn rather
    // than costing the whole one.
    expect(live.state.activeSeat).toBe(seat);
  });
});

describe('the remove-player vote over the wire', () => {
  it('drops a seat that never came back, once the table agrees and time passes', async () => {
    const host = await connect('Ana');
    host.send({ t: 'create' });
    const room = await host.next('room');

    const ben = await connect('Ben');
    ben.send({ t: 'join', code: room.code });
    await ben.next('welcome', (m) => m.seatId === 'seat_1');

    const cal = await connect('Cal');
    cal.send({ t: 'join', code: room.code });
    await cal.next('welcome', (m) => m.seatId === 'seat_2');

    // Four seats, so that removing one still leaves a legal three-player game.
    const dot = await connect('Dot');
    dot.send({ t: 'join', code: room.code });
    await dot.next('welcome', (m) => m.seatId === 'seat_3');

    const live = harness.rooms.get(room.code)!;

    // Cal joins the lobby and vanishes without ever choosing an explorer, so
    // the game cannot start: every seat needs one.
    cal.close();
    await host.waitForState((m) => m.state.players['seat_2']?.connected === false);

    host.action({ t: 'CHOOSE_CHAR', seat: 'seat_0', charId: 'char.green_a' });
    ben.action({ t: 'CHOOSE_CHAR', seat: 'seat_1', charId: 'char.red_a' });
    dot.action({ t: 'CHOOSE_CHAR', seat: 'seat_3', charId: 'char.blue_a' });
    await host.waitForState((m) => m.state.players['seat_3']?.charId !== null);

    host.action({ t: 'START_GAME', seat: 'seat_0' });
    const blocked = await host.next('error');
    expect(blocked.code).toBe('ILLEGAL_ACTION');
    expect(live.state.phase).toBe('lobby');

    // Two of the three remaining seats vote: a strict majority.
    host.action({ t: 'VOTE_REMOVE', seat: 'seat_0', target: 'seat_2', vote: true });
    ben.action({ t: 'VOTE_REMOVE', seat: 'seat_1', target: 'seat_2', vote: true });
    await host.waitForState((m) => (m.state.removeVotes['seat_2']?.length ?? 0) === 2);

    // Still there: the votes are in, but the grace period is not up.
    harness.gateway.sweepTimers(Date.now());
    expect(live.state.players['seat_2']?.removed).toBe(false);

    // Past the grace period, the seat goes.
    harness.gateway.sweepTimers(Date.now() + live.state.timers.removeGraceMs + 1);
    const removed = await host.waitForState(
      (m) => m.state.players['seat_2']?.removed === true,
    );
    expect(removed.state.removeVotes['seat_2']).toBeUndefined();

    // And the game the ghost seat was blocking can now start.
    host.action({ t: 'START_GAME', seat: 'seat_0' });
    const started = await host.waitForState((m) => m.state.phase === 'explore');
    expect(started.state.turnOrder).toEqual(
      expect.arrayContaining(['seat_0', 'seat_1', 'seat_3']),
    );
    expect(started.state.turnOrder).toHaveLength(3);
    expect(started.state.turnOrder).not.toContain('seat_2');
  });

  it('refuses a vote against a seat that is still connected', async () => {
    const host = await connect('Ana');
    host.send({ t: 'create' });
    const room = await host.next('room');

    const ben = await connect('Ben');
    ben.send({ t: 'join', code: room.code });
    await ben.next('welcome', (m) => m.seatId === 'seat_1');

    host.action({ t: 'VOTE_REMOVE', seat: 'seat_0', target: 'seat_1', vote: true });
    const err = await host.next('error');
    expect(err.code).toBe('ILLEGAL_ACTION');
    expect(err.message).toMatch(/still here/i);
  });
});

describe('redaction over the wire', () => {
  it('never sends the rng seed to a client', async () => {
    const host = await connect('Ana');
    host.send({ t: 'create' });
    await host.next('room');
    const snap = await host.waitForState(() => true);
    expect(snap.state.rng).toBeUndefined();
    expect(JSON.stringify(snap)).not.toContain('"seed"');
  });
});

describe('crash recovery', () => {
  it('rebuilds a room from its action log after a restart', async () => {
    // Use a dedicated server instance so we can kill it without affecting
    // the shared harness.
    const first = await startServer();
    const c = await Client.connect(first.url);
    await hello(c, 'Ana');
    c.send({ t: 'create' });
    const room = await c.next('room');

    const b = await Client.connect(first.url);
    await hello(b, 'Ben');
    b.send({ t: 'join', code: room.code });
    await b.next('welcome', (m) => m.seatId === 'seat_1');

    c.action({ t: 'CHOOSE_CHAR', seat: 'seat_0', charId: 'char.green_a' });
    const beforeCrash = await c.waitForState(
      (m) => m.state.players['seat_0']?.charId === 'char.green_a',
    );
    const versionBefore = beforeCrash.state.version;

    c.close();
    b.close();
    await first.close();

    // Restart: a brand-new process-equivalent reading the same DATA_DIR.
    const second = await startServer();
    const recovered = second.rooms.get(room.code);
    expect(recovered, 'room should be recovered from its log').toBeDefined();
    expect(recovered!.state.players['seat_0']?.charId).toBe('char.green_a');
    // Recovery replays the log, then logs a DISCONNECT per seat (the process
    // died, so nobody is connected). Version therefore advances past the
    // pre-crash value rather than matching it exactly.
    expect(recovered!.state.version).toBeGreaterThanOrEqual(versionBefore);
    expect(recovered!.state.players['seat_0']?.connected).toBe(false);
    expect(recovered!.state.players['seat_1']?.connected).toBe(false);

    await second.close();
  });

  it('fills in a timer budget a log predates, rather than recovering a NaN clock', async () => {
    // A log written before `promptMs` existed carries the other three budgets
    // and not that one. Substituting the header wholesale (`header.timers ??
    // this.timers()`) hands the room a `promptMs: undefined`, every prompt
    // deadline becomes `now + undefined` — NaN — and `now >= NaN` is false
    // forever: a prompt clock that looks armed and never fires. The header is
    // merged over today's defaults instead.
    const code = 'OLDLOG';
    fs.writeFileSync(
      path.join(dataDir, `${code}.jsonl`),
      `${JSON.stringify({
        header: true,
        seed: 7,
        code,
        createdAt: Date.now(),
        timers: { turnMs: 1000, disconnectedMs: 500, removeGraceMs: 2000 },
      })}\n`,
    );

    const server = await startServer();
    const room = server.rooms.get(code);
    expect(room, 'the old-format log should still recover').toBeDefined();

    // The budgets the log DID record are the ones it ran with, not today's.
    expect(room!.state.timers.turnMs).toBe(1000);
    // And the one it could not record is a real number.
    expect(Number.isFinite(room!.state.timers.promptMs)).toBe(true);

    room!.state = {
      ...room!.state,
      pending: {
        id: 'p',
        seatId: 'seat_0',
        kind: 'confirm',
        payload: null,
        deadline: null,
        defaultAnswer: true,
      },
      players: {
        seat_0: {
          ...makeRecoveredPlayer(),
        },
      },
    };
    const now = Date.now();
    server.gateway.sweepTimers(now);
    expect(room!.state.pending?.deadline).toBe(now + room!.state.timers.promptMs);
    expect(Number.isNaN(room!.state.pending?.deadline)).toBe(false);

    await server.close();
  });
});

/** A minimal seated player, so a planted prompt targets a real seat (invariant 7). */
function makeRecoveredPlayer() {
  return {
    seatId: 'seat_0',
    name: 'Ana',
    charId: null,
    traits: { speed: 0, might: 0, sanity: 0, knowledge: 0 },
    location: null,
    movesLeft: 0,
    cameFrom: null,
    items: [],
    omens: [],
    isTraitor: false,
    isDead: false,
    connected: false,
    disconnectedAt: null,
    removed: false,
    hasAttackedThisTurn: false,
    flags: {},
  };
}
