import { describe, expect, it } from 'vitest';
import { fixtureContent } from '@bahoth/content';
import { playGame, replay, startedGame } from './testing.js';
import { reduce } from './reduce.js';
import { makeSeatId } from './setup.js';
import { getHostSeat, getLegalActions, traitValue } from './selectors.js';
import { checkInvariants } from './invariants.js';
import { TRAITS, type GameAction } from '@bahoth/shared';

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

  it('seeds trait indices from the chosen character, never the skull', () => {
    const character = content.characters[0]!;
    const g = playGame({
      players: ['Ana', 'Ben', 'Cal'],
      actions: [{ t: 'CHOOSE_CHAR', seat: 'seat_0', charId: character.id }],
    });
    expect(g.errors).toEqual([]);
    expect(g.state.players['seat_0']?.traits).toEqual(character.start);
    for (const trait of TRAITS) {
      expect(g.state.players['seat_0']?.traits[trait]).toBeGreaterThan(0);
    }
  });

  it('returns traits to zero when a character is cleared', () => {
    const g = playGame({
      players: ['Ana', 'Ben', 'Cal'],
      actions: [
        { t: 'CHOOSE_CHAR', seat: 'seat_0', charId: content.characters[0]!.id },
        { t: 'CHOOSE_CHAR', seat: 'seat_0', charId: null },
      ],
    });
    expect(g.errors).toEqual([]);
    expect(g.state.players['seat_0']?.traits).toEqual({
      speed: 0,
      might: 0,
      sanity: 0,
      knowledge: 0,
    });
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

describe('host transfer', () => {
  const chosen = ['seat_0', 'seat_1', 'seat_2'].map((seat, i) => ({
    t: 'CHOOSE_CHAR' as const,
    seat,
    charId: content.characters[i * 2]!.id,
  }));

  it('is the earliest-joined connected seat', () => {
    const g = playGame({ players: ['Ana', 'Ben', 'Cal'] });
    expect(getHostSeat(g.state)).toBe('seat_0');

    const dropped = playGame({
      players: ['Ana', 'Ben', 'Cal'],
      actions: [{ t: 'DISCONNECT', seat: 'seat_0' }],
    });
    expect(getHostSeat(dropped.state)).toBe('seat_1');
  });

  it('returns to the original host when they reconnect', () => {
    const g = playGame({
      players: ['Ana', 'Ben', 'Cal'],
      actions: [
        { t: 'DISCONNECT', seat: 'seat_0' },
        { t: 'RECONNECT', seat: 'seat_0' },
      ],
    });
    expect(getHostSeat(g.state)).toBe('seat_0');
  });

  it('lets the new host actually start the game', () => {
    const g = playGame({
      players: ['Ana', 'Ben', 'Cal'],
      actions: [...chosen, { t: 'DISCONNECT', seat: 'seat_0' }],
    });
    expect(getLegalActions(g.state, 'seat_1', content).map((a) => a.t)).toContain(
      'START_GAME',
    );

    const started = reduce(g.state, { t: 'START_GAME', seat: 'seat_1' }, content);
    expect(started.error).toBeUndefined();
    expect(started.state.phase).toBe('explore');
  });

  it('no longer offers START_GAME to a host who has dropped', () => {
    const g = playGame({
      players: ['Ana', 'Ben', 'Cal'],
      actions: [...chosen, { t: 'DISCONNECT', seat: 'seat_0' }],
    });
    expect(getLegalActions(g.state, 'seat_0', content).map((a) => a.t)).not.toContain(
      'START_GAME',
    );
  });

  it('narrates the transfer in the log', () => {
    const g = playGame({
      players: ['Ana', 'Ben', 'Cal'],
      actions: [{ t: 'DISCONNECT', seat: 'seat_0' }],
    });
    expect(g.events).toContainEqual({ t: 'log', text: 'Ben is now the host' });
  });

  it('says nothing when the drop does not move the role', () => {
    const g = playGame({
      players: ['Ana', 'Ben', 'Cal'],
      actions: [{ t: 'DISCONNECT', seat: 'seat_2' }],
    });
    expect(g.events.filter((e) => e.t === 'log')).toEqual([]);
  });

  it('falls back to the earliest seat when nobody is connected', () => {
    // Every seat dropping is exactly what crash recovery produces, and the
    // room must still name a host rather than returning null.
    const g = playGame({
      players: ['Ana', 'Ben', 'Cal'],
      actions: ['seat_0', 'seat_1', 'seat_2'].map((seat) => ({
        t: 'DISCONNECT' as const,
        seat,
      })),
    });
    expect(getHostSeat(g.state)).toBe('seat_0');
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

  it('carries real trait values into the started game', () => {
    const g = startedGame({ players: ['Ana', 'Ben', 'Cal'] });
    for (const player of Object.values(g.state.players)) {
      for (const trait of TRAITS) {
        // A printed trait value, not the zero an uninitialised index yields.
        expect(traitValue(g.state, player.seatId, trait, content)).toBeGreaterThan(0);
      }
    }
  });

  it('is rejected by the invariants if an explorer sits on the skull', () => {
    const g = startedGame();
    const seat = g.state.turnOrder[0]!;
    const player = g.state.players[seat]!;
    const skulled = {
      ...g.state,
      players: {
        ...g.state.players,
        [seat]: { ...player, traits: { ...player.traits, might: 0 } },
      },
    };
    expect(checkInvariants(skulled)).toContainEqual(expect.stringContaining('skull'));
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

describe('the turn clock', () => {
  const T0 = 1_700_000_000_000;

  it('is unarmed until the first TICK, because the engine has no clock', () => {
    const g = startedGame();
    expect(g.state.turnDeadline).toBeNull();

    const armed = reduce(g.state, { t: 'TICK', now: T0 }, content);
    expect(armed.error).toBeUndefined();
    expect(armed.state.turnDeadline).toBe(T0 + g.state.timers.turnMs);
  });

  it('does nothing, and costs nothing, while the deadline is in the future', () => {
    const g = startedGame();
    const armed = reduce(g.state, { t: 'TICK', now: T0 }, content).state;

    const idle = reduce(armed, { t: 'TICK', now: T0 + 1000 }, content);
    expect(idle.error).toBeUndefined();
    // Returned by reference and with no version bump: the server keys logging,
    // broadcasting, and room liveness off a change, so an inert tick must not
    // look like one.
    expect(idle.state).toBe(armed);
    expect(idle.state.version).toBe(armed.version);
    expect(idle.events).toEqual([]);
  });

  it('ends the turn when the deadline passes', () => {
    const g = startedGame();
    const [first, second] = g.state.turnOrder;
    const armed = reduce(g.state, { t: 'TICK', now: T0 }, content).state;

    const expired = reduce(
      armed,
      { t: 'TICK', now: T0 + g.state.timers.turnMs },
      content,
    );
    expect(expired.error).toBeUndefined();
    expect(expired.state.activeSeat).toBe(second);
    expect(expired.state.activeSeat).not.toBe(first);
    // Disarmed again, ready for the next seat's budget.
    expect(expired.state.turnDeadline).toBeNull();
    expect(expired.events).toContainEqual({ t: 'turn_ended', seat: first });
    expect(
      expired.events.some((e) => e.t === 'log' && /ran out of time/.test(e.text)),
    ).toBe(true);
  });

  it('gives a seat that has dropped the shorter budget', () => {
    const g = startedGame();
    const active = g.state.activeSeat!;
    const dropped = reduce(g.state, { t: 'DISCONNECT', seat: active }, content).state;

    const armed = reduce(dropped, { t: 'TICK', now: T0 }, content).state;
    expect(armed.turnDeadline).toBe(T0 + g.state.timers.disconnectedMs);
    expect(g.state.timers.disconnectedMs).toBeLessThan(g.state.timers.turnMs);
  });

  it('re-arms with the short budget when the active seat drops mid-turn', () => {
    const g = startedGame();
    const active = g.state.activeSeat!;
    const armed = reduce(g.state, { t: 'TICK', now: T0 }, content).state;
    expect(armed.turnDeadline).toBe(T0 + g.state.timers.turnMs);

    // Dropping disarms; the next tick re-arms against the shorter budget, so a
    // player who walks out at the start of a 10-minute turn stalls the room
    // for 90 seconds, not for ten minutes.
    const gone = reduce(armed, { t: 'DISCONNECT', seat: active }, content).state;
    expect(gone.turnDeadline).toBeNull();
    const rearmed = reduce(gone, { t: 'TICK', now: T0 + 5000 }, content).state;
    expect(rearmed.turnDeadline).toBe(T0 + 5000 + g.state.timers.disconnectedMs);
  });

  it('restores the full budget when the active seat comes back', () => {
    const g = startedGame();
    const active = g.state.activeSeat!;
    let state = reduce(g.state, { t: 'DISCONNECT', seat: active }, content).state;
    state = reduce(state, { t: 'TICK', now: T0 }, content).state;
    expect(state.turnDeadline).toBe(T0 + g.state.timers.disconnectedMs);

    state = reduce(state, { t: 'RECONNECT', seat: active }, content).state;
    expect(state.turnDeadline).toBeNull();
    state = reduce(state, { t: 'TICK', now: T0 + 1000 }, content).state;
    expect(state.turnDeadline).toBe(T0 + 1000 + g.state.timers.turnMs);
  });

  it('does not run in the lobby', () => {
    const g = playGame({ players: ['Ana', 'Ben', 'Cal'] });
    const ticked = reduce(g.state, { t: 'TICK', now: T0 }, content);
    expect(ticked.state).toBe(g.state);
    expect(ticked.state.turnDeadline).toBeNull();
  });

  it('keeps the room moving indefinitely when nobody is connected', () => {
    // The failure this replaces: a disconnected active player stalled the room
    // forever. Now every expiry passes play on, so the game keeps advancing.
    const g = startedGame();
    let state = g.state;
    for (const seat of g.state.turnOrder) {
      state = reduce(state, { t: 'DISCONNECT', seat }, content).state;
    }

    let now = T0;
    const seen: string[] = [];
    for (let i = 0; i < 6; i++) {
      state = reduce(state, { t: 'TICK', now }, content).state; // arms
      now = state.turnDeadline!;
      state = reduce(state, { t: 'TICK', now }, content).state; // expires
      seen.push(state.activeSeat!);
    }
    expect(new Set(seen).size).toBe(g.state.turnOrder.length);
    expect(state.round).toBeGreaterThan(1);
  });

  it('replays to the same deadlines from the log', () => {
    const g = startedGame({ seed: 77 });
    const ticks: GameAction[] = [
      { t: 'TICK', now: T0 },
      { t: 'TICK', now: T0 + g.state.timers.turnMs },
      { t: 'TICK', now: T0 + g.state.timers.turnMs + 1 },
    ];
    let state = g.state;
    for (const a of ticks) state = reduce(state, a, content).state;

    const r = replay([...g.accepted, ...ticks], { seed: 77, content });
    expect(r.errors).toEqual([]);
    expect(JSON.stringify(r.state)).toBe(JSON.stringify(state));
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
