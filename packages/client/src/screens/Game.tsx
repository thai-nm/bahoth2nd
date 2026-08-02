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
import { isRotateTilePayload } from '@bahoth/shared';
import type { Floor, RotateTilePayload, Rotation } from '@bahoth/shared';
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

/**
 * The rotation the OTHER seat's ghost previews, since only the prompted seat
 * gets to pick — everyone else sees `defaultAnswer`, the same rotation
 * `resolvePromptWithDefault` (packages/engine/src/reduce.ts) would apply if
 * nobody answers in time.
 */
function defaultRotation(payload: RotateTilePayload, defaultAnswer: unknown): Rotation {
  return typeof defaultAnswer === 'number' &&
    payload.legalRotations.includes(defaultAnswer as Rotation)
    ? (defaultAnswer as Rotation)
    : payload.legalRotations[0]!;
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
  // The prompt's own clock, which is a different and much shorter one
  // (docs/07-ui.md#74: "a countdown if a deadline exists"). Shown in full
  // rather than only in its last minute, because the whole budget IS about a
  // minute and it is holding up every seat at the table, not just its owner.
  const promptRemaining = useRemaining(state?.pending?.deadline ?? null);

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

  // The rotate_tile prompt (docs/07-ui.md#73, #74 "Pending prompts"). Narrow
  // once here rather than at every use site below. `state.pending` carries
  // `payload: unknown` by design (docs/04-data-model.md#pendingprompt) — the
  // type guard from shared is the only way either side may trust its shape.
  const pendingPayload =
    state?.pending?.kind === 'rotate_tile' && isRotateTilePayload(state.pending.payload)
      ? state.pending.payload
      : null;
  const isMyPrompt = pendingPayload !== null && state?.pending?.seatId === seatId;

  // The previewed rotation while I own the prompt: transient UI state seeded
  // to the prompt's own default (docs/07-ui.md#77 allows this — it is not
  // game state, `ROTATE_TILE` is what makes a choice real). Reset whenever
  // the prompt itself changes identity, not on every render.
  const [previewRotation, setPreviewRotation] = useState<Rotation | null>(null);
  const pendingId = state?.pending?.id ?? null;
  useEffect(() => {
    if (!pendingPayload) {
      setPreviewRotation(null);
      return;
    }
    const def = state?.pending?.defaultAnswer;
    const seeded =
      typeof def === 'number' && pendingPayload.legalRotations.includes(def as Rotation)
        ? (def as Rotation)
        : pendingPayload.legalRotations[0]!;
    setPreviewRotation(seeded);
    // Keyed off the prompt's own id, not `pendingPayload` — that object is
    // rebuilt fresh from `state` every render, so depending on it would reset
    // the preview on every keystroke of rotating instead of once per prompt.
  }, [pendingId]);

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

  // A doorway is only live if getLegalActions actually offers it — never a
  // second local legality check (docs/05-engine.md#57). During any pending
  // prompt `legal` holds only ROTATE_TILE entries (or nothing, for every
  // other seat), so this is naturally empty then, with no separate guard.
  const throughDirs = legal.filter((a) => a.t === 'MOVE_THROUGH').map((a) => a.dir);

  // While a rotate_tile prompt is outstanding, the board is forced to the
  // floor the discovery is happening on (docs/07-ui.md#73) — the player must
  // see the ghost tile they (or someone else) is about to place, regardless
  // of which tab they last clicked. `floor` (the tab state) is left alone so
  // it resumes exactly where the player was once the prompt resolves.
  const displayFloor = pendingPayload ? pendingPayload.floor : floor;

  // The engine's answer, never a second local "can I move there?" check
  // (docs/05-engine.md#57). It already returns [] for anything that is not
  // this seat's live turn, so the highlight switches itself off with no
  // guard needed here. It spans floors (a staircase link crosses one), but
  // `Board` renders a single floor, so filter to the one on screen — passing
  // the unfiltered list through would silently drop a same-turn destination
  // on another floor, which reads as the engine being wrong rather than as
  // "look at the other tab".
  const reachableHere = getReachable(state, seatId, content).filter(
    (id) => floorOf(state.board, id) === displayFloor,
  );

  const promptTileName = pendingPayload
    ? (content.tilesById[pendingPayload.tileId]?.name ?? pendingPayload.tileId)
    : null;
  const promptSeatName = state.pending
    ? (seats.find((s) => s.seatId === state.pending!.seatId)?.name ??
      state.pending.seatId)
    : null;
  const ghost = pendingPayload
    ? {
        tileId: pendingPayload.tileId,
        x: pendingPayload.x,
        y: pendingPayload.y,
        rotation: isMyPrompt
          ? (previewRotation ?? pendingPayload.legalRotations[0]!)
          : defaultRotation(pendingPayload, state.pending?.defaultAnswer),
      }
    : undefined;

  const rotateStep = (delta: number) => {
    if (!pendingPayload || previewRotation === null) return;
    const opts = pendingPayload.legalRotations;
    const idx = opts.indexOf(previewRotation);
    setPreviewRotation(opts[(idx + delta + opts.length) % opts.length]!);
  };

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
              // Deliberately NOT gated on `state.pending`. Conceding is a
              // player's way out of a room they no longer want to be in, and
              // a prompt they cannot answer — someone else's — is exactly a
              // moment they might want it. The engine resolves a prompt owned
              // by the conceding seat on its default answer (`concede` in
              // packages/engine/src/reduce.ts), so leaving mid-discovery
              // cannot strand the drawn tile. Disabling the button here would
              // be a second, client-side legality opinion, which
              // docs/05-engine.md#57 forbids. `pending` below is the local
              // in-flight-action flag, unrelated to `state.pending`.
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
          {pendingPayload && (
            <div className="panel rotate-prompt">
              {isMyPrompt ? (
                <>
                  <h3>
                    Placing: {promptTileName}
                    {promptRemaining !== null && (
                      <span
                        className={
                          promptRemaining <= 10_000
                            ? 'rotate-prompt__clock rotate-prompt__clock--urgent'
                            : 'rotate-prompt__clock'
                        }
                        aria-live="polite"
                      >
                        {formatRemaining(promptRemaining)}
                      </span>
                    )}
                  </h3>
                  {/* Naming the consequence, not just the number: the
                      countdown is only reassuring if you know the tile still
                      gets placed when it runs out. */}
                  <p className="rotate-prompt__hint">
                    {promptRemaining === null
                      ? 'Choose a rotation.'
                      : 'If time runs out, it is placed as shown to everyone else.'}
                  </p>
                  <div className="actions">
                    <button
                      type="button"
                      className="btn"
                      disabled={pendingPayload.legalRotations.length < 2}
                      onClick={() => rotateStep(-1)}
                    >
                      Rotate left
                    </button>
                    <button
                      type="button"
                      className="btn"
                      disabled={pendingPayload.legalRotations.length < 2}
                      onClick={() => rotateStep(1)}
                    >
                      Rotate right
                    </button>
                    <button
                      type="button"
                      className="btn btn--primary"
                      disabled={previewRotation === null}
                      onClick={() =>
                        previewRotation !== null &&
                        send({
                          t: 'ROTATE_TILE',
                          seat: seatId,
                          rotation: previewRotation,
                        })
                      }
                    >
                      Place
                    </button>
                  </div>
                </>
              ) : (
                // docs/07-ui.md#73: "every other player sees 'Ox is placing
                // the Ballroom…'" — no controls, since ROTATE_TILE is not
                // this seat's action to take (getLegalActions returns [] for
                // everyone but the prompted seat while this is pending).
                <p>
                  {promptSeatName} is placing the {promptTileName}…
                  {promptRemaining !== null && (
                    <span className="rotate-prompt__clock" aria-live="polite">
                      {formatRemaining(promptRemaining)}
                    </span>
                  )}
                </p>
              )}
            </div>
          )}
          <FloorTabs active={displayFloor} onSelect={setFloor} pawnsByFloor={byFloor} />
          <Board
            board={state.board}
            content={content}
            floor={displayFloor}
            pawns={byFloor[displayFloor]}
            reachable={reachableHere}
            onMoveTo={
              pending
                ? undefined
                : (placedId) => send({ t: 'MOVE', seat: seatId, to: placedId })
            }
            moveThrough={
              pending || myLocation === null
                ? undefined
                : {
                    from: myLocation,
                    dirs: throughDirs,
                    onMove: (dir) => send({ t: 'MOVE_THROUGH', seat: seatId, dir }),
                  }
            }
            ghost={ghost}
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
