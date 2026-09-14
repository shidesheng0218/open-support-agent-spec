import os
import unittest

os.environ.setdefault("OSAS_PROVIDER_EVENT_KEY", "py-provider-key")

from server import (  # noqa: E402
    GENESIS_HASH,
    HttpError,
    active_policy,
    audit,
    capabilities,
    create_proposal,
    evaluate,
    evaluate_stored,
    execute_stored,
    fixtures,
    hash_event,
    ingest_provider_event,
    load_demo_fixtures,
    policy_activate,
    policy_transition,
    pure_policy,
    reset_state,
    validate_against,
    verify_chain,
)


def refund_body(**over):
    body = {
        "caseId": "case_refund",
        "profile": "ecommerce",
        "actionType": "refund",
        "reasonCode": "damaged",
        "params": {"orderId": "ord_small"},
        "requestedPermission": "request-approval",
        "requestedBy": {"actorType": "human", "actorId": "test"},
        "amount": {"currency": "USD", "minorUnits": 2500},
        "evidenceIds": ["ev_ord_small"],
        "idempotencyKey": "py-test-idem",
    }
    body.update(over)
    return body


class PythonReferenceContractTest(unittest.TestCase):
    def setUp(self):
        reset_state(seed=True)

    def test_declares_sandbox_without_live(self):
        manifest = capabilities()
        self.assertIn("sandbox", manifest["executionModes"])
        self.assertNotIn("live", manifest["executionModes"])
        self.assertEqual(manifest["executionContracts"][0]["actionType"], "refund")

    def test_fixtures_materialize_relative_tokens(self):
        f = load_demo_fixtures()
        verified = next(c for c in f["customers"] if c["id"] == "cus_verified")
        self.assertTrue(verified["identityVerification"]["verifiedAt"].endswith("Z"))
        self.assertNotIn("now", verified["createdAt"])
        policy = f["policy"]
        self.assertEqual(policy["id"], "pol_demo")
        self.assertEqual(policy["rules"][0]["maxAmount"]["minorUnits"], 5000)

    def test_evaluation_matrix(self):
        f = fixtures()
        policy = active_policy("tenant_demo")
        verified = next(c for c in f["customers"] if c["id"] == "cus_verified")
        unverified = next(c for c in f["customers"] if c["id"] == "cus_unverified")
        fresh = [e for e in f["evidence"] if e["id"] == "ev_ord_small"]

        proposal = create_proposal(refund_body(), "tenant_demo", "test")
        decision = evaluate(proposal, customer=verified, evidence=fresh,
                            policy=policy, recent_proposals=[])
        self.assertEqual(decision["decision"], "auto_execute")

        big = {**proposal, "amount": {"currency": "USD", "minorUnits": 90000}}
        decision = evaluate(big, customer=verified, evidence=fresh,
                            policy=policy, recent_proposals=[])
        self.assertEqual(decision["decision"], "require_approval")
        self.assertIn("OVER_THRESHOLD", [r["code"] for r in decision["reasons"]])

        decision = evaluate(proposal, customer=unverified, evidence=fresh,
                            policy=policy, recent_proposals=[])
        self.assertEqual(decision["decision"], "block")
        self.assertIn("IDENTITY_UNVERIFIED", [r["code"] for r in decision["reasons"]])

        overreach = {**proposal, "requestedPermission": "execute",
                     "requestedBy": {"actorType": "model", "actorId": "m"}}
        decision = evaluate(overreach, customer=verified, evidence=fresh,
                            policy=policy, recent_proposals=[])
        self.assertEqual(decision["decision"], "block")
        self.assertIn("PERMISSION_OVERREACH", [r["code"] for r in decision["reasons"]])

    def test_execute_replays_by_idempotency_key(self):
        proposal = create_proposal(refund_body(), "tenant_demo", "test")
        evaluate_stored(proposal, "test")
        first = execute_stored(proposal, "test")
        second = execute_stored(proposal, "test")
        self.assertEqual(first["execution"]["status"], "succeeded")
        self.assertFalse(first["replayed"])
        self.assertTrue(second["replayed"])
        self.assertEqual(first["attempt"]["id"], second["attempt"]["id"])

    def test_uncertain_provider_event_resolves_once(self):
        proposal = create_proposal(
            refund_body(params={"orderId": "ord_small", "simulate": "timeout"}),
            "tenant_demo", "test")
        evaluate_stored(proposal, "test")
        result = execute_stored(proposal, "test")
        self.assertEqual(result["execution"]["status"], "uncertain")
        self.assertEqual(result["reconciliation"]["status"], "open")
        event = {
            "provider": "sandbox",
            "providerEventId": "py-event-1",
            "eventType": "refund.succeeded",
            "idempotencyKey": "py-test-idem",
            "payload": {"status": "succeeded"},
        }
        first = ingest_provider_event(event, "tenant_demo", "py-provider-key")
        self.assertFalse(first["duplicate"])
        self.assertEqual(first["reconciliation"]["status"], "resolved")
        duplicate = ingest_provider_event(event, "tenant_demo", "py-provider-key")
        self.assertTrue(duplicate["duplicate"])

    def test_audit_chain_intact_and_tamper_evident(self):
        audit("tenant_demo", "policy_draft_created", "human", "tester", {"version": "1.0.1"})
        audit("tenant_demo", "policy_activated", "human", "tester", {"newVersion": "1.0.1"})
        stream = self._stream()
        self.assertEqual(stream[0]["previousHash"], GENESIS_HASH)
        self.assertTrue(verify_chain(stream)["intact"])
        tampered = [dict(e) for e in stream]
        tampered[0]["detail"] = {"version": "9.9.9"}
        result = verify_chain(tampered)
        self.assertFalse(result["intact"])
        self.assertEqual(result["firstError"]["reason"], "event_hash_mismatch")

    def test_policy_lifecycle(self):
        with self.assertRaises(HttpError) as ctx:
            policy_transition("tenant_demo", "1.0.0", "approved")
        self.assertEqual(ctx.exception.status, 409)
        record = self._make_draft("1.0.1")
        self.assertEqual(record["status"], "draft")
        with self.assertRaises(HttpError):
            policy_transition("tenant_demo", "1.0.1", "approved")
        policy_transition("tenant_demo", "1.0.1", "simulated", simulatedAt="now")
        policy_transition("tenant_demo", "1.0.1", "approved")
        activated, superseded = policy_activate("tenant_demo", "1.0.1", "test")
        self.assertEqual(activated["status"], "active")
        self.assertEqual(superseded["version"], "1.0.0")
        self.assertEqual(active_policy("tenant_demo")["version"], "1.0.1")
        # The previous active version was superseded to retired.
        self.assertEqual(self._versions()["1.0.0"]["status"], "retired")

    def test_validate_endpoint_semantics(self):
        valid, errors = validate_against("core/tenant-policy", pure_policy(active_policy("tenant_demo")))
        self.assertTrue(valid, errors)
        invalid, _ = validate_against("core/tenant-policy", {"specVersion": "0.2"})
        self.assertFalse(invalid)
        unknown, _ = validate_against("core/does-not-exist", {})
        self.assertFalse(unknown)

    # -- helpers -------------------------------------------------------------

    def _stream(self):
        from server import STATE
        return STATE["audit"]["tenant_demo"]

    def _versions(self):
        from server import STATE
        return STATE["policies"]["tenant_demo"]

    def _make_draft(self, version):
        record = {
            "id": f"pol_test_{version}",
            "specVersion": "0.2",
            "tenantId": "tenant_demo",
            "version": version,
            "effectiveFrom": "2026-01-01T00:00:00.000Z",
            "duplicateWindowSeconds": 86400,
            "maxEvidenceAgeSeconds": 604800,
            "defaultDecision": "block",
            "rules": [{"actionType": "refund", "decision": "auto_execute"}],
            "createdAt": "2026-01-01T00:00:00.000Z",
            "updatedAt": "2026-01-01T00:00:00.000Z",
            "status": "draft",
            "createdBy": "test",
        }
        self._versions()[version] = record
        return record


if __name__ == "__main__":
    unittest.main()
