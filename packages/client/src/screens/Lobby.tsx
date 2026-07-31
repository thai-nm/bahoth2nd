import { useStore } from '../store.js';
import { getLegalActions } from '@bahoth/engine';
import type { GameAction } from '@bahoth/shared';

export function Lobby() {
  const state = useStore((s) => s.state);
  const content = useStore((s) => s.content);
  const seatId = useStore((s) => s.seatId);
  const roomCode = useStore((s) => s.roomCode);
  const send = useStore((s) => s.send);
  const pending = useStore((s) => s.pendingSeq !== null);

  if (!state || !content || !seatId) return <div className="boot">Joining…</div>;

  // The single source of truth for what this seat may do. Never write a
  // second client-side legality check (docs/05-engine.md#57).
  const legal = getLegalActions(state, seatId, content);
  const canChoose = new Set(
    legal
      .filter((a) => a.t === 'CHOOSE_CHAR')
      .map((a) => (a as { charId: string | null }).charId),
  );
  const canStart = legal.some((a) => a.t === 'START_GAME');

  const me = state.players[seatId];

  // Seat rows read from state.players, not from the `room` message: `room` is
  // only re-sent on join/leave, so its charId goes stale the moment someone
  // picks an explorer, while every snapshot carries the current truth.
  const players = Object.values(state.players);

  return (
    <main className="screen">
      <header className="lobby__header">
        <div>
          <h1 className="title title--sm">Lobby</h1>
          <p className="subtitle">
            Share this code: <strong className="code">{roomCode}</strong>
          </p>
        </div>
        <button
          type="button"
          className="btn btn--primary"
          disabled={!canStart || pending}
          onClick={() => send({ t: 'START_GAME', seat: seatId })}
          title={
            canStart ? undefined : 'Every player needs an explorer, and 3 players minimum'
          }
        >
          Start game
        </button>
      </header>

      <section className="lobby__seats">
        <h2>Players ({players.length}/6)</h2>
        <ul className="seatlist">
          {players.map((s) => {
            const character = s.charId ? content.charactersById[s.charId] : null;
            return (
              <li
                key={s.seatId}
                className={s.seatId === seatId ? 'seat seat--me' : 'seat'}
              >
                <span className={s.connected ? 'dot dot--on' : 'dot'} aria-hidden />
                <span className="seat__name">{s.name}</span>
                <span className="seat__char">
                  {character ? (
                    <>
                      <span
                        className={`swatch swatch--${character.colour}`}
                        aria-hidden
                      />
                      {character.name}
                    </>
                  ) : (
                    <em>choosing…</em>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="lobby__chars">
        <h2>Choose an explorer</h2>
        <div className="chargrid">
          {content.characters.map((c) => {
            const mine = me?.charId === c.id;
            const available = canChoose.has(c.id);
            const action: GameAction = {
              t: 'CHOOSE_CHAR',
              seat: seatId,
              charId: mine ? null : c.id,
            };
            return (
              <button
                key={c.id}
                type="button"
                className={`charcard${mine ? ' charcard--mine' : ''}`}
                disabled={(!available && !mine) || pending}
                onClick={() => send(action)}
              >
                <span className={`swatch swatch--${c.colour}`} aria-hidden />
                <span className="charcard__name">{c.name}</span>
                <span className="charcard__traits">
                  {(['speed', 'might', 'sanity', 'knowledge'] as const).map((t) => (
                    <span key={t} title={t}>
                      {t[0]!.toUpperCase()} {c.tracks[t][c.start[t]]}
                    </span>
                  ))}
                </span>
                {mine && <span className="charcard__badge">yours — click to clear</span>}
              </button>
            );
          })}
        </div>
      </section>
    </main>
  );
}
