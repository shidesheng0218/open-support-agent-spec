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

const TONE_OK = new Set(["executed", "ok", "succeeded", "approved", "auto_execute", "resolved"]);
const TONE_WARN = new Set([
  "pending_approval",
  "require_approval",
  "pending",
  "claimed",
  "reconciliation_required",
  "uncertain",
  "executing",
  "proposed",
]);
const TONE_BAD = new Set([
  "policy_rejected",
  "rejected",
  "failed",
  "block",
  "down",
  // The approval fail-safe: an undecided approval past its deadline is denied.
  "expired",
]);

export function badgeTone(status: string): "ok" | "warn" | "bad" | "neutral" {
  if (TONE_OK.has(status)) return "ok";
  if (TONE_WARN.has(status)) return "warn";
  if (TONE_BAD.has(status)) return "bad";
  return "neutral";
}

export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`badge ${badgeTone(status)}`} data-testid={`status-${status}`}>
      {status}
    </span>
  );
}

export function money(m?: Money): string {
  if (!m) return "—";
  return `${(m.minorUnits / 100).toFixed(2)} ${m.currency}`;
}

export function MetricCard({
  label,
  value,
  percent = false,
}: {
  label: string;
  value: number;
  percent?: boolean;
}) {
  return (
    <div className="metric-card">
      <span className="muted">{label}</span>
      <strong>{percent ? `${Math.round(value * 100)}%` : value}</strong>
    </div>
  );
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
