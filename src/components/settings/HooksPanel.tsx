// Settings → Hooks: manage user-defined pre/post tool-call scripts.
//
// A hook runs a user command around agent tool calls (see src-tauri/src/hooks.rs):
// `pre_tool_use` can deny the call (exit 2 / JSON `decision: "deny"`), ask for
// approval (`decision: "ask"` — the same card the permission system uses), or
// rewrite args (`updatedInput`); `post_tool_use` can annotate the result
// (`additionalContext`) or just observe. The first run of each distinct
// command raises the native exec-gate dialog — the Test button triggers that
// same trust prompt deliberately, so a confirmed test trusts the hook for live
// turns. Config is stored as a JSON array under the `hooks` app_settings key.
//
// ORIGIN SCOPE: every tool call carries a dispatch origin (`chat` for the main
// loop, `subagent` for the builtin Task roles, `agent:<id>` for a crew agent,
// `harness` for a CLI harness, `relay_tools` for the MCP bridge). A hook with no
// origins selected is global; otherwise it fires only for the selected ones.
// This is the guardrail for the advisory tier — a crew agent running on a CLI
// harness can call that CLI's own tools, which Relay cannot restrict, so a
// `before` deny hook scoped to `agent:<id>` is what actually stops them.

import { Plus, Trash2, Zap, FlaskConical, Webhook } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  getHooks,
  saveHooks,
  testHook,
  importFromClaude,
  onHookRun,
  isKnownOrigin,
  KNOWN_HOOK_ORIGINS,
  HOOK_ORIGIN_LABELS,
  type ClaudeImportReport,
  type HookDef,
  type HookEvent,
  type HookRunPayload,
  type HookTestReport,
} from "../../lib/ipc";

const TOOL_MATCHER_CHIPS = [
  { label: "* any tool", pattern: "*" },
  { label: "writes", pattern: "write_file|edit_file" },
  { label: "shell", pattern: "run_shell" },
];

/** Lifecycle events fire from the global turn-finalization listeners, which
 *  know the session but not the dispatch origin — so the backend keeps them
 *  global and the picker would be a lie here. */
function isLifecycle(event: HookEvent): boolean {
  return event === "turn_complete" || event === "session_start";
}

function emptyHook(event: HookEvent): HookDef {
  return {
    id: `hook-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    event,
    name: "",
    matcher: "*",
    command: "",
    args: [],
    timeoutSecs: 30,
    onError: "open",
    async: false,
    origins: [],
    enabled: true,
  };
}

function eventBadge(event: HookEvent): string {
  switch (event) {
    case "pre_tool_use": return "before";
    case "post_tool_use": return "after";
    case "turn_complete": return "turn done";
    case "session_start": return "session start";
  }
}

/** One hook's Test report, rendered inline under its row. */
function TestReport({ report }: { report: HookTestReport }) {
  if (report.gateDenied) {
    return (
      <div className="settings-note" style={{ color: "var(--danger, #f85149)" }}>
        Not allowed to run — the exec-gate dialog was dismissed. Allow it to trust this hook.
      </div>
    );
  }
  if (report.timedOut) {
    return <div className="settings-note">Timed out before exiting.</div>;
  }
  if (report.spawnFailed) {
    return (
      <div className="settings-note" style={{ color: "var(--danger, #f85149)" }}>
        Failed to start — check the command (does the executable exist, is it on PATH?).
      </div>
    );
  }
  return (
    <div className="settings-note">
      Exit {report.exitCode ?? "?"} in {report.durationMs} ms
      {report.decision && <> · decision: <span className="mono">{report.decision}</span></>}
      {report.reason && <> · {report.reason}</>}
      {(report.stdout || report.stderr) && (
        <pre className="mono" style={{ marginTop: 6, maxHeight: 120, overflow: "auto", fontSize: 11 }}>
          {[report.stdout, report.stderr].filter(Boolean).join("\n")}
        </pre>
      )}
    </div>
  );
}

export function HooksPanel() {
  const [hooks, setHooks] = useState<HookDef[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<HookDef>(() => emptyHook("pre_tool_use"));
  const [draftArgs, setDraftArgs] = useState("");
  // Free text for the open-ended `agent:<id>` part of the scope — kept apart
  // from `draft.origins` so a half-typed id never round-trips through the array.
  const [draftAgentOrigins, setDraftAgentOrigins] = useState("");
  const [reports, setReports] = useState<Record<string, HookTestReport>>({});
  const [runs, setRuns] = useState<HookRunPayload[]>([]);
  const [importNote, setImportNote] = useState<string | null>(null);

  const handleImport = async () => {
    setBusy(true);
    try {
      const report: ClaudeImportReport = await importFromClaude();
      setImportNote(
        report.fileFound
          ? `Imported ${report.imported.length} hook${report.imported.length === 1 ? "" : "s"} from Claude Code` +
            (report.skippedDuplicates ? ` · ${report.skippedDuplicates} already present` : "") +
            (report.skippedNonCommand ? ` · ${report.skippedNonCommand} non-command handlers skipped` : "")
          : "No ~/.claude/settings.json found — nothing to import."
      );
      await refresh();
    } catch (err) {
      setError(`Import failed: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const refresh = useCallback(async () => {
    try {
      setHooks(await getHooks());
    } catch (err) {
      setError(`Failed to load hooks: ${String(err)}`);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Live hook-run observations (same subscription pattern as KnowledgePanel's
  // index progress): newest first, capped at 20.
  useEffect(() => {
    let stale = false;
    let unlisten: (() => void) | null = null;
    void onHookRun((run) => {
      if (stale) return;
      setRuns((prev) => [run, ...prev].slice(0, 20));
    }).then((u) => {
      if (stale) u();
      else unlisten = u;
    });
    return () => {
      stale = true;
      unlisten?.();
    };
  }, []);

  const persist = async (next: HookDef[]) => {
    setHooks(next);
    try {
      await saveHooks(next);
      setError(null);
    } catch (err) {
      setError(`Failed to save hooks: ${String(err)}`);
      setHooks(await getHooks());
    }
  };

  const handleAdd = async () => {
    if (!draft.command.trim()) {
      setError("Enter a command to run (e.g. node, powershell, prettier).");
      return;
    }
    setBusy(true);
    try {
      await persist([
        ...hooks,
        { ...draft, args: draftArgs.split("\n").map((l) => l.trim()).filter(Boolean) },
      ]);
      setDraft(emptyHook(draft.event));
      setDraftArgs("");
      setDraftAgentOrigins("");
    } finally {
      setBusy(false);
    }
  };

  const toggleDraftOrigin = (origin: string) =>
    setDraft((d) => ({
      ...d,
      origins: d.origins.includes(origin)
        ? d.origins.filter((o) => o !== origin)
        : [...d.origins, origin],
    }));

  /** Comma/space separated ids; a bare id gets the `agent:` prefix so the
   *  field accepts what the crew panel shows. */
  const setDraftAgentList = (raw: string) => {
    setDraftAgentOrigins(raw);
    const parsed = raw
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => (s.startsWith("agent:") ? s : `agent:${s}`));
    setDraft((d) => ({
      ...d,
      // The text field owns the whole `agent:` list: drop the previous parse
      // and take the new one, leaving the ticked fixed origins (and any
      // unrecognized value the user hand-edited) untouched.
      origins: [...d.origins.filter((o) => !o.startsWith("agent:")), ...parsed],
    }));
  };

  const handleRemove = async (id: string) => {
    setBusy(true);
    try {
      await persist(hooks.filter((h) => h.id !== id));
    } finally {
      setBusy(false);
    }
  };

  const handleToggle = async (id: string) => {
    setBusy(true);
    try {
      await persist(hooks.map((h) => (h.id === id ? { ...h, enabled: !h.enabled } : h)));
    } finally {
      setBusy(false);
    }
  };

  const handleTest = async (hook: HookDef) => {
    setBusy(true);
    try {
      const report = await testHook(hook);
      setReports((r) => ({ ...r, [hook.id]: report }));
    } catch (err) {
      setError(`Test failed: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const hasCommand = draft.command.trim().length > 0;

  return (
    <div className="settings-form">
      <div className="panel-head">
        <h3>Hooks</h3>
        {hooks.length > 0 && <span className="panel-count">{hooks.length} hook{hooks.length === 1 ? "" : "s"}</span>}
      </div>

      {runs.length > 0 && (
        <div className="settings-note mono" style={{ maxHeight: 160, overflow: "auto", fontSize: 11 }}>
          {runs.map((run, i) => (
            <div key={`${run.event}-${i}`}>
              {run.event} · {run.hookName || "(unnamed)"} · {run.tool || "—"} · {run.verdict} · {run.durationMs}ms
            </div>
          ))}
        </div>
      )}

      <div className="perm-card perm-info-card">
        <Webhook className="perm-icon" size={20} />
        <div>
          <div className="perm-info-title">Run your own scripts around tool calls</div>
          <div className="perm-info-body">
            A <span className="mono">before</span> hook can block a tool call (exit 2, or JSON
            {" "}<span className="mono">{`{"decision":"deny"}`}</span> on stdout), request approval, or rewrite
            arguments (<span className="mono">updatedInput</span>). An <span className="mono">after</span> hook can
            annotate the result (<span className="mono">additionalContext</span>). The command receives one JSON
            event on stdin and runs directly — never through a shell. The first run of each command asks via a
            native dialog. Leave the origin checkboxes empty to run everywhere, or pick the origins a hook
            should fire for — scoping a <span className="mono">before</span> hook to a crew agent
            (<span className="mono">agent:&lt;id&gt;</span>) is the guardrail for agents Relay can't otherwise
            restrain.
          </div>
        </div>
      </div>

      <div className="perm-card perm-add-card">
        <div className="perm-add-row">
          <select
            value={draft.event}
            onChange={(e) => {
              const event = e.target.value as HookEvent;
              // Lifecycle events are global in the backend (no dispatch origin
              // at the fire site), so drop any scope the user had staged —
              // BOTH the parsed origins and the free-text mirror, or the
              // field would still show agent ids after a round-trip through
              // a lifecycle event while the saved hook had gone global.
              if (isLifecycle(event)) {
                setDraft({ ...draft, event, origins: [] });
                setDraftAgentOrigins("");
              } else {
                setDraft({ ...draft, event });
              }
            }}
            aria-label="Hook event"
            className="perm-tool-select"
          >
            <option value="pre_tool_use">Before tool (pre_tool_use)</option>
            <option value="post_tool_use">After tool (post_tool_use)</option>
            <option value="turn_complete">Turn finished (turn_complete)</option>
            <option value="session_start">First message (session_start)</option>
          </select>
          <input
            type="text"
            value={draft.name}
            placeholder="Name (optional)"
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            className="perm-pattern-input"
            disabled={busy}
            aria-label="Hook name"
          />
          <input
            type="text"
            value={draft.command}
            placeholder="Command, e.g. node"
            onChange={(e) => {
              setDraft({ ...draft, command: e.target.value });
              if (e.target.value.trim()) setError(null);
            }}
            className="perm-pattern-input"
            disabled={busy}
            aria-label="Command"
          />
          <button className="primary" onClick={() => void handleAdd()} disabled={busy || !hasCommand} type="button">
            <Plus size={16} /> Add
          </button>
        </div>
        <div className="perm-add-row">
          <input
            type="text"
            value={draft.matcher}
            placeholder="write_file|edit_file · * = all · or a regex e.g. write_.*"
            onChange={(e) => setDraft({ ...draft, matcher: e.target.value })}
            className="perm-pattern-input"
            disabled={busy}
            aria-label="Tool matcher"
          />
          <textarea
            value={draftArgs}
            rows={2}
            placeholder={"Arguments, one per line; ${tool_input.path} substitutes"}
            onChange={(e) => setDraftArgs(e.target.value)}
            className="perm-pattern-input"
            disabled={busy}
            aria-label="Arguments"
            style={{ resize: "vertical" }}
          />
          <select
            value={draft.onError}
            onChange={(e) => setDraft({ ...draft, onError: e.target.value as HookDef["onError"] })}
            aria-label="Failure behavior"
            className="perm-tool-select"
          >
            <option value="open">On error: skip</option>
            <option value="closed">On error: block</option>
          </select>
          {draft.event === "post_tool_use" && (
            <label style={{ display: "flex", alignItems: "center", gap: 6, whiteSpace: "nowrap" }}>
              <input
                type="checkbox"
                checked={draft.async}
                onChange={(e) => setDraft({ ...draft, async: e.target.checked })}
                disabled={busy}
              />
              Run detached
            </label>
          )}
        </div>
        <div className="perm-add-row">
          {isLifecycle(draft.event) ? (
            <div className="settings-note" style={{ flex: 1 }}>
              Fires for every turn, whoever started it — turn/session events carry no
              origin, so they are always global.
            </div>
          ) : (
            <>
              <span className="settings-note" style={{ alignSelf: "center", whiteSpace: "nowrap" }}>
                {draft.origins.length === 0 ? "Runs for:" : "Only for:"}
              </span>
              {KNOWN_HOOK_ORIGINS.map((o) => (
                <label
                  key={o}
                  style={{ display: "flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" }}
                >
                  <input
                    type="checkbox"
                    checked={draft.origins.includes(o)}
                    onChange={() => toggleDraftOrigin(o)}
                    disabled={busy}
                    aria-label={`Scope to ${HOOK_ORIGIN_LABELS[o] ?? o}`}
                    title={HOOK_ORIGIN_LABELS[o] ?? o}
                  />
                  <span className="mono">{o}</span>
                </label>
              ))}
              <input
                type="text"
                value={draftAgentOrigins}
                placeholder="agent:<crew-id>, agent:other-id — blank = all origins"
                onChange={(e) => setDraftAgentList(e.target.value)}
                className="perm-pattern-input"
                disabled={busy}
                aria-label="Crew agent origins"
              />
            </>
          )}
        </div>
        <div className="perm-chips">
          {TOOL_MATCHER_CHIPS.map((c) => (
            <button
              key={c.pattern}
              type="button"
              className="perm-chip"
              onClick={() => {
                setDraft({ ...draft, matcher: c.pattern });
                setError(null);
              }}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="settings-note" style={{ color: "var(--danger, #f85149)" }}>
          {error}
        </div>
      )}

      {importNote && <div className="settings-note">{importNote}</div>}

      <button type="button" className="ghost" onClick={() => void handleImport()} disabled={busy}
        style={{ alignSelf: "flex-start" }}>
        Import from Claude Code settings…
      </button>

      {hooks.length === 0 ? (
        <div className="empty-reserved">
          <Zap className="empty-icon" size={22} />
          <div className="empty-text">
            No hooks yet. Add one above — for example a formatter that runs after every edit, or a
            guard that blocks writes to protected paths.
          </div>
        </div>
      ) : (
        <div className="perm-rules-list">
          {hooks.map((h) => (
            <div key={h.id} className="perm-rule-row" style={{ flexWrap: "wrap", alignItems: "flex-start" }}>
              <span className="perm-rule-tool">{eventBadge(h.event)}</span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span className="perm-rule-pattern mono">
                  {h.name || h.command} {h.command !== (h.name || h.command) && h.name ? `(${h.command})` : ""}
                </span>
                <span style={{ opacity: 0.7, marginLeft: 8, fontSize: 12 }}>
                  {h.matcher || "*"} · {h.timeoutSecs}s
                  {h.async && " · detached"}
                  {h.onError === "closed" && " · fail-closed"}
                </span>
                <div style={{ fontSize: 12, marginTop: 2, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                  <span style={{ opacity: 0.7 }}>
                    {h.origins.length === 0 ? "all origins" : `only: ${h.origins.join(", ")}`}
                  </span>
                  {h.origins.filter((o) => !isKnownOrigin(o)).map((o) => (
                    // Kept, not dropped: an unrecognized origin is inert (it
                    // matches no dispatch origin) but the user must SEE it —
                    // a stale id or a typo'd prefix silently narrowing a hook
                    // is exactly the failure this warns about.
                    <span
                      key={o}
                      className="perm-chip"
                      style={{ color: "var(--warn, #d29922)" }}
                      title={`Not an origin Relay dispatches ("${o}"). This hook will not fire for it.`}
                    >
                      unknown origin: {o}
                    </span>
                  ))}
                </div>
                {reports[h.id] && (
                  <div style={{ marginTop: 6 }}>
                    <TestReport report={reports[h.id]} />
                  </div>
                )}
              </span>
              <label style={{ display: "flex", alignItems: "center", gap: 6, whiteSpace: "nowrap" }}>
                <input
                  type="checkbox"
                  checked={h.enabled}
                  onChange={() => void handleToggle(h.id)}
                  disabled={busy}
                  aria-label={`Enable ${h.name || h.command}`}
                />
                enabled
              </label>
              <button
                type="button"
                className="ghost"
                onClick={() => void handleTest(h)}
                disabled={busy}
                title="Run against a test event"
                aria-label="Test hook"
              >
                <FlaskConical size={16} />
              </button>
              <button
                type="button"
                className="ghost"
                style={{ color: "var(--danger, #f85149)" }}
                onClick={() => void handleRemove(h.id)}
                disabled={busy}
                title="Remove hook"
                aria-label="Remove hook"
              >
                <Trash2 size={16} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
