import type { Money } from "@osas/core";

/**
 * Currency-aware money comparison (§0: minorUnits integers, never floats).
 * Returns a negative number, 0, or a positive number like Array#sort comparators.
 * Throws on currency mismatch — callers that must not throw should use
 * {@link compareMoneySafe}.
 */
export function compareMoney(a: Money, b: Money): number {
  if (a.currency !== b.currency) {
    throw new RangeError(
      `currency mismatch: ${a.currency} vs ${b.currency}`,
    );
  }
  return a.minorUnits - b.minorUnits;
}

/** Same as {@link compareMoney} but returns `null` on currency mismatch. */
export function compareMoneySafe(a: Money, b: Money): number | null {
  if (a.currency !== b.currency) return null;
  return a.minorUnits - b.minorUnits;
}

export function sameCurrency(a: Money, b: Money): boolean {
  return a.currency === b.currency;
}
