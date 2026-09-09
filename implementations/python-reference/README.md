# OSAS Python Reference Candidate

This directory is a dependency-free Python adoption sample for the OSAS v0.2
HTTP surface plus the v0.3 Controlled Execution Sandbox contract.

It is intentionally small and safe:

- no external network calls;
- no real provider credentials;
- deterministic Sandbox execution for refund success, failure, timeout,
  idempotency, receipts, reconciliation, and Provider Event deduplication;
- no production Live execution;
- synthetic policy and schema responses only.

Run it from the repository root:

```bash
python3 implementations/python-reference/server.py --port 3010
```

The implementation is an adoption sample, not yet an independent governance
implementation. To count toward the v1.0 gate, publish it as a separate
repository and run the black-box compatibility suite against it. Its
in-repository tests can be run with:

```bash
python3 -m unittest discover -s implementations/python-reference -p 'test_*.py'
```
