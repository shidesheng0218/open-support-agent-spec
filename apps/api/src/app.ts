import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import type { SupportAdapter } from "@osas/adapter";
import { InMemoryExecutionStore, InMemoryPolicyStore } from "@osas/policy-engine";
import {
  InMemoryUsageStore,
  MockModelProvider,
  ModelGateway,
  OpenAICompatibleProvider,
  type BudgetWarning,
  type UsageStore,
} from "@osas/model-gateway";
import { validateInline } from "@osas/schema-validator";
import {
  PostgresAuditStore,
  PostgresExecutionStore,
  PostgresPolicyStore,
  PostgresShadowRunStore,
  PostgresUsageStore,
  assertConnectable,
  createPool,
} from "@osas/store-postgres";
import {
  InMemoryShadowRunStore,
  loadExecutionMode,
  type ExecutionModeConfig,
  type ShadowRunStore,
} from "@osas/ecommerce-shadow";
import { createSeededAdapter } from "./seed.js";
import { SYSTEM_PRINCIPAL, loggerOptions, registerPlugins } from "./plugins.js";
import { createAuthHook, loadAuthConfig, type AuthConfig } from "./auth.js";
import {
  loadLlmConfig,
  loadStorageConfig,
  type LlmConfig,
  type StorageConfig,
} from "./config.js";
import { registerRoutes } from "./routes/index.js";

export interface BuildAppOptions {
  adapter?: SupportAdapter;
  logger?: boolean;
  // Defaults to <repo>/tests/compat/report/latest.json; overridable for tests
  // and deployments that generate the report elsewhere.
  compatReportPath?: string;
  /** Explicit auth config (tests). Defaults to loadAuthConfig(env). */
  auth?: AuthConfig;
  /** Explicit storage/LLM wiring (tests). Default: derived from env. */
  storage?: StorageConfig;
  llm?: LlmConfig;
  gateway?: ModelGateway;
  usageStore?: UsageStore;
  /** Explicit execution mode (tests). Default: loadExecutionMode(env) — fails closed on "live". */
  executionMode?: ExecutionModeConfig;
  /** Explicit ShadowRun store (tests). Default: memory or Postgres by storage mode. */
  shadowRunStore?: ShadowRunStore;
  /** Env override for config loading (tests); defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

const utcDayStart = (): string => `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;

/**
 * Audit-backed budget warning handler (Milestone 2): at 80% of a budget cap a
 * budget_warning event lands on the tenant's audit stream. Exported so tests
 * and embedders can attach it to a custom ModelGateway.
 */
export function createBudgetWarningAuditor(
  adapter: SupportAdapter,
  log: { warn(obj: unknown, msg: string): void },
): (warning: BudgetWarning) => void {
  return (warning) => {
    // Fire-and-forget audit warning (never blocks the request path).
    const tenantId = warning.tenantId ?? "tenant_demo";
    adapter
      .appendAuditEvent(
        { tenantId, principal: SYSTEM_PRINCIPAL },
        {
          tenantId,
          ...(warning.caseId ? { caseId: warning.caseId } : {}),
          eventType: "budget_warning",
          actorType: "system",
          actorId: "osas-api",
          detail: {
            scope: warning.scope,
            spentUsd: warning.spentUsd,
            capUsd: warning.capUsd,
          },
        },
      )
      .catch((err) => log.warn(err, "failed to record budget warning"));
  };
}

export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const env = opts.env ?? process.env;
  // Fail closed: unsafe auth/storage/LLM combinations abort startup here.
  const auth = opts.auth ?? loadAuthConfig(env);
  const storage = opts.storage ?? loadStorageConfig(env);
  const llm = opts.llm ?? loadLlmConfig(env);
  // v0.1.1: OSAS_EXECUTION_MODE — only "shadow" exists; "live" aborts startup
  // with LIVE_EXECUTION_NOT_AVAILABLE_IN_V0_1_1.
  const executionMode = opts.executionMode ?? loadExecutionMode(env);
  const adapter = opts.adapter ?? createSeededAdapter();
  const app = Fastify({ logger: opts.logger === false ? false : loggerOptions });
  await app.register(cors, { origin: true });
  app.decorate("adapter", adapter);
  app.decorate("executionMode", executionMode);

  let shadowRunStore: ShadowRunStore = opts.shadowRunStore ?? new InMemoryShadowRunStore();
  let usageStore: UsageStore = opts.usageStore ?? new InMemoryUsageStore();
  if (storage.mode === "postgres") {
    // Startup must connect — fail closed otherwise.
    const pool = createPool(storage.databaseUrl!);
    await assertConnectable(pool);
    app.decorate("executionStore", new PostgresExecutionStore(pool));
    app.decorate("policyStore", new PostgresPolicyStore(pool));
    app.decorate("auditStore", new PostgresAuditStore(pool));
    app.decorate("pgPool", pool);
    if (!opts.usageStore) usageStore = new PostgresUsageStore(pool);
    if (!opts.shadowRunStore) shadowRunStore = new PostgresShadowRunStore(pool);
    app.addHook("onClose", async () => {
      await pool.end();
    });
  } else {
    app.decorate("executionStore", new InMemoryExecutionStore());
    app.decorate("policyStore", new InMemoryPolicyStore());
  }
  app.decorate("usageStore", usageStore);
  app.decorate("shadowRunStore", shadowRunStore);

  const onBudgetWarning = createBudgetWarningAuditor(adapter, app.log);

  const gateway =
    opts.gateway ??
    new ModelGateway(
      [
        llm.provider === "openai-compatible"
          ? new OpenAICompatibleProvider({
              baseUrl: llm.baseUrl!,
              ...(llm.apiKey ? { apiKey: llm.apiKey } : {}),
              modelFast: llm.modelFast!,
              modelStandard: llm.modelStandard!,
              ...(llm.inputUsdPerMToken !== undefined
                ? { inputUsdPerMToken: llm.inputUsdPerMToken }
                : {}),
              ...(llm.outputUsdPerMToken !== undefined
                ? { outputUsdPerMToken: llm.outputUsdPerMToken }
                : {}),
              validateOutput: (schema, data) => validateInline(schema, data).valid,
            })
          : new MockModelProvider(),
      ],
      {
        ...(llm.provider === "openai-compatible"
          ? { routing: { classify: "openai-compatible", standard: "openai-compatible" } }
          : {}),
        ...(llm.dailyBudgetUsd !== undefined ? { dailyBudgetUsd: llm.dailyBudgetUsd } : {}),
        ...(llm.caseBudgetUsd !== undefined ? { caseBudgetUsd: llm.caseBudgetUsd } : {}),
        onBudgetWarning,
      },
    );

  // Budgets survive restarts: seed today's measured spend from the store.
  const todayRecords = await usageStore.query({ from: utcDayStart() }).catch(() => []);
  const casesUsd: Record<string, number> = {};
  for (const r of todayRecords) {
    if (r.caseId && r.costUsd !== undefined) {
      casesUsd[r.caseId] = (casesUsd[r.caseId] ?? 0) + r.costUsd;
    }
  }
  gateway.primeBudgets({
    dailyUsd: todayRecords.reduce((sum, r) => sum + (r.costUsd ?? 0), 0),
    casesUsd,
  });

  app.decorate("gateway", gateway);
  app.decorate("compatReportPath", opts.compatReportPath);
  app.decorate("authConfig", auth);
  registerPlugins(app, createAuthHook(auth));
  await registerRoutes(app);
  return app;
}
