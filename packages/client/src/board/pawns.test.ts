import { describe, expect, it } from 'vitest';
import { getReachable, makeSeatId, reduce, startedGame } from '@bahoth/engine';
import { placedIdFor } from '@bahoth/shared';
import type { GameState } from '@bahoth/shared';
import { fixtureContent } from '@bahoth/content';
import { floorOf, pawnInitial, pawnsFromState } from './pawns.js';

const content = fixtureContent();

describe('pawnsFromState', () => {
  it('places every explorer on the start tile, ground floor, one pawn each', () => {
    const g = startedGame();
    const { byFloor, all } = pawnsFromState(g.state, g.content, null);

    expect(all).toHaveLength(g.seats.length);
    expect(byFloor.ground).toHaveLength(g.seats.length);
    expect(byFloor.basement).toHaveLength(0);
    expect(byFloor.upper).toHaveLength(0);

    // All explorers begin in the same room (the house's declared start tile).
    const placedIds = new Set(byFloor.ground.map((p) => p.placedId));
    expect(placedIds.size).toBe(1);
  });

  it('sets isMe for exactly the given seat, and for nobody when mySeat is null', () => {
    const g = startedGame();
    const mySeat = makeSeatId(1);

    const withMe = pawnsFromState(g.state, g.content, mySeat);
    expect(withMe.all.filter((p) => p.isMe)).toHaveLength(1);

    const withoutMe = pawnsFromState(g.state, g.content, null);
    expect(withoutMe.all.filter((p) => p.isMe)).toHaveLength(0);
  });

  it('skips a dead player but keeps a removed one', () => {
    const g = startedGame();
    const deadSeat = makeSeatId(0);
    const removedSeat = makeSeatId(1);
    const state: GameState = {
      ...g.state,
      players: {
        ...g.state.players,
        [deadSeat]: { ...g.state.players[deadSeat]!, isDead: true },
        [removedSeat]: { ...g.state.players[removedSeat]!, removed: true },
      },
    };

    const { all } = pawnsFromState(state, g.content, null);
    expect(all).toHaveLength(g.seats.length - 1); // dead seat dropped, removed seat kept

    const removedPlayer = state.players[removedSeat]!;
    const removedCharacter = g.content.charactersById[removedPlayer.charId!]!;
    expect(all.some((p) => p.colour === removedCharacter.colour)).toBe(true);
  });

  it('skips a player whose location points at a tile not in board.placed, without throwing', () => {
    const g = startedGame();
    const ghostSeat = makeSeatId(0);
    const state: GameState = {
      ...g.state,
      players: {
        ...g.state.players,
        [ghostSeat]: {
          ...g.state.players[ghostSeat]!,
          location: placedIdFor('upper', 99, 99), // never placed
        },
      },
    };

    expect(() => pawnsFromState(state, g.content, null)).not.toThrow();
    const { all } = pawnsFromState(state, g.content, null);
    expect(all).toHaveLength(g.seats.length - 1);
  });

  it('floorOf returns the floor for a placed id and null for an unknown one', () => {
    const g = startedGame();
    const startTile = g.state.players[makeSeatId(0)]!.location!;

    expect(floorOf(g.state.board, startTile)).toBe('ground');
    expect(floorOf(g.state.board, placedIdFor('upper', 42, 42))).toBeNull();
    expect(floorOf(g.state.board, null)).toBeNull();
  });

  it('follows the pawn to its new tile after a MOVE', () => {
    const g = startedGame();
    const seat = g.state.activeSeat;
    expect(seat).not.toBeNull();

    // getReachable is the only source of truth for where this seat may go
    // (docs/05-engine.md#57) — pull a legal destination from it rather than
    // guessing a PlacedId by hand.
    const reachable = getReachable(g.state, seat!, g.content);
    expect(reachable.length).toBeGreaterThan(0);
    const destination = reachable[0]!;

    const result = reduce(
      g.state,
      { t: 'MOVE', seat: seat!, to: destination },
      g.content,
    );
    expect(result.error).toBeUndefined();

    const { all } = pawnsFromState(result.state, g.content, null);
    const moved = all.find((p) => p.placedId === destination);
    expect(moved).toBeDefined();
  });
});

describe('pawnInitial', () => {
  // Every placeholder explorer is "The <something>", so the raw first letter
  // gave every pawn on the board the same "T" — found by opening the screen,
  // not by a test. The assertion is here so it cannot come back.
  it('drops a leading article rather than initialling every explorer "T"', () => {
    expect(pawnInitial('The Athlete', 'Ana')).toBe('A');
    expect(pawnInitial('The Mechanic', 'Ben')).toBe('M');
    expect(pawnInitial('The Student', 'Cal')).toBe('S');
  });

  it('leaves a name with no article alone', () => {
    expect(pawnInitial('Ox Bellows', 'Ana')).toBe('O');
  });

  it('falls back to the player name when the character name is empty', () => {
    expect(pawnInitial('', 'Ana')).toBe('A');
  });

  it('gives distinct initials to the fixture explorers a game actually seats', () => {
    // The real defect was collision, not a wrong letter, so assert on that:
    // the three explorers a 3-player game takes must not all draw the same
    // pawn. One-per-colour mirrors how startedGame picks them.
    const seen = new Set<string>();
    const picked: string[] = [];
    for (const c of content.characters) {
      if (seen.has(c.colour)) continue;
      seen.add(c.colour);
      picked.push(pawnInitial(c.name, 'x'));
      if (picked.length === 3) break;
    }
    expect(new Set(picked).size).toBe(3);
  });
});
