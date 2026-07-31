# 01 — Overview

## What we are building

A browser game that plays a full session of Betrayal at House on the Hill,
2nd edition, for 3–6 players over the internet. Each player opens a URL, joins
a room with a code, picks an explorer, and plays: explore the house, draw
cards, trigger the haunt, then play out the haunt as traitor or heroes until
someone wins.

The physical game is a turn-based, hidden-information board game with a large
pile of one-off scripted rules. That shape drives every technical decision in
these documents: state is small, turns are discrete, latency is irrelevant,
and **rules content vastly outweighs rules engine**. Optimise for content
authoring speed, not for frames per second.

## Goals

1. **Faithful to the printed rules.** Where the rulebook is ambiguous, we pick
   an interpretation, document it in [02-rules-model.md](02-rules-model.md),
   and make it consistent.
2. **Server-authoritative.** A client cannot see hidden information it should
   not have, and cannot make an illegal move, even with a patched bundle.
3. **Resilient to disconnects.** Board game sessions run 60–90 minutes. People
   close laptops. Rejoining must be a non-event.
4. **Content is data.** Rooms, cards, characters, and as many haunts as
   possible live in JSON validated by a schema — not in hand-written
   TypeScript branches.
5. **Small enough for one or two people to finish.** Every "we could also…"
   is listed as a non-goal until the vertical slice is playable end to end.

## Non-goals (for now)

- Native mobile apps. The web client should be usable on a tablet in
  landscape; phone support is best-effort.
- Matchmaking, ranked play, accounts, or persistent player profiles. Room
  codes and a name field are the whole identity system.
- AI-controlled players. Explicitly deferred; see the roadmap.
- Expansions (Widow's Walk, Betrayal Legacy, 3rd edition). The data model
  should not actively prevent them, but nothing is built for them.
- 3D, isometric, or animated-sprite presentation. Flat 2D tiles.
- Voice or video chat. Assume players are on Discord already; a text log and
  simple chat are enough.

## Player-facing scope of the vertical slice

The first genuinely playable build (milestone M4) supports:

- 3–6 human players, one room at a time per server process is fine
- All 44 room tiles, all three floors, all special room connections
- Item, Event, and Omen decks with full card counts
- All 12 explorers with correct trait tracks
- The haunt roll and the haunt-selection table (all 50 entries mapped)
- **Five implemented haunts**; the remaining 45 report "not yet implemented"
  and let players finish manually, or reroll onto an implemented haunt
  (configurable per room)

Milestone M6 closes the remaining 45.

## Constraints and assumptions

- **Two-person team at most, part-time.** Prefer boring technology.
- **No budget for art.** The first several milestones use CSS/SVG-drawn tiles
  with room names as text. The renderer takes tile appearance from content
  data, so swapping in real artwork later is a data change, not a rewrite.
- **Hosting is a single small VM or container.** In-memory game state, no
  database in the vertical slice. See [10-testing-and-ops.md](10-testing-and-ops.md).
- **Sessions are ephemeral.** A game lives as long as the server process, plus
  an append-only action log on disk for crash recovery.

## Intellectual property position

Betrayal at House on the Hill is published by Avalon Hill / Hasbro. Game
_mechanics_ are not copyrightable, but the specific card text, room names and
descriptions, character names and portraits, haunt narrative text, and all
artwork are.

The plan therefore separates the **engine** (ours) from the **content**
(theirs). The repository ships schemas, loaders, and a small set of clearly
placeholder content for tests. Real card and room text is treated as a local
asset that a user supplies from their own copy of the game; content files
containing verbatim published text should not be committed to a public
repository or distributed.

Practical consequences baked into the design:

- `packages/content` holds only schemas, validators, and placeholder fixtures
  in version control.
- Real content loads from a `content/` directory resolved at runtime, path
  configurable, `.gitignore`d by default.
- The build must succeed and the test suite must pass with placeholder content
  only, so CI never needs the real files.

If you intend to publish this, get your own read on the licensing situation
first — this section is design guidance, not legal advice.
