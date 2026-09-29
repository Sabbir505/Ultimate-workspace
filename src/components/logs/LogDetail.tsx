// One log row's detail pane: the metadata the normalizer extracted, plus the
// verbatim request and response bodies.
//
// The bodies are the point. Telemetry is best-effort and nullable (see
// llm_log::normalize), so when a field is missing here the raw payload is
// still on screen to read or re-derive from.

import { useEffect, useState } from "react";
import { Copy, Check, AlertTriangle } from "lucide-react";
import { llmLogGet } from "../../lib/ipc";
import type { LlmLogDetail as Detail } from "../../types";

function pretty(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    // Not JSON — SSE, or Ollama's newline-delimited stream. Show it as sent.
    return body;
  }
}

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function Stat({ label, value }: { label: string; value: string | number | null | undefined }) {
  return (
    <div className="logs-stat">
      <span className="logs-stat-label">{label}</span>
      <span className="logs-stat-value">{value ?? "—"}</span>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="logs-copy-btn"
      title="Copy to clipboard"
      aria-label="Copy to clipboard"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        });
      }}
    >
      {done ? <Check size={13} /> : <Copy size={13} />}
    </button>
  );
}

export function LogDetail({ id }: { id: string }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setError(null);
    void llmLogGet(id).then(
      (d) => {
        if (cancelled) return;
        if (d) setDetail(d);
        else setError("That entry no longer exists — it may have aged out.");
      },
      (e) => !cancelled && setError(String(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (error) return <div className="logs-detail-empty">{error}</div>;
  if (!detail) return <div className="logs-detail-empty">Loading…</div>;

  const tps =
    detail.tokensPerSecond != null ? `${detail.tokensPerSecond.toFixed(1)} tok/s` : null;

  return (
    <div className="logs-detail">
      <div className="logs-detail-head">
        <code className="logs-detail-path">
          {detail.method} {detail.path}
        </code>
        <CopyButton text={`${detail.method} ${detail.path}`} />
      </div>

      {detail.error && (
        <div className="logs-detail-error">
          <AlertTriangle size={14} />
          <span>{detail.error}</span>
        </div>
      )}

      <div className="logs-stats">
        <Stat label="Status" value={detail.upstreamStatus ?? "—"} />
        <Stat label="Model" value={detail.model} />
        <Stat label="Duration" value={detail.durationMs != null ? `${detail.durationMs} ms` : null} />
        <Stat label="TTFT" value={detail.ttftMs != null ? `${detail.ttftMs} ms` : null} />
        <Stat label="Input" value={detail.inputTokens} />
        <Stat label="Output" value={detail.outputTokens} />
        <Stat label="Throughput" value={tps} />
        <Stat label="Sizes" value={`${bytes(detail.requestBytes)} → ${bytes(detail.responseBytes)}`} />
      </div>

      {detail.truncated && (
        <p className="logs-truncation">
          Bodies were capped at the configured limit. The untruncated response is not stored.
        </p>
      )}

      <section className="logs-pane">
        <header className="logs-pane-head">
          <h3>Request</h3>
          {detail.requestBody && <CopyButton text={detail.requestBody} />}
        </header>
        <pre className="logs-body">
          {detail.requestBody ? pretty(detail.requestBody) : "(not captured)"}
        </pre>
      </section>

      <section className="logs-pane">
        <header className="logs-pane-head">
          <h3>Response</h3>
          {detail.responseBody && <CopyButton text={detail.responseBody} />}
        </header>
        <pre className="logs-body">
          {detail.responseBody ? pretty(detail.responseBody) : "(no body)"}
        </pre>
      </section>

      {detail.timingsJson && (
        <section className="logs-pane">
          <header className="logs-pane-head">
            <h3>Runtime timings</h3>
            <CopyButton text={detail.timingsJson} />
          </header>
          <pre className="logs-body">{pretty(detail.timingsJson)}</pre>
        </section>
      )}
    </div>
  );
}
