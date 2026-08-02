/**
 * The log panel (docs/07-ui.md#72: "scrolling event narration + chat").
 *
 * Deliberately thin. Every decision worth testing — what a line says, whose
 * it is — lives in `narrate.ts`, which is pure and covered; what is left here
 * is DOM wiring that vitest's `node` environment cannot reach (D6 in
 * docs/11-progress.md). Keeping the split sharp is the point: a component
 * that decided its own wording would be a component whose wording is untested.
 */

import { useEffect, useRef, useState } from 'react';
import { MAX_CHAT_LENGTH } from '@bahoth/shared';
import type { SeatId } from '@bahoth/shared';
import type { LogEntry } from './narrate.js';

/** Below this many px from the bottom, the view counts as pinned. */
const PIN_SLACK_PX = 24;

function timeOf(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function LogPanel({
  entries,
  mySeat,
  colourOf,
  onSend,
}: {
  entries: LogEntry[];
  mySeat: SeatId | null;
  /** Player colour for a seat, or null where there is no honest colour yet. */
  colourOf: (seat: SeatId) => string | null;
  onSend: (text: string) => void;
}) {
  const listRef = useRef<HTMLOListElement>(null);
  // Whether the reader is at the bottom. A log that always scrolls to the
  // newest line yanks history away from anyone scrolled up reading it, which
  // in a game with a turn clock is exactly when they are trying to catch up.
  const pinned = useRef(true);
  const [draft, setDraft] = useState('');

  useEffect(() => {
    const el = listRef.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [entries.length]);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight <= PIN_SLACK_PX;
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    // Saying something re-pins you. Not doing this means a player scrolled up
    // reading history types a message and never sees it arrive, which reads
    // as chat being broken.
    pinned.current = true;
    onSend(text);
    setDraft('');
  };

  return (
    <section className="panel log-panel">
      <h2>Log</h2>
      {/*
        aria-live="polite" makes the whole game followable by screen reader
        without any extra work (docs/07-ui.md#76) — every new line is
        announced when the reader is idle. It sits on the list rather than on
        each item so entries are announced in arrival order.
      */}
      <ol
        className="log"
        ref={listRef}
        onScroll={onScroll}
        aria-live="polite"
        aria-label="Event log"
      >
        {entries.map((entry) => {
          const colour = entry.seat ? colourOf(entry.seat) : null;
          return (
            <li
              key={entry.id}
              className={`log__line log__line--${entry.kind}${
                entry.seat && entry.seat === mySeat ? ' log__line--mine' : ''
              }`}
            >
              <time className="log__time" dateTime={new Date(entry.at).toISOString()}>
                {timeOf(entry.at)}
              </time>
              {/* Colour is never the only carrier of who a line is about
                  (docs/07-ui.md#76) — the name is in the text itself; the
                  swatch is a second, redundant cue. */}
              {colour && <span className={`swatch swatch--${colour}`} aria-hidden />}
              <span className="log__text">{entry.text}</span>
            </li>
          );
        })}
      </ol>

      <form className="log__compose" onSubmit={submit}>
        <input
          className="log__input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Say something…"
          aria-label="Chat message"
          // The server's own limit (protocol.ts), not a second number: a
          // client that let you type past it would be offering a message the
          // gateway rejects as BAD_MESSAGE.
          maxLength={MAX_CHAT_LENGTH}
        />
        <button type="submit" className="btn btn--tiny" disabled={draft.trim() === ''}>
          Send
        </button>
      </form>
    </section>
  );
}
