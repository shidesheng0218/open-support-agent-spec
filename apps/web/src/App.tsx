import { NavLink, Route, Routes } from "react-router-dom";
import Overview from "./pages/Overview";
import Developer from "./pages/Developer";
import Agent from "./pages/Agent";
import Shadow from "./pages/Shadow";
import Platform from "./pages/Platform";
import Demo from "./pages/Demo";

const NAV = [
  { to: "/", label: "Overview", zh: "概览", end: true },
  { to: "/developer", label: "Developer", zh: "开发者", end: false },
  { to: "/agent", label: "Agent", zh: "人工坐席", end: false },
  { to: "/shadow", label: "Shadow", zh: "影子模式", end: false },
  { to: "/platform", label: "Platform", zh: "平台治理", end: false },
  { to: "/demo", label: "Demo", zh: "演示", end: false },
];

export default function App() {
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-title">OSAS Console</span>
          <span className="brand-sub">Open Support Agent Spec v0.2 · 开放客服智能体规范</span>
        </div>
        <nav className="nav" data-testid="nav">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              className={({ isActive }) => (isActive ? "nav-link active" : "nav-link")}
            >
              {n.label}
              <span className="nav-zh">{n.zh}</span>
            </NavLink>
          ))}
        </nav>
      </header>
      <main className="content">
        <Routes>
          <Route path="/" element={<Overview />} />
          <Route path="/developer" element={<Developer />} />
          <Route path="/agent" element={<Agent />} />
          <Route path="/shadow" element={<Shadow />} />
          <Route path="/platform" element={<Platform />} />
          <Route path="/demo" element={<Demo />} />
        </Routes>
      </main>
      <footer className="footer">OSAS v0.2 Draft · Apache-2.0</footer>
    </div>
  );
}
