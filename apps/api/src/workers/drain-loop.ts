import type { GovernanceRuntime } from "@osas/governance";
import { ConfigError } from "../config.js";

/**
 * Optional in-process queue drain. Off unless OSAS_GOVERNANCE_WORKER_INTERVAL_MS
 * is set, so tests and the demo never get a background timer by accident.
 * Sweeps never overlap: a slow sweep delays the next one instead of racing it.
 */
export const MIN_DRAIN_INTERVAL_MS = 250;

export function loadDrainIntervalMs(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env.OSAS_GOVERNANCE_WORKER_INTERVAL_MS?.trim();
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < MIN_DRAIN_INTERVAL_MS) {
    throw new ConfigError(
      `OSAS_GOVERNANCE_WORKER_INTERVAL_MS must be an integer >= ${MIN_DRAIN_INTERVAL_MS}; got "${raw}"`,
    );
  }
  return n;
}

export function startDrainLoop(
  runtime: GovernanceRuntime,
  intervalMs: number,
  log: { warn(o: unknown, m: string): void },
): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const tick = async (): Promise<void> => {
    try {
      await runtime.runner.runOnce({ limit: 10 });
    } catch (err) {
      log.warn(err, "governance drain sweep failed");
    }
    if (!stopped) {
      timer = setTimeout(() => void tick(), intervalMs);
      timer.unref();
    }
  };
  timer = setTimeout(() => void tick(), intervalMs);
  timer.unref();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
