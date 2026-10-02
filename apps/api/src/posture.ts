/**
 * Startup security-posture summary (observability only).
 *
 * After every config loader has run — all of them fail closed on unsafe
 * combinations — the API logs one structured line describing the resulting
 * posture, plus one WARN line per weak-but-allowed combination. The summary
 * contains only enum-like values ("set" / "unset", mode names); secrets,
 * URLs, and credentials are never included. See docs/production-hardening.md.
 */
import type { AuthConfig } from "./auth.js";
import type { ConformanceConfig, LlmConfig, StorageConfig } from "./config.js";

export interface SecurityPosture {
  authMode: AuthConfig["mode"];
  storage: StorageConfig["mode"];
  executionMode: string;
  conformanceMode: "on" | "off";
  llmProvider: LlmConfig["provider"];
  llmBudgets: "set" | "unset";
  llmPricing: "set" | "unset" | "n/a";
  nodeEnv: string;
}

export interface SecurityPostureReport {
  posture: SecurityPosture;
  /** Human-readable weak-configuration findings; empty means nothing to flag. */
  warnings: string[];
}

export function buildSecurityPosture(input: {
  auth: AuthConfig;
  storage: StorageConfig;
  llm: LlmConfig;
  executionMode: { mode: string };
  conformance: ConformanceConfig;
  env?: NodeJS.ProcessEnv;
}): SecurityPostureReport {
  const { auth, storage, llm, executionMode, conformance } = input;
  const nodeEnv = input.env?.NODE_ENV ?? auth.nodeEnv ?? "development";
  const warnings: string[] = [];

  if (auth.mode === "demo") {
    // demo+production already fails closed in loadAuthConfig; this covers the rest.
    warnings.push(
      "auth=demo: identity is self-asserted via x-osas-* headers — use OSAS_AUTH_MODE=jwt beyond local development",
    );
  }
  if (storage.mode === "memory") {
    warnings.push(
      "storage=memory: all state is per-process and lost on restart — use OSAS_STORAGE=postgres for anything you intend to keep",
    );
  }
  if (conformance.enabled) {
    warnings.push(
      "conformance=on: reset/fixture/snapshot endpoints are live — never enable outside a throwaway test environment",
    );
  }
  if (llm.provider === "mock" && nodeEnv === "production") {
    warnings.push(
      "llm=mock under NODE_ENV=production: no real model will be called — set OSAS_LLM_PROVIDER=openai-compatible",
    );
  }
  if (llm.dailyBudgetUsd === undefined && llm.caseBudgetUsd === undefined) {
    warnings.push(
      "llm budgets unset: no OSAS_LLM_DAILY_BUDGET_USD / OSAS_LLM_CASE_BUDGET_USD caps — spend is uncapped",
    );
  }
  const llmPricing =
    llm.provider === "mock"
      ? "n/a"
      : llm.inputUsdPerMToken !== undefined && llm.outputUsdPerMToken !== undefined
        ? "set"
        : "unset";
  if (llm.provider === "openai-compatible" && llmPricing === "unset") {
    warnings.push(
      "llm pricing unset: costs are recorded as unknown (never fabricated) and budget caps cannot measure spend",
    );
  }

  return {
    posture: {
      authMode: auth.mode,
      storage: storage.mode,
      executionMode: executionMode.mode,
      conformanceMode: conformance.enabled ? "on" : "off",
      llmProvider: llm.provider,
      llmBudgets:
        llm.dailyBudgetUsd !== undefined || llm.caseBudgetUsd !== undefined ? "set" : "unset",
      llmPricing,
      nodeEnv,
    },
    warnings,
  };
}
