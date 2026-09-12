import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { ErrorBox, JsonBlock, Section, StatusBadge, money } from "../components";
import type {
  AfterSalesCase,
  AfterSalesCaseDetail,
  AfterSalesDecision,
  AfterSalesMetrics,
  AfterSalesScenario,
  ApprovalWithProposal,
  HumanHandoff,
  ActionProposal,
} from "../types";

export const AFTER_SALES_SCENARIOS: readonly AfterSalesScenario[] = [
  "wismo",
  "delivery_delay",
  "not_received",
  "damaged_item",
  "wrong_or_missing_item",
  "refund_request",
  "refund_pending",
  "return_request",
  "reshipment_request",
  "exchange_request",
];

const SCENARIO_LABELS: Record<AfterSalesScenario, string> = {
  wismo: "订单/物流进度",
  delivery_delay: "配送延迟",
  not_received: "未收到货",
  damaged_item: "商品破损",
  wrong_or_missing_item: "错发/漏发",
  refund_request: "退款申请",
  refund_pending: "退款未到账",
  return_request: "退货申请",
  reshipment_request: "补发申请",
  exchange_request: "换货申请",
};

export function statusTone(status: string): "ok" | "warn" | "bad" | "neutral" {
  if (["resolved", "succeeded", "approved"].includes(status)) return "ok";
  if (["pending_approval", "reconciliation_required", "executing", "intake", "evaluated"].includes(status)) return "warn";
  if (["blocked", "failed", "rejected", "policy_rejected"].includes(status)) return "bad";
  return "neutral";
}

function CaseRow({ item, selected, onSelect }: { item: AfterSalesCase; selected: boolean; onSelect: () => void }) {
  return (
    <button className={`after-sales-row ${selected ? "selected" : ""}`} onClick={onSelect} type="button">
      <span>
        <strong>{SCENARIO_LABELS[item.scenarioCode]}</strong>
        <small className="mono">{item.id.slice(0, 18)}</small>
      </span>
      <span className="after-sales-row-meta">
        <span className="badge neutral">{item.riskLevel}</span>
        <span className={`badge ${statusTone(item.status)}`}>{item.status}</span>
      </span>
    </button>
  );
}

function MetricCard({ label, value, percent = false }: { label: string; value: number; percent?: boolean }) {
  return (
    <div className="metric-card">
      <span className="muted">{label}</span>
      <strong>{percent ? `${Math.round(value * 100)}%` : value}</strong>
    </div>
  );
}

function DetailPanel({ detail, onChanged }: { detail: AfterSalesCaseDetail; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [decision, setDecision] = useState<"succeeded" | "failed" | null>(null);
  const kase = detail.case;
  const proposal = detail.proposal;
  const pendingApproval = detail.approvals.find((approval) => approval.status === "pending");
  const openReconciliation = detail.reconciliation.find((task) => task.status === "open");

  const approve = async (value: "approved" | "rejected") => {
    if (!pendingApproval) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/v1/approvals/${pendingApproval.id}/decide`, {
        decision: value,
        approverId: "after_sales_console",
        comment: value === "approved" ? "Approved from after-sales operations console" : "Rejected from after-sales operations console",
      });
      onChanged();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const reconcile = async () => {
    if (!proposal || !decision) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/v1/proposals/${proposal.id}/reconcile`, {
        outcome: decision,
        note: "Resolved from after-sales reconciliation center",
      });
      setDecision(null);
      onChanged();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="after-sales-detail">
      <div className="btn-row" style={{ justifyContent: "space-between" }}>
        <div>
          <h2 style={{ margin: 0 }}>{SCENARIO_LABELS[kase.scenarioCode]}</h2>
          <p className="muted" style={{ margin: "3px 0 0" }}>
            <span className="mono">{kase.id}</span> · source <span className="mono">{kase.sourceCaseId}</span>
          </p>
        </div>
        <span className={`badge ${statusTone(kase.status)}`}>{kase.status}</span>
      </div>

      <dl className="kv">
        <dt>Risk / 风险</dt><dd>{kase.riskLevel}</dd>
        <dt>Order / 订单</dt><dd className="mono">{kase.orderId ?? "—"}</dd>
        <dt>Policy / 策略</dt><dd className="mono">{kase.policyVersion}</dd>
        <dt>Evidence / 证据</dt><dd>{detail.evidence.length} records ({kase.evidenceIds.length} linked)</dd>
        {kase.amount ? <><dt>Amount / 金额</dt><dd>{money(kase.amount)}</dd></> : null}
      </dl>

      {kase.requestMessage ? <p className="case-message">{kase.requestMessage}</p> : null}

      {pendingApproval ? (
        <section className="subpanel" data-testid="after-sales-approval-center">
          <div className="btn-row" style={{ justifyContent: "space-between" }}>
            <strong>Approval center <span className="zh-sub">审批中心</span></strong>
            <span className="badge warn">pending</span>
          </div>
          <p className="muted">The model can propose only. Approval remains a human/system-controlled action.</p>
          <div className="btn-row">
            <button className="btn" disabled={busy} onClick={() => void approve("approved")}>Approve</button>
            <button className="btn danger" disabled={busy} onClick={() => void approve("rejected")}>Reject</button>
          </div>
        </section>
      ) : null}

      {openReconciliation ? (
        <section className="subpanel" data-testid="after-sales-reconciliation-center">
          <div className="btn-row" style={{ justifyContent: "space-between" }}>
            <strong>Reconciliation center <span className="zh-sub">对账中心</span></strong>
            <span className="badge warn">unknown result</span>
          </div>
          <p className="muted">Unknown provider results are never retried automatically. Confirm the external outcome.</p>
          <div className="btn-row">
            <button className="btn" disabled={busy} onClick={() => setDecision("succeeded")}>Mark succeeded</button>
            <button className="btn danger" disabled={busy} onClick={() => setDecision("failed")}>Mark failed</button>
            {decision ? <button className="btn secondary" disabled={busy} onClick={() => void reconcile()}>Confirm {decision}</button> : null}
          </div>
        </section>
      ) : null}

      {proposal ? (
        <section className="subpanel">
          <strong>Action proposal <span className="zh-sub">动作提案</span></strong>
          <dl className="kv">
            <dt>Action</dt><dd className="mono">{proposal.actionType}</dd>
            <dt>Status</dt><dd><span className={`badge ${statusTone(proposal.status)}`}>{proposal.status}</span></dd>
            <dt>Idempotency</dt><dd className="mono">{proposal.idempotencyKey}</dd>
            <dt>Policy decision</dt><dd>{proposal.policyDecision?.decision ?? "—"}</dd>
          </dl>
          {proposal.policyDecision?.reasons.length ? (
            <ul className="reason-list">
              {proposal.policyDecision.reasons.map((reason) => <li key={reason.code}><span className="mono">{reason.code}</span> — {reason.message}</li>)}
            </ul>
          ) : null}
        </section>
      ) : null}

      <div className="grid-2">
        <section className="subpanel"><strong>Evidence / 证据</strong>{detail.evidence.length ? <ul className="reason-list">{detail.evidence.map((e) => <li key={e.id}><span className="mono">{e.kind}</span> — {e.summary}</li>)}</ul> : <p className="muted">No evidence linked.</p>}</section>
        <section className="subpanel"><strong>Human handoffs / 人工接管</strong>{detail.handoffs.length ? <ul className="reason-list">{detail.handoffs.map((h: HumanHandoff) => <li key={h.id}><span className="mono">{h.reason}</span> — {h.status}</li>)}</ul> : <p className="muted">No handoff.</p>}</section>
      </div>

      <section className="subpanel">
        <div className="btn-row" style={{ justifyContent: "space-between" }}><strong>Audit trail / 审计链</strong><span className="muted">{detail.audit.length} events</span></div>
        {detail.audit.length ? <ul className="timeline">{detail.audit.slice().reverse().map((event) => <li key={event.id}><span className={`dot ${statusTone(event.eventType.includes("failed") ? "failed" : event.eventType.includes("succeeded") ? "resolved" : "proposed")}`} /><div className="step-title">{event.eventType}</div><div className="step-body">{event.actorType}:{event.actorId} · {event.createdAt}</div></li>)}</ul> : <p className="muted">No audit events yet.</p>}
      </section>

      <details className="raw"><summary>Operations envelope JSON</summary><JsonBlock value={detail} /></details>
      <ErrorBox error={error} />
    </div>
  );
}

export default function AfterSales() {
  const [cases, setCases] = useState<AfterSalesCase[]>([]);
  const [metrics, setMetrics] = useState<AfterSalesMetrics | null>(null);
  const [approvals, setApprovals] = useState<ApprovalWithProposal[]>([]);
  const [reconciliation, setReconciliation] = useState<Record<string, unknown>[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AfterSalesCaseDetail | null>(null);
  const [scenario, setScenario] = useState<AfterSalesScenario | "all">("all");
  const [status, setStatus] = useState<AfterSalesCase["status"] | "all">("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [caseRows, metricRow, approvalRows, reconciliationRows] = await Promise.all([
        api.get<AfterSalesCase[]>("/v1/after-sales/cases"),
        api.get<AfterSalesMetrics>("/v1/after-sales/metrics"),
        api.get<ApprovalWithProposal[]>("/v1/approvals"),
        api.get<Record<string, unknown>[]>("/v1/reconciliation?status=open"),
      ]);
      setCases(caseRows);
      setMetrics(metricRow);
      setApprovals(approvalRows.filter((approval) => approval.status === "pending"));
      setReconciliation(reconciliationRows);
      setSelectedId((current) => current && caseRows.some((item) => item.id === current) ? current : caseRows[0]?.id ?? null);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadDetail = useCallback(async (id: string | null) => {
    if (!id) { setDetail(null); return; }
    try {
      setDetail(await api.get<AfterSalesCaseDetail>(`/v1/after-sales/cases/${id}`));
    } catch (e) {
      setError(e);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void loadDetail(selectedId); }, [loadDetail, selectedId]);

  const visibleCases = useMemo(
    () => cases.filter((item) => (scenario === "all" || item.scenarioCode === scenario) && (status === "all" || item.status === status)),
    [cases, scenario, status],
  );

  const refresh = async () => {
    await load();
    await loadDetail(selectedId);
  };

  return (
    <div data-testid="after-sales-page">
      <div className="btn-row" style={{ justifyContent: "space-between" }}>
        <div><h1>After-sales Operations <span className="zh-sub">售后运营</span></h1><p className="page-sub">Top 10 scenarios with policy, approval, sandbox execution, audit and reconciliation in one operator view.</p></div>
        <button className="btn secondary" onClick={() => void refresh()} disabled={loading}>Refresh</button>
      </div>
      <ErrorBox error={error} />

      {metrics ? <div className="metric-grid" data-testid="after-sales-metrics"><MetricCard label="Cases / 工单" value={metrics.totalCases} /><MetricCard label="Auto answer" value={metrics.autoAnswerRate} percent /><MetricCard label="Approval" value={metrics.approvalRate} percent /><MetricCard label="Human handoff" value={metrics.humanHandoffRate} percent /><MetricCard label="Reconciliation" value={metrics.reconciliationRate} percent /><MetricCard label="Audit completeness" value={metrics.auditCompletenessRate} percent /></div> : null}

      <div className="after-sales-layout">
        <Section title="Case queue" zh="售后队列">
          <div className="filter-row">
            <select className="select" value={scenario} onChange={(event) => setScenario(event.target.value as AfterSalesScenario | "all")}><option value="all">All scenarios / 全部场景</option>{AFTER_SALES_SCENARIOS.map((code) => <option key={code} value={code}>{SCENARIO_LABELS[code]}</option>)}</select>
            <select className="select" value={status} onChange={(event) => setStatus(event.target.value as AfterSalesCase["status"] | "all")}><option value="all">All statuses / 全部状态</option>{["intake", "evidence_required", "pending_approval", "human_handoff", "resolved", "reconciliation_required", "blocked"].map((value) => <option key={value} value={value}>{value}</option>)}</select>
          </div>
          {loading ? <p className="muted">Loading…</p> : visibleCases.length ? <div className="after-sales-queue">{visibleCases.map((item) => <CaseRow key={item.id} item={item} selected={item.id === selectedId} onSelect={() => setSelectedId(item.id)} />)}</div> : <p className="empty">No after-sales cases match this filter.</p>}
          <p className="muted" style={{ marginBottom: 0 }}>{approvals.length} pending approvals · {reconciliation.length} open reconciliation tasks</p>
        </Section>

        <Section title="Case detail" zh="案例详情">
          {detail ? <DetailPanel detail={detail} onChanged={() => void refresh()} /> : <p className="empty">Select a case to inspect its complete operations envelope.</p>}
        </Section>
      </div>
    </div>
  );
}
