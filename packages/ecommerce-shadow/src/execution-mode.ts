import { ExecutionModeConfigError, LiveExecutionNotAvailableError } from "./errors.js";

/**
 * Proposal-only and Shadow modes never execute provider writes. Sandbox runs
 * deterministic synthetic execution. "live" fails closed at startup — live
 * execution requires a future RFC.
 */
export interface ExecutionModeConfig {
  mode: "proposal_only" | "shadow" | "sandbox";
}

export function loadExecutionMode(env: NodeJS.ProcessEnv = process.env): ExecutionModeConfig {
  const raw = (env.OSAS_EXECUTION_MODE ?? "").trim() || "shadow";
  if (raw === "proposal_only") return { mode: "proposal_only" };
  if (raw === "shadow") return { mode: "shadow" };
  if (raw === "sandbox") return { mode: "sandbox" };
  if (raw === "live") throw new LiveExecutionNotAvailableError();
  throw new ExecutionModeConfigError(raw);
}
