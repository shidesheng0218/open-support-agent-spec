import type { ActionProposal, ExecutionResult } from "@osas/core";
import { MockSupportAdapter } from "./mock-adapter.js";
import type { DemoFixtures } from "./fixtures.js";
import type { ToolContext } from "@osas/adapter";

/**
 * Deterministic v0.3 Sandbox adapter. It uses synthetic fixtures only and
 * never reaches a network or a real commerce provider.
 */
export class SandboxSupportAdapter extends MockSupportAdapter {
  constructor(fixtures?: DemoFixtures) {
    super(fixtures);
  }

  override async executeAction(
    ctx: ToolContext,
    proposal: ActionProposal,
  ): Promise<ExecutionResult> {
    const simulate = (proposal.params ?? {}).simulate;
    if (simulate === "failure") {
      return {
        status: "failed",
        providerStatus: "sandbox_failed",
        safeToRetry: false,
        detail: "sandbox failure requested by proposal.params.simulate",
      };
    }
    const result = await super.executeAction(ctx, proposal);
    if (result.status === "succeeded") {
      return {
        ...result,
        externalRef: result.externalRef?.replace(/^rfnd_ext_/, "sandbox_refund_") ?? result.externalRef,
        providerStatus: "sandbox_succeeded",
        safeToRetry: false,
      };
    }
    if (result.status === "uncertain") {
      return { ...result, providerStatus: "sandbox_unknown", safeToRetry: false };
    }
    return { ...result, providerStatus: "sandbox_failed", safeToRetry: false };
  }
}
