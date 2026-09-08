# RFC NNNN: <short title>

- **Status:** Draft <!-- Draft | Accepted | Rejected | Implemented | Superseded -->
- **Authors:** <name(s) / handle(s)>
- **Created:** YYYY-MM-DD

<!--
Process: copy this file to rfcs/NNNN-short-name.md and open a PR with Status: Draft.
An RFC is REQUIRED for breaking changes and any new semantics (schemas, state
machines, policy algorithm, permission ladder, tool surface, adapter interface).
Editorial changes do not need an RFC. See CONTRIBUTING.md and GOVERNANCE.md.
Delete these comments before submitting.
-->

## Summary

One-paragraph explanation of the change.

## Motivation

Why is this change needed? What problem does it solve? What use cases does it
enable? What happens if we do nothing?

## Design

The detailed design. Include normative language (MUST/SHOULD/MAY) where the change
affects conformance. Reference the affected sections of `docs/spec-v0.2.md`, the
affected schemas under `schemas/`, and the affected packages. For schema changes,
include the proposed schema diff or new schema.

## Compatibility

Is this a breaking change? What is the impact on:

- existing persisted objects and `specVersion`;
- independent implementations and the compat suite;
- the HTTP API and MCP tool surface;
- migration path, if any.

## Security

Impact on the normative security requirements (no credentials to the model,
injection defense, PII redaction, no blind retries, default-deny policy). New
attack surface introduced, and how it is mitigated.

## Test plan

Which unit tests and compat-suite cases will be added or changed? Which runnable
examples demonstrate the change? (Recall the release gate: schemas, EN+ZH docs,
reference implementation, and compat tests land in the same PR.)
