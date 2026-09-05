/**
 * Deterministic 32-bit FNV-1a string hash. Backs the mock provider's
 * pseudo-tokens/latency and derived idempotency keys (CONTRACTS.md §8).
 */
export function stableHash(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function stableHashHex(input: string): string {
  return stableHash(input).toString(16).padStart(8, "0");
}
