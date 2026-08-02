/**
 * The movement graph: adjacency, reachability, and the turn's movement
 * budget. See docs/02-rules-model.md#movement-graph and #24-turn-structure,
 * and docs/04-data-model.md#static-links for what a `StaticLink` means.
 */

import {
  DIR_ORDER,
  OPPOSITE,
  cellKey,
  neighbourCell,
  rotateDoors,
  type Floor,
  type GameState,
  type PlacedId,
  type SeatId,
} from '@bahoth/shared';
import type { Content } from '@bahoth/content';
import { traitValue } from './selectors.js';

/**
 * The placed tile that is `floor`'s landing, or null if it has not been
 * placed yet. Every floor has a landing declared in content
 * (`assertHouseCoherent`), but the landing tile itself is pre-placed by
 * `house.layout`, so this never needs to search the draw deck.
 */
function landingPlacedId(
  state: GameState,
  content: Content,
  floor: Floor,
): PlacedId | null {
  const landingTileId = content.house.landings[floor];
  for (const [id, tile] of Object.entries(state.board.placed)) {
    if (tile.tileId === landingTileId) return id;
  }
  return null;
}

/**
 * Every room `from` connects to right now, in a stable order: grid neighbours
 * in `DIR_ORDER` first, then static-link targets in declaration/placement
 * order, deduplicated. Determinism here is load-bearing — `property.test.ts`
 * asserts byte-identical replay, and this function is walked on every MOVE.
 */
export function getConnections(
  state: GameState,
  from: PlacedId,
  content: Content,
): PlacedId[] {
  const tile = state.board.placed[from];
  if (!tile) return [];
  const tileDef = content.tilesById[tile.tileId];

  const out: PlacedId[] = [];
  const seen = new Set<PlacedId>();
  // Never connect a tile to itself (D-c).
  const add = (id: PlacedId): void => {
    if (id === from || seen.has(id)) return;
    seen.add(id);
    out.push(id);
  };

  if (tileDef) {
    // 1. Grid adjacency: both edges need a door, after each tile's own
    //    rotation (docs/02-rules-model.md#movement-graph, rule 1).
    const doors = rotateDoors(tileDef.doors, tile.rotation);
    for (const dir of DIR_ORDER) {
      if (!doors[dir]) continue;
      const [nx, ny] = neighbourCell(tile.x, tile.y, dir);
      const neighbourId = state.board.index[tile.floor][cellKey(nx, ny)];
      if (!neighbourId) continue;
      const neighbour = state.board.placed[neighbourId];
      const neighbourDef = neighbour && content.tilesById[neighbour.tileId];
      if (!neighbour || !neighbourDef) continue;
      const neighbourDoors = rotateDoors(neighbourDef.doors, neighbour.rotation);
      if (neighbourDoors[OPPOSITE[dir]]) add(neighbourId);
    }

    // 2. This tile's own static links, forward direction — always active
    //    regardless of `twoWay` (docs/04-data-model.md#static-links).
    for (const link of tileDef.staticLinks) {
      if (link.kind === 'to_tile') {
        for (const [id, other] of Object.entries(state.board.placed)) {
          if (other.tileId === link.target) add(id);
        }
      } else if (link.kind === 'to_floor' || link.kind === 'oneway_drop') {
        const landing = landingPlacedId(state, content, link.floor);
        if (landing) add(landing);
      }
    }
  }

  // 3. Other placed tiles whose `twoWay` link points back at `from`. `twoWay`
  //    describes the link, not the pair, so the reverse direction is found by
  //    scanning rather than by a declaration on this tile (D-c).
  for (const [id, other] of Object.entries(state.board.placed)) {
    if (id === from) continue;
    const otherDef = content.tilesById[other.tileId];
    if (!otherDef) continue;
    for (const link of otherDef.staticLinks) {
      if (link.kind === 'to_tile' && link.twoWay && link.target === tile.tileId) {
        add(id);
      } else if (
        link.kind === 'to_floor' &&
        link.twoWay &&
        link.landing === tile.tileId
      ) {
        add(id);
      }
    }
  }

  return out;
}

/**
 * A node in the BFS's actual state space: not just a room, but the room plus
 * how it was entered. Two visits to the same room with different `cameFrom`
 * are different states, because they forbid different next steps.
 */
interface StateKey {
  pos: PlacedId;
  cameFrom: PlacedId | null;
}

const stateKey = (pos: PlacedId, cameFrom: PlacedId | null): string =>
  `${pos}|${cameFrom ?? ''}`;

interface WalkResult {
  /** The seat's current location, or null if it cannot move at all. */
  start: PlacedId | null;
  /** The root state the BFS started from — `{ start, player.cameFrom }`. */
  root: StateKey | null;
  /**
   * The first (minimal-depth) BFS state that discovered each reachable room,
   * keyed by that room's id. This — not `predState` — is what `getReachable`
   * returns and what `findPath` starts reconstructing from: a room can be
   * discovered by several states along the way, and only the shortest one
   * should ever surface. The seat's own location is deliberately never a key
   * (D-d): it is where you are, not somewhere `MOVE` can take you.
   */
  firstState: Map<PlacedId, StateKey>;
  /**
   * Predecessor state for every BFS state visited, keyed by that state's own
   * key (`pos|cameFrom`), not by `pos` alone.
   *
   * Keying by position alone was the defect: when the BFS loops back through
   * `start` (a room may be walked through, just never landed on), it
   * re-explores start's neighbours from a *different* `cameFrom` than the
   * player's real one. A position-keyed map records whichever of those
   * discoveries happened to run last as "the" predecessor, and if that
   * happened to be the direct-from-start discovery, `findPath` reconstructed
   * a one-step path straight back into the room the player just left — the
   * no-backtrack rule silently defeated, and `move()` charging 1 point for a
   * path that was actually the long way round. Keying by state means each
   * loop through `start` is its own predecessor chain, so reconstruction
   * cannot cross into a different visit's history.
   */
  predState: Map<string, StateKey>;
}

/**
 * BFS over (position, cameFrom) rather than position alone, because the
 * no-backtrack rule makes which room you may not re-enter depend on how you
 * got to the current room (docs/02-rules-model.md#24, the [RULING] on
 * backtracking). `getReachable` and `findPath` both call this so they can
 * never disagree.
 */
function walk(state: GameState, seat: SeatId, content: Content): WalkResult {
  const player = state.players[seat];
  const firstState = new Map<PlacedId, StateKey>();
  const predState = new Map<string, StateKey>();
  if (!player || player.isDead || player.removed || player.location === null) {
    return { start: null, root: null, firstState, predState };
  }
  const budget = player.movesLeft;
  if (budget <= 0) return { start: null, root: null, firstState, predState };

  const start = player.location;
  const root: StateKey = { pos: start, cameFrom: player.cameFrom };
  type QueueEntry = { pos: PlacedId; cameFrom: PlacedId | null; depth: number };
  const queue: QueueEntry[] = [{ pos: start, cameFrom: player.cameFrom, depth: 0 }];
  const visited = new Set<string>([stateKey(start, player.cameFrom)]);

  let head = 0;
  while (head < queue.length) {
    const entry = queue[head++]!;
    if (entry.depth >= budget) continue;

    for (const nb of getConnections(state, entry.pos, content)) {
      // No immediate backtrack into the room just left.
      if (nb === entry.cameFrom) continue;

      const key = stateKey(nb, entry.pos);
      if (visited.has(key)) continue;
      visited.add(key);
      predState.set(key, { pos: entry.pos, cameFrom: entry.cameFrom });
      queue.push({ pos: nb, cameFrom: entry.pos, depth: entry.depth + 1 });

      // The current location is never a destination, even reached by a loop
      // — but it may still be walked *through* on the way to somewhere else.
      // First-discovery only: a room found again later, by a longer route,
      // must not displace the shortest one already on record.
      if (nb !== start && !firstState.has(nb)) {
        firstState.set(nb, { pos: nb, cameFrom: entry.pos });
      }
    }
  }

  return { start, root, firstState, predState };
}

/** Every room the seat may issue `MOVE { to }` for right now. */
export function getReachable(
  state: GameState,
  seat: SeatId,
  content: Content,
): PlacedId[] {
  return Array.from(walk(state, seat, content).firstState.keys());
}

/**
 * The shortest legal path to `to`, excluding the start and including `to`,
 * or null if `to` is not reachable this turn. Shares `walk` with
 * `getReachable` so the two can never disagree about what is reachable.
 */
export function findPath(
  state: GameState,
  seat: SeatId,
  to: PlacedId,
  content: Content,
): PlacedId[] | null {
  const { start, root, firstState, predState } = walk(state, seat, content);
  const dest = start && root ? firstState.get(to) : undefined;
  if (!start || !root || !dest) return null;

  // Walk the predecessor chain from `to`'s first-discovered state back to
  // the root. Stopping at `pos === start` is not enough — a loop through
  // `start` mid-path is a different state (different `cameFrom`) from the
  // root, and stopping there would drop it from the path (see `predState`'s
  // comment on `walk`). Only the root itself — matched by state, not just
  // position — ends the walk.
  const path: PlacedId[] = [];
  let cur: StateKey | undefined = dest;
  while (cur && (cur.pos !== root.pos || cur.cameFrom !== root.cameFrom)) {
    path.unshift(cur.pos);
    cur = predState.get(stateKey(cur.pos, cur.cameFrom));
  }
  return path;
}

/**
 * Reset a seat's movement budget to its current Speed and clear `cameFrom`
 * (docs/02-rules-model.md#24, step 1: "Movement budget is set to the current
 * Speed value"). Called from every place the active seat changes — see
 * D-f — so a missed call site cannot leave a seat silently unable to move.
 */
export function beginTurnFor(
  state: GameState,
  seat: SeatId,
  content: Content,
): GameState {
  const player = state.players[seat];
  if (!player) return state;
  return {
    ...state,
    players: {
      ...state.players,
      [seat]: {
        ...player,
        movesLeft: traitValue(state, seat, 'speed', content),
        cameFrom: null,
      },
    },
  };
}
