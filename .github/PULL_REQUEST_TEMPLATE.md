<!--
Thanks for contributing. Delete this comment and fill in the sections below.
Security fixes: do NOT open a public PR — follow SECURITY.md first.
-->

## Summary

<!-- What does this PR change, and why? Link issues / RFCs. -->

## Checklist

- [ ] `pnpm typecheck`, `pnpm test`, `pnpm build` pass locally.
- [ ] `pnpm test:compat` passes; the report is regenerated when relevant.
- [ ] Schemas, prose docs, and implementation agree (the schema is the authority).
- [ ] EN and ZH documents are updated together, as complete equivalents.
- [ ] Breaking or new-semantics changes reference an **Accepted** RFC: <!-- rfcs/NNNN-… -->
- [ ] `CHANGELOG.md` has an entry under Unreleased (or the target version).
- [ ] No real customer data, credentials, or secrets are added anywhere.
- [ ] Every commit is signed off (`git commit -s`) per the [DCO](../DCO).

## Release gate (spec changes only)

If this PR changes spec semantics, confirm the gate: schemas, EN+ZH docs,
reference implementation, and compat tests all change in this PR.

- [ ] N/A — editorial/tooling/test-only change
- [ ] Gate satisfied — all four artifact kinds are included
