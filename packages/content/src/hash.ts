/**
 * Content hashing.
 *
 * Deliberately a small pure implementation rather than node:crypto, because
 * this module is imported by the client too. It is a fingerprint for
 * detecting mismatched content, not a security primitive.
 */

/** FNV-1a 64-bit, rendered as 16 hex chars. */
export function hashContent(value: unknown): string {
  const json = stableStringify(value);
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < json.length; i++) {
    h ^= BigInt(json.charCodeAt(i));
    h = (h * prime) & mask;
  }
  return h.toString(16).padStart(16, '0');
}

/** JSON.stringify with object keys sorted, so key order cannot change the hash. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(',')}}`;
}
