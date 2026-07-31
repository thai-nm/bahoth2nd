/**
 * The redaction test. See docs/10-testing-and-ops.md#the-redaction-test.
 *
 * "This is the one security property worth automating; write it in M1 and
 * never delete it." Written in M0 instead, because the deck plumbing exists
 * and there is no reason to ship a snapshot path without it.
 */

import { describe, expect, it } from 'vitest';
import { redactFor, isRedacted } from './redact.js';
import { startedGame } from './testing.js';
import { DECK_KINDS, type GameState } from '@bahoth/shared';

/** Plant known card ids in the draw piles so the leak test has something to find. */
function withStockedDecks(state: GameState): GameState {
  const decks = { ...state.decks };
  for (const kind of DECK_KINDS) {
    decks[kind] = {
      draw: [`${kind}.secret_1`, `${kind}.secret_2`, `${kind}.secret_3`],
      discard: [`${kind}.public_discard`],
      inPlay: [`${kind}.public_inplay`],
    };
  }
  return { ...state, decks };
}

describe('redactFor', () => {
  it('removes the RNG seed', () => {
    const state = startedGame().state;
    expect(state.rng).toBeDefined();
    const redacted = redactFor(state, 'seat_0');
    expect(redacted.rng).toBeUndefined();
    expect('rng' in redacted).toBe(false);
    expect(isRedacted(redacted)).toBe(true);
  });

  it('leaks no draw-pile card id, for any seat', () => {
    const state = withStockedDecks(startedGame().state);
    const viewers = [...state.turnOrder, null];

    for (const viewer of viewers) {
      const json = JSON.stringify(redactFor(state, viewer));
      for (const kind of DECK_KINDS) {
        for (const cardId of state.decks[kind].draw) {
          expect(json, `viewer ${viewer} saw ${cardId}`).not.toContain(cardId);
        }
      }
      expect(json).not.toContain('"seed"');
    }
  });

  it('keeps draw counts, discards, and in-play cards visible', () => {
    const state = withStockedDecks(startedGame().state);
    const redacted = redactFor(state, 'seat_0');
    for (const kind of DECK_KINDS) {
      expect(redacted.decks[kind].drawCount).toBe(3);
      expect(redacted.decks[kind].draw).toEqual([]);
      expect(redacted.decks[kind].discard).toContain(`${kind}.public_discard`);
      expect(redacted.decks[kind].inPlay).toContain(`${kind}.public_inplay`);
    }
  });

  it('keeps public information public', () => {
    // Items, traits, board, and omen count are open at the physical table.
    const state = startedGame().state;
    const redacted = redactFor(state, 'seat_1');
    expect(Object.keys(redacted.players)).toEqual(Object.keys(state.players));
    for (const seat of Object.keys(state.players)) {
      expect(redacted.players[seat]?.traits).toEqual(state.players[seat]?.traits);
      expect(redacted.players[seat]?.items).toEqual(state.players[seat]?.items);
    }
    expect(redacted.omensDrawn).toBe(state.omensDrawn);
    expect(redacted.turnOrder).toEqual(state.turnOrder);
  });

  it('hides the haunt id until the reveal completes', () => {
    const base = startedGame().state;
    const hidden: GameState = {
      ...base,
      haunt: { hauntId: 37, traitorSeat: 'seat_1', revealed: false, acknowledged: [] },
    };
    const redacted = redactFor(hidden, 'seat_0');
    expect(redacted.haunt?.hauntId).toBe(0);
    expect(redacted.haunt?.traitorSeat).toBeNull();
    expect(JSON.stringify(redacted)).not.toContain('37');

    const revealed: GameState = {
      ...hidden,
      haunt: { ...hidden.haunt!, revealed: true },
    };
    expect(redactFor(revealed, 'seat_0').haunt?.hauntId).toBe(37);
  });

  it('is subtractive: the result is still a valid GameState shape', () => {
    const state = withStockedDecks(startedGame().state);
    const redacted = redactFor(state, 'seat_0');
    expect(redacted.phase).toBe(state.phase);
    expect(redacted.version).toBe(state.version);
    expect(redacted.board).toEqual(state.board);
    expect(redacted.contentHash).toBe(state.contentHash);
  });

  it('does not mutate the input state', () => {
    const state = withStockedDecks(startedGame().state);
    const before = JSON.stringify(state);
    redactFor(state, 'seat_0');
    expect(JSON.stringify(state)).toBe(before);
  });
});
