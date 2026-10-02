import { describe, expect, it } from "vitest";
import { buildSecurityPosture } from "./posture.js";
import type { AuthConfig } from "./auth.js";
import type { ConformanceConfig, LlmConfig, StorageConfig } from "./config.js";

const jwtAuth: AuthConfig = {
  mode: "jwt",
  nodeEnv: "production",
  jwksUrl: "https://idp.example.com/.well-known/jwks.json",
  jwtIssuer: "https://idp.example.com/",
  jwtAudience: "osas-api",
};
const demoAuth: AuthConfig = { mode: "demo", nodeEnv: "development" };
const pgStorage: StorageConfig = { mode: "postgres", databaseUrl: "postgres://x" };
const memStorage: StorageConfig = { mode: "memory" };
const prodLlm: LlmConfig = {
  provider: "openai-compatible",
  baseUrl: "https://llm.example.com/v1",
  apiKey: "CANARY-SECRET-never-logged",
  modelFast: "fast-model",
  modelStandard: "std-model",
  inputUsdPerMToken: 0.15,
  outputUsdPerMToken: 0.6,
  dailyBudgetUsd: 10,
  caseBudgetUsd: 0.5,
};
const mockLlm: LlmConfig = { provider: "mock" };
const conformanceOff: ConformanceConfig = { enabled: false };
const conformanceOn: ConformanceConfig = { enabled: true, key: "test-only-key" };
const shadow = { mode: "shadow" };

describe("buildSecurityPosture", () => {
  it("reports a clean stage-3 posture with no warnings", () => {
    const { posture, warnings } = buildSecurityPosture({
      auth: jwtAuth,
      storage: pgStorage,
      llm: prodLlm,
      executionMode: shadow,
      conformance: conformanceOff,
      env: { NODE_ENV: "production" },
    });
    expect(posture).toEqual({
      authMode: "jwt",
      storage: "postgres",
      executionMode: "shadow",
      conformanceMode: "off",
      llmProvider: "openai-compatible",
      llmBudgets: "set",
      llmPricing: "set",
      nodeEnv: "production",
    });
    expect(warnings).toEqual([]);
  });

  it("flags the demo defaults a developer would see locally", () => {
    const { posture, warnings } = buildSecurityPosture({
      auth: demoAuth,
      storage: memStorage,
      llm: mockLlm,
      executionMode: shadow,
      conformance: conformanceOff,
      env: { NODE_ENV: "development" },
    });
    expect(posture.authMode).toBe("demo");
    expect(posture.llmPricing).toBe("n/a");
    expect(warnings.join("\n")).toMatch(/auth=demo/);
    expect(warnings.join("\n")).toMatch(/storage=memory/);
    expect(warnings.join("\n")).toMatch(/budgets unset/);
    // mock provider outside production is the intended default — no warning.
    expect(warnings.join("\n")).not.toMatch(/llm=mock/);
  });

  it("flags the mock provider under production", () => {
    const { warnings } = buildSecurityPosture({
      auth: jwtAuth,
      storage: pgStorage,
      llm: mockLlm,
      executionMode: shadow,
      conformance: conformanceOff,
      env: { NODE_ENV: "production" },
    });
    expect(warnings.join("\n")).toMatch(/llm=mock under NODE_ENV=production/);
  });

  it("flags conformance mode and missing LLM pricing", () => {
    const noPricing: LlmConfig = { ...prodLlm };
    delete (noPricing as Partial<LlmConfig>).inputUsdPerMToken;
    delete (noPricing as Partial<LlmConfig>).outputUsdPerMToken;
    const { posture, warnings } = buildSecurityPosture({
      auth: jwtAuth,
      storage: pgStorage,
      llm: noPricing,
      executionMode: shadow,
      conformance: conformanceOn,
      env: { NODE_ENV: "development" },
    });
    expect(posture.conformanceMode).toBe("on");
    expect(posture.llmPricing).toBe("unset");
    expect(warnings.join("\n")).toMatch(/conformance=on/);
    expect(warnings.join("\n")).toMatch(/pricing unset/);
  });

  it("never leaks secrets into the summary or the warnings", () => {
    const report = buildSecurityPosture({
      auth: jwtAuth,
      storage: pgStorage,
      llm: prodLlm,
      executionMode: shadow,
      conformance: conformanceOn,
      env: { NODE_ENV: "development" },
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("CANARY-SECRET-never-logged");
    expect(serialized).not.toContain("test-only-key");
    expect(serialized).not.toContain("postgres://x");
  });
});
