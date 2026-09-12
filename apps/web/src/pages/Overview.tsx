import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { ErrorBox, StatusBadge } from "../components";
import type { HealthResponse } from "../types";

const PERSONAS = [
  {
    to: "/developer",
    title: "Developer",
    zh: "开发者",
    desc: "Browse the 20 MCP tools, inspect JSON Schemas, and validate payloads against the spec.",
  },
  {
    to: "/agent",
    title: "Human Agent",
    zh: "人工坐席",
    desc: "Work the approval queue: review proposals with policy reasons, approve or reject, and claim handoffs.",
  },
  {
    to: "/after-sales",
    title: "After-sales Operations",
    zh: "售后运营",
    desc: "Operate the Top 10 after-sales scenarios with evidence, policy gates, approvals, sandbox receipts, audit and reconciliation.",
  },
  {
    to: "/platform",
    title: "Platform / Governance",
    zh: "平台治理",
    desc: "Audit every decision with the immutable event trail and check spec compatibility reports.",
  },
];

export default function Overview() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    api
      .get<HealthResponse>("/health")
      .then(setHealth)
      .catch(setError);
  }, []);

  return (
    <div>
      <h1>
        Open Support Agent Spec <span className="zh-sub">开放客服智能体规范</span>
      </h1>
      <p className="page-sub">
        OSAS <strong>v0.2 Draft</strong> — an open, Apache-2.0 specification for safe customer-support agents:
        typed tools, deterministic policy gates, human approvals, full auditability. This console exercises the
        reference API against the mock backend (<span className="mono">tenant_demo</span>).
      </p>

      <section className="panel">
        <h2 style={{ marginTop: 0 }}>
          API health <span className="zh-sub">服务状态</span>
        </h2>
        {health ? (
          <p style={{ margin: 0 }}>
            <StatusBadge status={health.status === "ok" ? "ok" : "down"} />{" "}
            <span className="muted mono">
              specVersion {health.specVersion} · api v{health.version}
            </span>
          </p>
        ) : error ? (
          <p style={{ margin: 0 }}>
            <StatusBadge status="down" /> <span className="muted">API unreachable at /health</span>
          </p>
        ) : (
          <p className="muted" style={{ margin: 0 }}>
            Checking…
          </p>
        )}
        <ErrorBox error={error} />
      </section>

      <div className="cards">
        {PERSONAS.map((p) => (
          <Link key={p.to} to={p.to} className="card-link">
            <section className="panel">
              <div className="card-title">{p.title}</div>
              <div className="card-zh">{p.zh}</div>
              <div className="card-desc">{p.desc}</div>
            </section>
          </Link>
        ))}
      </div>

      <section className="panel" style={{ marginTop: 16 }}>
        <h2 style={{ marginTop: 0 }}>
          Guided demo <span className="zh-sub">演示</span>
        </h2>
        <p className="card-desc">
          Three one-click scripted scenarios drive <span className="mono">POST /v1/chat</span> end-to-end:
          an auto-executed ecommerce refund, a SaaS credit that waits for human approval, and a prompt-injection
          attempt that gets blocked and handed off.{" "}
          <Link to="/demo">Open the demo →</Link>
        </p>
      </section>
    </div>
  );
}
