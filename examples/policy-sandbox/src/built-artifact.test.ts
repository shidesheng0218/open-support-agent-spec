import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * Executes the BUILT single-file artifact — not the sources.
 *
 * The sandbox's whole promise is "open this file, nothing to install", so the
 * thing worth testing is the file itself: that its inlined bundle boots against
 * the shell it was built into, and that the verdicts it paints are the engine's
 * real ones. A source-level test would not have caught a stale build or a
 * mismatched element id.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..");
/** Committed on purpose: this file is the deliverable. */
const artifact = path.join(packageRoot, "policy-sandbox.html");

interface StubElement {
  tagName: string;
  id: string;
  textContent: string;
  // className and innerHTML are installed as accessors by makeElement(), so they
  // are intentionally absent here: the bundle is a string run through
  // new Function(), and this interface only describes what the test touches.
  value: string;
  checked: boolean;
  type: string;
  dataset: Record<string, string>;
  children: StubElement[];
  handlers: Record<string, Array<() => void>>;
  classList: { toggle(name: string, force?: boolean): void; add(name: string): void; remove(name: string): void; contains(name: string): boolean };
  addEventListener(type: string, fn: () => void): void;
  appendChild(child: StubElement): StubElement;
  append(...nodes: StubElement[]): void;
  querySelectorAll(selector: string): StubElement[];
  fire(type: string): void;
}

function makeElement(tagName: string, id = ""): StubElement {
  const classes = new Set<string>();
  let inner = "";
  const el: StubElement = {
    tagName: tagName.toUpperCase(),
    id,
    textContent: "",
    value: "",
    checked: false,
    type: "",
    dataset: {},
    children: [],
    handlers: {},
    classList: {
      toggle(name, force) {
        const on = force ?? !classes.has(name);
        if (on) classes.add(name);
        else classes.delete(name);
        return on;
      },
      add: (name) => void classes.add(name),
      remove: (name) => void classes.delete(name),
      contains: (name) => classes.has(name),
    },
    addEventListener(type, fn) {
      (el.handlers[type] ??= []).push(fn);
    },
    appendChild(child) {
      el.children.push(child);
      return child;
    },
    append(...nodes) {
      el.children.push(...nodes);
    },
    querySelectorAll(selector) {
      const want = selector.toUpperCase();
      return el.children.filter((c) => c.tagName === want);
    },
    fire(type) {
      for (const fn of el.handlers[type] ?? []) fn();
    },
  };
  // A real DOM keeps className, classList and innerHTML consistent; the stub
  // has to as well, or it tests the stub instead of the artifact.
  Object.defineProperty(el, "className", {
    get: () => [...classes].join(" "),
    set: (value: string) => {
      classes.clear();
      for (const name of String(value).split(/\s+/)) if (name) classes.add(name);
    },
    enumerable: true,
  });
  Object.defineProperty(el, "innerHTML", {
    get: () => inner,
    set: (value: string) => {
      inner = String(value);
      if (inner === "") el.children.length = 0;
    },
    enumerable: true,
  });
  return el;
}

/** Every element the bundle may reach for, discovered from the real shell. */
function installDom(html: string): Map<string, StubElement> {
  const elements = new Map<string, StubElement>();
  for (const match of html.matchAll(/id="([^"]+)"/g)) {
    const id = match[1]!;
    elements.set(id, makeElement("div", id));
  }
  // The range input and the three checkboxes are inputs in the real shell, and
  // the bundle reads .value / .checked off them — so carry over the attributes
  // the shell actually declares, rather than testing against empty defaults.
  for (const tag of html.match(/<input\b[^>]*>/g) ?? []) {
    const id = /id="([^"]+)"/.exec(tag)?.[1];
    const el = id ? elements.get(id) : undefined;
    if (!el) continue;
    el.tagName = "INPUT";
    el.value = /value="([^"]*)"/.exec(tag)?.[1] ?? "";
    el.checked = /\bchecked\b/.test(tag);
    el.type = /type="([^"]+)"/.exec(tag)?.[1] ?? "";
  }
  // The preset container is the one place the bundle builds buttons into.
  const presets = elements.get("presets");
  if (presets) presets.querySelectorAll = (selector) =>
    selector.toUpperCase() === "BUTTON" ? presets.children : [];

  const documentStub = {
    documentElement: { lang: "" },
    getElementById: (id: string) => elements.get(id) ?? null,
    createElement: (tag: string) => makeElement(tag),
  };
  Object.defineProperty(globalThis, "document", { value: documentStub, configurable: true });
  Object.defineProperty(globalThis, "navigator", {
    value: { language: "zh-CN" },
    configurable: true,
  });
  return elements;
}

let els: Map<string, StubElement>;

const text = (id: string): string => els.get(id)?.textContent ?? "";
/** Reason codes painted into the list; the "all checks passed" row has none. */
const reasonCodes = (): string[] =>
  (els.get("reasons")?.children ?? [])
    .map((li) => (li.children.find((c) => c.classList.contains("code"))?.textContent ?? "").trim())
    .filter(Boolean);

describe("built policy-sandbox artifact", () => {
  beforeAll(() => {
    // Rebuild to a scratch path and compare. This makes the committed artifact
    // impossible to leave stale: editing src/ without rebuilding fails CI.
    const scratch = path.join(tmpdir(), `policy-sandbox-${process.pid}.html`);
    execFileSync(process.execPath, [path.join(packageRoot, "build.mjs"), "--out", scratch], {
      stdio: "pipe",
    });
    const fresh = readFileSync(scratch, "utf8");
    const html = readFileSync(artifact, "utf8");
    if (fresh !== html) {
      throw new Error(
        "the committed policy-sandbox.html does not match a fresh build — " +
          "run: pnpm --filter @osas-examples/policy-sandbox run build",
      );
    }
    expect(html).toContain("<!doctype html>");
    els = installDom(html);

    const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1];
    if (!script) throw new Error("artifact has no inline <script>");
    // Run the bundle exactly as a browser would: one IIFE over these globals.
    new Function(script)();
  }, 60_000);

  it("makes no external requests", () => {
    const html = readFileSync(artifact, "utf8");
    expect(html).not.toMatch(/<link[^>]+href="https?:/i);
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/@import\s+url\(/i);
  });

  it("starts at $25.00 and auto-executes", () => {
    expect(text("amount-out")).toBe("$25.00");
    expect(text("badge")).toBe("自动执行");
    expect(text("badge").length).toBeGreaterThan(0);
    expect(reasonCodes()).toEqual([]);
    // ...and it says so explicitly rather than showing an empty box.
    const clean = els.get("reasons")!.children;
    expect(clean).toHaveLength(1);
    expect(clean[0]!.classList.contains("ok")).toBe(true);
    expect(els.get("badge")?.classList.contains("auto_execute")).toBe(true);
  });

  it("closes the gate when the amount crosses the limit", () => {
    const amount = els.get("amount")!;
    amount.value = "12000";
    amount.fire("input");
    expect(text("amount-out")).toBe("$120.00");
    expect(text("badge")).toBe("转人工审批");
    expect(reasonCodes()).toContain("OVER_THRESHOLD");
  });

  it("blocks when the customer message carries instructions", () => {
    const injection = els.get("injection")!;
    injection.checked = true;
    injection.fire("input");
    expect(text("badge")).toBe("阻断");
    expect(reasonCodes()).toContain("PROMPT_INJECTION_SUSPECTED");
    injection.checked = false;
    injection.fire("input");
  });

  it("blocks a model that asks for execute, via a preset button", () => {
    const buttons = els.get("presets")!.children;
    expect(buttons.map((b) => b.textContent)).toEqual([
      "$25 损坏退款",
      "$120 超额退款",
      "模型越权",
      "指令注入",
      "过期证据",
    ]);
    buttons[2]!.fire("click");
    expect(text("amount-out")).toBe("$25.00");
    expect(text("badge")).toBe("阻断");
    expect(reasonCodes()).toContain("PERMISSION_OVERREACH");
    expect(buttons[2]!.classList.contains("on")).toBe(true);
  });

  it("blocks on stale evidence", () => {
    els.get("presets")!.children[4]!.fire("click");
    expect(text("badge")).toBe("阻断");
    expect(reasonCodes()).toContain("EVIDENCE_STALE");
  });

  it("publishes the engine's raw decision, not a copy of it", () => {
    const raw = JSON.parse(text("raw"));
    expect(raw.decision).toBe("block");
    expect(raw.reasons.map((r: { code: string }) => r.code)).toContain("EVIDENCE_STALE");
    expect(raw.policy.autoExecuteUnder).toBe("$50.00");
  });

  it("switches to English on the language button", () => {
    els.get("lang")!.fire("click");
    expect(text("lang")).toBe("中文");
    expect(text("badge")).toBe("Blocked");
    expect(els.get("presets")!.children[0]!.textContent).toBe("$25 damaged refund");
    // ...and back, for the Chinese-first audience.
    els.get("lang")!.fire("click");
    expect(text("badge")).toBe("阻断");
  });
});
