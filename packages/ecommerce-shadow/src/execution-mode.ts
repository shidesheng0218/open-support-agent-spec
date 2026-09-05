import { ExecutionModeConfigError, LiveExecutionNotAvailableError } from "./errors.js";

/**
 * Execution mode (v0.1.1 Milestone 3). Only "shadow" is supported: Shadow
 * Mode creates proposals, runs policy simulation, and records what would
 * have been auto-executed; humans write the final outcome. "live" fails
 * closed at startup — live execution requires a future RFC.
 */
export interface ExecutionModeConfig {
  mode: "shadow";
}

export function loadExecutionMode(env: NodeJS.ProcessEnv = process.env): ExecutionModeConfig {
  const raw = (env.OSAS_EXECUTION_MODE ?? "").trim() || "shadow";
  if (raw === "shadow") return { mode: "shadow" };
  if (raw === "live") throw new LiveExecutionNotAvailableError();
  throw new ExecutionModeConfigError(raw);
}
