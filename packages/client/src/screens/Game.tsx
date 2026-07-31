/**
 * M0 game screen: a debug panel, deliberately.
 *
 * The board, player rail, and action bar arrive in M2 once there is a house to
 * render. What this screen proves is the spine: the server's authoritative
 * snapshot round-trips, turn order advances, and legality comes from the
 * engine rather than from the UI.
 */

import { useStore } from '../store.js';
import { getLegalActions } from '@bahoth/engine';

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

  if (!state || !content || !seatId) return <div className="boot">Loading…</div>;

  const legal = getLegalActions(state, seatId, content);
  const canEndTurn = legal.some((a) => a.t === 'END_TURN');
  const isMyTurn = state.activeSeat === seatId;
  const activeName =
    seats.find((s) => s.seatId === state.activeSeat)?.name ?? state.activeSeat;

  return (
    <main className="screen game">
      <header className="topbar">
        <span className="code">{roomCode}</span>
        <span className="topbar__phase">{state.phase}</span>
        <span>Round {state.round}</span>
        <span className={isMyTurn ? 'topbar__turn topbar__turn--mine' : 'topbar__turn'}>
          {isMyTurn ? 'Your turn' : `${activeName}'s turn`}
        </span>
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
