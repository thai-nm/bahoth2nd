/**
 * Pure discovery mechanics: which rotations a drawn tile could land at, and
 * which tile comes off the deck. No reducer plumbing here — `reduce.ts` is
 * the only place that touches `GameState.pending` or emits events; this file
 * just answers questions about tiles and decks so that code can stay thin.
 * See docs/05-engine.md#56 (the worked example this implements steps 2-3 of)
 * and docs/02-rules-model.md#24 step 3, including its [RULING] on the draw.
 */

import {
  cellKey,
  neighbourCell,
  rotateDoors,
  DIR_ORDER,
  ROTATIONS,
  type Dir,
  type Floor,
  type GameState,
  type RngState,
  type Rotation,
  type SeatId,
  type TileId,
} from '@bahoth/shared';
import type { Content, Tile } from '@bahoth/content';
import { shuffle } from './rng.js';

/**
 * Rotations that put a door on `entry`, deduplicated by effective doors.
 *
 * A tile with doors on all four sides has four "legal" rotations that are
 * the same room. Prompting for a choice with no effect is worse than not
 * prompting; deduping is also what makes auto-apply (docs/09-roadmap.md open
 * question 7) fire on exactly the symmetric tiles it should.
 *
 * A tile always has at least one door (`assertTilesCoherent` rejects one with
 * none), so the result is never empty for any `entry`.
 */
export function legalRotations(tile: Tile, entry: Dir): Rotation[] {
  const out: Rotation[] = [];
  const seen = new Set<string>();
  for (const r of ROTATIONS) {
    const doors = rotateDoors(tile.doors, r);
    if (!doors[entry]) continue;
    const key = DIR_ORDER.map((d) => (doors[d] ? '1' : '0')).join('');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

export interface TileDraw {
  tileId: TileId;
  deck: TileId[];
  rng: RngState;
}

/**
 * Draw the top tile legal on `floor`, shuffling the passed-over ones back.
 *
 * Scans from index 0 for the first id whose declared `floors` include
 * `floor` (docs/02-rules-model.md#24's [RULING] on the draw). A plain
 * top-of-deck draw returns the RNG unchanged — burning a random number on
 * every discovery, even one that passed over nothing, would perturb every
 * later roll for no reason.
 *
 * The passed-over tiles go back into a deck whose order is hidden anyway, so
 * reshuffling the whole remainder is the same information as inserting them
 * at random positions, and is one line instead of ten.
 */
export function drawTile(
  deck: readonly TileId[],
  floor: Floor,
  content: Content,
  rng: RngState,
): TileDraw | null {
  const i = deck.findIndex((id) => content.tilesById[id]?.floors.includes(floor));
  if (i === -1) return null;

  const tileId = deck[i]!;
  const passed = deck.slice(0, i);
  const rest = deck.slice(i + 1);

  if (passed.length === 0) {
    return { tileId, deck: rest, rng };
  }

  const [shuffled, nextRng] = shuffle(rng, [...passed, ...rest]);
  return { tileId, deck: shuffled, rng: nextRng };
}

/**
 * Can any tile still in the deck be built on `floor`?
 *
 * Deliberately NOT `drawTile(state.tileDeck, floor, content, rng) !== null`.
 * `state.tileDeck` is redacted to `[]` (docs/06-networking.md#64: "Tile deck
 * order — same treatment"), and the client evaluates legality on the
 * redacted snapshot — docs/05-engine.md#57 is explicit that there is one
 * legality function on both sides, not a server version and a client
 * version. Reading `state.tileDeck` directly would be correct on the server
 * and permanently empty on the client, which would make every doorway arrow
 * dead forever.
 *
 * The deck's ORDER is hidden (that is what redaction protects), but its
 * COMPOSITION is not: the tile list is public content, the board is public,
 * and "what's left in the deck" is exactly "every printed copy minus what
 * has already been placed" — arithmetic anyone at a real table could do by
 * counting. `content.deckTiles` never contains a pre-placed tile
 * (`buildTileDeck` excludes them), so counting a deck id's occurrences in
 * `board.placed` is an exact count of how many copies are gone.
 */
export function canDiscoverOn(state: GameState, floor: Floor, content: Content): boolean {
  const placedCounts = new Map<TileId, number>();
  for (const tile of Object.values(state.board.placed)) {
    placedCounts.set(tile.tileId, (placedCounts.get(tile.tileId) ?? 0) + 1);
  }

  const remaining = new Map<TileId, number>();
  for (const id of content.deckTiles) {
    remaining.set(id, (remaining.get(id) ?? 0) + 1);
  }

  for (const [id, copies] of remaining) {
    if (copies - (placedCounts.get(id) ?? 0) <= 0) continue;
    if (content.tilesById[id]?.floors.includes(floor)) return true;
  }
  return false;
}

/** Directions the seat could `MOVE_THROUGH` right now. */
export function getOpenDoorways(state: GameState, seat: SeatId, content: Content): Dir[] {
  const player = state.players[seat];
  if (!player || player.isDead || player.removed || player.location === null) return [];
  if (player.movesLeft <= 0) return [];

  const location = state.board.placed[player.location];
  const tileDef = location && content.tilesById[location.tileId];
  if (!location || !tileDef) return [];

  const doors = rotateDoors(tileDef.doors, location.rotation);

  const out: Dir[] = [];
  for (const dir of DIR_ORDER) {
    if (!doors[dir]) continue;
    const [nx, ny] = neighbourCell(location.x, location.y, dir);
    if (state.board.index[location.floor][cellKey(nx, ny)]) continue;
    // Once nothing left in the deck can be built on this floor, the arrow
    // must go away: getLegalActions feeds property.test.ts straight into
    // reduce, and an offered action that reduce rejects fails that test.
    if (!canDiscoverOn(state, location.floor, content)) continue;
    out.push(dir);
  }
  return out;
}
