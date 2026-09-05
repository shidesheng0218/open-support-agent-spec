/**
 * Minimal injectable HTTP seam — same contract as @osas/zendesk-adapter's,
 * duplicated so this package has no cross-adapter dependency.
 */
export interface HttpRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface HttpResponse {
  status: number;
  body: unknown;
}

export type HttpClient = (req: HttpRequest) => Promise<HttpResponse>;

export class HttpTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HttpTransportError";
  }
}

export function createFetchHttpClient(
  fetchImpl: typeof fetch = globalThis.fetch,
): HttpClient {
  if (!fetchImpl) {
    throw new HttpTransportError("No fetch implementation available (node>=20 required)");
  }
  return async (req) => {
    let res: Response;
    try {
      res = await fetchImpl(req.url, {
        method: req.method,
        headers: {
          accept: "application/json",
          ...(req.body !== undefined ? { "content-type": "application/json" } : {}),
          ...(req.headers ?? {}),
        },
        ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
      });
    } catch (err) {
      throw new HttpTransportError(
        `HTTP ${req.method} ${new URL(req.url).pathname} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    return { status: res.status, body };
  };
}
