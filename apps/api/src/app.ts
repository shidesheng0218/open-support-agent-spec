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
  PostgresExecutionAttemptStore,
  PostgresExecutionReceiptStore,
  PostgresExecutionStore,
  PostgresPolicyStore,
  PostgresProviderEventStore,
  PostgresReconciliationStore,
  PostgresShadowRunStore,
  PostgresUsageStore,
  assertConnectable,
  createPool,
} from "@osas/store-postgres";
import {
  InMemoryExecutionAttemptStore,
  InMemoryExecutionReceiptStore,
  InMemoryProviderEventStore,
  InMemoryReconciliationStore,
  InMemoryShadowRunStore,
  loadExecutionMode,
  type ExecutionModeConfig,
  type ShadowRunStore,
} from "@osas/ecommerce-shadow";
import { createSandboxAdapter, createSeededAdapter } from "./seed.js";
import { SYSTEM_PRINCIPAL, loggerOptions, registerPlugins } from "./plugins.js";
import { createAuthHook, loadAuthConfig, type AuthConfig } from "./auth.js";
import {
  loadConformanceConfig,
  loadLlmConfig,
  loadProviderEventKey,
  loadStorageConfig,
  type ConformanceConfig,
  type LlmConfig,
  type StorageConfig,
} from "./config.js";
import { registerRoutes } from "./routes/index.js";
import { buildGovernance, loadGovernanceEventKey } from "./governance.js";
import type { GovernanceRuntime } from "@osas/governance";
import { buildSecurityPosture } from "./posture.js";
import { conformanceRoutes } from "./routes/conformance.js";
import { InMemoryAfterSalesStore } from "./routes/after-sales.js";

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
  /** Explicit conformance config (tests). Default: loadConformanceConfig(env) — fails closed in production. */
  conformance?: ConformanceConfig;
  /** Explicit ShadowRun store (tests). Default: memory or Postgres by storage mode. */
  shadowRunStore?: ShadowRunStore;
  /** Env override for config loading (tests); defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Explicit governance runtime (tests). Default: memory or Postgres wiring. */
  governance?: GovernanceRuntime;
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
  // v0.3 Draft: proposal_only/shadow/sandbox are non-live modes; live aborts
  // startup with LIVE_EXECUTION_NOT_AVAILABLE_IN_V0_1_1 (a historical stable
  // error-code name retained for compatibility).
  const executionMode = opts.executionMode ?? loadExecutionMode(env);
  // Milestone 4: conformance mode — enabled only via explicit env, never in
  // production, and only with a test-only key (loadConformanceConfig throws).
  const conformance = opts.conformance ?? loadConformanceConfig(env);
  const adapter =
    opts.adapter ?? (executionMode.mode === "sandbox" ? createSandboxAdapter() : createSeededAdapter());
  const app = Fastify({ logger: opts.logger === false ? false : loggerOptions });
  // Security posture summary: one structured line + one WARN per weak
  // combination. Observability only — the fail-closed loaders above already
  // enforced the hard rules. Never includes secrets (see posture.ts).
  const postureReport = buildSecurityPosture({ auth, storage, llm, executionMode, conformance, env });
  app.log.info({ posture: postureReport.posture }, "security posture summary");
  for (const warning of postureReport.warnings) app.log.warn(warning);
  await app.register(cors, { origin: true });
  app.decorate("adapter", adapter);
  app.decorate("executionMode", executionMode);
  // In-memory stores are the fallback ONLY when PostgreSQL does not supply
  // them. Fastify 5 refuses to re-decorate, so decorating here unconditionally
  // made "OSAS_STORAGE=postgres" fail at boot with
  // "The decorator 'executionAttemptStore' has already been added!" — the
  // unreachable-database tests never reached this line, so the successful
  // postgres path was the one that broke.
  if (storage.mode !== "postgres") {
    app.decorate("executionAttemptStore", new InMemoryExecutionAttemptStore());
    app.decorate("executionReceiptStore", new InMemoryExecutionReceiptStore());
    app.decorate("reconciliationStore", new InMemoryReconciliationStore());
    app.decorate("providerEventStore", new InMemoryProviderEventStore());
  }
  app.decorate("providerEventKey", loadProviderEventKey(env));
  app.decorate("afterSalesStore", new InMemoryAfterSalesStore());

  let shadowRunStore: ShadowRunStore = opts.shadowRunStore ?? new InMemoryShadowRunStore();
  let usageStore: UsageStore = opts.usageStore ?? new InMemoryUsageStore();
  if (storage.mode === "postgres") {
    // Startup must connect — fail closed otherwise.
    const pool = createPool(storage.databaseUrl!);
    await assertConnectable(pool);
    app.decorate("executionStore", new PostgresExecutionStore(pool));
    app.decorate("executionAttemptStore", new PostgresExecutionAttemptStore(pool));
    app.decorate("executionReceiptStore", new PostgresExecutionReceiptStore(pool));
    app.decorate("reconciliationStore", new PostgresReconciliationStore(pool));
    app.decorate("providerEventStore", new PostgresProviderEventStore(pool));
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

  // M1 governance control plane. Provider-neutral: the only extension point is
  // an injected job handler, and nothing here knows about a specific vendor.
  if (opts.governance) {
    app.decorate("governance", opts.governance);
    app.decorate("governanceEventKey", loadGovernanceEventKey(env));
  } else {
    const governance = buildGovernance({
      ...(app.pgPool ? { pool: app.pgPool } : {}),
      storage,
      env,
    });
    app.decorate("governance", governance.runtime);
    app.decorate("governanceEventKey", governance.eventKey);
    app.log.info(
      {
        consumer: governance.consumer,
        eventIngest: governance.eventKey ? "enabled" : "disabled",
        storage: storage.mode,
      },
      "governance control plane ready",
    );
  }

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
  app.decorate("conformanceConfig", conformance);
  registerPlugins(app, createAuthHook(auth));
  await registerRoutes(app);
  // Conformance endpoints exist only in conformance mode (never in production).
  if (conformance.enabled) {
    await app.register(conformanceRoutes);
  }
  return app;
}
