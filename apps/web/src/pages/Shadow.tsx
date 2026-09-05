import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { ErrorBox, RawToggle, Section, StatusBadge, money } from "../components";
import type { AuditChainVerification, ShadowRunEnvelope, ShadowRunOutcome } from "../types";

/**
 * Shadow Mode console (v0.1.1 Milestone 3). Shows simulated policy decisions
 * (ShadowRuns), the agent's suggested action, policy reasons, original
 * evidence links, and the audit-chain verification result. Humans record the
 * final outcome here — there is deliberately NO live-execute UI.
 */
function ShadowRunCard({ item, onReviewed }: { item: ShadowRunEnvelope; onReviewed: () => void }) {
  const { shadowRun: run, proposal, evidence } = item;
  const [comment, setComment] = useState("");
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const review = async (outcome: Exclude<ShadowRunOutcome, "pending">) => {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/v1/shadow-runs/${run.id}/review`, {
        outcome,
        humanComment: comment || undefined,
        externalReference: reference || undefined,
      });
      onReviewed();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel" data-testid="shadow-run-card">
      <div className="btn-row" style={{ justifyContent: "space-between" }}>
        <strong className="mono">
          {run.suggestedAction.actionType} · {run.suggestedAction.reasonCode}
        </strong>
        <span className="btn-row">
          <StatusBadge status={run.humanOutcome} />
          {run.wouldAutoExecute ? (
            <span className="badge warn" data-testid="would-auto-execute">
              would auto-execute
            </span>
          ) : (
            <span className="badge neutral" data-testid="no-auto-execute">
              no auto-execute
            </span>
          )}
        </span>
      </div>
      <dl className="kv">
        <dt>Shadow run</dt>
        <dd className="mono">{run.id}</dd>
        <dt>Proposal</dt>
        <dd className="mono">{run.proposalId}</dd>
        {proposal ? (
          <>
            <dt>Case</dt>
            <dd className="mono">{proposal.caseId}</dd>
            <dt>Proposal status</dt>
            <dd>
              <StatusBadge status={proposal.status} />
            </dd>
          </>
        ) : null}
        <dt>Suggested amount</dt>
        <dd>{money(run.suggestedAction.amount)}</dd>
        <dt>Created</dt>
        <dd className="mono">{run.createdAt}</dd>
        {run.reviewedAt ? (
          <>
            <dt>Reviewed</dt>
            <dd className="mono">{run.reviewedAt}</dd>
          </>
        ) : null}
        {run.humanComment ? (
          <>
            <dt>Human comment</dt>
            <dd>{run.humanComment}</dd>
          </>
        ) : null}
        {run.externalReference ? (
          <>
            <dt>External ref</dt>
            <dd className="mono">{run.externalReference}</dd>
          </>
        ) : null}
      </dl>

      <div>
        <span className="muted">
          Policy ({run.policyDecision.policyVersion}) <StatusBadge status={run.policyDecision.decision} />:
        </span>
        {run.policyDecision.reasons.length ? (
          <ul className="reason-list">
            {run.policyDecision.reasons.map((r, i) => (
              <li key={i}>
                <span className="mono">{r.code}</span> — {r.message}
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">No policy violations — the engine would have auto-executed this action.</p>
        )}
      </div>

      {evidence.length ? (
        <div data-testid="shadow-evidence">
          <span className="muted">Original evidence:</span>
          <ul className="reason-list">
            {evidence.map((ev) => (
              <li key={ev.id}>
                {ev.source.url ? (
                  <a href={ev.source.url} target="_blank" rel="noreferrer" data-testid="evidence-link">
                    {ev.source.system}/{ev.source.recordType}/{ev.source.recordId}
                  </a>
                ) : (
                  <span className="mono">
                    {ev.source.system}/{ev.source.recordType}/{ev.source.recordId}
                  </span>
                )}{" "}
                — {ev.summary}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <RawToggle value={run.suggestedAction} label="Suggested action JSON" />

      {run.humanOutcome === "pending" ? (
        <div style={{ marginTop: 8 }}>
          <div className="field">
            <input
              className="input"
              placeholder="Human comment (optional)"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              data-testid="shadow-comment"
            />
          </div>
          <div className="field">
            <input
              className="input"
              placeholder="External reference (e.g. Zendesk ticket URL, optional)"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              data-testid="shadow-reference"
            />
          </div>
          <div className="btn-row">
            <button className="btn" disabled={busy} onClick={() => review("accepted")} data-testid="shadow-accept-btn">
              Accept suggestion
            </button>
            <button className="btn secondary" disabled={busy} onClick={() => review("modified")} data-testid="shadow-modify-btn">
              Modified by human
            </button>
            <button className="btn danger" disabled={busy} onClick={() => review("rejected")} data-testid="shadow-reject-btn">
              Reject
            </button>
          </div>
        </div>
      ) : null}
      <ErrorBox error={error} />
    </div>
  );
}

function AuditChainStatus() {
  const [result, setResult] = useState<AuditChainVerification | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    api.get<AuditChainVerification>("/v1/audit/verify").then(setResult).catch(setError);
  }, []);
  return (
    <Section title="Audit chain" zh="审计链校验">
      <ErrorBox error={error} />
      {result ? (
        <p style={{ margin: 0 }}>
          {result.intact ? (
            <span className="badge ok" data-testid="audit-chain-intact">
              intact · {result.chainLength} events
            </span>
          ) : (
            <span className="badge bad" data-testid="audit-chain-broken">
              broken at {result.firstError?.eventId} ({result.firstError?.reason})
            </span>
          )}
        </p>
      ) : error ? null : (
        <p className="muted">Verifying…</p>
      )}
    </Section>
  );
}

export default function Shadow() {
  const [items, setItems] = useState<ShadowRunEnvelope[] | null>(null);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(() => {
    api
      .get<ShadowRunEnvelope[]>("/v1/shadow-runs")
      .then((runs) =>
        setItems(
          [...runs].sort((a, b) =>
            a.shadowRun.humanOutcome === "pending" && b.shadowRun.humanOutcome !== "pending"
              ? -1
              : a.shadowRun.humanOutcome !== "pending" && b.shadowRun.humanOutcome === "pending"
                ? 1
                : b.shadowRun.createdAt.localeCompare(a.shadowRun.createdAt),
          ),
        ),
      )
      .catch(setError);
  }, []);

  useEffect(load, [load]);

  return (
    <div data-testid="shadow-page">
      <h1>
        Shadow Mode <span className="zh-sub">影子模式</span>
      </h1>
      <p className="page-sub" data-testid="shadow-mode-banner">
        Shadow Mode simulates the policy decision for every proposal and records what the agent
        would have auto-executed. Humans review and write the final outcome — nothing is executed
        automatically, and there is no live-execute UI here.
      </p>
      <Section title="Shadow runs" zh="待人工审核">
        <div className="btn-row" style={{ marginBottom: 8 }}>
          <button className="btn secondary" onClick={load} data-testid="refresh-shadow-runs">
            Refresh
          </button>
          <span className="muted">
            Pending reviews first. Create one via POST /v1/proposals/:id/shadow-run.
          </span>
        </div>
        <ErrorBox error={error} />
        {items ? (
          items.length ? (
            items.map((item) => (
              <ShadowRunCard key={item.shadowRun.id} item={item} onReviewed={load} />
            ))
          ) : (
            <p className="empty" data-testid="shadow-empty">
              No shadow runs yet.
            </p>
          )
        ) : error ? null : (
          <p className="muted">Loading…</p>
        )}
      </Section>
      <AuditChainStatus />
    </div>
  );
}
