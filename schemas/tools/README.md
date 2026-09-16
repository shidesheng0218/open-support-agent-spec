# OSAS tool input schemas

One JSON Schema (draft 2020-12) per tool in the OSAS MCP surface
(CONTRACTS.md §7): 20 tools across the `core` / `ecommerce` / `saas` profiles.
Each schema validates the tool's **input arguments** and is registered in
`schemas/manifest.json` under the `tools` profile.

Notes:

- Every input schema is `type: "object"` with `additionalProperties: false`;
  clients MUST NOT send undeclared arguments (including governance fields such
  as `tenantId`, `requestedPermission`, or `requestedBy` — the server sets
  those from `ToolContext`).
- `executeAction` is deliberately **not** a tool: models can only create
  ActionProposals (`osas_core_create_action_proposal` and the proposal
  shortcuts), and the deterministic policy engine decides execution.

## Annotations 映射规则 (Annotations mapping rules)

Each schema carries a top-level `annotations` object describing the tool's
behavioral class. It is a JSON Schema keyword (a sibling of `properties`), not
an input field — the input-level `additionalProperties: false` above it
constrains tool arguments, not schema keywords. The annotations object itself
is closed (`additionalProperties: false`) with boolean-typed properties, and
exactly one hint is declared per tool:

| Hint | Meaning | Tools |
|---|---|---|
| `readOnlyHint: true` | Read-only lookup; no side effects | `osas_core_get_case`, `osas_core_search_cases`, `osas_core_get_customer`, `osas_core_search_knowledge`, `osas_ecom_get_order`, `osas_ecom_list_orders`, `osas_ecom_get_shipment`, `osas_ecom_get_shipment_incident`, `osas_ecom_get_refund_status`, `osas_saas_get_subscription`, `osas_saas_list_invoices`, `osas_saas_get_credit_balance` |
| `mutatingHint: true` | Creates or mutates records (notes, escalations, proposals, claims, requests) | `osas_core_create_case_note`, `osas_core_create_escalation`, `osas_core_create_action_proposal`, `osas_ecom_create_item_claim_request`, `osas_ecom_create_exchange_request`, `osas_saas_create_credit_request`, `osas_saas_create_cancellation_request`, `osas_saas_create_plan_change_request` |

Mapping to the MCP tool annotations (spec dated 2026-07-28):

- `readOnlyHint` corresponds 1:1 to the MCP `readOnlyHint` tool annotation
  (part of MCP's standard hint set — `readOnlyHint`, `destructiveHint`,
  `idempotentHint`, `openWorldHint` — and passed natively via
  `Tool.annotations`).
- **`mutatingHint` is an OSAS-defined annotation, not an MCP one.** MCP's
  standard set has no "mutating" flag; `destructiveHint` is the closest
  standard hint, but it describes potentially destructive updates, whereas
  OSAS needs a marker for every record-creating tool — including
  proposal-only shortcuts that create a record but perform no business write.
  OSAS therefore declares `mutatingHint` in its own tool schemas and surfaces
  it under the implementation-owned `Tool._meta["osas/annotations"]` key,
  where it cannot collide with future standard hints. If MCP later
  standardizes an equivalent hint, OSAS will map onto it and revisit this
  extension.

**Annotations are enforced by the governance layer, not by hints.** A
`mutatingHint` annotation is declarative metadata for clients and model routers;
it grants nothing. Every mutating tool call is still subject to the OSAS
permission ladder (models are capped at `request-approval`) and, for
side-effecting actions, to the `ActionProposal → policy engine` pipeline. The
policy engine — not the annotation — decides whether a proposed action is
auto-executed, routed to human approval, or blocked. Conversely, a model can
never turn a read-only hint into write access, and `executeAction` remains
unregistered as a tool regardless of annotations.

See `docs/mcp-2026-07-alignment.md` for how these annotations fit the OSAS
alignment with the MCP 2026-07 revision (MRTR, stateless servers).
