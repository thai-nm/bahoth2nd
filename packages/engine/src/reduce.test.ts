import { describe, expect, it } from 'vitest';
import {
  buildContent,
  fixtureContent,
  type Content,
  type House,
  type Tile,
} from '@bahoth/content';
import { playGame, replay, startedGame } from './testing.js';
import { reduce } from './reduce.js';
import { makeSeatId } from './setup.js';
import { getHostSeat, getLegalActions, traitValue } from './selectors.js';
import { checkInvariants } from './invariants.js';
import { getConnections } from './movement.js';
import { redactFor } from './redact.js';
import { canDiscoverOn, drawTile } from './discovery.js';
import { makeRng } from './rng.js';
import {
  FLOORS,
  isRotateTilePayload,
  placedIdFor,
  TRAITS,
  type Doors,
  type GameAction,
  type GameState,
} from '@bahoth/shared';

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

describe('the remove-player vote', () => {
  const T0 = 1_700_000_000_000;

  /** A started game with `absent` dropped at T0. */
  function gameWithAbsentee() {
    const g = startedGame({ players: ['Ana', 'Ben', 'Cal', 'Dot'] });
    // Pick someone who is not the active seat, so removal and the turn clock
    // are tested separately rather than in one tangle.
    const absent = g.state.turnOrder.find((s) => s !== g.state.activeSeat)!;
    const state = reduce(g.state, { t: 'DISCONNECT', seat: absent, at: T0 }, content);
    expect(state.error).toBeUndefined();
    return { state: state.state, absent, grace: g.state.timers.removeGraceMs };
  }

  it('is offered against an absent seat, and never against a present one', () => {
    const { state, absent } = gameWithAbsentee();
    const voter = Object.keys(state.players).find((s) => s !== absent)!;

    const targets = getLegalActions(state, voter, content)
      .filter((a) => a.t === 'VOTE_REMOVE')
      .map((a) => a.target);
    expect(targets).toEqual([absent]);
  });

  it('refuses a vote against yourself or against someone still here', () => {
    const { state, absent } = gameWithAbsentee();
    const present = Object.keys(state.players).find((s) => s !== absent)!;

    expect(
      reduce(
        state,
        { t: 'VOTE_REMOVE', seat: absent, target: absent, vote: true },
        content,
      ).error?.code,
    ).toBe('ILLEGAL_MOVE');
    expect(
      reduce(
        state,
        { t: 'VOTE_REMOVE', seat: absent, target: present, vote: true },
        content,
      ).error?.code,
    ).toBe('ILLEGAL_MOVE');
  });

  it('does nothing until the grace period has passed, however many vote', () => {
    const { state, absent, grace } = gameWithAbsentee();
    let s = state;
    for (const voter of Object.keys(s.players)) {
      if (voter === absent) continue;
      s = reduce(
        s,
        { t: 'VOTE_REMOVE', seat: voter, target: absent, vote: true },
        content,
      ).state;
    }
    expect(s.removeVotes[absent]).toHaveLength(3);

    // Unanimous, one millisecond short of the grace period.
    s = reduce(s, { t: 'TICK', now: T0 + grace - 1 }, content).state;
    expect(s.players[absent]?.removed).toBe(false);
    expect(s.turnOrder).toContain(absent);
  });

  it('removes the seat once a majority has voted and the grace has passed', () => {
    const { state, absent, grace } = gameWithAbsentee();
    let s = state;
    const voters = Object.keys(s.players).filter((v) => v !== absent);
    // Two of three eligible voters: a strict majority.
    for (const voter of voters.slice(0, 2)) {
      s = reduce(
        s,
        { t: 'VOTE_REMOVE', seat: voter, target: absent, vote: true },
        content,
      ).state;
    }

    const ticked = reduce(s, { t: 'TICK', now: T0 + grace }, content);
    expect(ticked.error).toBeUndefined();
    s = ticked.state;

    expect(s.players[absent]?.removed).toBe(true);
    expect(s.turnOrder).not.toContain(absent);
    expect(s.removeVotes[absent]).toBeUndefined();
    // The body stays on the board holding its things — removed is not dead.
    expect(s.players[absent]?.isDead).toBe(false);
    expect(s.players[absent]?.charId).toBe(state.players[absent]?.charId);
    expect(
      ticked.events.some((e) => e.t === 'log' && /removed by vote/.test(e.text)),
    ).toBe(true);
  });

  it('does not remove on a minority', () => {
    const { state, absent, grace } = gameWithAbsentee();
    const voter = Object.keys(state.players).find((v) => v !== absent)!;
    let s = reduce(
      state,
      { t: 'VOTE_REMOVE', seat: voter, target: absent, vote: true },
      content,
    ).state;

    s = reduce(s, { t: 'TICK', now: T0 + grace }, content).state;
    expect(s.players[absent]?.removed).toBe(false);
    expect(s.removeVotes[absent]).toEqual([voter]);
  });

  it('cancels every vote when the seat comes back', () => {
    const { state, absent, grace } = gameWithAbsentee();
    let s = state;
    for (const voter of Object.keys(s.players)) {
      if (voter === absent) continue;
      s = reduce(
        s,
        { t: 'VOTE_REMOVE', seat: voter, target: absent, vote: true },
        content,
      ).state;
    }

    s = reduce(s, { t: 'RECONNECT', seat: absent }, content).state;
    expect(s.removeVotes[absent]).toBeUndefined();
    expect(s.players[absent]?.disconnectedAt).toBeNull();

    // Dropping again starts the grace period over rather than resuming it.
    s = reduce(s, { t: 'DISCONNECT', seat: absent, at: T0 + grace }, content).state;
    s = reduce(s, { t: 'TICK', now: T0 + grace + 1 }, content).state;
    expect(s.players[absent]?.removed).toBe(false);
  });

  it('lets a voter withdraw', () => {
    const { state, absent } = gameWithAbsentee();
    const voter = Object.keys(state.players).find((v) => v !== absent)!;
    let s = reduce(
      state,
      { t: 'VOTE_REMOVE', seat: voter, target: absent, vote: true },
      content,
    ).state;
    expect(s.removeVotes[absent]).toEqual([voter]);

    s = reduce(
      s,
      { t: 'VOTE_REMOVE', seat: voter, target: absent, vote: false },
      content,
    ).state;
    // The key is dropped entirely rather than left as an empty array, so
    // "is there a vote running?" is a single check.
    expect(s.removeVotes[absent]).toBeUndefined();
  });

  it('passes the turn on if the removed seat was the active one', () => {
    const g = startedGame({ players: ['Ana', 'Ben', 'Cal', 'Dot'] });
    const absent = g.state.activeSeat!;
    let s = reduce(g.state, { t: 'DISCONNECT', seat: absent, at: T0 }, content).state;
    for (const voter of Object.keys(s.players)) {
      if (voter === absent) continue;
      s = reduce(
        s,
        { t: 'VOTE_REMOVE', seat: voter, target: absent, vote: true },
        content,
      ).state;
    }

    s = reduce(s, { t: 'TICK', now: T0 + g.state.timers.removeGraceMs }, content).state;
    expect(s.players[absent]?.removed).toBe(true);
    expect(s.activeSeat).not.toBe(absent);
    expect(s.turnOrder).toContain(s.activeSeat!);
  });

  it('carries two removals on one tick without stranding the turn', () => {
    // The active seat and the seat immediately after it both go, on the same
    // tick. Choosing the successor against the pre-removal order would hand
    // the turn to a seat this very tick removed — and because that breaks an
    // invariant, reduce rejects the whole TICK. Every later tick would then
    // fail identically: the clock stops and neither seat is ever removed.
    const g = startedGame({ players: ['Ana', 'Ben', 'Cal', 'Dot', 'Eve'] });
    const active = g.state.activeSeat!;
    const following = g.state.turnOrder[1]!;

    let s = g.state;
    for (const seat of [active, following]) {
      s = reduce(s, { t: 'DISCONNECT', seat, at: T0 }, content).state;
    }
    // `following` is voted on first, so it is the first key in removeVotes and
    // is resolved first — leaving the active seat's successor already removed.
    const voters = Object.keys(s.players).filter((v) => v !== active && v !== following);
    for (const target of [following, active]) {
      for (const voter of voters.slice(0, 2)) {
        s = reduce(
          s,
          { t: 'VOTE_REMOVE', seat: voter, target, vote: true },
          content,
        ).state;
      }
    }

    const result = reduce(
      s,
      { t: 'TICK', now: T0 + g.state.timers.removeGraceMs },
      content,
    );
    expect(result.error).toBeUndefined();

    s = result.state;
    expect(s.players[active]?.removed).toBe(true);
    expect(s.players[following]?.removed).toBe(true);
    expect(s.turnOrder).toEqual(expect.not.arrayContaining([active, following]));
    expect(s.activeSeat).not.toBe(active);
    expect(s.activeSeat).not.toBe(following);
    expect(s.turnOrder).toContain(s.activeSeat!);
  });

  it('offers a removed seat no actions at all', () => {
    const { state, absent, grace } = gameWithAbsentee();
    let s = state;
    for (const voter of Object.keys(s.players)) {
      if (voter === absent) continue;
      s = reduce(
        s,
        { t: 'VOTE_REMOVE', seat: voter, target: absent, vote: true },
        content,
      ).state;
    }
    s = reduce(s, { t: 'TICK', now: T0 + grace }, content).state;
    s = reduce(s, { t: 'RECONNECT', seat: absent }, content).state;

    // Even having come back, a removed seat is a spectator.
    expect(getLegalActions(s, absent, content)).toEqual([]);
  });

  it('unblocks a lobby held up by a seat that never returned', () => {
    const chosen = ['seat_0', 'seat_1', 'seat_2'].map((seat, i) => ({
      t: 'CHOOSE_CHAR' as const,
      seat,
      charId: content.characters[i * 2]!.id,
    }));
    // Four seats, one of whom leaves before choosing: START_GAME is blocked
    // because every seat needs an explorer.
    const g = playGame({
      players: ['Ana', 'Ben', 'Cal', 'Dot'],
      actions: [...chosen, { t: 'DISCONNECT', seat: 'seat_3', at: T0 }],
    });
    expect(getLegalActions(g.state, 'seat_0', content).map((a) => a.t)).not.toContain(
      'START_GAME',
    );

    let s = g.state;
    for (const voter of ['seat_0', 'seat_1', 'seat_2']) {
      s = reduce(
        s,
        { t: 'VOTE_REMOVE', seat: voter, target: 'seat_3', vote: true },
        content,
      ).state;
    }
    s = reduce(s, { t: 'TICK', now: T0 + s.timers.removeGraceMs }, content).state;

    expect(s.players['seat_3']?.removed).toBe(true);
    expect(getLegalActions(s, 'seat_0', content).map((a) => a.t)).toContain('START_GAME');

    const started = reduce(s, { t: 'START_GAME', seat: 'seat_0' }, content);
    expect(started.error).toBeUndefined();
    expect(started.state.turnOrder).toEqual(
      expect.arrayContaining(['seat_0', 'seat_1', 'seat_2']),
    );
    expect(started.state.turnOrder).not.toContain('seat_3');
  });
});

describe('unimplemented actions', () => {
  it('are rejected cleanly rather than silently ignored', () => {
    // MOVE_THROUGH and ROTATE_TILE are implemented as of M2; USE_ITEM is
    // still a later milestone, so it is the example here now.
    const g = startedGame();
    const r = reduce(
      g.state,
      { t: 'USE_ITEM', seat: g.state.activeSeat!, cardId: 'card.does_not_exist' },
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

// --- MOVE_THROUGH / ROTATE_TILE / discovery ---------------------------------

function dtile(id: string, doors: Partial<Doors>, opts: Partial<Tile> = {}): Tile {
  return {
    id,
    name: id,
    doors: { n: false, e: false, s: false, w: false, ...doors },
    floors: ['ground'],
    symbol: null,
    copies: 1,
    staticLinks: [],
    onEnter: [],
    ...opts,
  };
}

// Preplaced landings, and separate deck filler for the other two floors —
// distinct tiles, because a preplaced tile can never also be a deck entry
// (buildTileDeck excludes anything in house.layout).
const D_LAND_B = dtile('tile.d_land_b', { n: true }, { floors: ['basement'] });
const D_LAND_U = dtile('tile.d_land_u', { n: true }, { floors: ['upper'] });
const D_FILL_B = dtile('tile.d_fill_b', { n: true }, { floors: ['basement'] });
const D_FILL_U = dtile('tile.d_fill_u', { n: true }, { floors: ['upper'] });

/**
 * A one-room ground floor plus exactly one ground-legal deck tile. Only one
 * candidate ever matches `floors.includes('ground')`, so which tile gets
 * drawn is deterministic regardless of how the deck shuffle landed —
 * `deckTiles` can hold as many basement/upper fillers as it likes ahead of
 * it and the draw is still forced.
 */
function discoveryContent(start: Tile, ...deckTiles: Tile[]): Content {
  const tiles = [start, ...deckTiles, D_LAND_B, D_LAND_U, D_FILL_B, D_FILL_U];
  const house: House = {
    layout: [
      { tileId: start.id, floor: 'ground', x: 0, y: 0, rotation: 0 },
      { tileId: D_LAND_B.id, floor: 'basement', x: 0, y: 0, rotation: 0 },
      { tileId: D_LAND_U.id, floor: 'upper', x: 0, y: 0, rotation: 0 },
    ],
    startTile: start.id,
    landings: { basement: D_LAND_B.id, ground: start.id, upper: D_LAND_U.id },
  };
  return buildContent(
    { characters: fixtureContent().characters, tiles, house },
    'reduce.test.ts',
  );
}

const START_1DOOR = dtile('tile.start_1door', { n: true });
const AUTO4 = dtile('tile.auto4', { n: true, e: true, s: true, w: true });
// Adjacent (not opposite) doors: no rotational symmetry, so two distinct
// rotations put a door on the entry — see discovery.test.ts for why an
// opposite-door tile cannot do this.
const CORNER = dtile('tile.corner', { n: true, e: true });

describe('MOVE_THROUGH: happy path', () => {
  it('places the tile, updates the index, moves the explorer, and connects the rooms', () => {
    const c = discoveryContent(START_1DOOR, AUTO4);
    const g = startedGame({ content: c });
    const seat = g.state.activeSeat!;
    const start = g.state.players[seat]!.location!;

    const res = reduce(g.state, { t: 'MOVE_THROUGH', seat, dir: 'n' }, c);
    expect(res.error).toBeUndefined();

    const newId = placedIdFor('ground', 0, -1);
    const placed = res.state.board.placed[newId];
    expect(placed?.tileId).toBe(AUTO4.id);
    expect(placed?.discoveredBy).toBe(seat);
    expect(res.state.board.index.ground['0,-1']).toBe(newId);

    // discovered before moved, in that order.
    expect(res.events.map((e) => e.t)).toEqual(['discovered', 'moved']);

    const player = res.state.players[seat]!;
    expect(player.location).toBe(newId);
    expect(player.cameFrom).toBe(start);
    expect(player.movesLeft).toBe(g.state.players[seat]!.movesLeft - 1);

    // The whole point of the rotation rule: the two rooms are now really
    // connected, not just recorded as if they were.
    expect(getConnections(res.state, start, c)).toContain(newId);
    expect(getConnections(res.state, newId, c)).toContain(start);

    expect(checkInvariants(res.state)).toEqual([]);
  });

  it('shrinks the deck by exactly one and removes the drawn tile', () => {
    const c = discoveryContent(START_1DOOR, AUTO4);
    const g = startedGame({ content: c });
    const seat = g.state.activeSeat!;
    const before = g.state.tileDeck.length;

    const res = reduce(g.state, { t: 'MOVE_THROUGH', seat, dir: 'n' }, c);
    expect(res.error).toBeUndefined();
    expect(res.state.tileDeck).toHaveLength(before - 1);
    expect(res.state.tileDeck).not.toContain(AUTO4.id);
  });

  it('auto-applies with no prompt when only one rotation is legal', () => {
    const c = discoveryContent(START_1DOOR, AUTO4);
    const g = startedGame({ content: c });
    const seat = g.state.activeSeat!;

    const res = reduce(g.state, { t: 'MOVE_THROUGH', seat, dir: 'n' }, c);
    expect(res.error).toBeUndefined();
    expect(res.state.pending).toBeNull();
    const newId = placedIdFor('ground', 0, -1);
    expect(res.state.board.placed[newId]).toBeDefined();
  });
});

describe('MOVE_THROUGH: rejections', () => {
  it('rejects a seat that is not active', () => {
    const c = discoveryContent(START_1DOOR, AUTO4);
    const g = startedGame({ content: c });
    const seat = g.state.activeSeat!;
    const other = Object.keys(g.state.players).find((s) => s !== seat)!;

    const res = reduce(g.state, { t: 'MOVE_THROUGH', seat: other, dir: 'n' }, c);
    expect(res.error?.code).toBe('NOT_YOUR_TURN');
  });

  it('rejects a direction with no door', () => {
    const c = discoveryContent(START_1DOOR, AUTO4);
    const g = startedGame({ content: c });
    const seat = g.state.activeSeat!;

    const res = reduce(g.state, { t: 'MOVE_THROUGH', seat, dir: 'e' }, c);
    expect(res.error?.code).toBe('ILLEGAL_MOVE');
  });

  it('rejects a doorway whose neighbour cell is already built', () => {
    const NEXT = dtile('tile.next', { s: true });
    const tiles = [START_1DOOR, NEXT, AUTO4, D_LAND_B, D_LAND_U, D_FILL_B, D_FILL_U];
    const house: House = {
      layout: [
        { tileId: START_1DOOR.id, floor: 'ground', x: 0, y: 0, rotation: 0 },
        { tileId: NEXT.id, floor: 'ground', x: 0, y: -1, rotation: 0 },
        { tileId: D_LAND_B.id, floor: 'basement', x: 0, y: 0, rotation: 0 },
        { tileId: D_LAND_U.id, floor: 'upper', x: 0, y: 0, rotation: 0 },
      ],
      startTile: START_1DOOR.id,
      landings: { basement: D_LAND_B.id, ground: START_1DOOR.id, upper: D_LAND_U.id },
    };
    const c = buildContent(
      { characters: fixtureContent().characters, tiles, house },
      'reduce.test.ts',
    );
    const g = startedGame({ content: c });
    const seat = g.state.activeSeat!;

    const res = reduce(g.state, { t: 'MOVE_THROUGH', seat, dir: 'n' }, c);
    expect(res.error?.code).toBe('ILLEGAL_MOVE');
    expect(res.error?.message).toMatch(/MOVE/);
  });

  it('rejects when movesLeft is 0', () => {
    const c = discoveryContent(START_1DOOR, AUTO4);
    const g = startedGame({ content: c });
    const seat = g.state.activeSeat!;
    const state: GameState = {
      ...g.state,
      players: {
        ...g.state.players,
        [seat]: { ...g.state.players[seat]!, movesLeft: 0 },
      },
    };

    const res = reduce(state, { t: 'MOVE_THROUGH', seat, dir: 'n' }, c);
    expect(res.error?.code).toBe('ILLEGAL_MOVE');
  });

  it('rejects a second MOVE_THROUGH while a rotate_tile prompt is pending', () => {
    const c = discoveryContent(START_1DOOR, CORNER);
    const g = startedGame({ content: c });
    const seat = g.state.activeSeat!;

    const first = reduce(g.state, { t: 'MOVE_THROUGH', seat, dir: 'n' }, c);
    expect(first.error).toBeUndefined();
    expect(first.state.pending).not.toBeNull();

    const second = reduce(first.state, { t: 'MOVE_THROUGH', seat, dir: 'n' }, c);
    expect(second.error?.code).toBe('PROMPT_PENDING');
  });

  it('deck exhaustion: rejected by reduce AND absent from getLegalActions, on both real and redacted state', () => {
    // Once nothing left in the deck is legal on this floor, the doorway must
    // stop being offered AND stop being acceptable — the pair is the
    // invariant (getLegalActions feeds property.test.ts straight into
    // reduce). "Nothing left" is now derived from content + board
    // (`canDiscoverOn`), not read off `state.tileDeck` directly — so the way
    // to exhaust it in a test is to place every copy, not to edit tileDeck
    // by hand. AUTO4 has copies: 1 (the dtile() default), so one placement
    // uses it up.
    const c = discoveryContent(START_1DOOR, AUTO4);
    const g = startedGame({ content: c });
    const seat = g.state.activeSeat!;
    const ghostId = placedIdFor('ground', 99, 99);
    const emptied: GameState = {
      ...g.state,
      tileDeck: g.state.tileDeck.filter((id) => id !== AUTO4.id),
      board: {
        ...g.state.board,
        placed: {
          ...g.state.board.placed,
          [ghostId]: {
            id: ghostId,
            tileId: AUTO4.id,
            floor: 'ground',
            x: 99,
            y: 99,
            rotation: 0,
            discoveredBy: null,
            flags: {},
          },
        },
        index: {
          ...g.state.board.index,
          ground: { ...g.state.board.index.ground, '99,99': ghostId },
        },
      },
    };

    for (const view of [emptied, redactFor(emptied, seat)]) {
      const legal = getLegalActions(view, seat, c);
      expect(legal.some((a) => a.t === 'MOVE_THROUGH')).toBe(false);
    }

    const res = reduce(emptied, { t: 'MOVE_THROUGH', seat, dir: 'n' }, c);
    expect(res.error?.code).toBe('ILLEGAL_MOVE');
  });
});

describe('canDiscoverOn: derived from content + board, not state.tileDeck', () => {
  it('agrees with drawTile on every floor, including after several discoveries and after exhaustion', () => {
    const rng = makeRng(1);

    // A handful of real discoveries against the fixture house, so board
    // composition has actually moved away from the starting layout.
    const g = startedGame();
    const seat = g.state.activeSeat!;
    const foyer = placedIdFor('ground', 0, 1);
    let state = reduce(g.state, { t: 'MOVE', seat, to: foyer }, content).state;
    for (const dir of ['e', 'w'] as const) {
      const res = reduce(state, { t: 'MOVE_THROUGH', seat, dir }, content);
      if (res.error) continue;
      state = res.state;
      // A prompt (if raised) is answered on its default so the walk keeps
      // going and the board keeps changing.
      if (state.pending?.kind === 'rotate_tile') {
        const answer = state.pending.defaultAnswer as never;
        const answered = reduce(
          state,
          { t: 'ROTATE_TILE', seat, rotation: answer },
          content,
        );
        if (!answered.error) state = answered.state;
      }
    }

    for (const floor of FLOORS) {
      expect(canDiscoverOn(state, floor, content)).toBe(
        drawTile(state.tileDeck, floor, content, rng) !== null,
      );
    }

    // Now exhaust the ground floor by hand (place every remaining
    // ground-legal deck tile as if it had been discovered) and check again.
    const groundIds = new Set(
      content.deckTiles.filter((id) => content.tilesById[id]?.floors.includes('ground')),
    );
    let exhausted = state;
    let i = 0;
    for (const id of groundIds) {
      const ghostId = placedIdFor('ground', 500 + i, 500 + i);
      exhausted = {
        ...exhausted,
        board: {
          ...exhausted.board,
          placed: {
            ...exhausted.board.placed,
            [ghostId]: {
              id: ghostId,
              tileId: id,
              floor: 'ground',
              x: 500 + i,
              y: 500 + i,
              rotation: 0,
              discoveredBy: null,
              flags: {},
            },
          },
          index: {
            ...exhausted.board.index,
            ground: {
              ...exhausted.board.index.ground,
              [`${500 + i},${500 + i}`]: ghostId,
            },
          },
        },
        tileDeck: exhausted.tileDeck.filter((tid) => tid !== id),
      };
      i++;
    }

    expect(canDiscoverOn(exhausted, 'ground', content)).toBe(false);
    for (const floor of FLOORS) {
      expect(canDiscoverOn(exhausted, floor, content)).toBe(
        drawTile(exhausted.tileDeck, floor, content, rng) !== null,
      );
    }
  });
});

describe('legality parity between real and redacted state', () => {
  it('offers the same non-empty MOVE_THROUGH set on both — the whole point of docs/05-engine.md#57', () => {
    const g = startedGame();
    const seat = g.state.activeSeat!;
    const foyer = placedIdFor('ground', 0, 1);
    const toFoyer = reduce(g.state, { t: 'MOVE', seat, to: foyer }, content);
    expect(toFoyer.error).toBeUndefined();

    const dirsOf = (state: GameState) =>
      getLegalActions(state, seat, content)
        .filter(
          (a): a is Extract<GameAction, { t: 'MOVE_THROUGH' }> => a.t === 'MOVE_THROUGH',
        )
        .map((a) => a.dir)
        .sort();

    const real = dirsOf(toFoyer.state);
    const redacted = dirsOf(redactFor(toFoyer.state, seat));

    // Not vacuously true: the foyer's e/w doors are undiscovered in the
    // fixture starting layout, so this must be non-empty on the server.
    expect(real.length).toBeGreaterThan(0);
    expect(redacted).toEqual(real);
  });
});

describe('invariants: rotate_tile prompt coherence', () => {
  it('flags a prompt whose target cell is already built', () => {
    const c = discoveryContent(START_1DOOR, CORNER);
    const g = startedGame({ content: c });
    const seat = g.state.activeSeat!;
    const raised = reduce(g.state, { t: 'MOVE_THROUGH', seat, dir: 'n' }, c);
    const payload = raised.state.pending!.payload;
    if (!isRotateTilePayload(payload)) throw new Error('expected a RotateTilePayload');

    // Pretend the target cell got built by something else in the meantime —
    // exactly the situation `finishDiscovery`'s cell guard exists to catch.
    const corrupted: GameState = {
      ...raised.state,
      board: {
        ...raised.state.board,
        index: {
          ...raised.state.board.index,
          [payload.floor]: {
            ...raised.state.board.index[payload.floor],
            '0,-1': 'ground:0,0',
          },
        },
      },
    };
    expect(checkInvariants(corrupted).some((p) => p.includes('already built'))).toBe(
      true,
    );
  });
});

describe('rotate_tile prompt', () => {
  it('raises a prompt without moving the explorer or spending a move, and constrains getLegalActions', () => {
    const c = discoveryContent(START_1DOOR, CORNER);
    const g = startedGame({ content: c });
    const seat = g.state.activeSeat!;
    const other = Object.keys(g.state.players).find((s) => s !== seat)!;
    const start = g.state.players[seat]!.location!;
    const movesBefore = g.state.players[seat]!.movesLeft;

    const res = reduce(g.state, { t: 'MOVE_THROUGH', seat, dir: 'n' }, c);
    expect(res.error).toBeUndefined();
    expect(res.state.pending?.kind).toBe('rotate_tile');
    expect(res.state.pending?.seatId).toBe(seat);
    expect(res.state.players[seat]!.location).toBe(start);
    expect(res.state.players[seat]!.movesLeft).toBe(movesBefore);
    expect(placedIdFor('ground', 0, -1) in res.state.board.placed).toBe(false);

    const payload = res.state.pending!.payload;
    if (!isRotateTilePayload(payload)) throw new Error('expected a RotateTilePayload');
    expect(payload.legalRotations.length).toBeGreaterThanOrEqual(2);

    const mine = getLegalActions(res.state, seat, c);
    expect(mine).toHaveLength(payload.legalRotations.length);
    expect(mine.every((a) => a.t === 'ROTATE_TILE')).toBe(true);
    expect(getLegalActions(res.state, other, c)).toEqual([]);
  });

  it('rejects an illegal rotation and accepts a legal one', () => {
    const c = discoveryContent(START_1DOOR, CORNER);
    const g = startedGame({ content: c });
    const seat = g.state.activeSeat!;

    const raised = reduce(g.state, { t: 'MOVE_THROUGH', seat, dir: 'n' }, c);
    const payload = raised.state.pending!.payload;
    if (!isRotateTilePayload(payload)) throw new Error('expected a RotateTilePayload');
    const illegal = ([0, 90, 180, 270] as const).find(
      (r) => !payload.legalRotations.includes(r),
    )!;

    const rejected = reduce(
      raised.state,
      { t: 'ROTATE_TILE', seat, rotation: illegal },
      c,
    );
    expect(rejected.error?.code).toBe('ILLEGAL_MOVE');

    const accepted = reduce(
      raised.state,
      { t: 'ROTATE_TILE', seat, rotation: payload.legalRotations[0]! },
      c,
    );
    expect(accepted.error).toBeUndefined();
    expect(accepted.state.pending).toBeNull();
    const newId = placedIdFor('ground', 0, -1);
    expect(accepted.state.board.placed[newId]?.rotation).toBe(payload.legalRotations[0]);
    expect(accepted.state.players[seat]!.location).toBe(newId);
  });

  it('places the tile on the default rotation and ends the turn when the turn clock expires', () => {
    const c = discoveryContent(START_1DOOR, CORNER);
    const g = startedGame({ content: c });
    const seat = g.state.activeSeat!;

    const raised = reduce(g.state, { t: 'MOVE_THROUGH', seat, dir: 'n' }, c);
    expect(raised.state.pending).not.toBeNull();
    const defaultAnswer = raised.state.pending!.defaultAnswer;

    // Arm the turn clock, then tick past it.
    const armed = reduce(raised.state, { t: 'TICK', now: 1_700_000_000_000 }, c);
    expect(armed.state.turnDeadline).not.toBeNull();
    const expired = reduce(
      armed.state,
      { t: 'TICK', now: armed.state.turnDeadline! + 1 },
      c,
    );

    expect(expired.error).toBeUndefined();
    expect(expired.state.pending).toBeNull();
    const newId = placedIdFor('ground', 0, -1);
    const placed = expired.state.board.placed[newId];
    expect(placed).toBeDefined();
    expect(placed?.rotation).toBe(defaultAnswer);
    // The regression this guards: the tile really is on the board, not
    // dropped along with the prompt that carried it.
    expect(expired.state.activeSeat).not.toBe(seat);
  });

  it('resolves a prompt whose own deadline has already passed on TICK', () => {
    const c = discoveryContent(START_1DOOR, CORNER);
    const g = startedGame({ content: c });
    const seat = g.state.activeSeat!;

    const raised = reduce(g.state, { t: 'MOVE_THROUGH', seat, dir: 'n' }, c);
    const defaultAnswer = raised.state.pending!.defaultAnswer;
    // The server does not set deadlines yet (that is the next milestone
    // item) — set one by hand to exercise the resolution path.
    const withDeadline: GameState = {
      ...raised.state,
      pending: { ...raised.state.pending!, deadline: 1_700_000_000_000 },
    };

    const res = reduce(withDeadline, { t: 'TICK', now: 1_700_000_000_001 }, c);
    expect(res.error).toBeUndefined();
    expect(res.state.pending).toBeNull();
    const newId = placedIdFor('ground', 0, -1);
    expect(res.state.board.placed[newId]?.rotation).toBe(defaultAnswer);
  });
});

// A rotate_tile prompt can only be raised as of this PR — before it, no
// prompt could ever exist, so a prompt owner leaving mid-prompt was
// unreachable. Now it is reachable, both via CONCEDE and via a removal vote,
// and either path must not strand the room: `getLegalActions` keys the
// pending branch off `pending.seatId === seat` and returns `[]` outright for
// a `removed` seat, so an unresolved prompt whose owner is gone or removed
// blocks every seat until the ten-minute turn clock bails it out — D5's
// shape (docs/11-progress.md).
describe('a prompted seat leaving does not strand the room', () => {
  it("CONCEDE resolves the conceding seat's own rotate_tile prompt on its default first", () => {
    const c = discoveryContent(START_1DOOR, CORNER);
    const g = startedGame({ content: c });
    const seat = g.state.activeSeat!;

    const raised = reduce(g.state, { t: 'MOVE_THROUGH', seat, dir: 'n' }, c);
    expect(raised.state.pending?.seatId).toBe(seat);
    const defaultAnswer = raised.state.pending!.defaultAnswer;

    const conceded = reduce(raised.state, { t: 'CONCEDE', seat }, c);
    expect(conceded.error).toBeUndefined();
    expect(conceded.state.pending).toBeNull();

    const newId = placedIdFor('ground', 0, -1);
    const placed = conceded.state.board.placed[newId];
    expect(placed).toBeDefined();
    expect(placed?.rotation).toBe(defaultAnswer);

    // The deadlock, stated directly: a seat that is still playing must have
    // something to do — before the fix this was `[]` because `pending` still
    // pointed at the now-dead conceding seat.
    const active = conceded.state.activeSeat!;
    expect(active).not.toBe(seat);
    expect(getLegalActions(conceded.state, active, c).length).toBeGreaterThan(0);
  });

  it("a removal vote resolves the removed seat's rotate_tile prompt on its default first", () => {
    const c = discoveryContent(START_1DOOR, CORNER);
    const g = startedGame({ content: c });
    const seat = g.state.activeSeat!;
    const others = g.state.turnOrder.filter((s) => s !== seat);

    const raised = reduce(g.state, { t: 'MOVE_THROUGH', seat, dir: 'n' }, c);
    expect(raised.state.pending?.seatId).toBe(seat);
    const defaultAnswer = raised.state.pending!.defaultAnswer;

    const T0 = 1_700_000_000_000;
    let state = reduce(raised.state, { t: 'DISCONNECT', seat, at: T0 }, c).state;
    for (const voter of others) {
      const res = reduce(
        state,
        { t: 'VOTE_REMOVE', seat: voter, target: seat, vote: true },
        c,
      );
      expect(res.error).toBeUndefined();
      state = res.state;
    }

    // A single TICK, past the grace period, is what carries the removal —
    // resolveRemovals runs before tick's own prompt-deadline branch, so this
    // exercises resolveRemovals's own fix, not the deadline branch's.
    const removed = reduce(state, { t: 'TICK', now: T0 + state.timers.removeGraceMs }, c);
    expect(removed.error).toBeUndefined();
    expect(removed.state.players[seat]?.removed).toBe(true);
    expect(removed.state.pending).toBeNull();

    const newId = placedIdFor('ground', 0, -1);
    const placed = removed.state.board.placed[newId];
    expect(placed).toBeDefined();
    expect(placed?.rotation).toBe(defaultAnswer);

    const active = removed.state.activeSeat!;
    expect(active).not.toBe(seat);
    expect(getLegalActions(removed.state, active, c).length).toBeGreaterThan(0);
  });
});
