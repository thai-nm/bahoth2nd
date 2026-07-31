# 02 — Rules Model

This document is the specification the engine is written against. Where the
printed rulebook is ambiguous or commonly house-ruled, the chosen behaviour is
marked **[RULING]** and must not be changed silently — change it here first.

Everything below refers to 2nd edition. Exact numbers (door layouts, card
counts, trait tracks) must be verified against the physical components during
M0 content authoring; treat counts in this document as the expected shape, not
as verified truth.

## 2.1 Components modelled

| Component   | Count                 | Notes                                                     |
| ----------- | --------------------- | --------------------------------------------------------- |
| Explorers   | 12 (6 cards, 2 sides) | Grouped in 6 colours; one colour per player               |
| Room tiles  | 44                    | Plus the 3 pre-placed starting tiles and the two landings |
| Item cards  | ~22                   | Some are weapons, some companions                         |
| Omen cards  | 13                    | Most are also items and stay in play                      |
| Event cards | ~30                   | One-shot, discarded after resolution                      |
| Dice        | 8                     | Six-sided, faces `0,0,1,1,2,2`                            |
| Haunts      | 50                    | Selected by an omen × room lookup table                   |

## 2.2 Explorers and traits

Each explorer has four traits: **Speed, Might, Sanity, Knowledge**.

A trait is not a number — it is an **index into an 8-slot track** of printed
values. Slot 0 is the skull (death). The character card marks a starting index
per trait. Effects move a trait _up or down the track by steps_, never by
arithmetic on the value.

```
Might track:  [ 💀, 2, 3, 3, 4, 5, 6, 8 ]
                0   1  2  3  4  5  6  7
```

This is a common source of bugs in implementations that store the value
instead of the index. **Store the index.** The displayed number is
`track[index]`.

- Speed + Might are the **physical** traits.
- Sanity + Knowledge are the **mental** traits.
- If any trait index reaches 0, the explorer dies.
- Trait indices are clamped to `[0, 7]`; gains above the top of the track are
  simply lost.

## 2.3 The house

Three floors: **Basement**, **Ground**, **Upper**.

Each floor is an unbounded 2D integer grid. A placed tile occupies exactly one
cell. Tiles are square and have a door on zero or more of their four edges.

Starting layout (pre-placed, not drawn):

- Ground floor: Entrance Hall, Foyer, Grand Staircase, in a fixed arrangement.
- Upper floor: Upper Landing.
- Basement: Basement Landing.

All explorers start in the Entrance Hall.

### Room tile properties

- **Allowed floors.** Each tile prints which floors it may be placed on;
  several are basement-only or upper-only. A drawn tile that cannot be placed
  on the current floor is set aside and the next tile is drawn; set-aside tiles
  return to the deck. **[RULING]** We instead search the deck for the first
  legal tile, then shuffle the passed-over tiles back in — same distribution,
  no player-visible difference, far simpler to implement deterministically.
- **Card symbol.** Zero or one of Item / Event / Omen.
- **Special connections.** Some rooms connect to specific other rooms
  regardless of grid adjacency (the staircases, the Mystic Elevator, the
  Coal Chute, and so on). Modelled as declarative links in content data, not
  as engine special cases. See [04-data-model.md](04-data-model.md#static-links).

### Movement graph

Two rooms are connected if **either**:

1. They are orthogonally adjacent cells on the same floor, and both have a
   door on the shared edge (after applying each tile's rotation), or
2. A content-declared static link joins them.

## 2.4 Turn structure — exploration phase

Each turn, the active player:

1. **Start of turn.** Resolve start-of-turn effects (haunt rules, card
   effects). Movement budget is set to the _current_ Speed value.
2. **Move.** Spend one movement point per room entered. You may stop at any
   time. You may not re-enter a room you left this turn unless an effect says
   otherwise. **[RULING]** We enforce "no immediate backtrack into the room you
   just came from" only; free movement otherwise, matching common play.
3. **Discovery.** Moving through a doorway with no room behind it discovers a
   room: draw a legal tile for this floor, the player chooses a rotation such
   that at least one of its doors aligns with the doorway used, and it is
   placed.
4. **Draw.** If the newly discovered room has a card symbol, draw that card.
   **Drawing a card ends movement for the turn.** Entering an already-explored
   room never draws a card.
5. **Actions.** Use items, trade items with an explorer in the same room,
   resolve room actions. Attacks are not available before the haunt.
6. **End of turn.** Resolve end-of-turn effects; pass to the next player.

**[RULING]** Trading requires both explorers to be in the same room and is
allowed only on the active player's turn, and only with the active player.

## 2.5 Cards

| Deck  | On draw                                                  | Persists?         |
| ----- | -------------------------------------------------------- | ----------------- |
| Item  | Gain the item, held by the explorer                      | Yes, transferable |
| Event | Resolve immediately, then discard                        | No                |
| Omen  | Gain the omen (most are also items), then **haunt roll** | Yes               |

Decks are shuffled at setup. When a deck empties, its discard pile is
reshuffled into it.

Items are **public information** — everyone can see who holds what. Deck order
is hidden. This matters for redaction; see
[06-networking.md](06-networking.md#redaction).

## 2.6 The haunt roll

Immediately after any omen card is drawn (and after its own effect resolves):

```
roll 6 dice (sum of six faces from {0,0,1,1,2,2}, range 0..12)
if sum < number of omen cards drawn so far this game:
    the haunt begins
```

The omen count includes the card just drawn.

## 2.7 Haunt selection and the traitor

When the haunt begins:

- Look up `(omen just drawn, room it was drawn in)` in the **haunt table** to
  get a haunt number 1–50.
- The haunt entry declares how the traitor is chosen. The default is "the
  player who triggered the haunt", but many haunts specify otherwise (highest
  or lowest in some trait, the player holding a particular item, or no traitor
  at all in the survival haunts).
- Tie-breaks for "highest/lowest trait" resolve **[RULING]** to the tied player
  closest to the triggering player in turn order, going clockwise.

The haunt entry then declares setup (monsters to place, tokens, stat changes),
the traitor's goal, the heroes' goal, and any special rules. See
[08-haunt-system.md](08-haunt-system.md).

## 2.8 Turn structure — haunt phase

Same as the exploration phase, with these changes:

- **Attacks are enabled.** Once per turn, an explorer may attack another
  explorer or monster in the same room.
- The traitor takes their turn after all heroes, and controls all monsters,
  each of which moves and attacks on the traitor's turn.
- Win conditions are checked at the end of every action, not only at end of
  turn.

### Attack resolution

1. Attacker rolls dice equal to their **Might** value, defender rolls dice
   equal to theirs.
2. Higher total wins; ties do nothing.
3. The loser takes damage equal to the difference, applied as _steps down the
   track_, distributed by the loser across their two physical traits.
4. Some attacks are mental: same procedure using Sanity or Knowledge, damaging
   mental traits.

**[RULING]** Damage distribution is a player decision, so it is a distinct
engine action (`ASSIGN_DAMAGE`) that blocks the game until answered, with a
timeout that auto-assigns to the highest trait.

### Monsters

Monsters are defined per haunt: a name, optional stats, whether they can be
damaged, whether they can be killed, movement rules, and attack rules. Many
haunts define monsters that ignore normal rules — the monster definition is
data with the same trigger/effect vocabulary as haunt rules.

## 2.9 Death

When any trait index hits 0, the explorer dies:

- Drop all items and omens in the current room.
- Remove the explorer from the board.
- **[RULING]** A dead player becomes a spectator with full visibility of
  public state. They do not become a monster or take further turns unless the
  active haunt says so.

If all heroes die, the traitor wins. If the traitor dies and the haunt does
not specify otherwise, the heroes win.

## 2.10 Explicitly deferred rules

These are known gaps in the vertical slice, listed so nobody mistakes them for
bugs:

- Haunts that alter the physical layout of the house in ways not expressible
  as tile placement (folding floors together, etc.) — handled by the script
  escape hatch when we reach them.
- Player-facing rules arbitration. There is no "vote to override" mechanism;
  if the engine is wrong, the engine is wrong.
- Simultaneous-play haunts, if any require true simultaneity rather than
  ordered turns.
