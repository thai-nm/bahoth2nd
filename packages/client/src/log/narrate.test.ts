/**
 * Narration tests (docs/07-ui.md#72). All pure — see the note at the top of
 * narrate.ts, and D6 for why the panel component itself is not covered here.
 *
 * The load-bearing test is `every event type`: it is the one that would have
 * caught `moved` and `discovered` each shipping once as a bare event name.
 */

import { describe, expect, it } from 'vitest';
import { fixtureContent } from '@bahoth/content';
import { reduce, startedGame } from '@bahoth/engine';
import {
  EVENT_TYPES,
  placedIdFor,
  type EventType,
  type GameEvent,
  type PlacedTile,
  type PublicSeat,
  type SeatId,
} from '@bahoth/shared';
import { contextFrom, entryFor, narrate, type NarrationContext } from './narrate.js';

const content = fixtureContent();

const ANA: SeatId = 'seat_0';
const BEN: SeatId = 'seat_1';

/** The first two fixture characters, whose printed values the tests read back. */
const ANA_CHAR = content.characters[0]!;
const BEN_CHAR = content.characters.find((c) => c.colour !== ANA_CHAR.colour)!;

const HALL = content.house.layout[0]!;
const HALL_ID = placedIdFor(HALL.floor, HALL.x, HALL.y);
const HALL_NAME = content.tilesById[HALL.tileId]!.name;

function placedTile(): PlacedTile {
  return {
    id: HALL_ID,
    tileId: HALL.tileId,
    floor: HALL.floor,
    x: HALL.x,
    y: HALL.y,
    rotation: HALL.rotation,
    discoveredBy: ANA,
    flags: {},
  };
}

function ctx(overrides: Partial<NarrationContext> = {}): NarrationContext {
  return {
    names: { [ANA]: 'Ana', [BEN]: 'Ben' },
    chars: { [ANA]: ANA_CHAR.id, [BEN]: BEN_CHAR.id },
    placed: { [HALL_ID]: placedTile() },
    content,
    ...overrides,
  };
}

/**
 * One sample of every event variant.
 *
 * Typed as a total `Record<EventType, …>` — but test files are excluded from
 * `tsc` (packages/client/tsconfig.json) and vitest transpiles without
 * typechecking, so that annotation alone proves **nothing at run time**. The
 * `EVENT_TYPES` sweep in the first test is what actually holds this to every
 * variant; the annotation is only there to catch a mistyped sample in an
 * editor. A type-level claim nobody's build enforces is the same failure as a
 * check the wrong value satisfies.
 */
const SAMPLES: Record<EventType, GameEvent> = {
  joined: { t: 'joined', seat: ANA, name: 'Ana' },
  char_chosen: { t: 'char_chosen', seat: ANA, charId: ANA_CHAR.id },
  game_started: { t: 'game_started', turnOrder: [ANA, BEN] },
  turn_started: { t: 'turn_started', seat: ANA, round: 2 },
  turn_ended: { t: 'turn_ended', seat: ANA },
  moved: { t: 'moved', seat: ANA, from: null, to: HALL_ID },
  discovered: { t: 'discovered', seat: ANA, placed: placedTile() },
  drew_card: { t: 'drew_card', seat: ANA, deck: 'omen', cardId: 'card.the_dog' },
  rolled: { t: 'rolled', seat: ANA, dice: [0, 1, 2], total: 3, reason: 'Might' },
  trait_changed: { t: 'trait_changed', seat: ANA, trait: 'might', from: 4, to: 3 },
  haunt_roll: { t: 'haunt_roll', total: 7, needed: 5, triggered: true },
  haunt_begun: { t: 'haunt_begun', hauntId: 'haunt.1', traitor: BEN },
  attacked: {
    t: 'attacked',
    seat: ANA,
    target: { kind: 'seat', seatId: BEN },
    result: { attackerTotal: 5, defenderTotal: 3, winner: 'attacker', damage: 2 },
  },
  died: { t: 'died', seat: BEN },
  connection_changed: { t: 'connection_changed', seat: BEN, connected: false },
  game_over: {
    t: 'game_over',
    result: { outcome: 'heroes', winners: [ANA], reason: 'The house is quiet' },
  },
  log: { t: 'log', text: 'Something happened' },
};

describe('narrate', () => {
  it('narrates every event type as prose, never as the bare event name', () => {
    // Driven off shared's runtime list, not off `Object.keys(SAMPLES)`:
    // iterating the samples would only ever prove that the samples somebody
    // wrote are narrated, which is a test that cannot fail on the event they
    // forgot. `EVENT_TYPES` is checked against the union by the compiler
    // (packages/shared/src/events.ts), so this really is every kind.
    expect(Object.keys(SAMPLES).sort()).toEqual([...EVENT_TYPES].sort());

    for (const type of EVENT_TYPES) {
      const event = SAMPLES[type];
      const text = narrate(event, ctx());
      expect(text.length, type).toBeGreaterThan(0);
      // The old fallback returned `e.t` verbatim. Anything that still does is
      // a kind somebody added and did not narrate.
      expect(text, type).not.toBe(type);
      // A raw seat id in the log is the specific failure this item existed to
      // fix: the previous narration printed "seat_0 moved to ground:0,1".
      expect(text, type).not.toMatch(/seat_\d/);
    }
  });

  it('names the room a player moved into, not its PlacedId', () => {
    const text = narrate({ t: 'moved', seat: ANA, from: BEN, to: HALL_ID }, ctx());
    expect(text).toBe(`Ana moved to the ${HALL_NAME}`);
    expect(text).not.toContain(HALL_ID);
  });

  it('reads a first placement as arriving, not as a move', () => {
    const text = narrate({ t: 'moved', seat: ANA, from: null, to: HALL_ID }, ctx());
    expect(text).toBe(`Ana starts in the ${HALL_NAME}`);
  });

  it('names a discovered tile from content', () => {
    const text = narrate({ t: 'discovered', seat: ANA, placed: placedTile() }, ctx());
    expect(text).toBe(`Ana discovered the ${HALL_NAME}`);
  });

  it('renders a trait change as PRINTED values, not track indices', () => {
    // The whole point: "Might 4" is a slot number and means nothing to a
    // player. The printed value is what is on the card.
    const from = 5;
    const to = 3;
    const text = narrate(
      { t: 'trait_changed', seat: ANA, trait: 'might', from, to },
      ctx(),
    );
    expect(text).toBe(
      `Ana's Might fell from ${ANA_CHAR.tracks.might[from]} to ${ANA_CHAR.tracks.might[to]}`,
    );
    // Guard against the printed values coincidentally equalling the indices,
    // which would make the assertion above pass for the wrong reason — the
    // D1 family. If the fixture ever makes them equal, this fails loudly.
    expect(String(ANA_CHAR.tracks.might[from])).not.toBe(String(from));
  });

  it('calls index 0 the skull rather than a value', () => {
    const text = narrate(
      { t: 'trait_changed', seat: ANA, trait: 'sanity', from: 1, to: 0 },
      ctx(),
    );
    expect(text).toContain('the skull');
  });

  it('falls back to the index when the explorer is unknown', () => {
    const text = narrate(
      { t: 'trait_changed', seat: ANA, trait: 'might', from: 4, to: 3 },
      ctx({ chars: {} }),
    );
    expect(text).toBe("Ana's Might fell from 4 to 3");
  });

  it('never prints a drawn card id', () => {
    // A draw is the drawer's information until it is played. Narration is
    // broadcast to every seat, so a card id here leaks exactly what
    // redactFor exists to protect.
    const text = narrate(
      { t: 'drew_card', seat: ANA, deck: 'omen', cardId: 'card.the_dog' },
      ctx(),
    );
    expect(text).not.toContain('card.the_dog');
    expect(text).toBe('Ana drew an Omen card');
  });

  it('names explorers and seats in the turn order, not seat ids', () => {
    expect(narrate({ t: 'game_started', turnOrder: [ANA, BEN] }, ctx())).toBe(
      'The game begins. Turn order: Ana → Ben',
    );
    expect(narrate({ t: 'char_chosen', seat: BEN, charId: BEN_CHAR.id }, ctx())).toBe(
      `Ben is ${BEN_CHAR.name}`,
    );
  });

  it('states who took the damage in an attack, both ways round', () => {
    const base = {
      t: 'attacked' as const,
      seat: ANA,
      target: { kind: 'seat' as const, seatId: BEN },
    };
    const won = narrate(
      {
        ...base,
        result: { attackerTotal: 5, defenderTotal: 3, winner: 'attacker', damage: 2 },
      },
      ctx(),
    );
    const lost = narrate(
      {
        ...base,
        result: { attackerTotal: 2, defenderTotal: 6, winner: 'defender', damage: 4 },
      },
      ctx(),
    );
    expect(won).toContain('Ben takes 2');
    expect(lost).toContain('Ana takes 4');
  });

  it('falls back to the raw id for a seat, room, or tile it does not know', () => {
    // Honest rather than wrong: a redacted or stale snapshot legitimately
    // describes things this client has not been told about, and a blank
    // where a name should be reads as a bug in the game rather than as
    // missing data.
    const bare: NarrationContext = { names: {}, chars: {}, placed: {}, content: null };
    expect(narrate({ t: 'moved', seat: ANA, from: null, to: HALL_ID }, bare)).toContain(
      HALL_ID,
    );
    expect(narrate({ t: 'turn_ended', seat: ANA }, bare)).toBe('seat_0 ended their turn');
  });
});

describe('entryFor', () => {
  it('attributes a line to the seat it is about', () => {
    expect(entryFor(SAMPLES.turn_started!, ctx(), 1, 0).seat).toBe(ANA);
    expect(entryFor(SAMPLES.died!, ctx(), 1, 0).seat).toBe(BEN);
  });

  it('attributes table-wide narration to nobody', () => {
    // `game_started` is not Ana's line just because she is first in the turn
    // order; colouring it as hers would be wrong on screen.
    for (const e of [SAMPLES.game_started!, SAMPLES.haunt_roll!, SAMPLES.game_over!]) {
      expect(entryFor(e, ctx(), 1, 0).seat).toBeNull();
    }
  });

  it('attributes the haunt to the traitor', () => {
    expect(entryFor(SAMPLES.haunt_begun!, ctx(), 1, 0).seat).toBe(BEN);
    expect(
      entryFor({ t: 'haunt_begun', hauntId: 'haunt.1', traitor: null }, ctx(), 1, 0).seat,
    ).toBeNull();
  });

  it('carries the id and timestamp it was given', () => {
    const entry = entryFor(SAMPLES.turn_ended!, ctx(), 42, 1234);
    expect(entry).toMatchObject({ id: 42, at: 1234, kind: 'event' });
  });
});

describe('contextFrom', () => {
  const seats: PublicSeat[] = [
    { seatId: ANA, name: 'Ana (lobby)', connected: true, charId: null },
    { seatId: BEN, name: 'Ben (lobby)', connected: true, charId: null },
  ];

  it('works from the seat list alone, before any state exists', () => {
    const c = contextFrom(null, seats, content);
    expect(c.names[ANA]).toBe('Ana (lobby)');
    expect(c.placed).toEqual({});
  });

  it('prefers state.players over the lobby seat list', () => {
    // `room` is only re-sent on join/leave, so its names and charIds go stale
    // — the same reason Lobby.tsx reads its seat rows from state.players.
    const g = startedGame({ players: ['Ana', 'Ben', 'Cal'] });
    const c = contextFrom(g.state, seats, content);
    expect(c.names[ANA]).toBe('Ana');
    expect(c.chars[ANA]).toBe(g.state.players[ANA]?.charId);
  });

  it('narrates a real game end to end with no ids and no fallbacks', () => {
    // Real reducer events through the real context builder — the path the
    // store actually takes, rather than the hand-built samples above.
    const g = startedGame({ players: ['Ana', 'Ben', 'Cal'] });
    const seat = g.state.activeSeat!;
    const events = [...g.events];

    // Into the foyer, then out through whichever doorway has nothing behind
    // it — one `moved` and one `discovered` from the real engine.
    const foyer = placedIdFor('ground', 0, 1);
    let state = reduce(g.state, { t: 'MOVE', seat, to: foyer }, content).state;
    for (const dir of ['e', 'w', 'n', 's'] as const) {
      const res = reduce(state, { t: 'MOVE_THROUGH', seat, dir }, content);
      if (res.error) continue;
      state = res.state;
      events.push(...res.events);
      break;
    }

    // Narrated against the state that came with them, exactly as the store
    // does (snapshot then events, one version).
    const c = contextFrom(state, [], content);
    const types = new Set<string>();
    for (const e of events) {
      const text = narrate(e, c);
      types.add(e.t);
      expect(text, e.t).not.toBe(e.t);
      expect(text, e.t).not.toMatch(/seat_\d/);
    }

    // The run must actually have produced the narration worth checking; an
    // empty or trivial event stream would satisfy the loop above vacuously,
    // which is how a green suite ends up proving nothing.
    expect([...types]).toEqual(
      expect.arrayContaining(['game_started', 'turn_started', 'moved', 'discovered']),
    );
    // And the room names really did resolve, rather than every line falling
    // back to a PlacedId that happens not to match /seat_\d/.
    const moved = events.find((e) => e.t === 'moved' && e.from !== null)!;
    expect(narrate(moved, c)).not.toMatch(/ground:-?\d/);
  });
});
