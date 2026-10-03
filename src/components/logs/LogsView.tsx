// Logs — the local-model request log. A real view swap, same slot as
// Automations/Vault/Subagent (`baseView`), reached from the sidebar footer's log
// icon (see Sidebar.tsx).
//
// A full page rather than an overlay because the content is a scrolling table
// beside a detail pane; the overlay pattern (Cost) is for a single centred
// panel and would waste the width.
//
// Rows come from two origins that share one table: Relay's own local-model
// calls (`origin: "relay"`, captured in-process) and traffic other apps send
// through the gateway (`origin: "external"`).

import { memo, useEffect, useMemo, useState } from "react";
import { ScrollText, Search, Trash2, RefreshCw, Copy, Check } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ToolbarHeader } from "../common/ToolbarHeader";
import { GlassSelect, type SelectOption } from "../common/GlassSelect";
import { useLlmLogs } from "../../hooks/useLlmLogs";
import { gatewayStatus, llmLogClear, llmLogPrune } from "../../lib/ipc";
import type { GatewayStatus, LlmLogSummary } from "../../types";
import { LogDetail } from "./LogDetail";

const ORIGINS = [
  { id: null, label: "All" },
  { id: "relay", label: "Relay" },
  { id: "external", label: "External" },
] as const;

/** Fallback while `gatewayStatus` loads; the real list (which includes
 *  user-registered targets and anything with rows) replaces it. */
const TARGETS = ["llamacpp", "ollama", "lmstudio"] as const;

/** "All runtimes" lives in the option list rather than as a separate control,
 *  matching how GitPanel's provider filter reads. */
function runtimeOptions(known: readonly string[] | undefined): SelectOption<string>[] {
  const list = (known && known.length > 0 ? known : TARGETS) as readonly string[];
  return [
    { value: "", label: "All runtimes" },
    ...list.map((t) => ({ value: t as string, label: t })),
  ];
}

/** `createdAt` is unix SECONDS (what `now_ts()` writes) — not the
 *  milliseconds `Date.now()` returns. Mixing them printed every row as
 *  "~20000d" old. */
function relativeTime(ts: number): string {
  const s = Math.max(0, Math.round(Date.now() / 1000 - ts));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

/** Typing shouldn't fire the body LIKE scan (or re-subscribe the listener)
 *  per keystroke — the input updates instantly, the filter follows a beat
 *  behind. */
const SEARCH_DEBOUNCE_MS = 250;

/** One table row, memoized: appends re-render the list body per poll, and
 *  the full row markup (time/chips/metrics) is unchanged for every existing
 *  entry when only new rows arrive. */
const LogsRow = memo(function LogsRow({
  row,
  selected,
  onSelect,
}: {
  row: LlmLogSummary;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <button
      type="button"
      className={`logs-row${selected ? " is-selected" : ""}${row.error ? " is-error" : ""}`}
      onClick={() => onSelect(row.id)}
    >
      <span className="logs-row-time">{relativeTime(row.createdAt)}</span>
      <span className={`logs-chip logs-chip-origin logs-chip-${row.origin}`}>{row.origin}</span>
      <span className="logs-chip logs-chip-target">{row.target}</span>
      <span className="logs-row-path">{row.path}</span>
      <span className="logs-row-metrics">
        {row.upstreamStatus != null && (
          <span className={row.upstreamStatus >= 400 ? "logs-status-bad" : "logs-status-ok"}>
            {row.upstreamStatus}
          </span>
        )}
        {row.outputTokens != null && <span>{row.outputTokens} out</span>}
        {row.tokensPerSecond != null && <span>{row.tokensPerSecond.toFixed(1)} tok/s</span>}
        {row.durationMs != null && <span>{row.durationMs} ms</span>}
      </span>
    </button>
  );
});

export function LogsView() {
  const [origin, setOrigin] = useState<"relay" | "external" | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [searchRaw, setSearchRaw] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  // Prune/Clear/gateway-status failures — the banner under the toolbar.
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setSearch(searchRaw), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [searchRaw]);

  const { rows, stats, loading, loadingMore, error, refresh, loadMore, canLoadMore } =
    useLlmLogs({ origin, target, search });

  // Audit M (logs re-render): appends replace the whole array every debounced
  // poll, so all mounted rows re-rendered per refresh — LogsRow is memoized
  // below so unchanged rows skip the re-render, which was the dominant cost.
  // A @tanstack/react-virtual window was tried here, but virtual-core sizes
  // its window from the scroll element's offsetWidth/offsetHeight and mounts
  // with a bogus offset under conditions this list can hit (deferred until it
  // can be verified in a real webview); the memo keeps the per-poll cost
  // proportional to changed rows instead.

  // The gateway binds an ephemeral port and persists it, so the URL other apps
  // should use is never a constant — it has to come from the backend.
  const [gateway, setGateway] = useState<GatewayStatus | null>(null);
  useEffect(() => {
    let cancelled = false;
    void gatewayStatus()
      .then((s) => !cancelled && setGateway(s))
      .catch((e) => {
        if (!cancelled) setActionError(`Couldn't read gateway status: ${e instanceof Error ? e.message : String(e)}`);
      });
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
            themed to match the app, and this is the shared dropdown the rest of
            the shell uses. `null` collapses to "" at the boundary, the same
            shape GitPanel uses for an "all" entry. The options come from the
            backend so a user-registered gateway target is filterable too. */}
        <GlassSelect<string>
          value={target ?? ""}
          options={runtimeOptions(gateway?.knownTargets)}
          onChange={(v) => setTarget(v || null)}
          title="Filter by runtime"
        />

        <div className="logs-search">
          <Search size={14} aria-hidden="true" />
          <input
            type="search"
            placeholder="Search prompts and responses"
            value={searchRaw}
            onChange={(e) => setSearchRaw(e.target.value)}
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
              setActionError(null);
              void llmLogPrune()
                .catch((e) =>
                  setActionError(`Prune failed: ${e instanceof Error ? e.message : String(e)}`),
                )
                .finally(() => {
                  refresh();
                  setBusy(false);
                });
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
              setActionError(null);
              void llmLogClear()
                .catch((e) =>
                  setActionError(`Clear failed: ${e instanceof Error ? e.message : String(e)}`),
                )
                .finally(() => {
                  refresh();
                  setBusy(false);
                });
            }}
          >
            <Trash2 size={14} />
            <span>Clear</span>
          </button>
        </div>
      </div>

      {error && <div className="logs-error">{error}</div>}
      {actionError && <div className="logs-error">{actionError}</div>}

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
            <LogsRow key={r.id} row={r} selected={selected === r.id} onSelect={setSelected} />
          ))}
          {canLoadMore && (
            <button
              type="button"
              className="logs-load-more"
              disabled={loadingMore}
              onClick={() => void loadMore()}
            >
              {loadingMore ? "Loading…" : "Load older requests"}
            </button>
          )}
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
