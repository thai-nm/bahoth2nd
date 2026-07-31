/**
 * Client state. See docs/07-ui.md#77-client-state-and-data-flow.
 *
 * The store holds the redacted GameState exactly as the server sent it. No
 * component holds derived game state in local useState; derived values come
 * from the engine's selectors so the client and server can never disagree
 * about what is legal.
 */

import { create } from 'zustand';
import type {
  GameAction,
  GameEvent,
  GameState,
  PublicSeat,
  RoomCode,
  SeatId,
  ServerMessage,
} from '@bahoth/shared';
import type { Content } from '@bahoth/content';
import { buildContent } from '@bahoth/content';
import { Connection, saveToken, tokenFor } from './net.js';

export type Screen = 'home' | 'lobby' | 'game';

interface LogLine {
  id: number;
  text: string;
}

interface Store {
  screen: Screen;
  connected: boolean;
  name: string;
  content: Content | null;
  contentHash: string;

  roomCode: RoomCode | null;
  seatId: SeatId | null;
  seats: PublicSeat[];
  hostSeatId: SeatId | null;

  state: GameState | null;
  version: number;
  log: LogLine[];
  error: string | null;
  pendingSeq: number | null;
  /** Seat token from `welcome`, held until `room` reveals the code. */
  heldToken: string | null;

  conn: Connection | null;

  init: () => Promise<void>;
  setName: (name: string) => void;
  createRoom: () => void;
  joinRoom: (code: RoomCode) => void;
  send: (action: GameAction) => void;
  dismissError: () => void;
}

let logId = 0;

export const useStore = create<Store>((set, get) => ({
  screen: 'home',
  connected: false,
  name: localStorage.getItem('bahoth.name') ?? '',
  content: null,
  contentHash: '',

  roomCode: null,
  seatId: null,
  seats: [],
  hostSeatId: null,

  state: null,
  version: -1,
  log: [],
  error: null,
  pendingSeq: null,
  heldToken: null,

  conn: null,

  async init() {
    if (get().conn) return;

    // Content comes from the server so the hashes match by construction.
    const res = await fetch('/api/content');
    const raw: unknown = await res.json();
    const content = buildContent(raw, '/api/content');
    set({ content, contentHash: content.hash });

    const conn = new Connection({
      onOpen: () => {
        set({ connected: true });
        const { name, roomCode } = get();
        conn.hello(
          name || 'Explorer',
          content.hash,
          roomCode ? tokenFor(roomCode) : undefined,
        );
        // Resume in place after a dropped connection.
        if (roomCode) conn.join(roomCode);
      },
      onClose: () => set({ connected: false }),
      onMessage: (msg) => handle(msg, set, get),
    });

    set({ conn });
    conn.connect();
  },

  setName(name) {
    localStorage.setItem('bahoth.name', name);
    set({ name });
  },

  createRoom() {
    const { conn, name, contentHash } = get();
    conn?.hello(name || 'Explorer', contentHash);
    conn?.create();
  },

  joinRoom(code) {
    const { conn, name, contentHash } = get();
    const normalised = code.trim().toUpperCase();
    conn?.hello(name || 'Explorer', contentHash, tokenFor(normalised));
    conn?.join(normalised);
  },

  send(action) {
    const seq = get().conn?.action(action) ?? null;
    set({ pendingSeq: seq });
  },

  dismissError() {
    set({ error: null });
  },
}));

type Set = (partial: Partial<Store> | ((s: Store) => Partial<Store>)) => void;
type Get = () => Store;

function handle(msg: ServerMessage, set: Set, get: Get): void {
  switch (msg.t) {
    case 'welcome': {
      if (msg.seatId) set({ seatId: msg.seatId });
      // `welcome` carries the seat token but arrives BEFORE `room`, so the
      // room code is not known yet. Hold the token and persist it below.
      const code = get().roomCode;
      if (msg.token) {
        if (code) saveToken(code, msg.token);
        else set({ heldToken: msg.token });
      }
      break;
    }

    case 'room': {
      const before = get();
      set({ roomCode: msg.code, seats: msg.seats, hostSeatId: msg.hostSeatId });
      // Now that the code is known, persist the token from `welcome`. Without
      // this, reconnecting after a page reload is impossible.
      if (before.heldToken) {
        saveToken(msg.code, before.heldToken);
        set({ heldToken: null });
      }
      if (before.screen === 'home') set({ screen: 'lobby' });
      break;
    }

    case 'snapshot': {
      // The snapshot is always the truth; older versions are stale and dropped.
      if (msg.version < get().version) return;
      set({
        state: msg.state,
        version: msg.version,
        screen: msg.state.phase === 'lobby' ? 'lobby' : 'game',
        pendingSeq: null,
      });
      break;
    }

    case 'events':
      set((s) => ({ log: [...s.log, ...msg.events.map(toLogLine)].slice(-200) }));
      break;

    case 'ack':
      set({ pendingSeq: null });
      break;

    case 'error':
      set({ error: msg.message, pendingSeq: null });
      break;

    case 'chat':
      set((s) => ({
        log: [
          ...s.log,
          { id: logId++, text: `${seatName(get(), msg.seatId)}: ${msg.text}` },
        ],
      }));
      break;

    case 'left':
      set({ screen: 'home', roomCode: null, state: null, seats: [], version: -1 });
      break;

    case 'pong':
      break;
  }
}

function seatName(store: Store, seatId: SeatId): string {
  return store.seats.find((s) => s.seatId === seatId)?.name ?? seatId;
}

/** Turn an event into a log line. The real narration layer arrives with M2. */
function toLogLine(e: GameEvent): LogLine {
  return { id: logId++, text: describe(e) };
}

function describe(e: GameEvent): string {
  switch (e.t) {
    case 'joined':
      return `${e.name} joined`;
    case 'char_chosen':
      return e.charId ? `${e.seat} chose ${e.charId}` : `${e.seat} cleared their choice`;
    case 'game_started':
      return `The game begins. Turn order: ${e.turnOrder.join(' → ')}`;
    case 'turn_started':
      return `Round ${e.round}: ${e.seat}'s turn`;
    case 'turn_ended':
      return `${e.seat} ended their turn`;
    case 'connection_changed':
      return `${e.seat} ${e.connected ? 'reconnected' : 'disconnected'}`;
    case 'rolled':
      return `${e.seat} rolled ${e.total} (${e.dice.join(', ')}) for ${e.reason}`;
    case 'game_over':
      return `Game over: ${e.result.reason}`;
    case 'log':
      return e.text;
    default:
      return e.t;
  }
}
