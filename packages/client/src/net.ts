/**
 * WebSocket connection with resume-by-token.
 * See docs/06-networking.md#63-identity-seats-and-reconnection.
 *
 * The client never applies a reducer to produce authoritative state — it sends
 * intents and renders whatever snapshot comes back. Reconnection is therefore
 * indistinguishable from any other update.
 */

import type { GameAction, ServerMessage, RoomCode } from '@bahoth/shared';
import { WS_PATH } from '@bahoth/shared';

const TOKEN_KEY = 'bahoth.tokens';

type TokenStore = Record<RoomCode, string>;

function readTokens(): TokenStore {
  try {
    return JSON.parse(localStorage.getItem(TOKEN_KEY) ?? '{}') as TokenStore;
  } catch {
    return {};
  }
}

export function saveToken(code: RoomCode, token: string): void {
  const all = readTokens();
  all[code] = token;
  localStorage.setItem(TOKEN_KEY, JSON.stringify(all));
}

export function tokenFor(code: RoomCode): string | undefined {
  return readTokens()[code];
}

/** The most recently joined room, offered as "rejoin" on the home screen. */
export function lastRoom(): RoomCode | undefined {
  return Object.keys(readTokens()).at(-1);
}

export interface ConnectionHandlers {
  onMessage: (msg: ServerMessage) => void;
  onOpen: () => void;
  onClose: () => void;
}

export class Connection {
  private ws: WebSocket | null = null;
  private seq = 0;
  private reconnectAttempts = 0;
  private closedByUs = false;
  private queue: string[] = [];

  constructor(private readonly handlers: ConnectionHandlers) {}

  connect(): void {
    this.closedByUs = false;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}${WS_PATH}`);
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempts = 0;
      for (const msg of this.queue.splice(0)) ws.send(msg);
      this.handlers.onOpen();
    };

    ws.onmessage = (ev: MessageEvent<string>) => {
      try {
        this.handlers.onMessage(JSON.parse(ev.data) as ServerMessage);
      } catch {
        // A frame we cannot parse is a server bug, not something to crash on.
      }
    };

    ws.onclose = () => {
      this.handlers.onClose();
      if (this.closedByUs) return;
      // Exponential backoff, capped. The seat token means reconnecting is
      // cheap and safe to retry.
      const delay = Math.min(1000 * 2 ** this.reconnectAttempts++, 15000);
      setTimeout(() => this.connect(), delay);
    };
  }

  private send(msg: unknown): void {
    const payload = JSON.stringify(msg);
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(payload);
    else this.queue.push(payload);
  }

  hello(name: string, contentHash: string, token?: string): void {
    this.send({ t: 'hello', name, contentHash, ...(token ? { token } : {}) });
  }

  create(): void {
    this.send({ t: 'create' });
  }

  join(code: RoomCode): void {
    this.send({ t: 'join', code });
  }

  action(action: GameAction): number {
    const seq = this.seq++;
    this.send({ t: 'action', seq, action });
    return seq;
  }

  chat(text: string): void {
    this.send({ t: 'chat', text });
  }

  close(): void {
    this.closedByUs = true;
    this.ws?.close();
  }
}
