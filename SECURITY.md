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
  they are reference-grade, not production-grade.
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

If you are building an independent implementation, treat the items above as
minimum baselines, and see the normative security requirements in
[docs/spec-v0.2.md](docs/spec-v0.2.md) §9.
