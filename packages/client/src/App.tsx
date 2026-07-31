import { useEffect } from 'react';
import { useStore } from './store.js';
import { Home } from './screens/Home.js';
import { Lobby } from './screens/Lobby.js';
import { Game } from './screens/Game.js';

export function App() {
  const init = useStore((s) => s.init);
  const screen = useStore((s) => s.screen);
  const connected = useStore((s) => s.connected);
  const error = useStore((s) => s.error);
  const dismissError = useStore((s) => s.dismissError);
  const content = useStore((s) => s.content);

  useEffect(() => {
    void init();
  }, [init]);

  if (!content) {
    return <div className="boot">Loading…</div>;
  }

  return (
    <div className="app">
      {!connected && (
        <div className="banner banner--warn" role="status">
          Reconnecting…
        </div>
      )}
      {error && (
        <div className="banner banner--error" role="alert">
          {error}
          <button type="button" onClick={dismissError} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      {screen === 'home' && <Home />}
      {screen === 'lobby' && <Lobby />}
      {screen === 'game' && <Game />}
    </div>
  );
}
