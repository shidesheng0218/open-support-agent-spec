# OSAS Conformance Registry

This directory is the public registry of implementations that have been
verified against the OSAS conformance tooling.

- `implementations.json` — the registry of known implementations and their
  verification status.
- `badges/` — machine-readable badge records issued to verified
  implementations.
- `matrix.md` — the per-case pass matrix for registered implementations.

The authoritative gate for any compatibility claim is defined in
[GOVERNANCE.md](../GOVERNANCE.md#declaring-compatibility): the black-box
compatibility runner (`@osas/compat-runner`, invoked as
`osas:compat -- --target <url>`) must pass against the implementation over
HTTP, **including the stateful suite**, with `ok: true` in the report.

## Status values in `implementations.json`

| Status | Meaning |
|---|---|
| `reference` | The normative TypeScript reference implementation in this repository. Never counts toward the v1.0 independence gate. |
| `candidate` | An implementation under construction. It may be listed while incomplete (with `"independent": false` and `repository: null` if not yet published). |
| `conforming` | Passes the black-box runner (read-only + stateful suites) for its declared profiles, but is maintained by the founding maintainers — e.g. an in-repo or same-org second implementation. Does **not** count as independent. |
| `independent-conforming` | Meets the independence criteria below **and** passes the black-box runner for its declared profiles. Counts toward the v1.0 gate of ≥3 independent implementations. |

## Independence criteria

An implementation counts as **independent** only when all of the following
hold:

1. **Separate repository** — the implementation lives in its own repository,
   not inside the OSAS reference repository (submodules and vendored copies of
   the reference implementation do not qualify).
2. **Separate maintainership** — the implementation is maintained by a
   different organization or individual than the OSAS founding maintainers.
3. **Passing evidence** — the black-box compat runner passes against a live
   target operated by the implementer (or reproducible CI evidence), including
   the stateful suite, with `ok: true` in the report.
4. **Named spec version** — the claim names the spec version tested (e.g.
   "OSAS 0.2 ecommerce-compatible").

An implementation maintained by the founding maintainers can reach at most
`conforming` — it is valuable as a second validator of the spec, but it does
not satisfy the v1.0 independence gate.

## Registration flow

1. Open an issue using the **Compatibility claim / registry entry** template
   with your implementation repository, claimed profiles, a live target URL
   (or CI evidence), and the runner report JSON.
2. The founding maintainers verify the claim by re-running the runner against
   the provided target, or by reviewing linked CI evidence.
3. On success, a maintainer PR updates `implementations.json` and adds a badge
   record under `badges/` naming the implementation, spec version, profiles,
   and verification evidence.
4. Claims are re-verified when the claimed spec line changes (e.g. a 0.2 claim
   does not extend to 0.3 profiles). A claim found to be false or
   unreproducible is removed from the registry.

## Badge records

Files under `badges/` are machine-readable JSON:

```jsonc
{
  "schemaVersion": "1",
  "implementationId": "…",          // matches implementations.json
  "specVersion": "0.2",              // spec line verified
  "profile": "ecommerce",            // profile verified
  "status": "draft-conformance",     // while the spec line is a Draft
  "verifiedAt": "YYYY-MM-DD",
  "independent": false,
  "evidence": { "runner": "…", "requiredEnvironment": ["…"] }
}
```

Badges are records of a verification event, not certifications of production
readiness. `live` execution remains fail-closed in v0.x (see RFC 0003); no
badge implies live-write capability.
