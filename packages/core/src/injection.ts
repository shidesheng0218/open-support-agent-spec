/**
 * Prompt-injection detection (CONTRACTS.md §8).
 * Case-insensitive patterns, English + 中文.
 */

const INJECTION_PATTERNS: readonly RegExp[] = [
  /ignore\s+(all|previous|above)(\s+\w+)*\s+instructions/i,
  /system\s+prompt/i,
  /you\s+are\s+now/i,
  /do\s+anything\s+now/i,
  /无视\s*(之前|以上|所有)\s*指令/,
  /立即执行退款/,
];

export function detectInjection(text: string): boolean {
  return INJECTION_PATTERNS.some((p) => p.test(text));
}
