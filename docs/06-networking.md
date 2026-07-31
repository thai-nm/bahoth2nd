# 06 — Networking

## 6.1 Transport

A single WebSocket endpoint at `/ws`. JSON text frames. No binary encoding, no
compression, no subprotocol negotiation — payloads are kilobytes and messages
are rare.

Every frame in both directions is validated against a zod schema before it is
looked at. An invalid frame closes the socket with a policy-violation code; a
valid frame carrying an illegal *action* gets a polite error response and the
socket stays open.

## 6.2 Message envelopes

### Client → server

```ts
type ClientMessage =
  | { t: 'hello';   token?: string; name: string; contentHash: string }
  | { t: 'create';  }                          // returns a room code
  | { t: 'join';    code: RoomCode }
  | { t: 'leave';   }
  | { t: 'action';  seq: number; action: GameAction }
  | { t: 'chat';    text: string }
  | { t: 'ping';    }
```

### Server → client

```ts
type ServerMessage =
  | { t: 'welcome';  seatId: SeatId; token: string; contentHash: string }
  | { t: 'room';     code: RoomCode; seats: PublicSeat[]; hostSeatId: SeatId }
  | { t: 'snapshot'; version: number; state: GameState /* redacted */ }
  | { t: 'events';   version: number; events: GameEvent[] }
  | { t: 'ack';      seq: number }
  | { t: 'error';    seq?: number; code: ErrorCode; message: string }
  | { t: 'chat';     seatId: SeatId; text: string; at: number }
  | { t: 'pong';     }
```

`snapshot` and `events` for the same reduction are sent back to back and carry
the same `version`. The client applies the snapshot first, then plays the
events as animation and log lines. If a client receives `events` for a version
it has not seen a snapshot for, it discards them and requests a resync — the
snapshot is always the truth.

## 6.3 Identity, seats, and reconnection

There are no accounts. Identity is a **seat token**:

- On first `hello` without a token, the server mints `seatId` + a 32-byte
  random `token`, returns both in `welcome`, and the client stores the token
  in `localStorage` keyed by room code.
- On reconnect, the client sends `hello` **with** the token. The server matches
  it to the seat, marks the seat connected, and sends a fresh `snapshot`.
  Reconnection is therefore indistinguishable from any other update.
- Tokens are per room. Losing one means losing that seat; there is no recovery
  flow, and that is an acceptable trade for having no account system.

### Disconnection behaviour

- A seat that drops is marked `connected: false`. **The game does not pause.**
- If the disconnected seat is the active player, a turn timer starts (default
  90 s, configurable per room at creation). On expiry the server issues
  `TICK`, which auto-resolves any pending prompt with its `defaultAnswer` and
  then ends the turn.
- If a seat is gone for more than 10 minutes and a majority of connected
  players vote to remove them, the seat is dropped from `turnOrder`. Their
  explorer stays on the board as an inert body holding its items.
- The host role transfers to the longest-connected seat if the host drops.

Turn timers apply to *connected* players too, but with a much longer default
(10 minutes) and a visible countdown only in the last 60 seconds. Nobody
should lose a turn to a timer they didn't know existed.

## 6.4 Redaction

`redactFor(state, seat)` strips information a given viewer must not have. The
server calls it once per connected seat per update.

What gets redacted:

| Data | Redaction |
| --- | --- |
| `decks[*].draw` | Replaced with `{ count: n }`; card ids removed |
| Tile deck order | Same treatment |
| `rng` | Removed entirely — knowing the seed predicts every future roll |
| Traitor's haunt instructions | Sent only to the traitor's seat |
| Heroes' haunt instructions | Sent only to non-traitor seats |
| Unrevealed haunt id | Removed until `haunt_reveal` completes |

What is **not** redacted, because the physical game is open information:
players' items and omens, all trait values, board layout, discard piles,
`omensDrawn`.

Two rules to hold the line:

1. **Redaction is subtractive only.** It never invents or reorders data. A
   redacted state must be a valid `GameState` with optional fields cleared, so
   the client's rendering code is unaware redaction exists.
2. **A test asserts that no redacted snapshot contains any card id that is
   still in a draw pile.** This is the one security property worth automating;
   write it in M1 and never delete it.

## 6.5 Ordering, idempotency, and the `seq` field

The client attaches a monotonically increasing `seq` to every action and keeps
it in a small outbox until acked.

- The server processes actions per room strictly serially — one room is a
  single-threaded event loop with no `await` inside the reduction — so there
  are no interleaving hazards.
- If a client reconnects and replays an unacked action, the server drops it if
  `seq <= lastSeqFrom[seatId]`. Actions are therefore idempotent at the
  transport level without the engine needing to care.
- The client shows a pending indicator on the acting control between send and
  the resulting snapshot. No optimistic application of state. At board-game
  latency, an honest 60 ms spinner beats a rollback bug.

## 6.6 Rate limiting and abuse

Modest, but present from the start:

- 20 messages per second per socket, burst 50, then disconnect.
- 64 KB max frame.
- Room codes are 5 characters from a 22-symbol alphabet (~5.2M combinations);
  join attempts are limited to 10 per minute per IP to make enumeration
  pointless.
- Chat is length-capped at 500 characters and not persisted after the room is
  evicted.

## 6.7 Content hash check

Both `hello` and `welcome` carry a content hash. If a joining client's hash
differs from the server's, the join is refused with
`ErrorCode.CONTENT_MISMATCH` and the client tells the player to reload. This
turns the worst class of bug in a data-driven game — "your Ballroom has a door
that mine doesn't" — into a clear error message at join time.
