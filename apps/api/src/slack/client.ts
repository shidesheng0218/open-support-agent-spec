/**
 * Minimal Slack Web API client behind an injectable HTTP seam (same idea as the
 * adapters): tests pass a fake, production uses fetch. Only three methods are
 * used and the URL is always https://slack.com/api/<method>, so nothing from a
 * request can steer where the bot token is sent. The token never appears in
 * errors or logs.
 */
export interface SlackHttpRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}
export interface SlackHttpResponse {
  status: number;
  body: unknown;
}
export type SlackHttp = (req: SlackHttpRequest) => Promise<SlackHttpResponse>;

export class SlackApiError extends Error {
  override name = "SlackApiError";
  constructor(
    readonly method: string,
    readonly code: string,
  ) {
    super(`Slack ${method} failed: ${code}`);
  }
}

export const fetchSlackHttp: SlackHttp = async (req) => {
  const res = await fetch(req.url, {
    method: "POST",
    headers: req.headers,
    body: req.body,
    signal: AbortSignal.timeout(5000),
  });
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  return { status: res.status, body };
};

export interface SlackClient {
  postMessage(channel: string, text: string, blocks: unknown[]): Promise<{ ts: string; channel: string }>;
  updateMessage(channel: string, ts: string, text: string, blocks: unknown[]): Promise<void>;
  postEphemeral(channel: string, user: string, text: string): Promise<void>;
}

export function createSlackClient(token: string, http: SlackHttp = fetchSlackHttp): SlackClient {
  async function call(method: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    let res: SlackHttpResponse;
    try {
      res = await http({
        url: `https://slack.com/api/${method}`,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(payload),
      });
    } catch {
      throw new SlackApiError(method, "transport_error");
    }
    const body = (res.body ?? {}) as { ok?: boolean; error?: string };
    if (res.status < 200 || res.status >= 300) throw new SlackApiError(method, `http_${res.status}`);
    if (body.ok !== true) throw new SlackApiError(method, String(body.error ?? "unknown_error"));
    return body as Record<string, unknown>;
  }
  return {
    async postMessage(channel, text, blocks) {
      const r = await call("chat.postMessage", { channel, text, blocks });
      return { ts: String(r.ts), channel: String(r.channel ?? channel) };
    },
    async updateMessage(channel, ts, text, blocks) {
      await call("chat.update", { channel, ts, text, blocks });
    },
    async postEphemeral(channel, user, text) {
      await call("chat.postEphemeral", { channel, user, text });
    },
  };
}
