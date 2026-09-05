import { detectInjection } from "@osas/core";
import { BudgetExceededError } from "./errors.js";
import {
  TASK_OUTPUT_CAPS,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type ModelTelemetry,
  type ModelTier,
} from "./types.js";

export interface ModelGatewayOptions {
  /** tier → preferred provider name (default: all tiers → "mock-local"). */
  routing?: Partial<Record<ModelTier, string>>;
  /** Cumulative spend cap in USD; exceeding it throws BudgetExceededError. */
  budgetUsdCap?: number;
  onTelemetry?: (t: ModelTelemetry & { rejectedInjection?: boolean }) => void;
}

/** ~4 chars per token, per §8's mock convention. */
const CHARS_PER_TOKEN = 4;

/**
 * CONTRACTS.md §8 — routes requests tier → provider with fallback, enforces
 * per-task output caps (setting `truncated`), tracks a cumulative budget,
 * flags suspected prompt injection on telemetry.
 */
export class ModelGateway {
  private readonly providers: ModelProvider[];
  private readonly routing: Partial<Record<ModelTier, string>>;
  private readonly budgetUsdCap?: number;
  private readonly onTelemetry?: ModelGatewayOptions["onTelemetry"];
  private spentUsd = 0;

  constructor(providers: ModelProvider[], opts: ModelGatewayOptions = {}) {
    if (providers.length === 0) {
      throw new Error("ModelGateway requires at least one provider");
    }
    this.providers = [...providers];
    this.routing = opts.routing ?? {};
    if (opts.budgetUsdCap !== undefined) {
      this.budgetUsdCap = opts.budgetUsdCap;
    }
    if (opts.onTelemetry !== undefined) {
      this.onTelemetry = opts.onTelemetry;
    }
  }

  get cumulativeCostUsd(): number {
    return this.spentUsd;
  }

  private resolveProvider(tier: ModelTier): ModelProvider {
    const preferredName = this.routing[tier] ?? "mock-local";
    const preferred = this.providers.find(
      (p) => p.name === preferredName && p.supports(tier),
    );
    if (preferred) return preferred;
    // Degrade to the first provider that supports the tier.
    const fallback = this.providers.find((p) => p.supports(tier));
    if (!fallback) {
      throw new Error(`no provider supports tier '${tier}'`);
    }
    return fallback;
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    const rejectedInjection = req.messages.some(
      (m) => m.role === "user" && detectInjection(m.content),
    );

    const provider = this.resolveProvider(req.tier);

    const cap = TASK_OUTPUT_CAPS[req.task];
    const effectiveMaxTokens = Math.min(req.maxOutputTokens ?? cap, cap);
    const response = await provider.complete({
      ...req,
      maxOutputTokens: effectiveMaxTokens,
    });

    let text = response.text;
    let truncated = response.telemetry.truncated;
    const maxChars = effectiveMaxTokens * CHARS_PER_TOKEN;
    if (text.length > maxChars) {
      text = text.slice(0, maxChars);
      truncated = true;
    }

    const telemetry: ModelTelemetry = {
      ...response.telemetry,
      provider: provider.name,
      truncated,
    };

    const nextSpent = this.spentUsd + telemetry.costUsd;
    if (
      this.budgetUsdCap !== undefined &&
      nextSpent > this.budgetUsdCap
    ) {
      this.onTelemetry?.({ ...telemetry, rejectedInjection });
      throw new BudgetExceededError(nextSpent, this.budgetUsdCap);
    }
    this.spentUsd = nextSpent;

    this.onTelemetry?.({ ...telemetry, rejectedInjection });

    // A truncated body can no longer be trusted as parseable JSON.
    const parsed = truncated ? undefined : response.parsed;
    return { text, telemetry, ...(parsed !== undefined ? { parsed } : {}) };
  }
}
