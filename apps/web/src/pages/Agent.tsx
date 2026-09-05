import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { ErrorBox, money, RawToggle, Section, StatusBadge } from "../components";
import type { ApprovalWithProposal, DecideResponse, HumanHandoff } from "../types";

function ApprovalCard({ approval, onDecided }: { approval: ApprovalWithProposal; onDecided: () => void }) {
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<DecideResponse | null>(null);
  const p = approval.proposal;

  const decide = async (decision: "approved" | "rejected") => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<DecideResponse>(`/v1/approvals/${approval.id}/decide`, {
        decision,
        approverId: "agent_console",
        comment: comment || undefined,
      });
      setResult(res);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel" data-testid="approval-card">
      <div className="btn-row" style={{ justifyContent: "space-between" }}>
        <strong className="mono">{p?.actionType ?? approval.proposalId}</strong>
        <StatusBadge status={result ? result.approval.status : approval.status} />
      </div>
      {p ? (
        <dl className="kv">
          <dt>Case</dt>
          <dd className="mono">{p.caseId}</dd>
          <dt>Reason code</dt>
          <dd className="mono">{p.reasonCode}</dd>
          <dt>Amount</dt>
          <dd>{money(p.amount)}</dd>
          <dt>Evidence</dt>
          <dd className="mono">{p.evidenceIds.length ? p.evidenceIds.join(", ") : "—"}</dd>
          <dt>Requested by</dt>
          <dd className="mono">
            {p.requestedBy.actorType}:{p.requestedBy.actorId}
            {p.requestedBy.model ? ` (${p.requestedBy.model.provider}/${p.requestedBy.model.model})` : ""}
          </dd>
        </dl>
      ) : (
        <p className="muted">Proposal {approval.proposalId} (not embedded in response)</p>
      )}
      {p?.policyDecision ? (
        <div>
          <span className="muted">Policy ({p.policyDecision.policyVersion}):</span>
          <StatusBadge status={p.policyDecision.decision} />
          <ul className="reason-list">
            {p.policyDecision.reasons.map((r, i) => (
              <li key={i}>
                <span className="mono">{r.code}</span> — {r.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {p ? <RawToggle value={p} label="Proposal JSON" /> : null}

      {result ? (
        <div style={{ marginTop: 8 }} data-testid="decision-result">
          <p style={{ margin: "4px 0" }}>
            Decided <StatusBadge status={result.approval.status} /> by{" "}
            <span className="mono">{result.approval.approverId}</span>
            {result.approval.decidedAt ? ` at ${result.approval.decidedAt}` : ""}
          </p>
          {result.execution ? (
            <p style={{ margin: "4px 0" }}>
              Execution: <StatusBadge status={result.execution.status} />
              {result.execution.externalRef ? <span className="mono muted"> ref {result.execution.externalRef}</span> : null}
              {result.execution.detail ? <span className="muted"> — {result.execution.detail}</span> : null}
            </p>
          ) : null}
          <button className="btn secondary" onClick={onDecided} style={{ marginTop: 4 }}>
            Refresh queue
          </button>
        </div>
      ) : (
        <div style={{ marginTop: 8 }}>
          <div className="field">
            <input
              className="input"
              placeholder="Comment (optional)"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              data-testid="approval-comment"
            />
          </div>
          <div className="btn-row">
            <button className="btn" disabled={busy} onClick={() => decide("approved")} data-testid="approve-btn">
              Approve & execute
            </button>
            <button className="btn danger" disabled={busy} onClick={() => decide("rejected")} data-testid="reject-btn">
              Reject
            </button>
          </div>
        </div>
      )}
      <ErrorBox error={error} />
    </div>
  );
}

function ApprovalQueue() {
  const [approvals, setApprovals] = useState<ApprovalWithProposal[] | null>(null);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(() => {
    api
      .get<ApprovalWithProposal[]>("/v1/approvals?status=pending")
      .then(setApprovals)
      .catch(setError);
  }, []);

  useEffect(load, [load]);

  return (
    <Section title="Approval queue" zh="审批队列">
      <div className="btn-row" style={{ marginBottom: 8 }}>
        <button className="btn secondary" onClick={load} data-testid="refresh-approvals">
          Refresh
        </button>
        <span className="muted">Pending approvals requested by the policy engine.</span>
      </div>
      <ErrorBox error={error} />
      {approvals ? (
        approvals.length ? (
          approvals.map((a) => <ApprovalCard key={a.id} approval={a} onDecided={load} />)
        ) : (
          <p className="empty" data-testid="approvals-empty">
            No pending approvals. Run demo scenario 2 to create one.
          </p>
        )
      ) : error ? null : (
        <p className="muted">Loading…</p>
      )}
    </Section>
  );
}

function HandoffCard({ handoff, onChanged }: { handoff: HumanHandoff; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const act = async (path: string, body?: unknown) => {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/v1/handoffs/${handoff.id}/${path}`, body ?? {});
      onChanged();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const claim = () => {
    const assignee = window.prompt("Assign to (operator id):", "agent_console");
    if (assignee) void act("claim", { assignee });
  };
  const resolve = () => {
    const notes = window.prompt("Resolution notes (optional):") ?? undefined;
    void act("resolve", notes ? { notes } : {});
  };

  return (
    <div className="panel" data-testid="handoff-card">
      <div className="btn-row" style={{ justifyContent: "space-between" }}>
        <strong className="mono">{handoff.reason}</strong>
        <StatusBadge status={handoff.status} />
      </div>
      <dl className="kv">
        <dt>Case</dt>
        <dd className="mono">{handoff.caseId}</dd>
        {handoff.proposalId ? (
          <>
            <dt>Proposal</dt>
            <dd className="mono">{handoff.proposalId}</dd>
          </>
        ) : null}
        {handoff.assignedTo ? (
          <>
            <dt>Assigned to</dt>
            <dd className="mono">{handoff.assignedTo}</dd>
          </>
        ) : null}
        <dt>Created</dt>
        <dd className="mono">{handoff.createdAt}</dd>
      </dl>
      {handoff.notes ? <p className="muted">Notes: {handoff.notes}</p> : null}
      <RawToggle value={handoff} label="Handoff JSON" />
      {handoff.status !== "resolved" ? (
        <div className="btn-row" style={{ marginTop: 8 }}>
          {handoff.status === "open" ? (
            <button className="btn secondary" disabled={busy} onClick={claim} data-testid="claim-btn">
              Claim
            </button>
          ) : null}
          <button className="btn" disabled={busy} onClick={resolve} data-testid="resolve-btn">
            Resolve
          </button>
        </div>
      ) : null}
      <ErrorBox error={error} />
    </div>
  );
}

function Handoffs() {
  const [handoffs, setHandoffs] = useState<HumanHandoff[] | null>(null);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(() => {
    api.get<HumanHandoff[]>("/v1/handoffs?status=open").then(setHandoffs).catch(setError);
  }, []);

  useEffect(load, [load]);

  return (
    <Section title="Human handoffs" zh="人工接管">
      <div className="btn-row" style={{ marginBottom: 8 }}>
        <button className="btn secondary" onClick={load} data-testid="refresh-handoffs">
          Refresh
        </button>
        <span className="muted">Blocked proposals and uncertain executions escalate here.</span>
      </div>
      <ErrorBox error={error} />
      {handoffs ? (
        handoffs.length ? (
          handoffs.map((h) => <HandoffCard key={h.id} handoff={h} onChanged={load} />)
        ) : (
          <p className="empty" data-testid="handoffs-empty">
            No open handoffs. Run demo scenario 3 to create one.
          </p>
        )
      ) : error ? null : (
        <p className="muted">Loading…</p>
      )}
    </Section>
  );
}

export default function Agent() {
  return (
    <div>
      <h1>
        Human Agent <span className="zh-sub">人工坐席</span>
      </h1>
      <p className="page-sub">
        The agent&apos;s desk: approve or reject what the policy engine escalated, and pick up human handoffs.
      </p>
      <ApprovalQueue />
      <Handoffs />
    </div>
  );
}
