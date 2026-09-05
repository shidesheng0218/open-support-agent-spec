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
}

export interface ModelTelemetry {
  provider: string;
  model: string;
  tier: ModelTier;
  task: ModelTask;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  costUsd: number;
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
