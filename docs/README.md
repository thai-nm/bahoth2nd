# Betrayal at House on the Hill (2nd Edition) — Web Game

Design and development documentation for a browser-based, online-multiplayer
implementation of Betrayal at House on the Hill, 2nd edition.

## Decisions locked in

| Decision      | Choice                                             |
| ------------- | -------------------------------------------------- |
| Multiplayer   | Online, authoritative server, from commit 1        |
| Content scope | Vertical slice first, then expand to all 50 haunts |
| Language      | TypeScript everywhere                              |
| Client        | Vite + React + DOM/SVG board                       |
| Server        | Node + `ws`                                        |
| Engine        | Pure reducer, shared package, no I/O               |
| Repo          | npm workspaces monorepo                            |

## Documents

| #   | Document                               | What it covers                                         |
| --- | -------------------------------------- | ------------------------------------------------------ |
| 01  | [Overview](01-overview.md)             | Goals, non-goals, constraints, IP position             |
| 02  | [Rules Model](02-rules-model.md)       | The subset of the physical rules we implement, and how |
| 03  | [Architecture](03-architecture.md)     | Packages, stack rationale, build and deploy shape      |
| 04  | [Data Model](04-data-model.md)         | Game state types and content schemas                   |
| 05  | [Game Engine](05-engine.md)            | Reducer, phases, actions, determinism, RNG             |
| 06  | [Networking](06-networking.md)         | Protocol, rooms, redaction, reconnect                  |
| 07  | [UI](07-ui.md)                         | Screens, board rendering, interaction, art plan        |
| 08  | [Haunt System](08-haunt-system.md)     | Data-driven haunts, trigger DSL, script escape hatch   |
| 09  | [Roadmap](09-roadmap.md)               | Milestones M0–M6 with exit criteria                    |
| 10  | [Testing & Ops](10-testing-and-ops.md) | Test strategy, CI, hosting, observability              |

## Reading order

If you are about to write code, read 01 → 03 → 05 → 09. The rest are
reference documents you will return to while implementing a specific area.

## Open questions

Tracked at the bottom of [09-roadmap.md](09-roadmap.md#open-questions).
