/**
 * ID and timestamp helpers. No dependencies.
 */

/** `<prefix>_<base36 timestamp><base36 random>` — opaque, sortable-ish, unique enough for tests/demo. */
export function newId(prefix: string): string {
  const ts = Date.now().toString(36);
  const rand =
    Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
  return `${prefix}_${ts}${rand}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
