/**
 * CSS custom property for each explorer colour, defined in styles.css's
 * `:root` block. `Colour` itself lives in @bahoth/shared/ids.ts — it is a
 * domain enum (it describes an explorer, not a rendering concern), so the
 * client is not the package with an opinion about what colours exist. This
 * mapping genuinely is a client rendering concern and stays here.
 *
 * A Record keyed by the full Colour union indexes safely under
 * noUncheckedIndexedAccess — every key is covered, so there is no
 * `| undefined` to launder away.
 */

import type { Colour } from '@bahoth/shared';

export const COLOUR_VAR: Record<Colour, string> = {
  red: 'var(--red)',
  green: 'var(--green)',
  blue: 'var(--blue)',
  white: 'var(--white)',
  purple: 'var(--purple)',
  yellow: 'var(--yellow)',
};
