import type {
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelTier,
} from "./types.js";

/**
 * OpenAI-compatible chat-completions provider (Milestone 2). Plain HTTP via
 * fetch — no vendor SDK. Configure through env (see apps/api config):
 * OSAS_LLM_BASE_URL / OSAS_LLM_API_KEY / OSAS_LLM_MODEL_FAST /
 * OSAS_LLM_MODEL_STANDARD / OSAS_LLM_INPUT_USD_PER_MTOKEN /
 * OSAS_LLM_OUTPUT_USD_PER_MTOKEN.
 *
 * Rules honored here:
 * - The API key comes from config (env), is sent only as a Bearer header, and
 *   is never printed, logged, or embedded in errors/telemetry.
 * - Costs are computed only when both prices are configured; otherwise
 *   telemetry.costUsd stays undefined ("unknown") — never fabricated.
 * - Structured output prefers the provider-native json_schema response
 *   format; on an HTTP 400 (endpoint without support) the call is retried at
 *   most once without it, then the body is JSON-parsed and validated through
 *   the injected schema-validator seam. Any failure raises
 *   StructuredOutputError (the API turns it into a safe human handoff).
 */

export class ProviderHttpError extends Error {
  readonly code = "PROVIDER_HTTP_ERROR";
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ProviderHttpError";
  }
}

export class ProviderTimeoutError extends Error {
  readonly code = "PROVIDER_TIMEOUT";
  constructor(timeoutMs: number) {
    super(`model provider timed out after ${timeoutMs}ms`);
    this.name = "ProviderTimeoutError";
  }
}

export class ProviderResponseError extends Error {
  readonly code = "PROVIDER_RESPONSE_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "ProviderResponseError";
  }
}

export class StructuredOutputError extends Error {
  readonly code = "STRUCTURED_OUTPUT_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "StructuredOutputError";
  }
}

export interface OpenAICompatibleConfig {
  baseUrl: string;
  apiKey?: string;
  modelFast: string;
  modelStandard: string;
  timeoutMs?: number;
  /** USD per million input/output tokens; both required to price calls. */
  inputUsdPerMToken?: number;
  outputUsdPerMToken?: number;
  /** Test seam: replace global fetch (keeps tests network-free). */
  fetchFn?: typeof fetch;
  /** Schema-validator seam for structured output. */
  validateOutput?: (schema: Record<string, unknown>, data: unknown) => boolean;
}

interface ChatCompletion {
  choices?: Array<{
    message?: { content?: unknown };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

const DEFAULT_TIMEOUT_MS = 30_000;
/** Token estimate when the endpoint omits `usage` (§8 mock convention). */
const CHARS_PER_TOKEN = 4;

export class OpenAICompatibleProvider implements ModelProvider {
  readonly name = "openai-compatible";
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly config: OpenAICompatibleConfig) {
    this.fetchFn = config.fetchFn ?? fetch;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  supports(tier: ModelTier): boolean {
    // fast ("classify") and standard tiers only; reasoning is never routed here.
    return tier === "classify" || tier === "standard";
  }

  private modelFor(tier: ModelTier): string {
    return tier === "classify" ? this.config.modelFast : this.config.modelStandard;
  }

  private price(inputTokens: number, outputTokens: number): number | undefined {
    const { inputUsdPerMToken, outputUsdPerMToken } = this.config;
    if (inputUsdPerMToken === undefined || outputUsdPerMToken === undefined) {
      return undefined;
    }
    return (inputTokens * inputUsdPerMToken + outputTokens * outputUsdPerMToken) / 1_000_000;
  }

  private async post(body: Record<string, unknown>): Promise<Response> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.config.apiKey) {
      headers.authorization = `Bearer ${this.config.apiKey}`;
    }
    let res: Response;
    try {
      res = await this.fetchFn(`${this.config.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const name = (err as { name?: string }).name;
      if (name === "TimeoutError" || name === "AbortError") {
        throw new ProviderTimeoutError(this.timeoutMs);
      }
      throw new ProviderResponseError(
        `model provider request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return res;
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    const model = this.modelFor(req.tier);
    const messages = req.messages.map((m) => ({ role: m.role, content: m.content }));
    const base: Record<string, unknown> = { model, messages };
    if (req.maxOutputTokens !== undefined) base.max_tokens = req.maxOutputTokens;

    const started = Date.now();

    let res: Response;
    let usedStructuredFormat = false;
    if (req.outputSchema) {
      usedStructuredFormat = true;
      res = await this.post({
        ...base,
        response_format: {
          type: "json_schema",
          json_schema: { name: "osas_output", schema: req.outputSchema, strict: true },
        },
      });
      if (res.status === 400) {
        // Endpoint without structured-output support: retry at most once.
        usedStructuredFormat = false;
        res = await this.post(base);
      }
    } else {
      res = await this.post(base);
    }

    if (!res.ok) {
      // Never echo response bodies — they may contain the key or prompts.
      throw new ProviderHttpError(res.status, `model provider returned HTTP ${res.status}`);
    }

    let payload: ChatCompletion;
    try {
      payload = (await res.json()) as ChatCompletion;
    } catch {
      throw new ProviderResponseError("model provider returned a non-JSON body");
    }

    const choice = payload.choices?.[0];
    const content = choice?.message?.content;
    if (typeof content !== "string") {
      throw new ProviderResponseError("model provider response lacks choices[0].message.content");
    }

    const allText = messages.map((m) => m.content).join("\n");
    const inputTokens = payload.usage?.prompt_tokens ?? Math.max(1, Math.ceil(allText.length / CHARS_PER_TOKEN));
    const outputTokens = payload.usage?.completion_tokens ?? Math.max(1, Math.ceil(content.length / CHARS_PER_TOKEN));

    const response: ModelResponse = {
      text: content,
      telemetry: {
        provider: this.name,
        model,
        tier: req.tier,
        task: req.task,
        inputTokens,
        outputTokens,
        latencyMs: Date.now() - started,
        truncated: choice?.finish_reason === "length",
        ...(this.price(inputTokens, outputTokens) !== undefined
          ? { costUsd: this.price(inputTokens, outputTokens) }
          : {}),
      },
    };

    if (req.outputSchema) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch {
        throw new StructuredOutputError(
          `structured output was not valid JSON (structured_format=${usedStructuredFormat})`,
        );
      }
      if (this.config.validateOutput && !this.config.validateOutput(req.outputSchema, parsed)) {
        throw new StructuredOutputError("structured output failed schema validation");
      }
      response.parsed = parsed;
    } else {
      const trimmed = content.trimStart();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
          response.parsed = JSON.parse(content);
        } catch {
          // not parseable — leave parsed undefined
        }
      }
    }

    return response;
  }
}
