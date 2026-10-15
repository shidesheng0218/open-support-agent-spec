# Slack approval cards

[中文](slack-approvals.zh-CN.md)

When the policy engine returns `require_approval`, OSAS can post a card to a
Slack channel. An approver clicks Approve or Reject. The click goes through the
same code as `POST /v1/approvals/:id/decide` (`decideApprovalCore`), so expiry,
audit, and the `actionDigest` check at execution behave identically.

Status: covered by unit tests with a faked Slack HTTP client. **Not** run
against a real Slack workspace.

## Configure

All four variables are required together. Setting only some fails startup.

```bash
SLACK_BOT_TOKEN=xoxb-...             # scope: chat:write
SLACK_SIGNING_SECRET=...             # at least 16 characters
SLACK_APPROVAL_CHANNEL=C0123ABCD     # a channel ID, not a name; invite the bot
OSAS_SLACK_APPROVERS=U0123ABCD=tenant_demo:alice,U0456EFGH=tenant_demo:bob
# optional
SLACK_TEAM_ID=T0123ABCD
```

In the Slack app, enable Interactivity and set the request URL to
`https://<your-host>/v1/webhooks/slack/interactivity`. Slack must reach this
URL, so a local OSAS needs a tunnel or a public host.

## What is enforced

- Signature: `X-Slack-Signature` is verified over the exact request bytes with a
  300 second window. Any failure returns the same 401.
- Who may decide: only Slack users listed in `OSAS_SLACK_APPROVERS`. Each maps to
  one OSAS approver id and one tenant, and the approval is read through that
  tenant, so an approver for tenant A cannot reach tenant B.
- What is approved: the button carries the approval's `actionDigest`. A click is
  refused if the digest differs, or if the proposal no longer hashes to it.
- One decision: a second click finds the approval already decided and does nothing.
- Expired approvals are denied, as with the REST route.
- Where: clicks from another channel, or another workspace when `SLACK_TEAM_ID`
  is set, are ignored.
- Cards contain the action, amount, reason, order id, ids and a digest prefix.
  They never contain customer text or contact details. Interpolated text is
  escaped for Slack mrkdwn.
- A Slack outage never fails the evaluation that created the approval; the card
  is simply not posted and the approval stays pending in the console.
- No cards are posted for a tenant that has no mapped approver.

## Limits

- Slack authenticates the user, but OSAS trusts the id-to-approver mapping you
  configure. Review that list like an access list.
- The Slack user id is stored in the approval comment; the audit actor is the
  mapped OSAS approver id.
- Cards are posted when the approval is created, once. There is no retry queue
  and no reminder for undecided approvals.
- Approvals created by the REST route or by the Chatwoot shadow worker are
  separate paths. The shadow worker never creates an approval.
- Not verified: a real Slack workspace, Slack retries of the same click,
  Postgres storage, concurrent clicks from two approvers.
