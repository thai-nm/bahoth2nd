import { useState } from 'react';
import { useStore } from '../store.js';
import { lastRoom } from '../net.js';

export function Home() {
  const name = useStore((s) => s.name);
  const setName = useStore((s) => s.setName);
  const createRoom = useStore((s) => s.createRoom);
  const joinRoom = useStore((s) => s.joinRoom);
  const connected = useStore((s) => s.connected);

  const [code, setCode] = useState('');
  const previous = lastRoom();

  const canAct = connected && name.trim().length > 0;

  return (
    <main className="screen screen--centred">
      <h1 className="title">Betrayal at House on the Hill</h1>
      <p className="subtitle">Second edition · web</p>

      <div className="card">
        <label className="field">
          <span>Your name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={24}
            placeholder="Explorer"
            autoFocus
          />
        </label>

        <button
          type="button"
          className="btn btn--primary"
          disabled={!canAct}
          onClick={createRoom}
        >
          Create a game
        </button>

        <div className="divider">
          <span>or</span>
        </div>

        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            if (canAct && code.trim()) joinRoom(code);
          }}
        >
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="ROOM CODE"
            maxLength={5}
            className="input--code"
            aria-label="Room code"
          />
          <button
            type="submit"
            className="btn"
            disabled={!canAct || code.trim().length !== 5}
          >
            Join
          </button>
        </form>

        {previous && (
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => joinRoom(previous)}
          >
            Rejoin {previous}
          </button>
        )}
      </div>
    </main>
  );
}
