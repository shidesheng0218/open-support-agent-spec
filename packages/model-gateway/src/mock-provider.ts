import { stableHash, stableHashHex } from "./hash.js";
import type {
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelTier,
} from "./types.js";

type Scenario = "refund" | "credit_apply" | "subscription_cancel" | "none";

const SCENARIO_CATEGORY: Readonly<Record<Scenario, string>> = {
  refund: "refund_request",
  credit_apply: "credit_request",
  subscription_cancel: "cancellation_request",
  none: "general_inquiry",
};

function detectScenario(text: string): Scenario {
  if (/refund|退款/i.test(text)) return "refund";
  // "cancel" is checked before "credit": cancellation requests frequently
  // reference subscription/credit case ids (e.g. case_credit).
  if (/cancel|取消/i.test(text)) return "subscription_cancel";
  if (/credit|额度/i.test(text)) return "credit_apply";
  return "none";
}

function firstMatch(re: RegExp, text: string): string | undefined {
  return re.exec(text)?.[0];
}

/** `$<n>` → minorUnits (integer cents); default 2500 USD per §8. */
function parseAmount(text: string): { currency: string; minorUnits: number } {
  const m = /\$(\d+(?:\.\d+)?)/.exec(text);
  if (!m || m[1] === undefined) return { currency: "USD", minorUnits: 2500 };
  return { currency: "USD", minorUnits: Math.round(parseFloat(m[1]) * 100) };
}

function buildProposal(scenario: Exclude<Scenario, "none">, text: string) {
  const caseId = firstMatch(/case_\w+/, text) ?? "case_unknown";
  let profile: string;
  let actionType: string;
  let reasonCode: string;
  let params: Record<string, unknown>;
  let amount: { currency: string; minorUnits: number } | undefined;

  switch (scenario) {
    case "refund":
      profile = "ecommerce";
      actionType = "refund";
      reasonCode = "other";
      params = {
        orderId: firstMatch(/ord_\w+/, text) ?? "ord_unknown",
        reason: "customer_request",
      };
      amount = parseAmount(text);
      break;
    case "credit_apply":
      profile = "saas";
      actionType = "credit_apply";
      reasonCode = "goodwill";
      params = {
        customerId: firstMatch(/cus_\w+/, text) ?? "cus_unknown",
        reason: "customer_request",
      };
      amount = parseAmount(text);
      break;
    case "subscription_cancel":
      profile = "saas";
      actionType = "subscription_cancel";
      reasonCode = "other";
      params = {
        subscriptionId: firstMatch(/sub_\w+/, text) ?? "sub_unknown",
      };
      amount = undefined;
      break;
  }

  const idempotencyKey = `idem_mock_${stableHashHex(
    `${caseId}|${actionType}|${JSON.stringify(params)}`,
  )}`;

  return {
    tenantId: "tenant_demo",
    caseId,
    profile,
    actionType,
    reasonCode,
    params,
    requestedPermission: "request-approval",
    requestedBy: {
      actorType: "model",
      actorId: "mock-local",
      model: { provider: "mock-local", model: "mock-local" },
    },
    ...(amount ? { amount } : {}),
    evidenceIds: [] as string[],
    idempotencyKey,
  };
}

/**
 * CONTRACTS.md §8 — deterministic, network-free mock provider.
 * Same input always produces the same output; pseudo inputTokens /
 * outputTokens / latencyMs / costUsd (≈0) derive from a stable string hash.
 */
export class MockModelProvider implements ModelProvider {
  readonly name = "mock-local";
  readonly model = "mock-local-v0";

  supports(_tier: ModelTier): boolean {
    return true;
  }

  complete(req: ModelRequest): Promise<ModelResponse> {
    const userText = req.messages
      .filter((m) => m.role === "user")
      .map((m) => m.content)
      .join("\n");
    const allText = req.messages.map((m) => m.content).join("\n");
    const scenario = detectScenario(userText);

    let text: string;
    switch (req.task) {
      case "classify":
        text = SCENARIO_CATEGORY[scenario];
        break;
      case "extract":
        text = JSON.stringify({
          caseId: firstMatch(/case_\w+/, allText) ?? null,
          orderId: firstMatch(/ord_\w+/, allText) ?? null,
          subscriptionId: firstMatch(/sub_\w+/, allText) ?? null,
          customerId: firstMatch(/cus_\w+/, allText) ?? null,
        });
        break;
      case "propose":
        text =
          scenario === "none"
            ? this.replyText(userText)
            : JSON.stringify(buildProposal(scenario, allText), null, 2);
        break;
      case "reply":
        text = this.replyText(userText);
        break;
    }

    const seedSource = `${req.tier}|${req.task}|${allText}`;
    const inputTokens = Math.max(1, Math.ceil(allText.length / 4));
    const outputTokens = Math.max(1, Math.ceil(text.length / 4));
    const latencyMs = 5 + (stableHash(seedSource) % 45);
    const costUsd = (inputTokens + outputTokens) * 1e-7; // ≈ 0

    const response: ModelResponse = {
      text,
      telemetry: {
        provider: this.name,
        model: this.model,
        tier: req.tier,
        task: req.task,
        inputTokens,
        outputTokens,
        latencyMs,
        costUsd,
        truncated: false,
      },
    };

    const trimmed = text.trimStart();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        response.parsed = JSON.parse(text);
      } catch {
        // not parseable — leave parsed undefined
      }
    }

    return Promise.resolve(response);
  }

  private replyText(userText: string): string {
    const caseId = firstMatch(/case_\w+/, userText);
    const tag = stableHashHex(userText).slice(0, 6);
    return (
      `Thanks for reaching out${caseId ? ` about ${caseId}` : ""}. ` +
      `I've reviewed your request and a support specialist will follow up shortly. ` +
      `(ref ${tag})`
    );
  }
}
