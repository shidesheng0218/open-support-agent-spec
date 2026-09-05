import { describe, expect, it, vi } from "vitest";
import {
  OpenAICompatibleProvider,
  ProviderHttpError,
  ProviderResponseError,
  ProviderTimeoutError,
  StructuredOutputError,
  type OpenAICompatibleConfig,
} from "./openai-compatible.js";
import type { ModelRequest } from "./types.js";

function config(over: Partial<OpenAICompatibleConfig> = {}): OpenAICompatibleConfig {
  return {
    baseUrl: "https://llm.test/v1",
    apiKey: "sk-test-secret",
    modelFast: "fast-1",
    modelStandard: "standard-1",
    ...over,
  };
}

function request(over: Partial<ModelRequest> = {}): ModelRequest {
  return {
    tier: "classify",
    task: "classify",
    messages: [{ role: "user", content: "hello case_1" }],
    ...over,
  };
}

function chatResponse(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    choices: [
      { message: { role: "assistant", content: "refund_request" }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 10 },
    ...over,
  };
}

function okJson(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("OpenAICompatibleProvider", () => {
  it("calls {baseUrl}/chat/completions with a bearer key and tier-mapped model", async () => {
    const fetchFn = vi.fn(async () => okJson(chatResponse()));
    const p = new OpenAICompatibleProvider(config({ fetchFn: fetchFn as unknown as typeof fetch }));
    const res = await p.complete(request());
    expect(res.text).toBe("refund_request");
    expect(res.telemetry.model).toBe("fast-1"); // classify task -> fast model
    expect(res.telemetry.inputTokens).toBe(100);
    expect(res.telemetry.outputTokens).toBe(10);

    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://llm.test/v1/chat/completions");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-test-secret");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("fast-1");
  });

  it("standard tasks use the standard model", async () => {
    const fetchFn = vi.fn(async () => okJson(chatResponse()));
    const p = new OpenAICompatibleProvider(config({ fetchFn: fetchFn as unknown as typeof fetch }));
    const res = await p.complete(request({ tier: "standard", task: "propose" }));
    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string).model).toBe("standard-1");
    expect(res.telemetry.provider).toBe("openai-compatible");
  });

  it("computes cost only when prices are configured", async () => {
    const fetchFn = vi.fn(async () => okJson(chatResponse()));
    const priced = new OpenAICompatibleProvider(
      config({
        fetchFn: fetchFn as unknown as typeof fetch,
        inputUsdPerMToken: 1,
        outputUsdPerMToken: 2,
      }),
    );
    const res = await priced.complete(request());
    // 100 input * $1/M + 10 output * $2/M = 0.0001 + 0.00002
    expect(res.telemetry.costUsd).toBeCloseTo(0.00012, 8);

    const unpriced = new OpenAICompatibleProvider(
      config({ fetchFn: fetchFn as unknown as typeof fetch }),
    );
    const unknown = await unpriced.complete(request());
    // No fake cost: tokens + provider/model recorded, cost unknown.
    expect(unknown.telemetry.costUsd).toBeUndefined();
    expect(unknown.telemetry.inputTokens).toBe(100);
  });

  it("surfaces 429 as ProviderHttpError with the status", async () => {
    const fetchFn = vi.fn(async () => new Response("rate limited", { status: 429 }));
    const p = new OpenAICompatibleProvider(config({ fetchFn: fetchFn as unknown as typeof fetch }));
    await expect(p.complete(request())).rejects.toSatisfy(
      (e) => e instanceof ProviderHttpError && e.status === 429,
    );
  });

  it("surfaces timeouts as ProviderTimeoutError", async () => {
    const fetchFn = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("The operation timed out", "TimeoutError")),
          );
        }),
    );
    const p = new OpenAICompatibleProvider(
      config({ fetchFn: fetchFn as unknown as typeof fetch, timeoutMs: 5 }),
    );
    await expect(p.complete(request())).rejects.toBeInstanceOf(ProviderTimeoutError);
  });

  it("surfaces non-JSON responses as ProviderResponseError", async () => {
    const fetchFn = vi.fn(async () => new Response("<html>oops</html>", { status: 200 }));
    const p = new OpenAICompatibleProvider(config({ fetchFn: fetchFn as unknown as typeof fetch }));
    await expect(p.complete(request())).rejects.toBeInstanceOf(ProviderResponseError);
  });

  it("requests structured output and retries once without it on HTTP 400", async () => {
    const schema = { type: "object", properties: { category: { type: "string" } } };
    const fetchFn = vi
      .fn()
      .mockImplementationOnce(async () => new Response("unsupported", { status: 400 }))
      .mockImplementationOnce(async () =>
        okJson(chatResponse({
          choices: [
            { message: { role: "assistant", content: '{"category":"refund"}' }, finish_reason: "stop" },
          ],
        })),
      );
    const p = new OpenAICompatibleProvider(config({ fetchFn: fetchFn as unknown as typeof fetch }));
    const res = await p.complete(request({ outputSchema: schema }));
    expect(res.parsed).toEqual({ category: "refund" });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const first = JSON.parse((fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    const second = JSON.parse((fetchFn.mock.calls[1] as unknown as [string, RequestInit])[1].body as string);
    expect(first.response_format?.type).toBe("json_schema");
    expect(second.response_format).toBeUndefined();
  });

  it("fails structured output when the body is not JSON (after the retry)", async () => {
    const schema = { type: "object" };
    const fetchFn = vi.fn(async () =>
      okJson(chatResponse({
        choices: [
          { message: { role: "assistant", content: "not json at all" }, finish_reason: "stop" },
        ],
      })),
    );
    const p = new OpenAICompatibleProvider(config({ fetchFn: fetchFn as unknown as typeof fetch }));
    await expect(p.complete(request({ outputSchema: schema }))).rejects.toBeInstanceOf(
      StructuredOutputError,
    );
  });

  it("validates structured output against the schema validator seam", async () => {
    const schema = { type: "object" };
    const fetchFn = vi.fn(async () =>
      okJson(chatResponse({
        choices: [
          { message: { role: "assistant", content: '{"wrong":true}' }, finish_reason: "stop" },
        ],
      })),
    );
    const p = new OpenAICompatibleProvider(
      config({
        fetchFn: fetchFn as unknown as typeof fetch,
        validateOutput: () => false,
      }),
    );
    await expect(p.complete(request({ outputSchema: schema }))).rejects.toBeInstanceOf(
      StructuredOutputError,
    );
  });

  it("never includes the api key in thrown errors", async () => {
    const fetchFn = vi.fn(async () => new Response("bad key sk-test-secret", { status: 401 }));
    const p = new OpenAICompatibleProvider(config({ fetchFn: fetchFn as unknown as typeof fetch }));
    const err = await p.complete(request()).catch((e: unknown) => e);
    expect(String(err)).not.toContain("sk-test-secret");
  });

  it("marks truncated responses (finish_reason=length)", async () => {
    const fetchFn = vi.fn(async () =>
      okJson(chatResponse({
        choices: [
          { message: { role: "assistant", content: "partial..." }, finish_reason: "length" },
        ],
      })),
    );
    const p = new OpenAICompatibleProvider(config({ fetchFn: fetchFn as unknown as typeof fetch }));
    const res = await p.complete(request());
    expect(res.telemetry.truncated).toBe(true);
  });
});
