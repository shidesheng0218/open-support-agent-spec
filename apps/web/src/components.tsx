import { useState, type ReactNode } from "react";
import { ApiError } from "./api";
import type { Money } from "./types";

export function JsonBlock({ value }: { value: unknown }) {
  return <pre className="json">{JSON.stringify(value, null, 2)}</pre>;
}

export function RawToggle({ value, label = "Raw JSON" }: { value: unknown; label?: string }) {
  return (
    <details className="raw">
      <summary>{label}</summary>
      <JsonBlock value={value} />
    </details>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  const msg =
    error instanceof ApiError
      ? `${error.code}: ${error.message}${error.status ? ` (HTTP ${error.status})` : ""}`
      : error instanceof Error
        ? error.message
        : String(error);
  return (
    <div className="error-box" data-testid="error-box">
      {msg}
    </div>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const tone =
    status === "executed" || status === "ok" || status === "succeeded" || status === "approved" || status === "auto_execute" || status === "resolved"
      ? "ok"
      : status === "pending_approval" || status === "require_approval" || status === "pending" || status === "claimed" ||
          status === "reconciliation_required" || status === "uncertain" || status === "executing" || status === "proposed"
        ? "warn"
        : status === "policy_rejected" || status === "rejected" || status === "failed" || status === "block" || status === "down"
          ? "bad"
          : "neutral";
  return (
    <span className={`badge ${tone}`} data-testid={`status-${status}`}>
      {status}
    </span>
  );
}

export function money(m?: Money): string {
  if (!m) return "—";
  return `${(m.minorUnits / 100).toFixed(2)} ${m.currency}`;
}

export function Section({ title, zh, children }: { title: string; zh?: string; children: ReactNode }) {
  return (
    <section className="panel">
      <h2 style={{ marginTop: 0 }}>
        {title}
        {zh ? <span className="zh-sub">{zh}</span> : null}
      </h2>
      {children}
    </section>
  );
}

export function useToggle(initial = false): [boolean, () => void] {
  const [v, setV] = useState(initial);
  return [v, () => setV((x) => !x)];
}
