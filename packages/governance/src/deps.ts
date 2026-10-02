import { randomUUID } from "node:crypto";

/** Injected time source so tests can drive leases, backoff, and deadlines. */
export interface Clock {
  now(): Date;
}

export interface IdFactory {
  next(prefix: string): string;
}

export const systemClock: Clock = { now: () => new Date() };

/**
 * Random ids. Prefixes mirror the OSAS convention so an id is
 * self-describing in logs and audit detail.
 */
export const randomIdFactory: IdFactory = {
  next: (prefix) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
};

/** Deterministic ids for tests: `job_000001`, `job_000002`, ... */
export function sequentialIdFactory(): IdFactory {
  const counters = new Map<string, number>();
  return {
    next(prefix) {
      const n = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, n);
      return `${prefix}_${String(n).padStart(6, "0")}`;
    },
  };
}

/** Fixed clock for tests; advance manually. */
export function fixedClock(start: string | Date): Clock & { advance(ms: number): void; set(at: string | Date): void } {
  let current = new Date(start);
  return {
    now: () => new Date(current),
    advance(ms) {
      current = new Date(current.getTime() + ms);
    },
    set(at) {
      current = new Date(at);
    },
  };
}

export const toIso = (d: Date): string => d.toISOString();
