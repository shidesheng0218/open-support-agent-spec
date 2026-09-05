import { detectInjection } from "@osas/core";
import { BudgetExceededError } from "./errors.js";
import {
  TASK_OUTPUT_CAPS,
  TASK_TIER,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type ModelTelemetry,
  type ModelTier,
} from "./types.js";

export interface BudgetWarning {
  scope: "daily" | "case" | "total";
  tenantId?: string;
  caseId?: string;
  spentUsd: number;
  capUsd: number;
}

export interface ModelGatewayOptions {
  /** tier → preferred provider name (default: all tiers → "mock-local"). */
  routing?: Partial<Record<ModelTier, string>>;
  /** Cumulative spend cap in USD; exceeding it throws BudgetExceededError. */
  budgetUsdCap?: number;
  /** Milestone 2: daily and per-case spend caps (USD, measured spend only). */
  dailyBudgetUsd?: number;
  caseBudgetUsd?: number;
  /** Fired once per scope when spend crosses 80% of a cap. */
  onBudgetWarning?: (warning: BudgetWarning) => void;
  onTelemetry?: (t: ModelTelemetry & { rejectedInjection?: boolean }) => void;
}

/** ~4 chars per token, per §8's mock convention. */
const CHARS_PER_TOKEN = 4;
const WARN_FRACTION = 0.8;

const utcDay = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * CONTRACTS.md §8 — routes requests task → tier → provider, enforces
 * per-task output caps (setting `truncated`), tracks cumulative/daily/per-case
 * budgets (measured spend only — unknown costs never count), flags suspected
 * prompt injection on telemetry.
 *
 * Budgets are enforced BEFORE calling the provider: once a scope's measured
 * spend reaches its cap, further calls in that scope throw
 * BudgetExceededError without touching the network. At 80% of a cap,
 * onBudgetWarning fires exactly once per scope and day.
 *
 * The gateway never silently swaps in a more expensive model: the tier's
 * configured provider is used, or the request fails. (Cross-provider fallback
 * only applies when several providers are explicitly registered for a tier;
 * production wiring registers exactly one.)
 */
export class ModelGateway {
  private readonly providers: ModelProvider[];
  private readonly routing: Partial<Record<ModelTier, string>>;
  private readonly budgetUsdCap?: number;
  private readonly dailyBudgetUsd?: number;
  private readonly caseBudgetUsd?: number;
  private readonly onBudgetWarning?: ModelGatewayOptions["onBudgetWarning"];
  private readonly onTelemetry?: ModelGatewayOptions["onTelemetry"];
  private spentUsd = 0;
  private day = utcDay(new Date());
  private dailySpentUsd = 0;
  private readonly caseSpentUsd = new Map<string, number>();
  private readonly warned = new Set<string>();

  constructor(providers: ModelProvider[], opts: ModelGatewayOptions = {}) {
    if (providers.length === 0) {
      throw new Error("ModelGateway requires at least one provider");
    }
    this.providers = [...providers];
    this.routing = opts.routing ?? {};
    if (opts.budgetUsdCap !== undefined) {
      this.budgetUsdCap = opts.budgetUsdCap;
    }
    if (opts.dailyBudgetUsd !== undefined) {
      this.dailyBudgetUsd = opts.dailyBudgetUsd;
    }
    if (opts.caseBudgetUsd !== undefined) {
      this.caseBudgetUsd = opts.caseBudgetUsd;
    }
    if (opts.onBudgetWarning !== undefined) {
      this.onBudgetWarning = opts.onBudgetWarning;
    }
    if (opts.onTelemetry !== undefined) {
      this.onTelemetry = opts.onTelemetry;
    }
  }

  get cumulativeCostUsd(): number {
    return this.spentUsd;
  }

  get todayCostUsd(): number {
    this.rollDay();
    return this.dailySpentUsd;
  }

  private rollDay(): void {
    const today = utcDay(new Date());
    if (today !== this.day) {
      this.day = today;
      this.dailySpentUsd = 0;
      for (const key of [...this.warned]) {
        if (key.startsWith("daily:")) this.warned.delete(key);
      }
    }
  }

  /**
   * Seed budget counters from a persisted UsageStore at boot so restarts do
   * not reset measured spend.
   */
  primeBudgets(input: { dailyUsd?: number; casesUsd?: Record<string, number> }): void {
    this.rollDay();
    if (input.dailyUsd !== undefined) this.dailySpentUsd = input.dailyUsd;
    if (input.casesUsd) {
      for (const [caseId, usd] of Object.entries(input.casesUsd)) {
        this.caseSpentUsd.set(caseId, usd);
      }
    }
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

  private checkBudgets(caseId?: string): void {
    this.rollDay();
    if (this.dailyBudgetUsd !== undefined && this.dailySpentUsd >= this.dailyBudgetUsd) {
      throw new BudgetExceededError(this.dailySpentUsd, this.dailyBudgetUsd);
    }
    if (caseId !== undefined && this.caseBudgetUsd !== undefined) {
      const spent = this.caseSpentUsd.get(caseId) ?? 0;
      if (spent >= this.caseBudgetUsd) {
        throw new BudgetExceededError(spent, this.caseBudgetUsd);
      }
    }
  }

  private maybeWarn(
    scope: BudgetWarning["scope"],
    spent: number,
    cap: number,
    caseId?: string,
    tenantId?: string,
  ): void {
    if (!this.onBudgetWarning || spent < cap * WARN_FRACTION || spent >= cap) return;
    const key =
      scope === "daily" ? `daily:${this.day}` : scope === "case" ? `case:${caseId}` : "total";
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.onBudgetWarning({
      scope,
      spentUsd: spent,
      capUsd: cap,
      ...(tenantId ? { tenantId } : {}),
      ...(caseId ? { caseId } : {}),
    });
  }

  private accountSpend(costUsd: number | undefined, caseId?: string, tenantId?: string): void {
    if (costUsd === undefined) return; // unknown cost: recorded, never fabricated
    this.spentUsd += costUsd;
    this.dailySpentUsd += costUsd;
    if (caseId !== undefined) {
      this.caseSpentUsd.set(caseId, (this.caseSpentUsd.get(caseId) ?? 0) + costUsd);
    }
    if (this.dailyBudgetUsd !== undefined) {
      this.maybeWarn("daily", this.dailySpentUsd, this.dailyBudgetUsd, undefined, tenantId);
    }
    if (caseId !== undefined && this.caseBudgetUsd !== undefined) {
      this.maybeWarn("case", this.caseSpentUsd.get(caseId) ?? 0, this.caseBudgetUsd, caseId, tenantId);
    }
    if (this.budgetUsdCap !== undefined) {
      this.maybeWarn("total", this.spentUsd, this.budgetUsdCap, undefined, tenantId);
    }
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    const rejectedInjection = req.messages.some(
      (m) => m.role === "user" && detectInjection(m.content),
    );

    // Block BEFORE spending: a scope at/over its cap never reaches a provider.
    this.checkBudgets(req.caseId);

    // Fixed task → tier routing (Milestone 2); req.tier is not honored when
    // it disagrees, so callers cannot steer work onto pricier tiers.
    const tier = TASK_TIER[req.task];
    const provider = this.resolveProvider(tier);

    const cap = TASK_OUTPUT_CAPS[req.task];
    const effectiveMaxTokens = Math.min(req.maxOutputTokens ?? cap, cap);
    const response = await provider.complete({
      ...req,
      tier,
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
      tier,
      truncated,
    };

    // Legacy cumulative cap: a call that would push spend past the cap is
    // rejected without committing its cost.
    if (
      this.budgetUsdCap !== undefined &&
      telemetry.costUsd !== undefined &&
      this.spentUsd + telemetry.costUsd > this.budgetUsdCap
    ) {
      this.onTelemetry?.({ ...telemetry, rejectedInjection });
      throw new BudgetExceededError(this.spentUsd + telemetry.costUsd, this.budgetUsdCap);
    }

    this.accountSpend(telemetry.costUsd, req.caseId, req.tenantId);

    this.onTelemetry?.({ ...telemetry, rejectedInjection });

    // A truncated body can no longer be trusted as parseable JSON.
    const parsed = truncated ? undefined : response.parsed;
    return { text, telemetry, ...(parsed !== undefined ? { parsed } : {}) };
  }
}
