import json
import unittest

from server import (
    capabilities,
    create_proposal,
    execute_proposal,
    ingest_provider_event,
    policy,
    reset_state,
)


class PythonReferenceContractTest(unittest.TestCase):
    def test_declares_sandbox_without_live(self):
        manifest = capabilities()
        self.assertIn("sandbox", manifest["executionModes"])
        self.assertNotIn("live", manifest["executionModes"])
        self.assertEqual(manifest["executionContracts"][0]["actionType"], "refund")

    def test_policy_is_tenant_scoped(self):
        self.assertEqual(policy()["tenantId"], "tenant_demo")
        self.assertEqual(policy()["defaultDecision"], "block")

    def test_sandbox_success_replays_by_idempotency_key(self):
        reset_state()
        proposal = create_proposal({
            "caseId": "case_refund",
            "actionType": "refund",
            "params": {"orderId": "ord_small"},
            "amount": {"currency": "USD", "minorUnits": 2500},
            "evidenceIds": ["ev_ord_small"],
            "idempotencyKey": "py-idem-success",
        })
        first = execute_proposal(proposal, "sandbox")
        second = execute_proposal(proposal, "sandbox")
        self.assertEqual(first["execution"]["status"], "succeeded")
        self.assertFalse(first["replayed"])
        self.assertTrue(second["replayed"])

    def test_uncertain_provider_event_resolves_once(self):
        reset_state()
        proposal = create_proposal({
            "caseId": "case_refund",
            "actionType": "refund",
            "params": {"orderId": "ord_small", "simulate": "timeout"},
            "amount": {"currency": "USD", "minorUnits": 2500},
            "evidenceIds": ["ev_ord_small"],
            "idempotencyKey": "py-idem-uncertain",
        })
        result = execute_proposal(proposal, "sandbox")
        self.assertEqual(result["execution"]["status"], "uncertain")
        self.assertEqual(result["reconciliation"]["status"], "open")
        event = ingest_provider_event({
            "provider": "sandbox",
            "providerEventId": "py-event-1",
            "eventType": "refund.succeeded",
            "idempotencyKey": "py-idem-uncertain",
            "payload": {"status": "succeeded"},
        }, "py-provider-key")
        self.assertFalse(event["duplicate"])
        self.assertEqual(event["reconciliation"]["status"], "resolved")
        duplicate = ingest_provider_event({
            "provider": "sandbox",
            "providerEventId": "py-event-1",
            "eventType": "refund.succeeded",
            "idempotencyKey": "py-idem-uncertain",
            "payload": {"status": "succeeded"},
        }, "py-provider-key")
        self.assertTrue(duplicate["duplicate"])


if __name__ == "__main__":
    unittest.main()
