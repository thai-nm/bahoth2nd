/**
 * Explorer colour, mirrored from ColourSchema in
 * packages/content/src/schemas.ts. Content does not export a `Colour` type
 * (only the zod schema), and reaching into zod for a type-only inference
 * here would be more machinery than six literals warrant — packages/shared's
 * own ids.ts does the same thing for Floor/Dir/Trait rather than deriving
 * them from a schema.
 */
export type Colour = 'red' | 'green' | 'blue' | 'white' | 'purple' | 'yellow';

/**
 * CSS custom property for each colour, defined in styles.css's `:root`
 * block. A Record keyed by the full Colour union indexes safely under
 * noUncheckedIndexedAccess — every key is covered, so there is no
 * `| undefined` to launder away.
 */
export const COLOUR_VAR: Record<Colour, string> = {
  red: 'var(--red)',
  green: 'var(--green)',
  blue: 'var(--blue)',
  white: 'var(--white)',
  purple: 'var(--purple)',
  yellow: 'var(--yellow)',
};
