/** CONTRACTS.md §8 — model gateway types. */

export type ModelTier = "classify" | "standard" | "reasoning";

export type ModelTask = "classify" | "extract" | "reply" | "propose";

export interface ModelMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ModelRequest {
  tier: ModelTier;
  task: ModelTask;
  messages: ModelMessage[];
  outputSchema?: Record<string, unknown>;
  maxOutputTokens?: number;
  /** Case scope for per-case budget accounting; never sent to providers. */
  caseId?: string;
  /** Tenant scope for usage accounting/warnings; never sent to providers. */
  tenantId?: string;
}

export interface ModelTelemetry {
  provider: string;
  model: string;
  tier: ModelTier;
  task: ModelTask;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  /** USD cost. Undefined = unknown (no price configured) — never fabricated. */
  costUsd?: number;
  truncated: boolean;
}

export interface ModelResponse {
  text: string;
  parsed?: unknown;
  telemetry: ModelTelemetry;
}

export interface ModelProvider {
  name: string;
  supports(tier: ModelTier): boolean;
  complete(req: ModelRequest): Promise<ModelResponse>;
}

/** §8: per-task output caps enforced by the gateway (1 token ≈ 4 chars). */
export const TASK_OUTPUT_CAPS: Readonly<Record<ModelTask, number>> = {
  classify: 256,
  extract: 512,
  reply: 1024,
  propose: 1024,
};

/**
 * Milestone 2: fixed task → tier routing. classify/extract use the fast tier
 * ("classify"), reply/propose the standard tier. Callers may still pass
 * `req.tier`, but the gateway routes by task — there is no way for a caller
 * to steer a task onto a more expensive tier. High-risk action decisions are
 * always made by the policy engine; the model never participates in them.
 */
export const TASK_TIER: Readonly<Record<ModelTask, ModelTier>> = {
  classify: "classify",
  extract: "classify",
  reply: "standard",
  propose: "standard",
};
