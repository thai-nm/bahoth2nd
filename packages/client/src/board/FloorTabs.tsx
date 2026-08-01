/**
 * Basement / ground / upper switcher (docs/07-ui.md#73-board-rendering).
 *
 * Inactive floors are not rendered at all: this component only ever draws
 * the tab strip, never a Board for a floor that is not `active`. The caller
 * mounts exactly one <Board> for the current floor — there is nothing here
 * to keep an inactive floor's DOM alive.
 */

import { FLOORS } from '@bahoth/shared';
import type { Floor, PlacedId } from '@bahoth/shared';
import { COLOUR_VAR } from './colour.js';
import type { Colour } from './colour.js';

const FLOOR_LABEL: Record<Floor, string> = {
  basement: 'Basement',
  ground: 'Ground',
  upper: 'Upper',
};

interface FloorPawn {
  placedId: PlacedId;
  colour: Colour;
  initial: string;
}

interface FloorTabsProps {
  active: Floor;
  onSelect: (floor: Floor) => void;
  /** Pawns present on each floor, for that tab's dot row. */
  pawnsByFloor: Readonly<Record<Floor, readonly FloorPawn[]>>;
}

export function FloorTabs({ active, onSelect, pawnsByFloor }: FloorTabsProps) {
  return (
    <div className="floortabs" role="tablist" aria-label="Floor">
      {FLOORS.map((floor) => (
        <button
          key={floor}
          type="button"
          role="tab"
          aria-selected={floor === active}
          className={`floortab${floor === active ? ' floortab--active' : ''}`}
          onClick={() => onSelect(floor)}
        >
          <span className="floortab__name">{FLOOR_LABEL[floor]}</span>
          <span className="floortab__dots" aria-hidden="true">
            {pawnsByFloor[floor].map((p, i) => (
              <span
                key={`${p.placedId}-${i}`}
                className="floortab__dot"
                style={{ background: COLOUR_VAR[p.colour] }}
                title={p.initial}
              />
            ))}
          </span>
        </button>
      ))}
    </div>
  );
}
