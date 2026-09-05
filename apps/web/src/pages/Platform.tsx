import { Fragment, useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api";
import { ErrorBox, JsonBlock, Section, StatusBadge } from "../components";
import type { AuditEvent, CompatReport } from "../types";

function AuditViewer() {
  const [caseId, setCaseId] = useState("");
  const [proposalId, setProposalId] = useState("");
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const qs = new URLSearchParams();
    if (caseId.trim()) qs.set("caseId", caseId.trim());
    if (proposalId.trim()) qs.set("proposalId", proposalId.trim());
    const suffix = qs.size ? `?${qs.toString()}` : "";
    try {
      setEvents(await api.get<AuditEvent[]>(`/v1/audit${suffix}`));
    } catch (e) {
      setError(e);
    }
  }, [caseId, proposalId]);

  useEffect(() => {
    void load();
    // initial unfiltered load only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Section title="Audit trail" zh="审计日志">
      <div className="btn-row" style={{ marginBottom: 8 }}>
        <input
          className="input"
          style={{ maxWidth: 220 }}
          placeholder="caseId filter"
          value={caseId}
          onChange={(e) => setCaseId(e.target.value)}
          data-testid="audit-case-filter"
        />
        <input
          className="input"
          style={{ maxWidth: 220 }}
          placeholder="proposalId filter"
          value={proposalId}
          onChange={(e) => setProposalId(e.target.value)}
          data-testid="audit-proposal-filter"
        />
        <button className="btn" onClick={() => void load()} data-testid="audit-load">
          Load events
        </button>
      </div>
      <ErrorBox error={error} />
      {events ? (
        events.length ? (
          <table className="table" data-testid="audit-table">
            <thead>
              <tr>
                <th>Event</th>
                <th>Actor</th>
                <th>Policy</th>
                <th>Case / Proposal</th>
                <th>Time</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <Fragment key={e.id}>
                  <tr
                    className="clickable"
                    data-testid="audit-row"
                    onClick={() => setOpen(open === e.id ? null : e.id)}
                  >
                    <td className="mono">{e.eventType}</td>
                    <td className="mono">
                      {e.actorType}:{e.actorId}
                    </td>
                    <td className="mono">{e.policyVersion ?? "—"}</td>
                    <td className="mono muted">
                      {e.caseId ?? "—"}
                      {e.proposalId ? ` / ${e.proposalId}` : ""}
                    </td>
                    <td className="mono muted">{e.createdAt}</td>
                  </tr>
                  {open === e.id ? (
                    <tr>
                      <td colSpan={5}>
                        <JsonBlock value={e} />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="empty" data-testid="audit-empty">
            No audit events match. Run a demo scenario first.
          </p>
        )
      ) : error ? null : (
        <p className="muted">Loading…</p>
      )}
    </Section>
  );
}

function CompatReportViewer() {
  const [report, setReport] = useState<CompatReport | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    api
      .get<CompatReport>("/v1/compat/report")
      .then(setReport)
      .catch((e) => {
        if (e instanceof ApiError && e.status === 404) setMissing(true);
        else setError(e);
      });
  }, []);

  return (
    <Section title="Compatibility report" zh="兼容性报告">
      <ErrorBox error={error} />
      {report ? (
        <>
          <p style={{ marginTop: 0 }}>
            Overall: <StatusBadge status={report.ok ? "ok" : "failed"} />{" "}
            <span className="muted mono">
              specVersion {report.specVersion} · run at {report.runAt}
            </span>
          </p>
          <table className="table" data-testid="compat-table">
            <thead>
              <tr>
                <th>Suite</th>
                <th>Passed</th>
                <th>Failed</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {report.suites.map((s) => (
                <tr key={s.name} data-testid="compat-suite-row">
                  <td>{s.name}</td>
                  <td>{s.passed}</td>
                  <td>{s.failed}</td>
                  <td>
                    <StatusBadge status={s.failed === 0 ? "ok" : "failed"} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : missing ? (
        <p className="empty" data-testid="compat-empty">
          No compat report yet (404). Run <span className="mono">@osas/compat-suite</span> to generate{" "}
          <span className="mono">tests/compat/report/latest.json</span>.
        </p>
      ) : error ? null : (
        <p className="muted">Loading…</p>
      )}
    </Section>
  );
}

export default function Platform() {
  return (
    <div>
      <h1>
        Platform & Governance <span className="zh-sub">平台治理</span>
      </h1>
      <p className="page-sub">Every proposal, decision and execution leaves an audit event. Verify spec conformance here.</p>
      <AuditViewer />
      <CompatReportViewer />
    </div>
  );
}
