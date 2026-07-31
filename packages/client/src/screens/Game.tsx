/**
 * M0 game screen: a debug panel, deliberately.
 *
 * The board, player rail, and action bar arrive in M2 once there is a house to
 * render. What this screen proves is the spine: the server's authoritative
 * snapshot round-trips, turn order advances, and legality comes from the
 * engine rather than from the UI.
 */

import { useEffect, useState } from 'react';
import { useStore } from '../store.js';
import { getLegalActions } from '@bahoth/engine';

/** Seconds of countdown to show. Below this, the clock is worth watching. */
const VISIBLE_WITHIN_MS = 60 * 1000;

/**
 * Remaining time on the turn clock, re-read once a second.
 *
 * The deadline is an absolute ms epoch in the snapshot, so this needs no
 * messages from the server between the arming TICK and the expiry TICK — the
 * countdown is local arithmetic on a value everyone already has.
 */
function useRemaining(deadline: number | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (deadline === null) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [deadline]);
  return deadline === null ? null : Math.max(0, deadline - now);
}

function formatRemaining(ms: number): string {
  const total = Math.ceil(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export function Game() {
  const state = useStore((s) => s.state);
  const content = useStore((s) => s.content);
  const seatId = useStore((s) => s.seatId);
  const seats = useStore((s) => s.seats);
  const roomCode = useStore((s) => s.roomCode);
  const version = useStore((s) => s.version);
  const log = useStore((s) => s.log);
  const send = useStore((s) => s.send);
  const pending = useStore((s) => s.pendingSeq !== null);
  // Called before the early return: hooks may not be conditional.
  const remaining = useRemaining(state?.turnDeadline ?? null);

  if (!state || !content || !seatId) return <div className="boot">Loading…</div>;

  const legal = getLegalActions(state, seatId, content);
  const canEndTurn = legal.some((a) => a.t === 'END_TURN');
  // target -> the vote this seat would cast by clicking (true = for removal).
  const removeVotes = new Map(
    legal.filter((a) => a.t === 'VOTE_REMOVE').map((a) => [a.target, a.vote]),
  );
  const isMyTurn = state.activeSeat === seatId;
  const activeName =
    seats.find((s) => s.seatId === state.activeSeat)?.name ?? state.activeSeat;

  // Nobody should lose a turn to a clock they didn't know existed, and nobody
  // needs a ten-minute countdown in their face either: show it in the last
  // minute, or whenever the active seat has dropped and is on the short budget
  // (docs/06-networking.md#disconnection-behaviour).
  const activeConnected =
    state.activeSeat === null || state.players[state.activeSeat]?.connected !== false;
  const showClock =
    remaining !== null && (!activeConnected || remaining <= VISIBLE_WITHIN_MS);

  return (
    <main className="screen game">
      <header className="topbar">
        <span className="code">{roomCode}</span>
        <span className="topbar__phase">{state.phase}</span>
        <span>Round {state.round}</span>
        <span className={isMyTurn ? 'topbar__turn topbar__turn--mine' : 'topbar__turn'}>
          {isMyTurn ? 'Your turn' : `${activeName}'s turn`}
        </span>
        {showClock && (
          <span
            className={
              remaining <= 10_000
                ? 'topbar__clock topbar__clock--urgent'
                : 'topbar__clock'
            }
            aria-live="polite"
          >
            {activeConnected ? '' : 'away · '}
            {formatRemaining(remaining)}
          </span>
        )}
        <span className="topbar__version">v{version}</span>
      </header>

      <div className="game__body">
        <section className="panel">
          <h2>Players</h2>
          <ul className="seatlist">
            {state.turnOrder.map((sid) => {
              const p = state.players[sid];
              const character = p?.charId ? content.charactersById[p.charId] : null;
              if (!p) return null;
              return (
                <li
                  key={sid}
                  className={`seat${sid === state.activeSeat ? ' seat--active' : ''}${sid === seatId ? ' seat--me' : ''}`}
                >
                  <span className={p.connected ? 'dot dot--on' : 'dot'} aria-hidden />
                  <span className="seat__name">{p.name}</span>
                  <span className="seat__char">
                    {character && (
                      <>
                        <span
                          className={`swatch swatch--${character.colour}`}
                          aria-hidden
                        />
                        {character.name}
                      </>
                    )}
                  </span>
                  {p.isDead && <span className="tag">dead</span>}
                  {p.removed && <span className="tag">removed</span>}
                  {removeVotes.has(sid) && (
                    <button
                      type="button"
                      className="btn btn--tiny"
                      disabled={pending}
                      onClick={() =>
                        send({
                          t: 'VOTE_REMOVE',
                          seat: seatId,
                          target: sid,
                          vote: removeVotes.get(sid)!,
                        })
                      }
                      title="Takes effect once they have been gone long enough"
                    >
                      {removeVotes.get(sid) ? 'Vote to remove' : 'Withdraw vote'} (
                      {state.removeVotes[sid]?.length ?? 0})
                    </button>
                  )}
                </li>
              );
            })}
          </ul>

          <div className="actions">
            <button
              type="button"
              className="btn btn--primary"
              disabled={!canEndTurn || pending}
              onClick={() => send({ t: 'END_TURN', seat: seatId })}
            >
              End turn
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              disabled={pending}
              onClick={() => send({ t: 'CONCEDE', seat: seatId })}
            >
              Concede
            </button>
          </div>
          <p className="hint">
            The board arrives in M2. This screen proves the spine: authoritative
            snapshots, turn order, and engine-driven legality.
          </p>
        </section>

        <section className="panel">
          <h2>Log</h2>
          <ul className="log">
            {log.slice(-40).map((l) => (
              <li key={l.id}>{l.text}</li>
            ))}
          </ul>
        </section>

        <section className="panel panel--wide">
          <h2>State (redacted, as received)</h2>
          <pre className="json">{JSON.stringify(state, null, 2)}</pre>
        </section>
      </div>
    </main>
  );
}
