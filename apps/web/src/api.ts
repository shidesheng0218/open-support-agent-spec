export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
      ...init,
    });
  } catch (e) {
    throw new ApiError(0, "NETWORK_ERROR", e instanceof Error ? e.message : "network error");
  }
  const text = await res.text();
  let body: unknown = undefined;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!res.ok) {
    const err = (body as { error?: { code?: string; message?: string; details?: unknown } } | undefined)?.error;
    throw new ApiError(res.status, err?.code ?? `HTTP_${res.status}`, err?.message ?? res.statusText, err?.details);
  }
  return body as T;
}

// True when the API reports that no compat report has been generated yet
// (expected on fresh non-Docker checkouts — not a system error).
export function isCompatReportNotGenerated(e: unknown): boolean {
  return e instanceof ApiError && e.code === "COMPAT_REPORT_NOT_GENERATED";
}

// Base = same origin; vite proxy forwards /v1 and /health to the API (localhost:3001).
export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, data?: unknown) =>
    request<T>(path, { method: "POST", body: data === undefined ? undefined : JSON.stringify(data) }),
  put: <T>(path: string, data?: unknown) =>
    request<T>(path, { method: "PUT", body: data === undefined ? undefined : JSON.stringify(data) }),
};
