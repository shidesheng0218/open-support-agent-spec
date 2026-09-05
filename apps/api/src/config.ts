/**
 * Environment-backed configuration (Milestone 2). All loaders fail closed:
 * unsafe or incomplete combinations throw at startup instead of degrading
 * silently. Secrets (OSAS_LLM_API_KEY) are read here and never logged.
 */

export class ConfigError extends Error {
  override name = "ConfigError";
}

export type StorageMode = "memory" | "postgres";

export interface StorageConfig {
  mode: StorageMode;
  databaseUrl?: string;
}

export function loadStorageConfig(env: NodeJS.ProcessEnv = process.env): StorageConfig {
  const raw = (env.OSAS_STORAGE ?? "").trim();
  if (!raw || raw === "memory" || raw === "mock") return { mode: "memory" };
  if (raw !== "postgres") {
    throw new ConfigError(`OSAS_STORAGE must be "memory" or "postgres"; got "${raw}"`);
  }
  const databaseUrl = env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new ConfigError("OSAS_STORAGE=postgres requires DATABASE_URL to be set");
  }
  return { mode: "postgres", databaseUrl };
}

export type LlmProviderKind = "mock" | "openai-compatible";

export interface LlmConfig {
  provider: LlmProviderKind;
  baseUrl?: string;
  apiKey?: string;
  modelFast?: string;
  modelStandard?: string;
  inputUsdPerMToken?: number;
  outputUsdPerMToken?: number;
  dailyBudgetUsd?: number;
  caseBudgetUsd?: number;
}

const parseMoney = (env: NodeJS.ProcessEnv, key: string): number | undefined => {
  const raw = env[key]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new ConfigError(`${key} must be a non-negative number; got "${raw}"`);
  }
  return value;
};

export function loadLlmConfig(env: NodeJS.ProcessEnv = process.env): LlmConfig {
  const provider = (env.OSAS_LLM_PROVIDER ?? "mock").trim() || "mock";
  const dailyBudgetUsd = parseMoney(env, "OSAS_LLM_DAILY_BUDGET_USD");
  const caseBudgetUsd = parseMoney(env, "OSAS_LLM_CASE_BUDGET_USD");
  if (provider === "mock") {
    return {
      provider,
      ...(dailyBudgetUsd !== undefined ? { dailyBudgetUsd } : {}),
      ...(caseBudgetUsd !== undefined ? { caseBudgetUsd } : {}),
    };
  }
  if (provider !== "openai-compatible") {
    throw new ConfigError(
      `OSAS_LLM_PROVIDER must be "mock" or "openai-compatible"; got "${provider}"`,
    );
  }
  const missing = [
    ["OSAS_LLM_BASE_URL", env.OSAS_LLM_BASE_URL],
    ["OSAS_LLM_MODEL_FAST", env.OSAS_LLM_MODEL_FAST],
    ["OSAS_LLM_MODEL_STANDARD", env.OSAS_LLM_MODEL_STANDARD],
  ]
    .filter(([, v]) => !v || !v.trim())
    .map(([k]) => k);
  if (missing.length > 0) {
    throw new ConfigError(
      `OSAS_LLM_PROVIDER=openai-compatible requires ${missing.join(", ")} to be set`,
    );
  }
  const inputUsdPerMToken = parseMoney(env, "OSAS_LLM_INPUT_USD_PER_MTOKEN");
  const outputUsdPerMToken = parseMoney(env, "OSAS_LLM_OUTPUT_USD_PER_MTOKEN");
  if ((inputUsdPerMToken === undefined) !== (outputUsdPerMToken === undefined)) {
    throw new ConfigError(
      "OSAS_LLM_INPUT_USD_PER_MTOKEN and OSAS_LLM_OUTPUT_USD_PER_MTOKEN must be set together " +
        "(or both omitted — costs are then recorded as unknown, never fabricated)",
    );
  }
  return {
    provider,
    baseUrl: env.OSAS_LLM_BASE_URL!.trim(),
    ...(env.OSAS_LLM_API_KEY?.trim() ? { apiKey: env.OSAS_LLM_API_KEY.trim() } : {}),
    modelFast: env.OSAS_LLM_MODEL_FAST!.trim(),
    modelStandard: env.OSAS_LLM_MODEL_STANDARD!.trim(),
    ...(inputUsdPerMToken !== undefined ? { inputUsdPerMToken } : {}),
    ...(outputUsdPerMToken !== undefined ? { outputUsdPerMToken } : {}),
    ...(dailyBudgetUsd !== undefined ? { dailyBudgetUsd } : {}),
    ...(caseBudgetUsd !== undefined ? { caseBudgetUsd } : {}),
  };
}
