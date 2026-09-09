import type { RunnerOptions } from "./types.js";

export interface Response {
  status: number;
  json(): Promise<unknown>;
}

const KNOWN_PROFILES = new Set(["core", "ecommerce", "saas"]);

export class HttpClient {
  readonly baseUrl: string;
  private readonly opts: RunnerOptions;

  constructor(opts: RunnerOptions) {
    this.opts = opts;
    this.baseUrl = opts.target.replace(/\/+$/, "");
  }

  private headers(
    role?: string,
    conformanceKey?: string,
    providerEventKey?: string,
  ): Record<string, string> {
    const h: Record<string, string> = {};
    if (this.opts.token) h.authorization = `Bearer ${this.opts.token}`;
    // Demo-auth targets read these headers; jwt-mode targets ignore them.
    h["x-tenant-id"] = this.opts.tenant ?? "tenant_demo";
    h["x-osas-role"] = role ?? this.opts.role ?? "policy_admin";
    if (conformanceKey) h["x-osas-conformance-key"] = conformanceKey;
    if (providerEventKey) h["x-osas-provider-key"] = providerEventKey;
    return h;
  }

  async request(
    method: string,
    path: string,
    opts: {
      body?: unknown;
      role?: string;
      conformanceKey?: string;
      providerEventKey?: string;
      tenant?: string;
    } = {},
  ): Promise<{ status: number; body: unknown }> {
    const headers = this.headers(opts.role, opts.conformanceKey, opts.providerEventKey);
    if (opts.tenant) headers["x-tenant-id"] = opts.tenant;
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    const res = await (this.opts.fetchFn ?? fetch)(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
    });
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { status: res.status, body };
  }

  get(path: string, opts?: { role?: string; conformanceKey?: string; providerEventKey?: string; tenant?: string }) {
    return this.request("GET", path, opts);
  }

  post(path: string, body?: unknown, opts?: { role?: string; conformanceKey?: string; providerEventKey?: string; tenant?: string }) {
    return this.request("POST", path, { ...opts, body });
  }

  put(path: string, body?: unknown, opts?: { role?: string }) {
    return this.request("PUT", path, { ...opts, body });
  }
}

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function isKnownProfile(name: unknown): boolean {
  return typeof name === "string" && KNOWN_PROFILES.has(name);
}

export function errorCode(body: unknown): string | undefined {
  if (isObject(body) && isObject(body.error) && typeof body.error.code === "string") {
    return body.error.code;
  }
  return undefined;
}
