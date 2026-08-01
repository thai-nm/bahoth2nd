/**
 * The board viewport (docs/07-ui.md#73-board-rendering, #76-accessibility).
 *
 * Presentational only: it derives no game state and holds no game state in
 * `useState`, just transient UI state (pan/zoom) per docs/07-ui.md#77. The
 * movement graph does not exist yet, so `reachable` arrives as a prop instead
 * of being computed here from `getReachable` — nothing in this file may
 * depend on that function or on any adjacency/connectivity logic.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import { DIR_ORDER, FLOORS } from '@bahoth/shared';
import type { BoardState, Colour, Dir, Floor, PlacedId } from '@bahoth/shared';
import type { Content } from '@bahoth/content';
import {
  TILE,
  boardBounds,
  clampZoom,
  fitTransform,
  openDoorways,
  tileViewsForFloor,
} from './layout.js';
import type { TileView } from './layout.js';
import { COLOUR_VAR } from './colour.js';

export interface Pawn {
  placedId: PlacedId;
  colour: Colour;
  initial: string;
  isMe: boolean;
}

interface BoardProps {
  board: BoardState;
  content: Content;
  floor: Floor;
  pawns: ReadonlyArray<Pawn>;
  /** Will come from getReachable once the movement graph lands. Until then the caller supplies it. */
  reachable?: readonly PlacedId[] | undefined;
  onMoveTo?: ((placedId: PlacedId) => void) | undefined;
  onMoveThrough?: ((placedId: PlacedId, dir: Dir) => void) | undefined;
}

/** Breathing room around the floor when fitting it to the viewport, in px. */
const FIT_PAD = 40;

const DIR_LABEL: Record<Dir, string> = { n: 'north', e: 'east', s: 'south', w: 'west' };

interface PanZoom {
  tx: number;
  ty: number;
  k: number;
}

export function Board({
  board,
  content,
  floor,
  pawns,
  reachable,
  onMoveTo,
  onMoveThrough,
}: BoardProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ startX: number; startY: number; origin: PanZoom } | null>(
    null,
  );
  const [view, setView] = useState<PanZoom>({ tx: 0, ty: 0, k: 1 });

  const views = useMemo(
    () => tileViewsForFloor(board, content, floor),
    [board, content, floor],
  );
  const bounds = useMemo(() => boardBounds(views), [views]);
  const doorways = useMemo(() => openDoorways(views), [views]);
  const reachableSet = useMemo(() => new Set<PlacedId>(reachable ?? []), [reachable]);
  const pawnsByTile = useMemo(() => {
    const map = new Map<PlacedId, Pawn[]>();
    for (const pawn of pawns) {
      const list = map.get(pawn.placedId);
      if (list) list.push(pawn);
      else map.set(pawn.placedId, [pawn]);
    }
    return map;
  }, [pawns]);

  const fitFloor = useCallback(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const fit = fitTransform(
      bounds.width,
      bounds.height,
      vp.clientWidth,
      vp.clientHeight,
      FIT_PAD,
    );
    // fitTransform assumes the content box starts at (0,0); shift by the
    // floor's actual bounds so the box it centred is the one we drew.
    setView({
      tx: fit.tx - bounds.minX * fit.k,
      ty: fit.ty - bounds.minY * fit.k,
      k: fit.k,
    });
  }, [bounds]);

  // Re-fit whenever `fitFloor` itself changes identity — which happens on
  // every floor switch, since `bounds` is derived from `floor` — by calling
  // it directly rather than trusting ResizeObserver's initial-notification
  // timing. Switching floors does not necessarily change the viewport
  // element's own size, and re-observing an unchanged-size element with a
  // fresh observer is not reliably guaranteed to fire; only an explicit call
  // makes every floor refit, not just the first one.
  useEffect(() => {
    fitFloor();
  }, [fitFloor]);

  // Separately, watch the viewport element itself for real size changes
  // (window resize, layout reflow) and refit then too.
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const observer = new ResizeObserver(() => fitFloor());
    observer.observe(vp);
    return () => observer.disconnect();
  }, [fitFloor]);

  const centreOnMe = useCallback(() => {
    const vp = viewportRef.current;
    const mine = pawns.find((p) => p.isMe);
    const tile = mine ? views.find((v) => v.placedId === mine.placedId) : undefined;
    if (!vp || !tile) return;
    setView((prev) => ({
      tx: vp.clientWidth / 2 - (tile.px + TILE / 2) * prev.k,
      ty: vp.clientHeight / 2 - (tile.py + TILE / 2) * prev.k,
      k: prev.k,
    }));
  }, [pawns, views]);

  // Wheel needs a non-passive native listener to preventDefault — React's
  // synthetic onWheel cannot stop the page from scrolling underneath a board
  // that doesn't fill the viewport.
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = vp.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      setView((prev) => {
        const k = clampZoom(prev.k * factor);
        // Zoom around the pointer, not the origin, so the room under the cursor stays put.
        const wx = (px - prev.tx) / prev.k;
        const wy = (py - prev.ty) / prev.k;
        return { k, tx: px - wx * k, ty: py - wy * k };
      });
    };
    vp.addEventListener('wheel', handleWheel, { passive: false });
    return () => vp.removeEventListener('wheel', handleWheel);
  }, []);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    // Only start a pan from empty space — tiles and doorway arrows handle their own clicks.
    if ((e.target as HTMLElement).closest('.tile, .doorway')) return;
    dragRef.current = { startX: e.clientX, startY: e.clientY, origin: view };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    setView({
      ...drag.origin,
      tx: drag.origin.tx + (e.clientX - drag.startX),
      ty: drag.origin.ty + (e.clientY - drag.startY),
    });
  };
  const onPointerUp = () => {
    dragRef.current = null;
  };

  return (
    <div className="board">
      <div className="board__controls">
        <button type="button" className="board__btn" onClick={fitFloor}>
          Fit floor
        </button>
        <button type="button" className="board__btn" onClick={centreOnMe}>
          Centre on me
        </button>
      </div>
      <div
        className="viewport"
        ref={viewportRef}
        tabIndex={0}
        role="group"
        aria-label={`Board, ${floor} floor`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div
          className="world"
          style={{ transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.k})` }}
        >
          {views.map((tv) => (
            <Tile
              key={tv.placedId}
              view={tv}
              content={content}
              floor={floor}
              reachable={reachableSet.has(tv.placedId)}
              pawns={pawnsByTile.get(tv.placedId) ?? []}
              onMoveTo={onMoveTo}
            />
          ))}
          {doorways.map((d) => (
            <button
              key={`${d.placedId}:${d.dir}`}
              type="button"
              className={`doorway doorway--${d.dir} ${onMoveThrough ? 'doorway--live' : 'doorway--dim'}`}
              style={{ left: d.px, top: d.py }}
              disabled={!onMoveThrough}
              onClick={() => onMoveThrough?.(d.placedId, d.dir)}
              aria-label={`Open doorway, ${DIR_LABEL[d.dir]}`}
            >
              <span aria-hidden="true">▲</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

const SYMBOL_GLYPH: Record<'item' | 'event' | 'omen', string> = {
  item: '◆',
  event: '✦',
  omen: '☾',
};
const SYMBOL_LABEL: Record<'item' | 'event' | 'omen', string> = {
  item: 'Item',
  event: 'Event',
  omen: 'Omen',
};

/** Small offsets from the pawn anchor so several pawns in one room stay individually readable. */
const FAN_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [-22, -14],
  [22, -14],
  [-22, 14],
  [22, 14],
  [0, -26],
];

/**
 * Below the vertical centre, clear of the centred room label (docs/07-ui.md
 * #73: the approved mock centres the name — moving the label instead of the
 * pawns would make the tile read as a labelled box rather than a room).
 */
const PAWN_ANCHOR_Y = TILE * 0.72;

interface TileProps {
  view: TileView;
  content: Content;
  floor: Floor;
  reachable: boolean;
  pawns: readonly Pawn[];
  onMoveTo: ((placedId: PlacedId) => void) | undefined;
}

function Tile({ view, content, floor, reachable, pawns, onMoveTo }: TileProps) {
  const tile = content.tilesById[view.tileId];
  // Doors are drawn in the tile's PRINTED frame and then the frame itself is
  // rotated (docs/07-ui.md#73: "Rotation is a CSS transform on the tile's
  // background layer only"), so the notch ends up wherever view.doors (the
  // already-rotated, effective doors) says it should. Falling back to the
  // effective doors with no rotation is only reachable for content that
  // failed to load — coherent content always has the tile.
  const printedDoors = tile?.doors ?? view.doors;
  const printedDoorDirs = DIR_ORDER.filter((d) => printedDoors[d]);

  const style: CSSProperties = { left: view.px, top: view.py, width: TILE, height: TILE };
  const frameStyle: CSSProperties = {
    transform: `rotate(${view.rotation}deg)`,
    ...(tile?.art?.bg ? { background: tile.art.bg } : {}),
  };

  const content_ = (
    <>
      <div className={`tile__frame tile__frame--${floor}`} style={frameStyle}>
        {printedDoorDirs.map((d) => (
          <span key={d} className={`doornotch doornotch--${d}`} />
        ))}
      </div>
      {/* The label lives outside the rotated frame so it stays upright — one
          less transform than counter-rotating it back (docs/07-ui.md#73). */}
      <span className="tile__label">{view.name}</span>
      {view.symbol && (
        <span
          className={`tile__symbol tile__symbol--${view.symbol}`}
          title={SYMBOL_LABEL[view.symbol]}
        >
          <span aria-hidden="true">{SYMBOL_GLYPH[view.symbol]}</span>
          <span className="sr-only">{SYMBOL_LABEL[view.symbol]}</span>
        </span>
      )}
      {view.links.length > 0 && (
        <span className="tile__link">{`→ ${view.links.join(', ')}`}</span>
      )}
      <span className="tile__floors" aria-hidden="true">
        {FLOORS.map((f) => (
          <span
            key={f}
            className={`tile__floordot${view.floors.includes(f) ? ` tile__floordot--${f}` : ''}`}
            title={f}
          />
        ))}
      </span>
      <span className="sr-only">Placeable on: {view.floors.join(', ')}</span>
      {pawns.map((pawn, i) => {
        const offset = FAN_OFFSETS[i % FAN_OFFSETS.length] ?? [0, 0];
        const [dx, dy] = offset;
        return (
          <span
            key={`${pawn.colour}-${pawn.initial}-${i}`}
            className={`pawn${pawn.isMe ? ' pawn--me' : ''}`}
            style={{
              left: TILE / 2 + dx,
              top: PAWN_ANCHOR_Y + dy,
              background: COLOUR_VAR[pawn.colour],
            }}
            title={pawn.initial}
          >
            {pawn.initial}
          </span>
        );
      })}
    </>
  );

  if (reachable) {
    return (
      <button
        type="button"
        className="tile tile--reachable"
        style={style}
        disabled={!onMoveTo}
        onClick={() => onMoveTo?.(view.placedId)}
      >
        {content_}
      </button>
    );
  }
  return (
    <div className="tile" style={style}>
      {content_}
    </div>
  );
}
