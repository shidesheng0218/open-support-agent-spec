import { Fragment, useEffect, useState } from "react";
import { api } from "../api";
import { ErrorBox, JsonBlock, Section, StatusBadge } from "../components";
import type { SchemaManifest, ToolDefinition, ValidationResult } from "../types";

function ToolCatalog() {
  const [tools, setTools] = useState<ToolDefinition[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    api.get<ToolDefinition[]>("/v1/meta/tools").then(setTools).catch(setError);
  }, []);

  return (
    <Section title="Tool catalog" zh="工具目录">
      <ErrorBox error={error} />
      {tools ? (
        <>
          <p className="muted" style={{ marginTop: 0 }}>
            {tools.length} MCP tools exposed by the reference server. Click a row to inspect its input schema.
          </p>
          <table className="table" data-testid="tool-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Profile</th>
                <th>Permission</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              {tools.map((t) => (
                <Fragment key={t.name}>
                  <tr
                    className="clickable"
                    data-testid="tool-row"
                    onClick={() => setOpen(open === t.name ? null : t.name)}
                  >
                    <td className="mono">{t.name}</td>
                    <td>{t.profile}</td>
                    <td>
                      <StatusBadge status={t.permissionRequired} />
                    </td>
                    <td className="muted">{t.description}</td>
                  </tr>
                  {open === t.name ? (
                    <tr>
                      <td colSpan={4}>
                        <div className="muted" style={{ marginBottom: 4 }}>
                          inputSchema · adapter method <span className="mono">{t.adapterMethod}</span>
                        </div>
                        <JsonBlock value={t.inputSchema} />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              ))}
            </tbody>
          </table>
        </>
      ) : error ? null : (
        <p className="muted">Loading tools…</p>
      )}
    </Section>
  );
}

function SchemaBrowser({ manifest, onError }: { manifest: SchemaManifest | null; onError: (e: unknown) => void }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [schema, setSchema] = useState<unknown>(null);
  const [error, setError] = useState<unknown>(null);

  const load = (name: string) => {
    setSelected(name);
    setSchema(null);
    setError(null);
    api.get<unknown>(`/v1/schemas/${encodeURIComponent(name)}`).then(setSchema).catch((e) => {
      setError(e);
      onError(e);
    });
  };

  return (
    <Section title="Schema browser" zh="模式浏览">
      <ErrorBox error={error} />
      {manifest ? (
        <div className="grid-2">
          <div>
            <p className="muted" style={{ marginTop: 0 }}>
              {manifest.schemas.length} schemas · specVersion <span className="mono">{manifest.specVersion}</span>
            </p>
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Profile</th>
                </tr>
              </thead>
              <tbody>
                {manifest.schemas.map((s) => (
                  <tr
                    key={s.name}
                    className="clickable"
                    data-testid="schema-row"
                    onClick={() => load(s.name)}
                    style={selected === s.name ? { background: "var(--accent-soft)" } : undefined}
                  >
                    <td className="mono">{s.name}</td>
                    <td className="muted">{s.profile}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div>
            {selected ? (
              schema ? (
                <JsonBlock value={schema} />
              ) : (
                <p className="muted">Loading {selected}…</p>
              )
            ) : (
              <p className="empty">Select a schema to view its JSON.</p>
            )}
          </div>
        </div>
      ) : (
        <p className="muted">Loading manifest…</p>
      )}
    </Section>
  );
}

function ValidatorPlayground({ manifest }: { manifest: SchemaManifest | null }) {
  const [schemaName, setSchemaName] = useState("");
  const [text, setText] = useState('{\n  "specVersion": "0.2"\n}');
  const [result, setResult] = useState<ValidationResult | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!schemaName && manifest?.schemas.length) {
      setSchemaName(manifest.schemas[0]!.name);
    }
  }, [manifest, schemaName]);

  const run = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch (e) {
      setError(new Error(`Invalid JSON in textarea: ${e instanceof Error ? e.message : String(e)}`));
      setBusy(false);
      return;
    }
    try {
      setResult(await api.post<ValidationResult>("/v1/validate", { schemaName, data }));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Validator playground" zh="校验器">
      <div className="grid-2">
        <div>
          <div className="field">
            <label>Schema name</label>
            <select className="select" value={schemaName} onChange={(e) => setSchemaName(e.target.value)} data-testid="validator-schema">
              {manifest?.schemas.map((s) => (
                <option key={s.name} value={s.name}>
                  {s.name} ({s.profile})
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Payload (JSON)</label>
            <textarea className="textarea" value={text} onChange={(e) => setText(e.target.value)} data-testid="validator-input" spellCheck={false} />
          </div>
          <button className="btn" onClick={run} disabled={busy || !schemaName} data-testid="validator-run">
            {busy ? "Validating…" : "Validate"}
          </button>
        </div>
        <div>
          <ErrorBox error={error} />
          {result ? (
            result.valid ? (
              <p data-testid="validator-result">
                <StatusBadge status="ok" /> <span className="muted">Payload is valid against {schemaName}.</span>
              </p>
            ) : (
              <div data-testid="validator-result">
                <p>
                  <StatusBadge status="block" /> <span className="muted">{result.errors?.length ?? 0} error(s):</span>
                </p>
                <ul className="reason-list">
                  {(result.errors ?? []).map((e, i) => (
                    <li key={i}>
                      <span className="mono">{e.instancePath || "(root)"}</span> — {e.message ?? JSON.stringify(e)}
                    </li>
                  ))}
                </ul>
                <JsonBlock value={result.errors} />
              </div>
            )
          ) : (
            <p className="empty">Run validation to see results.</p>
          )}
        </div>
      </div>
    </Section>
  );
}

export default function Developer() {
  const [manifest, setManifest] = useState<SchemaManifest | null>(null);
  const [manifestError, setManifestError] = useState<unknown>(null);

  useEffect(() => {
    api.get<SchemaManifest>("/v1/schemas").then(setManifest).catch(setManifestError);
  }, []);

  return (
    <div>
      <h1>
        Developer <span className="zh-sub">开发者</span>
      </h1>
      <p className="page-sub">Tools, schemas and live validation — everything a builder needs to integrate with OSAS.</p>
      <ErrorBox error={manifestError} />
      <ToolCatalog />
      <SchemaBrowser manifest={manifest} onError={setManifestError} />
      <ValidatorPlayground manifest={manifest} />
    </div>
  );
}
