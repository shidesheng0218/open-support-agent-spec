#!/usr/bin/env python3
"""OSAS Python reference implementation (second-implementation candidate).

Implements the OSAS v0.2 HTTP surface end to end — discovery, real JSON Schema
validation, the deterministic policy-evaluation algorithm (spec §5), the
policy version lifecycle, idempotent execution with reconciliation, per-tenant
audit hash chains, RBAC/tenant isolation, Conformance Mode — plus the v0.3
controlled-execution sandbox profile.

Safety posture: the model-proposal boundary is honored (proposals are capped
at request-approval semantics; only the server decides/executes), `live`
execution refuses startup, Conformance Mode is test-only and fail-closed, and
no provider credentials are read and no external network calls are made.

Requires: python >= 3.11 and the `jsonschema` package (see requirements.txt).
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import hmac
import json
import os
import re
import sys
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse

import jsonschema
from referencing import Registry, Resource
from referencing.jsonschema import DRAFT202012

ROOT = Path(__file__).resolve().parents[2]
SCHEMAS = ROOT / "schemas"
FIXTURE_FILE = ROOT / "conformance" / "fixtures" / "demo-tenant.json"
TENANT = "tenant_demo"
GENESIS_HASH = "0" * 64

SEVERITY = {"auto_execute": 0, "require_approval": 1, "block": 2}
GRADE_BY_SEVERITY = ["auto_execute", "require_approval", "block"]
DUPLICATE_STATUSES = {"executing", "executed", "pending_approval", "approved"}
FINANCIAL_ACTION_TYPES = {"refund", "reshipment", "credit_apply"}
NEVER_AUTO_EXECUTE = {"exchange_request"}
ACTION_TYPE_PROFILE = {
    "create_note": "core",
    "create_escalation": "core",
    "refund": "ecommerce",
    "return_request": "ecommerce",
    "reshipment": "ecommerce",
    "cancel_order": "ecommerce",
    "exchange_request": "ecommerce",
    "credit_apply": "saas",
    "subscription_cancel": "saas",
    "plan_change": "saas",
}

TOOL_CAPABILITIES = {
    "osas_core_get_case": "case.read",
    "osas_core_search_cases": "case.read",
    "osas_core_get_customer": "customer.read",
    "osas_core_search_knowledge": "knowledge.read",
    "osas_core_create_case_note": "note.write",
    "osas_core_create_escalation": "escalation.write",
    "osas_core_create_action_proposal": "proposal.write",
    "osas_ecom_get_order": "ecommerce.order.read",
    "osas_ecom_list_orders": "ecommerce.order.read",
    "osas_ecom_get_shipment": "ecommerce.shipment.read",
    "osas_ecom_get_shipment_incident": "ecommerce.shipment_incident.read",
    "osas_ecom_get_refund_status": "ecommerce.refund_status.read",
    "osas_ecom_create_item_claim_request": "ecommerce.item_claim.propose",
    "osas_ecom_create_exchange_request": "ecommerce.exchange.propose",
    "osas_saas_get_subscription": "saas.subscription.read",
    "osas_saas_list_invoices": "saas.subscription.read",
    "osas_saas_get_credit_balance": "saas.subscription.read",
    "osas_saas_create_credit_request": "saas.credit.propose",
    "osas_saas_create_cancellation_request": "proposal.write",
    "osas_saas_create_plan_change_request": "proposal.write",
}

# ---------------------------------------------------------------------------
# Canonical JSON + audit hash chain (see docs/implementing-osas.md —
# "Reproducing the audit hash chain")
# ---------------------------------------------------------------------------


def stable_json(value: Any) -> str:
    """Canonical serialization matching @osas/policy-engine stableStringify."""
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def hash_event(event: dict[str, Any]) -> str:
    content = {k: v for k, v in event.items() if k != "eventHash"}
    return hashlib.sha256(stable_json(content).encode("utf-8")).hexdigest()


def verify_chain(events: list[dict[str, Any]]) -> dict[str, Any]:
    ordered = sorted(events, key=lambda e: e.get("sequence", 0))
    previous = GENESIS_HASH
    for i, event in enumerate(ordered):
        if "sequence" not in event or "previousHash" not in event or not event.get("eventHash"):
            return {"intact": False, "chainLength": len(ordered),
                    "firstError": {"eventId": event.get("id"), "reason": "missing_chain_fields"}}
        if event["sequence"] != i + 1:
            return {"intact": False, "chainLength": len(ordered),
                    "firstError": {"eventId": event["id"], "sequence": event["sequence"], "reason": "sequence_gap"}}
        if event["previousHash"] != previous:
            return {"intact": False, "chainLength": len(ordered),
                    "firstError": {"eventId": event["id"], "reason": "previous_hash_mismatch"}}
        actual = hash_event(event)
        if actual != event["eventHash"]:
            return {"intact": False, "chainLength": len(ordered),
                    "firstError": {"eventId": event["id"], "reason": "event_hash_mismatch",
                                   "expectedEventHash": event["eventHash"], "actualEventHash": actual}}
        previous = event["eventHash"]
    return {"intact": True, "chainLength": len(ordered)}


# ---------------------------------------------------------------------------
# Demo fixtures (conformance/fixtures/demo-tenant.json, now-token timestamps)
# ---------------------------------------------------------------------------

_TOKEN = re.compile(r"^now(?:([+-])(\d+)([smhd]))?$")
_UNIT_MS = {"s": 1_000, "m": 60_000, "h": 3_600_000, "d": 86_400_000}


def _iso(ts_ms: float) -> str:
    return (
        datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def now_iso() -> str:
    return _iso(datetime.now(timezone.utc).timestamp() * 1000)


def _materialize(value: Any, base_ms: float) -> Any:
    if isinstance(value, str):
        m = _TOKEN.match(value)
        if not m:
            return value
        if m.group(1) is None:
            return _iso(base_ms)
        delta = int(m.group(2)) * _UNIT_MS[m.group(3)] * (-1 if m.group(1) == "-" else 1)
        return _iso(base_ms + delta)
    if isinstance(value, list):
        return [_materialize(v, base_ms) for v in value]
    if isinstance(value, dict):
        return {k: _materialize(v, base_ms) for k, v in value.items()}
    return value


def load_demo_fixtures() -> dict[str, Any]:
    raw = json.loads(FIXTURE_FILE.read_text())
    return _materialize(raw, datetime.now(timezone.utc).timestamp() * 1000)


# ---------------------------------------------------------------------------
# JSON Schema validation (vendored schemas/ via the referencing registry)
# ---------------------------------------------------------------------------


def _build_registry() -> tuple[Registry, dict[str, dict[str, Any]]]:
    resources = []
    by_name: dict[str, dict[str, Any]] = {}
    for path in sorted(SCHEMAS.rglob("*.json")):
        if path.name.startswith("manifest"):
            continue
        contents = json.loads(path.read_text())
        rel = path.relative_to(SCHEMAS).as_posix()
        name = rel[: -len(".json")]
        by_name[name] = contents
        uri = contents.get("$id", f"https://open-support-agent.dev/schemas/{rel}")
        resources.append((uri, Resource.from_contents(contents, default_specification=DRAFT202012)))
    return Registry().with_resources(resources), by_name


REGISTRY, SCHEMAS_BY_NAME = _build_registry()


def validate_against(schema_name: str, data: Any) -> tuple[bool, list[dict[str, str]]]:
    schema = SCHEMAS_BY_NAME.get(schema_name)
    if schema is None:
        return False, [{"message": f"unknown schema '{schema_name}'"}]
    validator = jsonschema.Draft202012Validator(schema, registry=REGISTRY)
    errors = [
        {"message": e.message, "path": "/" + "/".join(str(p) for p in e.absolute_path)}
        for e in validator.iter_errors(data)
    ]
    return (len(errors) == 0), errors


# ---------------------------------------------------------------------------
# Deterministic policy evaluation (spec §5) — a faithful port of
# @osas/policy-engine evaluateProposal, including param-transform passthrough.
# ---------------------------------------------------------------------------


def _deep_equal(a: Any, b: Any) -> bool:
    return stable_json(a) == stable_json(b)


def evaluate(
    proposal: dict[str, Any],
    *,
    customer: dict[str, Any] | None,
    evidence: list[dict[str, Any]],
    policy: dict[str, Any],
    recent_proposals: list[dict[str, Any]],
    injection_suspected: bool = False,
    now_ms: float | None = None,
) -> dict[str, Any]:
    now_ms = now_ms if now_ms is not None else datetime.now(timezone.utc).timestamp() * 1000
    reasons: list[dict[str, str]] = []
    worst = 0

    def add(code: str, message: str, grade: str) -> None:
        nonlocal worst
        reasons.append({"code": code, "message": message})
        worst = max(worst, SEVERITY[grade])

    action = proposal.get("actionType")

    # 1. PERMISSION_OVERREACH: models are capped at request-approval.
    if proposal.get("requestedPermission") == "execute" and (
        proposal.get("requestedBy") or {}
    ).get("actorType") == "model":
        add("PERMISSION_OVERREACH",
            "model principals are capped at request-approval; requestedPermission 'execute' is not allowed",
            "block")

    # 2. PROMPT_INJECTION_SUSPECTED.
    if injection_suspected:
        add("PROMPT_INJECTION_SUSPECTED",
            "prompt injection suspected in the originating conversation", "block")

    # 3. PROFILE_MISMATCH.
    expected_profile = ACTION_TYPE_PROFILE.get(action)
    if expected_profile is None or expected_profile != proposal.get("profile"):
        add("PROFILE_MISMATCH",
            f"actionType '{action}' does not belong to profile '{proposal.get('profile')}'", "block")

    # 4. NO_RULE (+ 5 reason codes, 7 threshold, 8 identity, 9 region).
    rule = next((r for r in policy.get("rules", []) if r.get("actionType") == action), None)
    if rule is None:
        add("NO_RULE", f"no policy rule matches actionType '{action}'; default decision is block", "block")
    else:
        if rule.get("reasonCodes") is not None and proposal.get("reasonCode") not in rule["reasonCodes"]:
            add("REASON_CODE_NOT_ALLOWED",
                f"reasonCode '{proposal.get('reasonCode')}' is not in the allowed list for actionType '{action}'",
                "block")
        amount, max_amount = proposal.get("amount"), rule.get("maxAmount")
        if amount and max_amount:
            if amount.get("currency") != max_amount.get("currency"):
                add("CURRENCY_MISMATCH",
                    f"amount currency {amount.get('currency')} does not match rule.maxAmount currency {max_amount.get('currency')}",
                    "require_approval")
            elif int(amount.get("minorUnits", 0)) > int(max_amount.get("minorUnits", 0)):
                add("OVER_THRESHOLD",
                    f"amount {amount.get('minorUnits')} {amount.get('currency')} exceeds rule maxAmount {max_amount.get('minorUnits')} {max_amount.get('currency')}",
                    "require_approval")
        if rule.get("requireVerifiedIdentity"):
            iv = (customer or {}).get("identityVerification")
            if customer is None or not iv:
                add("IDENTITY_REQUIRED",
                    "rule requires a verified identity but no customer identity record is available", "block")
            elif iv.get("status") != "verified":
                add("IDENTITY_UNVERIFIED",
                    f"rule requires a verified identity but status is '{iv.get('status')}'", "block")
            elif rule.get("identityMaxAgeSeconds") is not None:
                if not iv.get("verifiedAt"):
                    add("IDENTITY_UNVERIFIED",
                        "identity is verified but verifiedAt is missing; age cannot be validated", "block")
                else:
                    age_s = (now_ms - _parse_ms(iv["verifiedAt"])) / 1000
                    if age_s > rule["identityMaxAgeSeconds"]:
                        add("IDENTITY_UNVERIFIED",
                            f"identity verification is {int(age_s)}s old, exceeding identityMaxAgeSeconds {rule['identityMaxAgeSeconds']}",
                            "block")
        region = (customer or {}).get("region")
        if region is not None:
            if region in (rule.get("blockedRegions") or []):
                add("REGION_BLOCKED",
                    f"customer region '{region}' is in blockedRegions for actionType '{action}'", "block")
            elif rule.get("allowedRegions") is not None and region not in rule["allowedRegions"]:
                add("REGION_UNLISTED",
                    f"customer region '{region}' is not in allowedRegions for actionType '{action}'",
                    "require_approval")

    # 6. DUPLICATE_REQUEST.
    window_ms = int(policy.get("duplicateWindowSeconds", 86400)) * 1000
    duplicate = next(
        (p for p in recent_proposals
         if p.get("id") != proposal.get("id")
         and p.get("tenantId") == proposal.get("tenantId")
         and p.get("caseId") == proposal.get("caseId")
         and p.get("actionType") == action
         and p.get("status") in DUPLICATE_STATUSES
         and now_ms - _parse_ms(p.get("createdAt", _iso(now_ms))) <= window_ms
         and _deep_equal(p.get("params"), proposal.get("params"))),
        None,
    )
    if duplicate:
        add("DUPLICATE_REQUEST",
            f"proposal '{duplicate['id']}' with identical params is already {duplicate['status']} within the duplicate window",
            "block")

    # 10. INSUFFICIENT_EVIDENCE / EVIDENCE_STALE.
    if action in FINANCIAL_ACTION_TYPES and not proposal.get("evidenceIds"):
        add("INSUFFICIENT_EVIDENCE",
            f"financial actionType '{action}' requires at least one evidence reference", "block")
    max_age_s = int(policy.get("maxEvidenceAgeSeconds", 604800))
    referenced = [e for e in evidence if e.get("id") in (proposal.get("evidenceIds") or [])]
    stale = [
        e for e in referenced
        if (e.get("expiresAt") and _parse_ms(e["expiresAt"]) < now_ms)
        or ((now_ms - _parse_ms(e.get("retrievedAt", _iso(now_ms)))) / 1000 > max_age_s)
    ]
    if stale:
        add("EVIDENCE_STALE",
            "evidence expired or older than maxEvidenceAgeSeconds: " + ", ".join(e["id"] for e in stale),
            "require_approval")

    # 11. Rule-matched baseline; final = worst of everything.
    if rule is not None:
        worst = max(worst, SEVERITY[rule.get("decision", "block")])

    # 12. NEVER_AUTO_EXECUTE cap (e.g. exchange_request is human-fulfilled only).
    if action in NEVER_AUTO_EXECUTE and worst < SEVERITY["require_approval"]:
        add("NEVER_AUTO_EXECUTE",
            f"actionType '{action}' is never model-executed; decision is capped at require_approval",
            "require_approval")

    decision = GRADE_BY_SEVERITY[worst]
    result: dict[str, Any] = {
        "decision": decision,
        "reasons": reasons,
        "policyVersion": policy.get("version"),
        "evaluatedAt": _iso(now_ms),
    }
    # Param transforms ride along on non-block decisions (never on block).
    if rule is not None and decision != "block" and rule.get("transforms"):
        result["transforms"] = copy.deepcopy(rule["transforms"])
    return result


def _parse_ms(value: str) -> float:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000


def apply_transforms(params: dict[str, Any], transforms: list[dict[str, Any]]) -> dict[str, Any]:
    """Apply rule transforms to a deep clone of params; unmatched paths no-op."""
    out = copy.deepcopy(params)
    for t in transforms:
        if t.get("op") != "redact":
            continue
        parts = [p for p in str(t.get("path", "")).lstrip("/").split("/") if p]
        if not parts:
            continue
        node: Any = out
        for part in parts[:-1]:
            if not isinstance(node, dict) or part not in node:
                node = None
                break
            node = node[part]
        if isinstance(node, dict) and parts[-1] in node:
            node[parts[-1]] = t.get("replacement", "[REDACTED]")
    return out


# ---------------------------------------------------------------------------
# In-memory state (single-process reference; per-tenant maps)
# ---------------------------------------------------------------------------

STATE: dict[str, Any] = {}


def reset_state(seed: bool = True) -> None:
    STATE.clear()
    STATE.update({
        "proposals": {},
        "decisions": {},
        "executions": {},
        "attempts": {},
        "receipts": {},
        "reconciliations": {},
        "provider_events": {},
        "policies": {},  # tenant -> {version -> record}
        "audit": {},     # tenant -> [events]
        "fixtures": None,
    })
    if seed:
        fixtures = load_demo_fixtures()
        STATE["fixtures"] = fixtures
        for proposal in fixtures["proposals"]:
            STATE["proposals"][proposal["id"]] = copy.deepcopy(proposal)
        policy = copy.deepcopy(fixtures["policy"])
        record = {
            **policy,
            "status": "active",
            "createdBy": "seed",
            "activatedBy": "seed",
            "activatedAt": policy["createdAt"],
        }
        STATE["policies"][TENANT] = {policy["version"]: record}


def fixtures() -> dict[str, Any]:
    return STATE["fixtures"] or {"cases": [], "customers": [], "evidence": [], "proposals": [], "policy": {}}


def _id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def audit(tenant: str, event_type: str, actor_type: str, actor_id: str, detail: dict[str, Any], **extra: Any) -> None:
    stream = STATE["audit"].setdefault(tenant, [])
    event: dict[str, Any] = {
        "id": _id("evt"),
        "specVersion": "0.2",
        "tenantId": tenant,
        "eventType": event_type,
        "actorType": actor_type,
        "actorId": actor_id,
        "detail": detail,
        "createdAt": now_iso(),
        **extra,
        "sequence": len(stream) + 1,
        "previousHash": stream[-1]["eventHash"] if stream else GENESIS_HASH,
    }
    event["eventHash"] = hash_event(event)
    stream.append(event)


# ---------------------------------------------------------------------------
# Policy version lifecycle store (draft -> simulated -> approved -> active -> retired)
# ---------------------------------------------------------------------------

_TRANSITIONS = {
    "draft": {"simulated", "retired"},
    "simulated": {"simulated", "approved", "retired"},
    "approved": {"active", "retired"},
    "active": {"retired"},
    "retired": set(),
}


def _versions(tenant: str) -> dict[str, Any]:
    return STATE["policies"].setdefault(tenant, {})


def _bump_patch(version: str) -> str:
    m = re.match(r"^(\d+)\.(\d+)\.(\d+)([-+].*)?$", version)
    if not m:
        return version
    return f"{m.group(1)}.{m.group(2)}.{int(m.group(3)) + 1}{m.group(4) or ''}"


class HttpError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status = status
        self.code = code


def policy_transition(tenant: str, version: str, to: str, **stamp: Any) -> dict[str, Any]:
    record = _versions(tenant).get(version)
    if record is None:
        raise HttpError(404, "NOT_FOUND", f"Policy version {version} for tenant {tenant} not found")
    if record["status"] != to and to not in _TRANSITIONS.get(record["status"], set()):
        raise HttpError(409, "CONFLICT", f"Illegal policyVersion transition {record['status']} -> {to}")
    record.update(stamp, status=to, updatedAt=now_iso())
    return copy.deepcopy(record)


def policy_activate(tenant: str, version: str, actor_id: str) -> tuple[dict[str, Any], dict[str, Any] | None]:
    """Activate a version and supersede the previously active one (retired)."""
    previous = next((r for r in _versions(tenant).values()
                     if r["status"] == "active" and r["version"] != version), None)
    activated = policy_transition(tenant, version, "active",
                                  activatedBy=actor_id, activatedAt=now_iso())
    superseded = None
    if previous is not None:
        superseded = policy_transition(tenant, previous["version"], "retired",
                                       retiredBy=actor_id, retiredAt=now_iso())
    return activated, superseded


def active_policy(tenant: str) -> dict[str, Any]:
    for record in _versions(tenant).values():
        if record["status"] == "active":
            return record
    # Fall back to re-seeding the legacy fixture policy (idempotent import).
    policy = copy.deepcopy(fixtures()["policy"])
    record = {**policy, "status": "active", "createdBy": "seed",
              "activatedBy": "seed", "activatedAt": now_iso()}
    _versions(tenant)[policy["version"]] = record
    return record


def pure_policy(record: dict[str, Any]) -> dict[str, Any]:
    """Strip lifecycle metadata — tenant-policy.json has additionalProperties: false."""
    return {k: v for k, v in record.items()
            if k not in {"status", "createdBy", "simulatedAt", "approvedBy", "approvedAt",
                         "activatedBy", "activatedAt", "retiredBy", "retiredAt"}}


# ---------------------------------------------------------------------------
# Capability manifest + tools
# ---------------------------------------------------------------------------


def capabilities() -> dict[str, Any]:
    return {
        "specVersion": "0.2",
        "implementationId": "osas-python-reference-candidate",
        "implementationVersion": "0.3.0-python",
        "profiles": [
            {"name": "core", "capabilities": ["case.read", "customer.read", "knowledge.read", "evidence.read"]},
            {"name": "ecommerce", "capabilities": ["ecommerce.order.read", "ecommerce.shipment.read",
                                                   "ecommerce.refund.propose", "ecommerce.refund.execute"]},
        ],
        "transports": ["http"],
        "executionModes": ["proposal_only", "shadow", "sandbox"],
        "adapterVersion": "python-reference-0.3.0",
        "executionContracts": [
            {
                "actionType": "refund",
                "supportedModes": ["proposal_only", "shadow", "sandbox"],
                "approvalRequired": True,
                "supportsIdempotency": True,
                "supportsReconciliation": True,
                "supportsCompensation": False,
            }
        ],
    }


def tools() -> list[dict[str, Any]]:
    items = []
    for entry in load_manifest()["schemas"]:
        if not entry["name"].startswith("tools/"):
            continue
        name = entry["name"].split("/", 1)[1]
        items.append({
            "name": name,
            "description": f"Python reference declaration for {name}",
            "inputSchema": SCHEMAS_BY_NAME.get(entry["name"], {"type": "object"}),
            "permissionRequired": "read" if re.search(r"_(get|list|search)_", name) else "draft",
            "capabilityRequired": TOOL_CAPABILITIES[name],
        })
    return items


def load_manifest() -> dict[str, Any]:
    return json.loads((SCHEMAS / "manifest.json").read_text())


# ---------------------------------------------------------------------------
# Proposal evaluation / execution
# ---------------------------------------------------------------------------


def resolve_customer(proposal: dict[str, Any]) -> dict[str, Any] | None:
    case = next((c for c in fixtures()["cases"] if c["id"] == proposal.get("caseId")), None)
    if case is None:
        return None
    return next((c for c in fixtures()["customers"] if c["id"] == case.get("customerId")), None)


def evaluate_stored(proposal: dict[str, Any], actor_id: str) -> dict[str, Any]:
    decision = evaluate(
        proposal,
        customer=resolve_customer(proposal),
        evidence=[e for e in fixtures()["evidence"] if e["id"] in proposal.get("evidenceIds", [])],
        policy=active_policy(proposal["tenantId"]),
        recent_proposals=list(STATE["proposals"].values()),
    )
    if decision["decision"] == "auto_execute":
        proposal["status"] = "approved"
    elif decision["decision"] == "require_approval":
        proposal["status"] = "pending_approval"
    else:
        proposal["status"] = "policy_rejected"
    proposal["updatedAt"] = now_iso()
    STATE["proposals"][proposal["id"]] = copy.deepcopy(proposal)
    STATE["decisions"][proposal["id"]] = copy.deepcopy(decision)
    return {"proposal": copy.deepcopy(proposal), "decision": decision}


def execute_stored(proposal: dict[str, Any], actor_id: str) -> dict[str, Any]:
    key = f"{proposal['tenantId']}:{proposal['idempotencyKey']}"
    prior = STATE["executions"].get(key)
    if prior:
        result = copy.deepcopy(prior)
        result["replayed"] = True
        return result
    if proposal.get("status") == "proposed":
        proposal = evaluate_stored(proposal, actor_id)["proposal"]
    if proposal.get("status") != "approved":
        raise HttpError(409, "CONFLICT", f"proposal status {proposal.get('status')} cannot execute")

    decision = STATE["decisions"].get(proposal["id"], {})
    params = apply_transforms(proposal.get("params", {}), decision.get("transforms", []))
    idem = proposal["idempotencyKey"]
    attempt = {
        "id": _id("attempt"),
        "specVersion": "0.3",
        "tenantId": proposal["tenantId"],
        "proposalId": proposal["id"],
        "idempotencyKey": idem,
        "mode": os.environ.get("OSAS_EXECUTION_MODE", "shadow"),
        "status": "started",
        "requestHash": hashlib.sha256(stable_json({
            k: proposal.get(k)
            for k in ("tenantId", "id", "actionType", "params", "amount", "idempotencyKey")
        }).encode()).hexdigest(),
        "startedAt": now_iso(),
    }
    simulate = params.get("simulate")
    if simulate == "timeout":
        execution = {"status": "uncertain", "providerStatus": "sandbox_unknown",
                     "safeToRetry": False, "detail": "sandbox timeout requested"}
        proposal_status = "reconciliation_required"
    elif simulate == "failure":
        execution = {"status": "failed", "providerStatus": "sandbox_failed",
                     "safeToRetry": False, "detail": "sandbox failure requested"}
        proposal_status = "failed"
    else:
        execution = {"status": "succeeded",
                     "externalRef": f"sandbox_refund_{len(STATE['executions']) + 1}",
                     "providerStatus": "sandbox_succeeded", "safeToRetry": False}
        proposal_status = "executed"
    attempt["status"] = execution["status"]
    attempt["finishedAt"] = now_iso()
    receipt = {
        "id": _id("receipt"),
        "specVersion": "0.3",
        "tenantId": proposal["tenantId"],
        "proposalId": proposal["id"],
        "attemptId": attempt["id"],
        "status": execution["status"],
        "providerStatus": execution.get("providerStatus"),
        "safeToRetry": False,
        "createdAt": now_iso(),
    }
    if execution.get("externalRef"):
        receipt["externalRef"] = execution["externalRef"]

    result: dict[str, Any] = {
        "proposalId": proposal["id"],
        "execution": copy.deepcopy(execution),
        "attempt": copy.deepcopy(attempt),
        "receipt": copy.deepcopy(receipt),
        "replayed": False,
    }
    if execution["status"] == "uncertain":
        reconciliation = {
            "id": _id("recon"),
            "specVersion": "0.3",
            "tenantId": proposal["tenantId"],
            "proposalId": proposal["id"],
            "attemptId": attempt["id"],
            "reason": execution["detail"],
            "queryKey": key,
            "status": "open",
            "createdAt": now_iso(),
        }
        STATE["reconciliations"][reconciliation["id"]] = copy.deepcopy(reconciliation)
        result["reconciliation"] = copy.deepcopy(reconciliation)
        audit(proposal["tenantId"], "reconciliation_required", "system", "python-reference",
              {"proposalId": proposal["id"], "attemptId": attempt["id"]}, proposalId=proposal["id"])
    else:
        audit(proposal["tenantId"],
              "execution_succeeded" if execution["status"] == "succeeded" else "execution_failed",
              "system", "python-reference",
              {"proposalId": proposal["id"], "status": execution["status"]}, proposalId=proposal["id"])

    proposal["status"] = proposal_status
    proposal["updatedAt"] = now_iso()
    STATE["proposals"][proposal["id"]] = copy.deepcopy(proposal)
    STATE["attempts"][attempt["id"]] = copy.deepcopy(attempt)
    STATE["receipts"][receipt["id"]] = copy.deepcopy(receipt)
    result["proposal"] = copy.deepcopy(proposal)
    STATE["executions"][key] = copy.deepcopy(result)
    return result


def create_proposal(body: dict[str, Any], tenant: str, actor_id: str) -> dict[str, Any]:
    required = ("caseId", "profile", "actionType", "reasonCode", "requestedPermission",
                "requestedBy", "idempotencyKey")
    missing = [f for f in required if f not in body]
    if missing or body.get("actionType") not in ACTION_TYPE_PROFILE:
        raise HttpError(422, "SCHEMA_INVALID",
                        f"proposal is missing/invalid fields: {', '.join(missing) or 'actionType'}")
    proposal = {
        "id": _id("prop"),
        "specVersion": "0.2",
        "tenantId": tenant,
        "caseId": body["caseId"],
        "profile": body["profile"],
        "actionType": body["actionType"],
        "reasonCode": body["reasonCode"],
        "params": copy.deepcopy(body.get("params", {})),
        "requestedPermission": body["requestedPermission"],
        "requestedBy": copy.deepcopy(body["requestedBy"]),
        "evidenceIds": copy.deepcopy(body.get("evidenceIds", [])),
        "idempotencyKey": body["idempotencyKey"],
        "status": "proposed",
        "createdAt": now_iso(),
        "updatedAt": now_iso(),
    }
    if "amount" in body:
        proposal["amount"] = copy.deepcopy(body["amount"])
    STATE["proposals"][proposal["id"]] = copy.deepcopy(proposal)
    audit(tenant, "proposal_created", "human", actor_id,
          {"proposalId": proposal["id"], "actionType": proposal["actionType"]},
          proposalId=proposal["id"], caseId=proposal["caseId"])
    return copy.deepcopy(proposal)


def ingest_provider_event(body: dict[str, Any], tenant: str, given_key: str) -> dict[str, Any]:
    expected = os.environ.get("OSAS_PROVIDER_EVENT_KEY", "")
    if not expected or not hmac.compare_digest(
        hashlib.sha256(given_key.encode()).digest(),
        hashlib.sha256(expected.encode()).digest(),
    ):
        raise HttpError(403, "FORBIDDEN", "invalid provider event key")
    event_key = f"{tenant}:{body.get('provider')}:{body.get('providerEventId')}"
    if event_key in STATE["provider_events"]:
        return {"duplicate": True, "event": copy.deepcopy(STATE["provider_events"][event_key])}
    stored = {**copy.deepcopy(body), "id": _id("provider_event"), "specVersion": "0.3",
              "tenantId": tenant, "createdAt": now_iso()}
    stored["payloadHash"] = hashlib.sha256(stable_json(body.get("payload", {})).encode()).hexdigest()
    STATE["provider_events"][event_key] = copy.deepcopy(stored)
    audit(tenant, "provider_event_received", "system", "python-reference",
          {"provider": body.get("provider"), "providerEventId": body.get("providerEventId")})
    result: dict[str, Any] = {"duplicate": False, "event": copy.deepcopy(stored)}
    proposal = next((p for p in STATE["proposals"].values()
                     if p.get("idempotencyKey") == body.get("idempotencyKey")
                     and p.get("tenantId") == tenant), None)
    task = next((r for r in STATE["reconciliations"].values()
                 if r["status"] == "open" and r["proposalId"] == (proposal or {}).get("id")), None)
    payload_status = (body.get("payload") or {}).get("status")
    if proposal and task and payload_status in ("succeeded", "failed"):
        task.update(status="resolved", resolvedBy=body.get("provider"), resolvedAt=now_iso())
        proposal["status"] = "executed" if payload_status == "succeeded" else "failed"
        proposal["updatedAt"] = now_iso()
        STATE["proposals"][proposal["id"]] = copy.deepcopy(proposal)
        result["proposal"] = copy.deepcopy(proposal)
        result["reconciliation"] = copy.deepcopy(task)
    return result


# ---------------------------------------------------------------------------
# HTTP layer
# ---------------------------------------------------------------------------


def snapshot(tenant: str) -> dict[str, Any]:
    f = fixtures()
    return {
        "tenantId": tenant,
        "counts": {
            "cases": len(f.get("cases", [])),
            "customers": len(f.get("customers", [])),
            "proposals": len(STATE["proposals"]),
            "policyVersions": len(_versions(tenant)),
            "auditEvents": len(STATE["audit"].get(tenant, [])),
        },
        "auditChain": verify_chain(STATE["audit"].get(tenant, [])),
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "OSASPythonReference/0.3"
    conformance_mode = os.environ.get("OSAS_CONFORMANCE_MODE") == "true"
    conformance_key = os.environ.get("OSAS_CONFORMANCE_KEY", "")

    def log_message(self, *_: Any) -> None:
        return

    # -- helpers ------------------------------------------------------------

    def send_json(self, status: int, body: Any) -> None:
        raw = json.dumps(body, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("content-length", "0") or "0")
        value = json.loads(self.rfile.read(length) or b"{}")
        return value if isinstance(value, dict) else {}

    @property
    def tenant(self) -> str:
        return self.headers.get("x-tenant-id", TENANT)

    @property
    def role(self) -> str:
        return self.headers.get("x-osas-role", "support_agent")

    @property
    def actor_id(self) -> str:
        return self.headers.get("x-osas-actor-id", "python-reference")

    def check_tenant(self, tenant: str) -> None:
        if tenant != self.tenant:
            raise HttpError(403, "TENANT_MISMATCH", f"tenant {tenant} is not the authenticated tenant")

    def require_policy_admin(self) -> None:
        if self.role != "policy_admin":
            raise HttpError(403, "POLICY_ADMIN_REQUIRED", "policy administration requires the policy_admin role")

    def check_conformance_key(self) -> None:
        given = hashlib.sha256(self.headers.get("x-osas-conformance-key", "").encode()).digest()
        expected = hashlib.sha256(self.conformance_key.encode()).digest()
        if not hmac.compare_digest(given, expected):
            raise HttpError(403, "FORBIDDEN", "invalid conformance key")

    def error(self, err: HttpError) -> None:
        self.send_json(err.status, {"error": {"code": err.code, "message": str(err)}})

    # -- routes ---------------------------------------------------------------

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        query = parse_qs(urlparse(self.path).query)
        try:
            if path == "/health":
                return self.send_json(200, {"status": "ok", "specVersion": "0.2", "version": "0.3.0-python"})
            if path == "/.well-known/osas":
                return self.send_json(200, {
                    "specVersion": "0.2",
                    "version": "0.3.0-python",
                    "executionMode": os.environ.get("OSAS_EXECUTION_MODE", "shadow"),
                    "capabilities": capabilities(),
                    "endpoints": {"capabilities": "/v1/capabilities", "schemas": "/v1/schemas",
                                  "executions": "/v1/executions/:id", "reconciliation": "/v1/reconciliation",
                                  "providerEvents": "/v1/provider-events"},
                })
            if path == "/v1/capabilities":
                return self.send_json(200, capabilities())
            if path == "/v1/meta/tools":
                return self.send_json(200, tools())
            if path == "/v1/schemas":
                return self.send_json(200, load_manifest())
            if path.startswith("/v1/schemas/"):
                name = unquote(path[len("/v1/schemas/"):])
                schema = SCHEMAS_BY_NAME.get(name)
                if schema is None:
                    raise HttpError(404, "NOT_FOUND", f"unknown schema {name}")
                return self.send_json(200, schema)
            if path.startswith("/v1/policies/"):
                tenant = path.rsplit("/", 1)[-1]
                self.check_tenant(tenant)
                if path.endswith("/versions"):
                    return self.send_json(200, list(_versions(tenant).values()))
                return self.send_json(200, pure_policy(active_policy(tenant)))
            if path.startswith("/v1/proposals/"):
                proposal = STATE["proposals"].get(path.rsplit("/", 1)[-1])
                if not proposal:
                    raise HttpError(404, "NOT_FOUND", path)
                return self.send_json(200, copy.deepcopy(proposal))
            if path.startswith("/v1/executions/"):
                attempt = STATE["attempts"].get(path.rsplit("/", 1)[-1])
                if not attempt:
                    raise HttpError(404, "NOT_FOUND", path)
                receipt = next((r for r in STATE["receipts"].values() if r["attemptId"] == attempt["id"]), None)
                return self.send_json(200, {"attempt": copy.deepcopy(attempt), "receipt": copy.deepcopy(receipt)})
            if path == "/v1/reconciliation":
                status = query.get("status", [None])[0]
                tasks = [r for r in STATE["reconciliations"].values() if status is None or r["status"] == status]
                return self.send_json(200, copy.deepcopy(tasks))
            if path == "/v1/audit":
                return self.send_json(200, copy.deepcopy(STATE["audit"].get(self.tenant, [])))
            if path == "/v1/audit/verify":
                return self.send_json(200, {"tenantId": self.tenant,
                                            **verify_chain(STATE["audit"].get(self.tenant, []))})
            if path == "/v1/conformance/snapshot":
                if not self.conformance_mode:
                    raise HttpError(404, "NOT_FOUND", path)
                self.check_conformance_key()
                return self.send_json(200, snapshot(self.tenant))
            raise HttpError(404, "NOT_FOUND", path)
        except HttpError as err:
            return self.error(err)

    def do_PUT(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        try:
            if path.startswith("/v1/policies/"):
                tenant = path.rsplit("/", 1)[-1]
                self.check_tenant(tenant)
                raise HttpError(409, "POLICY_IMMUTABLE",
                                "the active policy is immutable; use the versioned lifecycle endpoints")
            raise HttpError(404, "NOT_FOUND", path)
        except HttpError as err:
            return self.error(err)

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path
        body = self.read_json()
        try:
            if path == "/v1/validate":
                schema_name = body.get("schemaName")
                if not isinstance(schema_name, str):
                    raise HttpError(422, "SCHEMA_INVALID", "body requires schemaName")
                valid, errors = validate_against(schema_name, body.get("data"))
                return self.send_json(200, {"valid": valid, "errors": errors})

            if path == "/v1/conformance/reset":
                if not self.conformance_mode:
                    raise HttpError(404, "NOT_FOUND", path)
                self.check_conformance_key()
                reset_state(seed=True)
                audit(self.tenant, "conformance_reset", "system", "python-reference",
                      {"note": "conformance reset re-seeded the demo fixtures"})
                return self.send_json(200, {"reset": True, "snapshot": snapshot(self.tenant)})

            if path == "/v1/conformance/fixtures/load":
                if not self.conformance_mode:
                    raise HttpError(404, "NOT_FOUND", path)
                self.check_conformance_key()
                name = body.get("name")
                if name not in ("demo", "empty"):
                    raise HttpError(422, "SCHEMA_INVALID", 'body.name must be "demo" or "empty"')
                reset_state(seed=(name == "demo"))
                return self.send_json(200, {"loaded": name, "snapshot": snapshot(self.tenant)})

            if path == "/v1/proposals":
                return self.send_json(201, create_proposal(body, self.tenant, self.actor_id))

            if path.startswith("/v1/proposals/"):
                parts = path.split("/")
                proposal_id = parts[3]
                action = parts[4] if len(parts) > 4 else ""
                proposal = STATE["proposals"].get(proposal_id)
                if not proposal:
                    raise HttpError(404, "NOT_FOUND", path)
                if action == "evaluate":
                    return self.send_json(200, evaluate_stored(proposal, self.actor_id))
                if action == "execute":
                    return self.send_json(200, execute_stored(proposal, self.actor_id))
                if action == "reconcile":
                    outcome = body.get("outcome")
                    if outcome not in ("succeeded", "failed"):
                        raise HttpError(422, "SCHEMA_INVALID",
                                        'body must be { outcome: "succeeded" | "failed", note? }')
                    if proposal.get("status") != "reconciliation_required":
                        raise HttpError(409, "CONFLICT",
                                        f"proposal status {proposal.get('status')} cannot reconcile")
                    task = next((r for r in STATE["reconciliations"].values()
                                 if r["proposalId"] == proposal_id and r["status"] == "open"), None)
                    if task:
                        task.update(status="resolved", resolvedBy="human", resolvedAt=now_iso())
                    proposal["status"] = "executed" if outcome == "succeeded" else "failed"
                    proposal["updatedAt"] = now_iso()
                    STATE["proposals"][proposal_id] = copy.deepcopy(proposal)
                    audit(proposal["tenantId"], "reconciliation_resolved", "human", self.actor_id,
                          {"proposalId": proposal_id, "outcome": outcome, "note": body.get("note")},
                          proposalId=proposal_id)
                    return self.send_json(200, {"proposal": copy.deepcopy(proposal),
                                                "reconciliation": copy.deepcopy(task)})
                raise HttpError(404, "NOT_FOUND", path)

            if path.startswith("/v1/policies/"):
                parts = path.split("/")
                tenant = parts[3]
                self.check_tenant(tenant)

                if len(parts) == 5 and parts[4] == "drafts":
                    self.require_policy_admin()
                    if not isinstance(body.get("rules"), list):
                        raise HttpError(422, "SCHEMA_INVALID", "body must be a TenantPolicy object with rules")
                    versions = _versions(tenant)
                    latest = list(versions)[-1] if versions else "0.1.0"
                    candidate = {
                        **copy.deepcopy(body),
                        "id": body.get("id", _id("pol")),
                        "specVersion": "0.2",
                        "tenantId": tenant,
                        "version": body.get("version", _bump_patch(latest)),
                        "createdAt": body.get("createdAt", now_iso()),
                        "updatedAt": now_iso(),
                    }
                    valid, errors = validate_against("core/tenant-policy", candidate)
                    if not valid:
                        raise HttpError(422, "SCHEMA_INVALID",
                                        "; ".join(e["message"] for e in errors[:3]))
                    if candidate["version"] in versions:
                        raise HttpError(409, "CONFLICT",
                                        f"Policy version {candidate['version']} already exists; versions are immutable")
                    record = {**candidate, "status": "draft", "createdBy": self.actor_id}
                    versions[candidate["version"]] = record
                    audit(tenant, "policy_draft_created", "human", self.actor_id,
                          {"version": record["version"], "rules": len(record["rules"])},
                          policyVersion=record["version"])
                    return self.send_json(201, copy.deepcopy(record))

                if len(parts) == 5 and parts[4] == "simulate":
                    self.require_policy_admin()
                    version = body.get("version")
                    record = _versions(tenant).get(version)
                    if record is None:
                        raise HttpError(404, "NOT_FOUND",
                                        f"Policy version {version} for tenant {tenant} not found")
                    p = body.get("proposal") or {}
                    customer = body.get("customer")
                    if isinstance(customer, str):
                        customer = next((c for c in fixtures()["customers"] if c["id"] == customer), None)
                    proposal = {
                        "id": _id("sim"),
                        "specVersion": "0.2",
                        "tenantId": tenant,
                        "caseId": p.get("caseId", "case_simulation"),
                        "profile": p.get("profile"),
                        "actionType": p.get("actionType"),
                        "reasonCode": p.get("reasonCode", "other"),
                        "params": copy.deepcopy(p.get("params", {})),
                        "requestedPermission": "request-approval",
                        "requestedBy": {"actorType": "human", "actorId": "policy-simulation"},
                        "evidenceIds": copy.deepcopy(p.get("evidenceIds", [])),
                        "idempotencyKey": _id("sim"),
                        "status": "proposed",
                        "createdAt": now_iso(),
                        "updatedAt": now_iso(),
                    }
                    if "amount" in p:
                        proposal["amount"] = copy.deepcopy(p["amount"])
                    decision = evaluate(
                        proposal,
                        customer=customer,
                        evidence=body.get("evidence") or [],
                        policy=record,
                        recent_proposals=[],
                        injection_suspected=bool(body.get("injectionSuspected", False)),
                    )
                    simulated = policy_transition(tenant, version, "simulated", simulatedAt=now_iso())
                    audit(tenant, "policy_simulated", "human", self.actor_id,
                          {"version": version, "decision": decision["decision"],
                           "reasons": decision["reasons"]},
                          policyVersion=version)
                    return self.send_json(200, {"decision": decision, "policyVersion": simulated})

                if len(parts) == 7 and parts[4] == "versions":
                    self.require_policy_admin()
                    version, action = parts[5], parts[6]
                    record = _versions(tenant).get(version)
                    if record is None:
                        raise HttpError(404, "NOT_FOUND", f"Policy version {version} not found")
                    if action == "approve":
                        approved = policy_transition(tenant, version, "approved",
                                                     approvedBy=self.actor_id, approvedAt=now_iso())
                        audit(tenant, "policy_approved", "human", self.actor_id,
                              {"version": version}, policyVersion=version)
                        return self.send_json(200, approved)
                    if action == "activate":
                        activated, superseded = policy_activate(tenant, version, self.actor_id)
                        audit(tenant, "policy_activated", "human", self.actor_id,
                              {"previousVersion": superseded["version"] if superseded else None,
                               "newVersion": version},
                              policyVersion=version)
                        result: dict[str, Any] = {"activated": activated}
                        if superseded is not None:
                            audit(tenant, "policy_retired", "system", "python-reference",
                                  {"version": superseded["version"], "supersededBy": version},
                                  policyVersion=superseded["version"])
                            result["superseded"] = superseded
                        return self.send_json(200, result)
                    if action == "retire":
                        retired = policy_transition(tenant, version, "retired",
                                                    retiredBy=self.actor_id, retiredAt=now_iso())
                        audit(tenant, "policy_retired", "human", self.actor_id,
                              {"version": version}, policyVersion=version)
                        return self.send_json(200, retired)
                    raise HttpError(404, "NOT_FOUND", path)

                raise HttpError(404, "NOT_FOUND", path)

            if path == "/v1/provider-events":
                result = ingest_provider_event(body, self.tenant,
                                               self.headers.get("x-osas-provider-key", ""))
                return self.send_json(200, result)

            raise HttpError(404, "NOT_FOUND", path)
        except HttpError as err:
            return self.error(err)
        except json.JSONDecodeError as exc:
            return self.error(HttpError(400, "BAD_JSON", str(exc)))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=3010)
    args = parser.parse_args()

    if os.environ.get("OSAS_EXECUTION_MODE") == "live":
        print("LIVE_EXECUTION_NOT_AVAILABLE_IN_V0_1_1: live execution requires a future RFC", file=sys.stderr)
        sys.exit(1)
    if os.environ.get("OSAS_CONFORMANCE_MODE") == "true" and not os.environ.get("OSAS_CONFORMANCE_KEY"):
        print("CONFORMANCE_CONFIG_INVALID: OSAS_CONFORMANCE_MODE requires OSAS_CONFORMANCE_KEY", file=sys.stderr)
        sys.exit(1)
    if os.environ.get("NODE_ENV") == "production" and os.environ.get("OSAS_CONFORMANCE_MODE") == "true":
        print("CONFORMANCE_IN_PRODUCTION: conformance mode is test-only", file=sys.stderr)
        sys.exit(1)

    reset_state(seed=True)
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
