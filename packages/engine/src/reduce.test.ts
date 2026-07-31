import { describe, expect, it } from 'vitest';
import { fixtureContent } from '@bahoth/content';
import { playGame, replay, startedGame } from './testing.js';
import { reduce } from './reduce.js';
import { makeSeatId } from './setup.js';
import { getLegalActions } from './selectors.js';
import type { GameAction } from '@bahoth/shared';

const content = fixtureContent();

describe('lobby', () => {
  it('seats joining players', () => {
    const g = playGame({ players: ['Ana', 'Ben', 'Cal'] });
    expect(g.errors).toEqual([]);
    expect(Object.keys(g.state.players)).toHaveLength(3);
    expect(g.state.players['seat_0']?.name).toBe('Ana');
    expect(g.state.phase).toBe('lobby');
  });

  it('rejects a seventh player', () => {
    const g = playGame({ players: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] });
    expect(g.errors).toHaveLength(1);
    expect(g.errors[0]?.error.code).toBe('TOO_MANY_PLAYERS');
    expect(Object.keys(g.state.players)).toHaveLength(6);
  });

  it('treats a repeat JOIN on the same seat as a reconnect', () => {
    const g = playGame({
      players: ['Ana', 'Ben', 'Cal'],
      actions: [
        { t: 'DISCONNECT', seat: 'seat_0' },
        { t: 'JOIN', seat: 'seat_0', name: 'Ana' },
      ],
    });
    expect(g.errors).toEqual([]);
    expect(g.state.players['seat_0']?.connected).toBe(true);
    expect(Object.keys(g.state.players)).toHaveLength(3);
  });

  it('refuses two players the same character', () => {
    const charId = content.characters[0]!.id;
    const g = playGame({
      players: ['Ana', 'Ben', 'Cal'],
      actions: [
        { t: 'CHOOSE_CHAR', seat: 'seat_0', charId },
        { t: 'CHOOSE_CHAR', seat: 'seat_1', charId },
      ],
    });
    expect(g.errors).toHaveLength(1);
    expect(g.errors[0]?.error.code).toBe('CHARACTER_TAKEN');
  });

  it('refuses two players the same colour', () => {
    // fixtures pair characters by colour: green_a and green_b.
    const green = content.characters.filter((c) => c.colour === 'green');
    expect(green.length).toBeGreaterThanOrEqual(2);
    const g = playGame({
      players: ['Ana', 'Ben', 'Cal'],
      actions: [
        { t: 'CHOOSE_CHAR', seat: 'seat_0', charId: green[0]!.id },
        { t: 'CHOOSE_CHAR', seat: 'seat_1', charId: green[1]!.id },
      ],
    });
    expect(g.errors).toHaveLength(1);
    expect(g.errors[0]?.error.code).toBe('CHARACTER_TAKEN');
  });

  it('lets a player clear and re-pick a character', () => {
    const a = content.characters[0]!.id;
    const g = playGame({
      players: ['Ana', 'Ben', 'Cal'],
      actions: [
        { t: 'CHOOSE_CHAR', seat: 'seat_0', charId: a },
        { t: 'CHOOSE_CHAR', seat: 'seat_0', charId: null },
        { t: 'CHOOSE_CHAR', seat: 'seat_1', charId: a },
      ],
    });
    expect(g.errors).toEqual([]);
    expect(g.state.players['seat_1']?.charId).toBe(a);
  });
});

describe('starting a game', () => {
  it('requires three players', () => {
    const g = playGame({
      players: ['Ana', 'Ben'],
      actions: [
        { t: 'CHOOSE_CHAR', seat: 'seat_0', charId: content.characters[0]!.id },
        { t: 'CHOOSE_CHAR', seat: 'seat_1', charId: content.characters[2]!.id },
        { t: 'START_GAME', seat: 'seat_0' },
      ],
    });
    expect(g.errors.at(-1)?.error.code).toBe('NOT_ENOUGH_PLAYERS');
    expect(g.state.phase).toBe('lobby');
  });

  it('requires every player to have chosen', () => {
    const g = playGame({
      players: ['Ana', 'Ben', 'Cal'],
      actions: [
        { t: 'CHOOSE_CHAR', seat: 'seat_0', charId: content.characters[0]!.id },
        { t: 'START_GAME', seat: 'seat_0' },
      ],
    });
    expect(g.errors.at(-1)?.error.code).toBe('CHARACTER_REQUIRED');
  });

  it('only the host may start', () => {
    const g = startedGame({
      players: ['Ana', 'Ben', 'Cal'],
      actions: [],
    });
    expect(g.state.phase).toBe('explore');

    const nonHost = playGame({
      players: ['Ana', 'Ben', 'Cal'],
      actions: [
        ...['seat_0', 'seat_1', 'seat_2'].map((seat, i) => ({
          t: 'CHOOSE_CHAR' as const,
          seat,
          charId: content.characters[i * 2]!.id,
        })),
        { t: 'START_GAME', seat: 'seat_2' },
      ],
    });
    expect(nonHost.errors.at(-1)?.error.code).toBe('NOT_HOST');
  });

  it('shuffles turn order deterministically from the seed', () => {
    expect(startedGame({ seed: 99 }).state.turnOrder).toEqual(
      startedGame({ seed: 99 }).state.turnOrder,
    );
  });

  it('produces different turn orders across seeds', () => {
    // Asserting two specific seeds differ would be flaky: three players have
    // only six permutations. The real property is that the order depends on
    // the seed at all, so check the spread over many seeds.
    const orders = new Set<string>();
    for (let seed = 1; seed <= 40; seed++) {
      orders.add(startedGame({ seed }).state.turnOrder.join(','));
    }
    expect(orders.size).toBeGreaterThan(1);
  });

  it('seats every player exactly once in turn order', () => {
    const g = startedGame({ players: ['Ana', 'Ben', 'Cal', 'Dot'] });
    expect([...g.state.turnOrder].sort()).toEqual(Object.keys(g.state.players).sort());
  });
});

describe('turn loop', () => {
  it('passes the turn around and counts rounds', () => {
    const g = startedGame();
    const order = g.state.turnOrder;
    let state = g.state;

    for (const seat of order) {
      expect(state.activeSeat).toBe(seat);
      const r = reduce(state, { t: 'END_TURN', seat }, content);
      expect(r.error).toBeUndefined();
      state = r.state;
    }

    expect(state.activeSeat).toBe(order[0]);
    expect(state.round).toBe(2);
  });

  it('refuses an out-of-turn END_TURN', () => {
    const g = startedGame();
    const notActive = g.state.turnOrder[1]!;
    const r = reduce(g.state, { t: 'END_TURN', seat: notActive }, content);
    expect(r.error?.code).toBe('NOT_YOUR_TURN');
  });

  it('leaves state untouched when an action is rejected', () => {
    const g = startedGame();
    const before = JSON.stringify(g.state);
    const r = reduce(g.state, { t: 'END_TURN', seat: g.state.turnOrder[1]! }, content);
    expect(r.error).toBeDefined();
    expect(JSON.stringify(r.state)).toBe(before);
    expect(r.events).toEqual([]);
  });

  it('bumps version only on accepted actions', () => {
    const g = startedGame();
    const v = g.state.version;
    const ok = reduce(g.state, { t: 'END_TURN', seat: g.state.activeSeat! }, content);
    expect(ok.state.version).toBe(v + 1);
    const bad = reduce(g.state, { t: 'END_TURN', seat: g.state.turnOrder[1]! }, content);
    expect(bad.state.version).toBe(v);
  });

  it('skips dead players when passing the turn', () => {
    const g = startedGame();
    const [first, second] = g.state.turnOrder;
    const conceded = reduce(g.state, { t: 'CONCEDE', seat: second! }, content);
    expect(conceded.error).toBeUndefined();
    const ended = reduce(conceded.state, { t: 'END_TURN', seat: first! }, content);
    expect(ended.error).toBeUndefined();
    expect(ended.state.activeSeat).not.toBe(second);
  });
});

describe('unimplemented actions', () => {
  it('are rejected cleanly rather than silently ignored', () => {
    const g = startedGame();
    const r = reduce(
      g.state,
      { t: 'MOVE', seat: g.state.activeSeat!, to: 'nowhere' },
      content,
    );
    expect(r.error?.code).toBe('UNKNOWN_ACTION');
    expect(r.state).toBe(g.state);
  });
});

describe('replay determinism', () => {
  it('reproduces the exact final state from the action log', () => {
    const g = startedGame({
      seed: 4242,
      actions: [
        { t: 'END_TURN', seat: 'seat_0' },
        { t: 'END_TURN', seat: 'seat_1' },
        { t: 'END_TURN', seat: 'seat_2' },
      ].filter(Boolean) as GameAction[],
    });

    // The scripted actions above may include out-of-turn ones depending on the
    // shuffled order; replay the ACCEPTED log, which is what the server writes.
    const r = replay(g.accepted, { seed: 4242, content });
    expect(r.errors).toEqual([]);
    expect(JSON.stringify(r.state)).toBe(JSON.stringify(g.state));
  });
});

describe('getLegalActions', () => {
  it('offers only the active seat an END_TURN', () => {
    const g = startedGame();
    const active = g.state.activeSeat!;
    const other = g.state.turnOrder.find((s) => s !== active)!;
    expect(getLegalActions(g.state, active, content).map((a) => a.t)).toContain(
      'END_TURN',
    );
    expect(getLegalActions(g.state, other, content)).toEqual([]);
  });

  it('offers the host START_GAME only once everyone has chosen', () => {
    const seats = ['seat_0', 'seat_1', 'seat_2'];
    const partial = playGame({
      players: ['Ana', 'Ben', 'Cal'],
      actions: [{ t: 'CHOOSE_CHAR', seat: 'seat_0', charId: content.characters[0]!.id }],
    });
    expect(
      getLegalActions(partial.state, 'seat_0', content).map((a) => a.t),
    ).not.toContain('START_GAME');

    const full = playGame({
      players: ['Ana', 'Ben', 'Cal'],
      actions: seats.map((seat, i) => ({
        t: 'CHOOSE_CHAR' as const,
        seat,
        charId: content.characters[i * 2]!.id,
      })),
    });
    expect(getLegalActions(full.state, 'seat_0', content).map((a) => a.t)).toContain(
      'START_GAME',
    );
    // ...and never to a non-host.
    expect(getLegalActions(full.state, 'seat_1', content).map((a) => a.t)).not.toContain(
      'START_GAME',
    );
  });

  it('never offers a character that is taken or colour-blocked', () => {
    const green = content.characters.filter((c) => c.colour === 'green');
    const g = playGame({
      players: ['Ana', 'Ben', 'Cal'],
      actions: [{ t: 'CHOOSE_CHAR', seat: 'seat_0', charId: green[0]!.id }],
    });
    const offered = getLegalActions(g.state, 'seat_1', content)
      .filter((a) => a.t === 'CHOOSE_CHAR')
      .map((a) => (a as { charId: string | null }).charId);
    expect(offered).not.toContain(green[0]!.id);
    expect(offered).not.toContain(green[1]!.id);
  });
});

describe('makeSeatId', () => {
  it('is stable', () => {
    expect(makeSeatId(0)).toBe('seat_0');
    expect(makeSeatId(5)).toBe('seat_5');
  });
});
