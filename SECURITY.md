# Security Policy

## Supported versions

| Version | Status | Supported |
|---|---|---|
| 0.2.x | Draft | Yes — fixes land on `main` |

OSAS is at v0.2 Draft; there is no stable release line yet. Only the latest
`0.2.x` state of `main` receives security fixes.

## Reporting a vulnerability

**Please do not open public issues for security vulnerabilities.**

Report vulnerabilities through **GitHub private vulnerability reporting**
(Security tab → "Report a vulnerability") on this repository. Include:

- the affected component (spec text, schema, package, app) and version/commit;
- a description of the issue and its security impact;
- steps to reproduce or a proof of concept, if available.

We aim to acknowledge reports within 3 business days and to coordinate a fix and
disclosure timeline with the reporter. Credit is given in the release notes
unless you prefer otherwise.

## Scope notes

- **The reference implementation is demo-grade.** It is designed to make the
  specification runnable and testable — not to be deployed as a production
  support system. It ships with an in-memory mock backend, a deterministic mock
  model provider, and a demo auth mode (`OSAS_AUTH_MODE=demo`), and it has
  never been hardened or audited for production. Authentication (demo headers
  or JWT/OIDC) and per-tenant isolation do exist and are covered by tests, but
  they are reference-grade, not production-grade. The staged path from this
  demo to a production posture — configuration matrix, never-list, and
  pre-launch checklist — lives in
  [docs/production-hardening.md](docs/production-hardening.md).
- **Never feed real customer data** into this repository, its demos, its issues,
  or its fixtures. All fixtures under `packages/mock-backend/` are synthetic.
- **Logs redact PII.** The reference API logs no request/response bodies by
  default and configures log redaction for authorization headers, email,
  phone, and free-text body fields (`req.headers.authorization`, `*.email`,
  `*.phone`, `req.body`, `res.body`, `*.body` — see `apps/api/src/plugins.ts`,
  pinned by `src/log-redaction.test.ts`). Keep this property intact in
  contributions.
- **The model layer holds no credentials.** Models never receive backend
  credentials; all backend access flows through the adapter with an explicit
  principal and permission. Do not introduce code paths that pass secrets to a
  model provider.
- **Injection defense and no blind retries** are normative parts of the spec
  (see [docs/spec-v0.2.md](docs/spec-v0.2.md) §9). Changes that weaken them are
  treated as security regressions.

## Known vulnerabilities (as of 2024-10-21)

The reference implementation currently depends on packages with known security
advisories. We actively track these and apply mitigations where possible.

| Severity | Component | CVE/Advisory | Status | Mitigation |
|----------|-----------|--------------|--------|------------|
| Critical | vitest | Arbitrary file read/exec via UI server | Dev-only | UI endpoints blocked in production via security plugin |
| Critical | proxy-addr | IPv4-mapped IPv6 trust subnet spoofing | Runtime | Input validation added in security plugin |
| Critical | tinypool (2) | Prototype pollution RCE in worker options | Dev-only | Used only in test runner, not in production runtime |
| High | vite | `server.fs.deny` bypass on Windows paths | Dev-only | Build tool only, not exposed in production |
| High | source-map-js | Event-loop DoS via indexed source maps | Dev-only | Used in build pipeline, not runtime |
| High | @modelcontextprotocol/sdk | OAuth credentials to attacker-chosen server | Runtime | Under review; consider pinning or forking |
| Moderate | Various | 19 moderate-severity findings | Mixed | Evaluating on case-by-case basis |

**Production deployment:** The security plugin (`apps/api/src/plugins/security.ts`)
maintains runtime mitigations for runtime vulnerabilities. Dev-only
vulnerabilities (vitest, vite, tinypool, source-map-js) do not affect the
production API deployment.

**Tracking:** We monitor `pnpm audit` output and upstream issue trackers. When
upstream fixes become available, we will update dependencies immediately. For
issues without upstream fixes, we evaluate alternatives including forking or
replacing the affected dependency.

See [docs/security-audit.md](docs/security-audit.md) for detailed analysis and
tracking status (TODO: create this document).

If you are building an independent implementation, treat the items above as
minimum baselines, and see the normative security requirements in
[docs/spec-v0.2.md](docs/spec-v0.2.md) §9.
