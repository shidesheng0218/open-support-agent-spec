# MCP 2026-07 Revision Alignment

[中文版](mcp-2026-07-alignment.zh-CN.md)

- **Corresponds to:** MCP specification revision dated **2026-07-28**
- **OSAS version:** v0.2
- **Status:** Draft
- **Related:** [RFC 0002](../rfcs/0002-osas-as-mcp-governance-profile.md), [schemas/tools/README.md](../schemas/tools/README.md) (Annotations mapping rules)

The MCP 2026-07 revision introduces two changes that matter to OSAS:
multi-round-trip (MRTR) interactions replacing elicitation/sampling, and
stateless servers. A third area — how OSAS's own tool-annotation extension
relates to MCP's standard hint set — is covered in §3. This document records
how the OSAS governance profile maps onto each change. It is an alignment
statement, not a normative spec change.

## 1. MRTR alignment

The 2026-07 revision replaces the legacy elicitation and sampling mechanisms
with **multi-round-trip (MRTR)**: a tool call may return an `input_required`
result type carrying `inputRequests`; the client gathers the missing input
(human or model) and **re-issues the same tool call** with the answers, which
then completes normally.

OSAS's request-approval interaction is structurally isomorphic to MRTR — it
was designed this way before the revision landed:

1. The model calls `osas_core_create_action_proposal` (or a proposal
   shortcut) for a side-effecting action.
2. The tenant policy evaluates the proposal. If it requires approval, the
   proposal is `require_approval` and the flow parks in
   `await_approval` — conceptually an `input_required` result: the pending
   item tells the client *what* is missing (a human approval decision) and
   *who* may supply it.
3. A human client (console, AG-UI front end, or another agent over A2A)
   supplies the answer: approve or reject.
4. The same call context is resumed — the approval decision re-enters the
   deterministic policy engine, the proposal becomes `approved` or
   `rejected`, and execution (where policy allows it) proceeds with
   idempotency and audit anchoring as before.

Conceptual sequence:

```
model → create_action_proposal(require_approval action)
      → policy: require_approval
      → await_approval                     [input_required + inputRequests]
client (human) supplies approval decision
      → same proposal re-evaluated         [MRTR round 2]
      → approved → policy engine executes (or hands off), else rejected
```

The MRTR framing gives standard clients a first-class way to render the
approval wait instead of treating it as an ad-hoc polling loop against the
API.

## 2. Stateless servers

The 2026-07 revision makes **server statelessness** explicit: servers MUST NOT
hold per-session interaction state between requests; resumable state belongs
in the data plane.

OSAS satisfies this by construction and treats it as a selling point: the MCP
server (`@osas/mcp-server`) holds **no session state at all**. Every request
carries its `ToolContext` (tenant, principal), and everything resumable — the
pending ActionProposal awaiting approval, the approval record, the policy
version that decided it — lives in the **proposal store** (e.g.
`@osas/store-postgres`) behind the adapter boundary. The server process can be
restarted, scaled horizontally, or served by multiple replicas without any
loss of in-flight approval state; a resumed MRTR round 2 is answered entirely
from the store.

## 3. Tool annotations (OSAS extension)

MCP's standard annotation set — `readOnlyHint`, `destructiveHint`,
`idempotentHint`, `openWorldHint` — predates the 2026-07 revision (it landed
in 2025-03) and is unchanged by it. All 20 OSAS tool schemas declare their
behavioral class via a top-level `annotations` object: `readOnlyHint` maps 1:1
onto the standard MCP hint, while **`mutatingHint` is an OSAS-defined
extension** — the standard set has no mutating flag, and `destructiveHint` is
the wrong shape for OSAS (proposal-shortcut tools create records without
performing a business write, and are certainly not destructive).
`@osas/mcp-server` passes `readOnlyHint` natively via `Tool.annotations` and
carries the OSAS extension under the implementation-owned
`Tool._meta["osas/annotations"]` key. The full mapping table and the
governance caveat — annotations are declarative metadata; enforcement stays in
the permission ladder and the policy engine — are normative in
[schemas/tools/README.md](../schemas/tools/README.md).

## 4. Migration strategy

OSAS commits to a **12-month dual-revision support window** from the date of
this document:

- During the window, `@osas/mcp-server` keeps serving clients on the
  pre-2026-07 revision baseline: it retains the existing transport adaptation
  and does not require MRTR-capable clients for the request-approval flow
  (approvals remain readable/writable through the existing API surface).
- The 2026-07 annotations are additive and ignored by older clients, so tool
  listings stay compatible in both directions.
- At the end of the window the project will re-evaluate: drop the legacy path,
  extend once, or publish a migration RFC. No code changes are made by this
  document; the plan above is a commitment, not an implementation.

## Status

Draft. This document will be promoted alongside the corresponding RFC once at
least one independent implementation confirms the MRTR mapping in
interoperability testing.
