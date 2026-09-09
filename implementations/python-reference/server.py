#!/usr/bin/env python3
"""Dependency-free OSAS Python reference candidate.

This sample implements the safe HTTP discovery surface plus deterministic v0.3
Sandbox execution. It never reads provider credentials, calls external
networks, or enables Live execution.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parents[2]
SCHEMAS = ROOT / "schemas"
TENANT = "tenant_demo"

STATE: dict[str, dict[str, Any]] = {
    "proposals": {},
    "executions": {},
    "attempts": {},
    "receipts": {},
    "reconciliations": {},
    "events": {},
}


def now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def clone(value: Any) -> Any:
    return copy.deepcopy(value)


def reset_state() -> None:
    for value in STATE.values():
        value.clear()


def load_manifest() -> dict[str, Any]:
    return json.loads((SCHEMAS / "manifest.json").read_text())


def tools() -> list[dict[str, Any]]:
    items = []
    for entry in load_manifest()["schemas"]:
        if not entry["name"].startswith("tools/"):
            continue
        name = entry["name"].split("/", 1)[1]
        items.append(
            {
                "name": name,
                "profile": "core" if name.startswith("osas_core_") else "ecommerce" if name.startswith("osas_ecom_") else "saas",
                "description": "Python reference tool declaration",
                "inputSchema": {"type": "object", "additionalProperties": True, "properties": {}},
                "adapterMethod": "readOnlyReference",
                "permissionRequired": "read",
                "capabilityRequired": "case.read" if name.startswith("osas_core_") else "ecommerce.order.read" if name.startswith("osas_ecom_") else "saas.subscription.read",
            }
        )
    return items


def capabilities() -> dict[str, Any]:
    return {
        "specVersion": "0.2",
        "implementationId": "osas-python-reference-candidate",
        "implementationVersion": "0.3.0-python",
        "profiles": [
            {"name": "core", "capabilities": ["case.read", "customer.read", "knowledge.read", "evidence.read"]},
            {"name": "ecommerce", "capabilities": ["ecommerce.order.read", "ecommerce.shipment.read", "ecommerce.refund.propose", "ecommerce.refund.execute"]},
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


def policy() -> dict[str, Any]:
    return {
        "id": "policy_python_demo",
        "specVersion": "0.2",
        "tenantId": TENANT,
        "version": "1.0.0",
        "effectiveFrom": "2026-01-01T00:00:00.000Z",
        "duplicateWindowSeconds": 86400,
        "maxEvidenceAgeSeconds": 604800,
        "rules": [{"actionType": "refund", "decision": "auto_execute", "maxAmount": {"currency": "USD", "minorUnits": 5000}}],
        "defaultDecision": "block",
        "createdAt": "2026-01-01T00:00:00.000Z",
        "updatedAt": "2026-01-01T00:00:00.000Z",
    }


def _id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def create_proposal(payload: dict[str, Any]) -> dict[str, Any]:
    proposal = {
        "id": payload.get("id", _id("prop")),
        "specVersion": "0.2",
        "tenantId": payload.get("tenantId", TENANT),
        "caseId": payload.get("caseId", "case_refund"),
        "profile": payload.get("profile", "ecommerce"),
        "actionType": payload.get("actionType", "refund"),
        "reasonCode": payload.get("reasonCode", "damaged"),
        "params": clone(payload.get("params", {})),
        "requestedPermission": payload.get("requestedPermission", "request-approval"),
        "requestedBy": clone(payload.get("requestedBy", {"actorType": "human", "actorId": "python-reference"})),
        "amount": clone(payload.get("amount", {"currency": "USD", "minorUnits": 2500})),
        "evidenceIds": clone(payload.get("evidenceIds", ["ev_ord_small"])),
        "idempotencyKey": payload.get("idempotencyKey", _id("idem")),
        "status": "proposed",
        "createdAt": now(),
        "updatedAt": now(),
    }
    STATE["proposals"][proposal["id"]] = clone(proposal)
    return clone(proposal)


def evaluate_proposal(proposal: dict[str, Any]) -> dict[str, Any]:
    reasons: list[dict[str, str]] = []
    if proposal.get("actionType") != "refund":
        reasons.append({"code": "NO_RULE", "message": "no sandbox rule for this action"})
        decision = "block"
    elif not proposal.get("evidenceIds"):
        reasons.append({"code": "INSUFFICIENT_EVIDENCE", "message": "at least one evidence id is required"})
        decision = "block"
    elif int(proposal.get("amount", {}).get("minorUnits", 0)) > 5000:
        reasons.append({"code": "OVER_THRESHOLD", "message": "refund exceeds sandbox auto threshold"})
        decision = "require_approval"
    else:
        decision = "auto_execute"
    if decision == "auto_execute":
        proposal["status"] = "approved"
    elif decision == "require_approval":
        proposal["status"] = "pending_approval"
    else:
        proposal["status"] = "policy_rejected"
    proposal["updatedAt"] = now()
    STATE["proposals"][proposal["id"]] = clone(proposal)
    return {"proposal": clone(proposal), "decision": {"decision": decision, "reasons": reasons, "policyVersion": "1.0.0", "evaluatedAt": now()}}


def _request_hash(proposal: dict[str, Any]) -> str:
    raw = json.dumps(
        {k: proposal.get(k) for k in ("tenantId", "id", "actionType", "params", "amount", "idempotencyKey")},
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
    return hashlib.sha256(raw).hexdigest()


def execute_proposal(proposal: dict[str, Any], mode: str) -> dict[str, Any]:
    if mode != "sandbox":
        raise ValueError("proposal_only and shadow modes are simulation-only")
    idem = str(proposal["idempotencyKey"])
    prior = STATE["executions"].get(f"{proposal['tenantId']}:{idem}")
    if prior:
        return {**clone(prior), "replayed": True}
    if proposal.get("status") == "proposed":
        evaluated = evaluate_proposal(proposal)
        proposal = evaluated["proposal"]
    if proposal.get("status") != "approved":
        raise ValueError(f"proposal status {proposal.get('status')} cannot execute")
    attempt = {
        "id": _id("attempt"),
        "specVersion": "0.3",
        "tenantId": proposal["tenantId"],
        "proposalId": proposal["id"],
        "idempotencyKey": idem,
        "mode": mode,
        "status": "started",
        "requestHash": _request_hash(proposal),
        "startedAt": now(),
    }
    simulate = proposal.get("params", {}).get("simulate")
    if simulate == "timeout":
        execution = {"status": "uncertain", "providerStatus": "sandbox_unknown", "safeToRetry": False, "detail": "sandbox timeout requested"}
        proposal_status = "reconciliation_required"
    elif simulate == "failure":
        execution = {"status": "failed", "providerStatus": "sandbox_failed", "safeToRetry": False, "detail": "sandbox failure requested"}
        proposal_status = "failed"
    else:
        execution = {"status": "succeeded", "externalRef": f"sandbox_refund_{len(STATE['executions']) + 1}", "providerStatus": "sandbox_succeeded", "safeToRetry": False}
        proposal_status = "executed"
    attempt["status"] = execution["status"]
    attempt["finishedAt"] = now()
    receipt = {
        "id": _id("receipt"),
        "specVersion": "0.3",
        "tenantId": proposal["tenantId"],
        "proposalId": proposal["id"],
        "attemptId": attempt["id"],
        "status": execution["status"],
        "providerStatus": execution.get("providerStatus"),
        "safeToRetry": False,
        "createdAt": now(),
    }
    if execution.get("externalRef"):
        receipt["externalRef"] = execution["externalRef"]
    reconciliation = None
    if execution["status"] == "uncertain":
        reconciliation = {
            "id": _id("recon"),
            "specVersion": "0.3",
            "tenantId": proposal["tenantId"],
            "proposalId": proposal["id"],
            "attemptId": attempt["id"],
            "reason": execution["detail"],
            "queryKey": f"{proposal['tenantId']}:{idem}",
            "status": "open",
            "createdAt": now(),
        }
        STATE["reconciliations"][reconciliation["id"]] = clone(reconciliation)
    proposal["status"] = proposal_status
    proposal["updatedAt"] = now()
    STATE["proposals"][proposal["id"]] = clone(proposal)
    STATE["attempts"][attempt["id"]] = clone(attempt)
    STATE["receipts"][receipt["id"]] = clone(receipt)
    result = {"proposal": clone(proposal), "execution": clone(execution), "attempt": clone(attempt), "receipt": clone(receipt), "replayed": False}
    if reconciliation:
        result["reconciliation"] = clone(reconciliation)
    STATE["executions"][f"{proposal['tenantId']}:{idem}"] = clone(result)
    return result


def ingest_provider_event(event: dict[str, Any], key: str) -> dict[str, Any]:
    expected = os.environ.get("OSAS_PROVIDER_EVENT_KEY", "py-provider-key")
    if key != expected:
        raise PermissionError("invalid provider event key")
    event_key = f"{TENANT}:{event['provider']}:{event['providerEventId']}"
    if event_key in STATE["events"]:
        return {"duplicate": True, "event": clone(STATE["events"][event_key])}
    stored = {**clone(event), "id": _id("provider_event"), "specVersion": "0.3", "tenantId": TENANT, "createdAt": now()}
    stored["payloadHash"] = hashlib.sha256(json.dumps(event.get("payload", {}), sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    STATE["events"][event_key] = clone(stored)
    proposal = next((p for p in STATE["proposals"].values() if p.get("idempotencyKey") == event.get("idempotencyKey") and p.get("tenantId") == TENANT), None)
    reconciliation = next((r for r in STATE["reconciliations"].values() if r.get("status") == "open" and r.get("proposalId") == (proposal or {}).get("id")), None)
    result: dict[str, Any] = {"duplicate": False, "event": clone(stored)}
    if proposal and reconciliation and event.get("payload", {}).get("status") in {"succeeded", "failed"}:
        reconciliation["status"] = "resolved"
        reconciliation["resolvedBy"] = event["provider"]
        reconciliation["resolvedAt"] = now()
        proposal["status"] = "executed" if event["payload"]["status"] == "succeeded" else "failed"
        STATE["reconciliations"][reconciliation["id"]] = clone(reconciliation)
        STATE["proposals"][proposal["id"]] = clone(proposal)
        result["proposal"] = clone(proposal)
        result["reconciliation"] = clone(reconciliation)
    return result


class Handler(BaseHTTPRequestHandler):
    server_version = "OSASPythonReference/0.3"

    def log_message(self, *_: Any) -> None:
        return

    def send_json(self, status: int, body: Any) -> None:
        raw = json.dumps(body, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("content-length", "0"))
        value = json.loads(self.rfile.read(length) or b"{}")
        return value if isinstance(value, dict) else {}

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path
        if path == "/health":
            return self.send_json(200, {"status": "ok", "specVersion": "0.2", "version": "0.3.0-python"})
        if path == "/.well-known/osas":
            return self.send_json(200, {"specVersion": "0.2", "version": "0.3.0-python", "executionMode": os.environ.get("OSAS_EXECUTION_MODE", "shadow"), "capabilities": capabilities(), "endpoints": {"capabilities": "/v1/capabilities", "schemas": "/v1/schemas", "executions": "/v1/executions/:id", "reconciliation": "/v1/reconciliation", "providerEvents": "/v1/provider-events"}})
        if path == "/v1/capabilities":
            return self.send_json(200, capabilities())
        if path == "/v1/meta/tools":
            return self.send_json(200, tools())
        if path == "/v1/schemas":
            return self.send_json(200, load_manifest())
        if path == "/v1/policies/tenant_demo":
            return self.send_json(200, policy())
        if path.startswith("/v1/proposals/"):
            proposal = STATE["proposals"].get(path.rsplit("/", 1)[-1])
            return self.send_json(200, clone(proposal)) if proposal else self.send_json(404, {"error": {"code": "NOT_FOUND", "message": path}})
        if path.startswith("/v1/executions/"):
            attempt = STATE["attempts"].get(path.rsplit("/", 1)[-1])
            if not attempt:
                return self.send_json(404, {"error": {"code": "NOT_FOUND", "message": path}})
            receipt = next((r for r in STATE["receipts"].values() if r["attemptId"] == attempt["id"]), None)
            return self.send_json(200, {"attempt": clone(attempt), "receipt": clone(receipt)})
        if path == "/v1/reconciliation":
            status = parse_qs(parsed.query).get("status", [None])[0]
            tasks = [r for r in STATE["reconciliations"].values() if status is None or r["status"] == status]
            return self.send_json(200, clone(tasks))
        if path == "/v1/audit/verify":
            return self.send_json(200, {"intact": True, "chainLength": 0})
        if path == "/v1/audit":
            return self.send_json(200, [])
        return self.send_json(404, {"error": {"code": "NOT_FOUND", "message": path}})

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path
        body = self.read_json()
        try:
            if path == "/v1/validate":
                data = body.get("data")
                valid = isinstance(data, dict) and data.get("specVersion") in {"0.2", "0.3"}
                return self.send_json(200, {"valid": valid, "errors": [] if valid else [{"message": "reference validator requires an object with a supported specVersion"}]})
            if path == "/v1/conformance/reset":
                if self.headers.get("x-osas-conformance-key") != os.environ.get("OSAS_CONFORMANCE_KEY", ""):
                    return self.send_json(403, {"error": {"code": "FORBIDDEN", "message": "invalid conformance key"}})
                reset_state()
                return self.send_json(200, {"reset": True, "snapshot": {"counts": {"cases": 1, "proposals": 0}}})
            if path == "/v1/proposals":
                return self.send_json(201, create_proposal(body))
            if path.startswith("/v1/proposals/") and path.endswith("/evaluate"):
                proposal_id = path.split("/")[-2]
                proposal = STATE["proposals"].get(proposal_id)
                if not proposal:
                    return self.send_json(404, {"error": {"code": "NOT_FOUND", "message": path}})
                return self.send_json(200, evaluate_proposal(proposal))
            if path.startswith("/v1/proposals/") and path.endswith("/execute"):
                proposal_id = path.split("/")[-2]
                proposal = STATE["proposals"].get(proposal_id)
                if not proposal:
                    return self.send_json(404, {"error": {"code": "NOT_FOUND", "message": path}})
                result = execute_proposal(proposal, os.environ.get("OSAS_EXECUTION_MODE", "shadow"))
                return self.send_json(200, result)
            if path == "/v1/provider-events":
                result = ingest_provider_event(body, self.headers.get("x-osas-provider-key", ""))
                return self.send_json(200, result)
            return self.send_json(404, {"error": {"code": "NOT_FOUND", "message": path}})
        except PermissionError as exc:
            return self.send_json(403, {"error": {"code": "FORBIDDEN", "message": str(exc)}})
        except ValueError as exc:
            return self.send_json(409, {"error": {"code": "CONFLICT", "message": str(exc)}})


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=3010)
    args = parser.parse_args()
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
