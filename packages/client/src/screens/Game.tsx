/**
 * The game screen (docs/07-ui.md#72-game-layout).
 *
 * Players rail (left) and log (right) are the same `.panel` markup the M0
 * spine used; the centre column is the board, wired up here for the first
 * time now that `getReachable` (docs/05-engine.md#57) exists. This is
 * deliberately the only place in the client that calls it: the highlight the
 * player sees and the engine's legality answer are the same function call,
 * so a UI bug can never let someone attempt a move the server would reject.
 */

import { useEffect, useState } from 'react';
import { useStore } from '../store.js';
import { getLegalActions, getReachable } from '@bahoth/engine';
import type { Floor } from '@bahoth/shared';
import { Board } from '../board/Board.js';
import { FloorTabs } from '../board/FloorTabs.js';
import { floorOf, pawnsFromState } from '../board/pawns.js';

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

  // Which floor the board shows. This is transient UI state (docs/07-ui.md
  // #77 allows it for things like which tab is open), not derived game
  // state — the store comment on this file is emphatic that derived state
  // does not belong in useState. So it is seeded to a fixed default and then
  // corrected by the effect below from the one piece of derived truth that
  // matters here: the local player's own floor.
  const [floor, setFloor] = useState<Floor>('ground');
  const myLocation = state && seatId ? (state.players[seatId]?.location ?? null) : null;
  const myFloor = state ? floorOf(state.board, myLocation) : null;
  useEffect(() => {
    // Only follow MY pawn. Taking a staircase must not leave the player
    // staring at a floor they left, but another player crossing floors is
    // not a reason to yank the view out from under whoever is looking at it.
    if (myFloor) setFloor(myFloor);
  }, [myFloor]);

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

  const { byFloor } = pawnsFromState(state, content, seatId);

  // The engine's answer, never a second local "can I move there?" check
  // (docs/05-engine.md#57). It already returns [] for anything that is not
  // this seat's live turn, so the highlight switches itself off with no
  // guard needed here. It spans floors (a staircase link crosses one), but
  // `Board` renders a single floor, so filter to the one on screen — passing
  // the unfiltered list through would silently drop a same-turn destination
  // on another floor, which reads as the engine being wrong rather than as
  // "look at the other tab".
  const reachableHere = getReachable(state, seatId, content).filter(
    (id) => floorOf(state.board, id) === floor,
  );

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
        <section className="panel game__players">
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
          {/* The full players-rail design (docs/07-ui.md#72: portraits, 8-slot
              trait strips, item rows) is out of scope here. Traits are stored
              as track indices with no death detection surfaced yet (that
              lands with combat in M3), so this stays the plain seat list. */}
        </section>

        <section className="panel game__board">
          <FloorTabs active={floor} onSelect={setFloor} pawnsByFloor={byFloor} />
          <Board
            board={state.board}
            content={content}
            floor={floor}
            pawns={byFloor[floor]}
            reachable={reachableHere}
            onMoveTo={
              pending
                ? undefined
                : (placedId) => send({ t: 'MOVE', seat: seatId, to: placedId })
            }
            // Discovery (MOVE_THROUGH) is not implemented in the engine yet —
            // it is still UNKNOWN_ACTION there. Not passing a handler is what
            // keeps every doorway arrow dead: `Board` dims and disables them
            // whenever `onMoveThrough` is undefined, so this is the whole
            // fix, not a stopgap needing a follow-up.
          />
        </section>

        <section className="panel game__log">
          <h2>Log</h2>
          <ul className="log">
            {log.slice(-40).map((l) => (
              <li key={l.id}>{l.text}</li>
            ))}
          </ul>
        </section>
      </div>
    </main>
  );
}
