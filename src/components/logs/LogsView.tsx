// Logs — the local-model request log. A real view swap, same slot as
// Automations/Vault/Crew (`baseView`), reached from the sidebar footer's log
// icon (see Sidebar.tsx).
//
// A full page rather than an overlay because the content is a scrolling table
// beside a detail pane; the overlay pattern (Cost) is for a single centred
// panel and would waste the width.
//
// Rows come from two origins that share one table: Relay's own local-model
// calls (`origin: "relay"`, captured in-process) and traffic other apps send
// through the gateway (`origin: "external"`).

import { useEffect, useMemo, useState } from "react";
import { ScrollText, Search, Trash2, RefreshCw, Copy, Check } from "lucide-react";
import { ToolbarHeader } from "../common/ToolbarHeader";
import { GlassSelect, type SelectOption } from "../common/GlassSelect";
import { useLlmLogs } from "../../hooks/useLlmLogs";
import { gatewayStatus, llmLogClear, llmLogPrune } from "../../lib/ipc";
import type { GatewayStatus } from "../../types";
import { LogDetail } from "./LogDetail";

const ORIGINS = [
  { id: null, label: "All" },
  { id: "relay", label: "Relay" },
  { id: "external", label: "External" },
] as const;

const TARGETS = ["llamacpp", "ollama", "lmstudio"] as const;

/** "All runtimes" lives in the option list rather than as a separate control,
 *  matching how GitPanel's provider filter reads. */
const RUNTIMES: SelectOption<string>[] = [
  { value: "", label: "All runtimes" },
  ...TARGETS.map((t) => ({ value: t as string, label: t })),
];

function relativeTime(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

export function LogsView() {
  const [origin, setOrigin] = useState<"relay" | "external" | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [searchRaw, setSearchRaw] = useState("");
  // Debounced so typing doesn't fire a LIKE scan per keystroke.
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  const { rows, stats, loading, error } = useLlmLogs({ origin, target, search });

  // The gateway binds an ephemeral port and persists it, so the URL other apps
  // should use is never a constant — it has to come from the backend.
  const [gateway, setGateway] = useState<GatewayStatus | null>(null);
  useEffect(() => {
    let cancelled = false;
    void gatewayStatus().then((s) => !cancelled && setGateway(s));
    return () => {
      cancelled = true;
    };
  }, []);

  const gatewayUrl = gateway?.running ? `http://127.0.0.1:${gateway.port}` : null;
  const cURL = gatewayUrl ?? "gateway not running";

  const summary = useMemo(() => {
    if (!stats || stats.total === 0) return null;
    const parts = [`${stats.total.toLocaleString()} requests`];
    if (stats.outputTokens > 0) parts.push(`${stats.outputTokens.toLocaleString()} tokens out`);
    if (stats.avgTokensPerSecond) parts.push(`${stats.avgTokensPerSecond.toFixed(1)} tok/s avg`);
    if (stats.avgTtftMs) parts.push(`${Math.round(stats.avgTtftMs)} ms TTFT`);
    if (stats.errorCount > 0) parts.push(`${stats.errorCount} errors`);
    return parts.join(" · ");
  }, [stats]);

  return (
    <div className="logs-view">
      {/* The header rides in the window title bar, not above the page — see
          common/ToolbarHeader. */}
      <ToolbarHeader>
        <div className="logs-header" data-tauri-drag-region="">
          <ScrollText size={18} strokeWidth={1.8} aria-hidden="true" className="logs-header-icon" />
          <h1>Logs</h1>
          {summary && <span className="logs-header-badge">{summary}</span>}
        </div>
      </ToolbarHeader>

      <div className="logs-toolbar">
        <div className="logs-segmented" role="group" aria-label="Filter by origin">
          {ORIGINS.map((o) => (
            <button
              key={o.id ?? "all"}
              type="button"
              className={origin === o.id ? "is-active" : ""}
              onClick={() => setOrigin(o.id)}
            >
              {o.label}
            </button>
          ))}
        </div>

        {/* GlassSelect, not a native <select>: OS-drawn option lists can't be
            themed to match the app, and this is the shared dropdown the rest
            of the shell uses. `null` collapses to "" at the boundary, the same
            shape GitPanel uses for an "all" entry. */}
        <GlassSelect<string>
          value={target ?? ""}
          options={RUNTIMES}
          onChange={(v) => setTarget(v || null)}
          title="Filter by runtime"
        />

        <div className="logs-search">
          <Search size={14} aria-hidden="true" />
          <input
            type="search"
            placeholder="Search prompts and responses"
            value={searchRaw}
            onChange={(e) => {
              setSearchRaw(e.target.value);
              setSearch(e.target.value);
            }}
          />
        </div>

        <div className="logs-toolbar-right">
          <button
            type="button"
            className="logs-btn"
            disabled={!gatewayUrl}
            title={
              gatewayUrl
                ? `Point another app's base_url at ${gatewayUrl}${gateway?.requireAuth ? " with the token from Settings" : " (auth is off)"}`
                : "The gateway is not running"
            }
            onClick={() => {
              if (!gatewayUrl) return;
              void navigator.clipboard?.writeText(gatewayUrl).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              });
            }}
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
            <span>{cURL}</span>
          </button>
          <button
            type="button"
            className="logs-btn"
            title="Apply retention and row limits now"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void llmLogPrune().finally(() => setBusy(false));
            }}
          >
            <RefreshCw size={14} />
            <span>Prune</span>
          </button>
          <button
            type="button"
            className="logs-btn logs-btn-danger"
            title="Delete every logged request"
            disabled={busy || rows.length === 0}
            onClick={() => {
              if (!confirm("Delete all logged requests? This cannot be undone.")) return;
              setBusy(true);
              setSelected(null);
              void llmLogClear().finally(() => setBusy(false));
            }}
          >
            <Trash2 size={14} />
            <span>Clear</span>
          </button>
        </div>
      </div>

      {error && <div className="logs-error">{error}</div>}

      <div className="logs-split">
        <div className="logs-list">
          {loading && rows.length === 0 && <div className="logs-empty">Loading…</div>}
          {!loading && rows.length === 0 && (
            <div className="logs-empty">
              No requests logged yet.
              <span>
                Local-model turns Relay runs show up here automatically; point another app at
                the gateway to capture its traffic too.
              </span>
            </div>
          )}
          {rows.map((r) => (
            <button
              key={r.id}
              type="button"
              className={`logs-row${selected === r.id ? " is-selected" : ""}${r.error ? " is-error" : ""}`}
              onClick={() => setSelected(r.id)}
            >
              <span className="logs-row-time">{relativeTime(r.createdAt)}</span>
              <span className={`logs-chip logs-chip-origin logs-chip-${r.origin}`}>{r.origin}</span>
              <span className="logs-chip logs-chip-target">{r.target}</span>
              <span className="logs-row-path">{r.path}</span>
              <span className="logs-row-metrics">
                {r.upstreamStatus != null && (
                  <span className={r.upstreamStatus >= 400 ? "logs-status-bad" : "logs-status-ok"}>
                    {r.upstreamStatus}
                  </span>
                )}
                {r.outputTokens != null && <span>{r.outputTokens} out</span>}
                {r.tokensPerSecond != null && <span>{r.tokensPerSecond.toFixed(1)} tok/s</span>}
                {r.durationMs != null && <span>{r.durationMs} ms</span>}
              </span>
            </button>
          ))}
        </div>

        <aside className="logs-detail-pane">
          {selected ? (
            <LogDetail id={selected} />
          ) : (
            <div className="logs-detail-empty">Select a request to inspect its payload.</div>
          )}
        </aside>
      </div>
    </div>
  );
}
