import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  listChatModels,
  listHarnessModels,
  memoryCreate,
  memoryDelete,
  memoryDocumentHistory,
  memoryExport,
  memoryList,
  memoryPurge,
  memoryRecentOps,
  memorySetDocument,
  memorySetEnabled,
  memorySetExtractModel,
  memoryStatus,
  memoryUpdate,
  scanLocalModels,
  type MemoryDocVersionView,
  type MemoryOpRowView,
  type MemoryRecordView,
  type MemoryStatusView,
} from "../../lib/ipc";
import { shortModelName } from "../../lib/modelLabel";
import { Modal } from "../common/Modal";

/**
 * Settings → Memory browser (MEMORY_DESIGN_ARCHITECTURE.md §12.2, amended).
 * The anti-black-box commitment: the assistant injects ONE human-readable
 * memory document each turn (≤2200 tokens, enforced in Rust) — the editor
 * below shows and edits exactly that text. New memories are merged into the
 * document automatically by the extraction pipeline (dedupe + contradiction
 * resolution). The raw fact records stay listed underneath as the audit log.
 */

const KIND_LABELS: Record<string, string> = {
  identity: "Identity",
  preference: "Preference",
  fact: "Fact",
  project: "Project",
  feedback: "Feedback",
  episode: "Episode",
};

const STATUS_FILTERS = ["active", "superseded", "retired", "flagged"] as const;

/** Agent sources for the extraction-model picker — the SAME groups and ids
 *  the Automations form offers (AGENT_OPTIONS there), so both surfaces read
 *  identically: CLI harnesses, cloud API providers, local GGUF. */
const EXTRACT_AGENT_OPTIONS: { id: string; label: string; group: "harness" | "api" | "local" }[] = [
  { id: "claude_code", label: "Claude Code (harness)", group: "harness" },
  { id: "opencode", label: "OpenCode (harness)", group: "harness" },
  { id: "pi", label: "Pi (harness)", group: "harness" },
  { id: "omp", label: "Omp (harness)", group: "harness" },
  { id: "commandcode", label: "CommandCode (harness)", group: "harness" },
  { id: "anthropic", label: "Anthropic API", group: "api" },
  { id: "openai", label: "OpenAI API", group: "api" },
  { id: "openrouter", label: "OpenRouter", group: "api" },
  { id: "anthropic_compatible", label: "Anthropic-compatible", group: "api" },
  { id: "openai_compatible", label: "OpenAI-compatible", group: "api" },
  { id: "local_gguf", label: "Local GGUF", group: "local" },
];

function extractAgentGroup(id: string): "harness" | "api" | "local" {
  return EXTRACT_AGENT_OPTIONS.find((a) => a.id === id)?.group ?? "api";
}

/** Same chars→tokens estimate the Rust side uses (4 chars ≈ 1 token). */
const estTokens = (text: string) => Math.ceil(text.length / 4);

function fmtDate(unixSecs: number): string {
  try {
    return new Date(unixSecs * 1000).toLocaleDateString();
  } catch {
    return String(unixSecs);
  }
}

export function MemoryPanel() {
  const [status, setStatus] = useState<MemoryStatusView | null>(null);
  const [memories, setMemories] = useState<MemoryRecordView[]>([]);
  const [filter, setFilter] = useState<(typeof STATUS_FILTERS)[number] | "all">("active");
  const [query, setQuery] = useState("");
  const [newFact, setNewFact] = useState("");
  const [newKind, setNewKind] = useState("fact");
  const [editing, setEditing] = useState<{ id: string; content: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // Typed confirmation for the destructive purge (replaces the native
  // window.prompt, which rendered as an unstyled browser dialog).
  const [confirmPurge, setConfirmPurge] = useState(false);
  const [purgeInput, setPurgeInput] = useState("");

  // Cheap extraction model override (extraction + judge + document merge):
  // an agent/source (CLI harness, cloud API, or local GGUF — same groups as
  // the Automations form) plus a model auto-fetched for that source. Applied
  // as "provider::model"; "" = use the chat's own model.
  const [extractAgent, setExtractAgent] = useState("chat");
  const [extractModel, setExtractModel] = useState("");
  const [modelOptions, setModelOptions] = useState<{ id: string; label: string }[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [extractModelSaved, setExtractModelSaved] = useState(false);
  const extractAgentIsHarness = extractAgentGroup(extractAgent) === "harness";

  // Raw entries vs audit log — two tabs over the same underlying data.
  const [listTab, setListTab] = useState<"entries" | "audit">("entries");

  // Document version history (History + Restore).
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<MemoryDocVersionView[] | null>(null);

  // Write-decision audit log.
  const [ops, setOps] = useState<MemoryOpRowView[] | null>(null);

  // The memory document editor. `docDirty` (ref, so the refresh closure can
  // read it) keeps an in-flight refresh from clobbering unsaved edits.
  const [doc, setDoc] = useState("");
  const [docError, setDocError] = useState<string | null>(null);
  const [docSavedFlash, setDocSavedFlash] = useState(false);
  const docDirty = useRef(false);

  const refresh = useCallback(async () => {
    const [s, list] = await Promise.all([memoryStatus(), memoryList(true)]);
    setStatus(s);
    setMemories(list ?? []);
    // Rehydrate the picker from the stored "provider::model" override.
    const stored = s?.extractModel ?? "";
    if (stored.includes("::")) {
      const [p, m] = stored.split("::");
      setExtractAgent(p);
      setExtractModel(m);
    } else {
      setExtractAgent("chat");
      setExtractModel("");
    }
    if (!docDirty.current) setDoc(s?.document ?? "");
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Auto-fetch the model list whenever the extraction agent source changes —
  // same three-way fetch the Automations form does (harness catalog / cloud
  // API / local scan).
  useEffect(() => {
    if (extractAgent === "chat") {
      setModelOptions([]);
      return;
    }
    let cancelled = false;
    setModelsLoading(true);
    setModelOptions([]);
    void (async () => {
      try {
        if (extractAgentIsHarness) {
          const cfg = await listHarnessModels(extractAgent);
          if (!cancelled && cfg) {
            setModelOptions(cfg.models.map((m) => ({ id: m.id, label: m.label })));
          }
        } else if (extractAgentGroup(extractAgent) === "api") {
          const list = await listChatModels(extractAgent);
          if (!cancelled && list) {
            const deduped = [...new Set(list.map((m) => m.id))];
            setModelOptions(
              deduped.map((id) => ({ id, label: shortModelName(id) })),
            );
          }
        } else {
          const local = await scanLocalModels();
          if (!cancelled && local) {
            setModelOptions(
              local.map((m) => ({ id: m.name || m.filename, label: shortModelName(m.name || m.filename) })),
            );
          }
        }
      } catch {
        // listing failed — the free-text input stays available
      } finally {
        if (!cancelled) setModelsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [extractAgent, extractAgentIsHarness]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return memories
      .filter((m) => (filter === "all" ? true : m.status === filter))
      .filter((m) => (q ? m.content.toLowerCase().includes(q) : true));
  }, [memories, filter, query]);

  const budget = status?.documentBudget ?? 2200;
  const docTokens = estTokens(doc);
  const docOver = docTokens > budget;

  const toggle = async (enabled: boolean) => {
    setBusy(true);
    await memorySetEnabled(enabled);
    await refresh();
    setBusy(false);
  };

  const saveDoc = async () => {
    setBusy(true);
    setDocError(null);
    try {
      await memorySetDocument(doc);
      docDirty.current = false;
      setDocSavedFlash(true);
      window.setTimeout(() => setDocSavedFlash(false), 2500);
      await refresh();
    } catch (err) {
      setDocError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const resetDoc = async () => {
    setBusy(true);
    setDocError(null);
    try {
      await memorySetDocument("");
      docDirty.current = false;
      await refresh();
    } catch (err) {
      setDocError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const changeExtractModel = async (value: string) => {
    setExtractModel(value);
    setBusy(true);
    try {
      await memorySetExtractModel(value.trim());
      setExtractModelSaved(true);
      window.setTimeout(() => setExtractModelSaved(false), 2500);
    } finally {
      setBusy(false);
    }
  };

  const switchListTab = (tab: "entries" | "audit") => {
    setListTab(tab);
    // Audit rows load lazily the first time the tab opens.
    if (tab === "audit" && ops === null) {
      void memoryRecentOps(30).then((rows) => setOps(rows ?? []));
    }
  };

  /** Persist the override as `agent::model`. CLI harnesses can't run the
   *  background pipeline (they're interactive agent turns), so browsing them
   *  never overwrites the saved pick — the inline warning explains. */
  const applyExtractOverride = async (agent: string, model: string) => {
    if (extractAgentGroup(agent) === "harness") return;
    const value = agent === "chat" || !model ? "" : `${agent}::${model}`;
    setBusy(true);
    try {
      await memorySetExtractModel(value);
      setExtractModelSaved(true);
      window.setTimeout(() => setExtractModelSaved(false), 2500);
    } finally {
      setBusy(false);
    }
  };

  const toggleHistory = async () => {
    const next = !historyOpen;
    setHistoryOpen(next);
    if (next && history === null) {
      setHistory((await memoryDocumentHistory(20)) ?? []);
    }
  };

  const restoreVersion = async (v: MemoryDocVersionView) => {
    setBusy(true);
    setDocError(null);
    try {
      await memorySetDocument(v.text);
      docDirty.current = false;
      setHistoryOpen(false);
      await refresh();
    } catch (err) {
      setDocError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const retire = async (id: string) => {
    setBusy(true);
    await memoryDelete(id);
    await refresh();
    setBusy(false);
  };

  const saveEdit = async () => {
    if (!editing) return;
    setBusy(true);
    await memoryUpdate(editing.id, editing.content);
    setEditing(null);
    await refresh();
    setBusy(false);
  };

  const add = async () => {
    const content = newFact.trim();
    if (!content) return;
    setBusy(true);
    await memoryCreate(content, newKind);
    setNewFact("");
    await refresh();
    setBusy(false);
  };

  const purgeAll = async () => {
    setBusy(true);
    try {
      await memoryPurge();
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const exportAll = async () => {
    const json = await memoryExport();
    if (!json) return;
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `memory-export-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="panel memory-panel" data-testid="memory-panel">
      <div className="panel-head">
        <div>
          <h2>Memory</h2>
          <p className="muted">
            One human-readable profile the assistant remembers across chats —
            stored locally, shown in full, and merged automatically as new
            facts arrive.
          </p>
        </div>
        <label className="memory-toggle">
          <input
            type="checkbox"
            checked={status?.enabled ?? true}
            disabled={busy}
            onChange={(e) => void toggle(e.target.checked)}
          />
          <span className="memory-toggle-track" aria-hidden="true">
            <span className="memory-toggle-knob" />
          </span>
          <span>Remember across chats</span>
        </label>
      </div>

      {/* ── The memory document: exactly what gets injected each turn ── */}
      <div className="memory-doc" data-testid="memory-doc">
        <div className="memory-doc-head">
          <h3>Memory document</h3>
          <span
            className={`memory-doc-budget${docOver ? " over" : ""}`}
            title="Rough token estimate — the injection budget enforced in Rust"
          >
            ~{docTokens} / {budget} tokens
          </span>
        </div>
        <p className="muted memory-doc-note">
          New memories are merged into this document automatically — duplicates
          folded, contradictions resolved — and it is injected as one message
          every turn. Edit it freely; what you save is what the assistant sees.
        </p>
        <textarea
          className="memory-doc-editor"
          value={doc}
          rows={12}
          spellCheck={false}
          placeholder="Nothing here yet — chat with the assistant, or write your own memory document."
          onChange={(e) => {
            docDirty.current = true;
            setDocError(null);
            setDoc(e.target.value);
          }}
        />
        <div className="memory-doc-actions">
          <button
            onClick={() => void saveDoc()}
            disabled={busy || !docDirty.current || docOver}
          >
            Save document
          </button>
          {status?.documentStored && (
            <button onClick={() => void resetDoc()} disabled={busy}>
              Reset to auto-generated
            </button>
          )}
          <button
            onClick={() => void toggleHistory()}
            disabled={busy}
            title="Restore a previous version"
          >
            {historyOpen ? "Hide history" : "History"}
          </button>
          {docSavedFlash && <span className="memory-doc-flash">Saved ✓</span>}
          {docError && <span className="memory-doc-error">{docError}</span>}
        </div>
        {historyOpen && (
          <div className="memory-doc-history">
            {history === null ? (
              <span className="muted">Loading…</span>
            ) : history.length === 0 ? (
              <span className="muted">No stored versions yet — merges and saves will appear here.</span>
            ) : (
              history.map((v) => (
                <div key={v.id} className="memory-doc-version">
                  <div className="memory-doc-version-meta">
                    <span className="chip kind">{v.source === "user" ? "your edit" : "auto merge"}</span>
                    <span className="muted">{fmtDate(v.createdAt)}</span>
                    <span className="muted">~{estTokens(v.text)} tokens</span>
                  </div>
                  <div className="memory-doc-version-text">{v.text}</div>
                  <button
                    onClick={() => void restoreVersion(v)}
                    disabled={busy}
                    title="Make this version the current document"
                  >
                    Restore
                  </button>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* Cheap-model override for extraction / judge / document merge —
          the SAME agent groups + auto-fetching model picker the Automations
          form uses (CLI harness / cloud API / local GGUF). */}
      <div className="memory-extract-model">
        <label htmlFor="memory-extract-agent">Extraction model</label>
        <select
          id="memory-extract-agent"
          value={extractAgent}
          disabled={busy}
          onChange={(e) => {
            setExtractAgent(e.target.value);
            setExtractModel("");
            void applyExtractOverride(e.target.value, "");
          }}
        >
          <option value="chat">Chat model (automatic)</option>
          <optgroup label="CLI Agents">
            {EXTRACT_AGENT_OPTIONS.filter((a) => a.group === "harness").map((a) => (
              <option key={a.id} value={a.id}>{a.label}</option>
            ))}
          </optgroup>
          <optgroup label="Cloud APIs">
            {EXTRACT_AGENT_OPTIONS.filter((a) => a.group === "api").map((a) => (
              <option key={a.id} value={a.id}>{a.label}</option>
            ))}
          </optgroup>
          <optgroup label="Local">
            {EXTRACT_AGENT_OPTIONS.filter((a) => a.group === "local").map((a) => (
              <option key={a.id} value={a.id}>{a.label}</option>
            ))}
          </optgroup>
        </select>
        {extractAgent !== "chat"
          ? modelOptions.length > 0 && !modelsLoading ? (
            <select
              value={extractModel}
              disabled={busy}
              onChange={(e) => void changeExtractModel(e.target.value)}
            >
              <option value="">
                {extractAgentIsHarness
                  ? "Harness default"
                  : extractAgentGroup(extractAgent) === "local"
                    ? "Auto-detect"
                    : "Provider default"}
              </option>
              {modelOptions.map((m) => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>
          ) : (
            <input
              value={extractModel}
              onChange={(e) => void changeExtractModel(e.target.value)}
              placeholder={modelsLoading ? "Loading models…" : "model id"}
              disabled={modelsLoading}
              spellCheck={false}
            />
          )
          : (
            <select disabled aria-label="Model (follows your chat selection)">
              <option>Chat model (automatic)</option>
            </select>
          )}
        {extractModelSaved && <span className="memory-doc-flash">Saved ✓</span>}
        {extractAgentIsHarness && (
          <span className="memory-doc-error memory-extract-model-hint">
            CLI harnesses are interactive agent turns and can't run the
            background memory pipeline — pick a Cloud API or Local model.
          </span>
        )}
        <span className="muted memory-extract-model-hint">
          Runs the background pipeline (extraction, judging, document merges) —
          a small local or cheap cloud model keeps it inexpensive.
        </span>
      </div>

      <div className="memory-raw">
        <div className="memory-tabs" role="tablist">
          <button
            role="tab"
            aria-selected={listTab === "entries"}
            className={`memory-tab${listTab === "entries" ? " on" : ""}`}
            onClick={() => switchListTab("entries")}
          >
            Raw memory entries
          </button>
          <button
            role="tab"
            aria-selected={listTab === "audit"}
            className={`memory-tab${listTab === "audit" ? " on" : ""}`}
            onClick={() => switchListTab("audit")}
          >
            Audit log
          </button>
        </div>

        {listTab === "entries" ? (
          <>
            <p className="muted">
              The underlying fact records — everything the memory document was
              built from. Search, edit, or forget individual facts.
            </p>
            <div className="memory-toolbar">
              <input
                className="memory-search"
                placeholder="Search memories…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <div className="memory-filters">
                {(["all", ...STATUS_FILTERS] as const).map((f) => (
                  <button
                    key={f}
                    className={`chip${filter === f ? " on" : ""}`}
                    onClick={() => setFilter(f)}
                  >
                    {f}
                  </button>
                ))}
              </div>
              <div className="memory-actions">
                <button onClick={() => void exportAll()} disabled={busy}>
                  Export
                </button>
                <button className="danger" onClick={() => setConfirmPurge(true)} disabled={busy}>
                  Delete all…
                </button>
              </div>
            </div>

            <div className="memory-add">
              <input
                placeholder="Add a fact yourself, e.g. “Prefers concise answers”…"
                value={newFact}
                onChange={(e) => setNewFact(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void add();
                }}
              />
              <select value={newKind} onChange={(e) => setNewKind(e.target.value)}>
                {Object.entries(KIND_LABELS).map(([k, label]) => (
                  <option key={k} value={k}>
                    {label}
                  </option>
                ))}
              </select>
              <button onClick={() => void add()} disabled={busy || !newFact.trim()}>
                Add
              </button>
            </div>

            <div className="memory-count muted">
              {status ? `${status.activeCount} active · ${memories.length} total` : "—"}
            </div>

            <ul className="memory-list">
              {shown.map((m) => (
                <li key={m.id} className={`memory-item status-${m.status}`} data-memory-id={m.id}>
                  {editing?.id === m.id ? (
                    <div className="memory-edit">
                      <input
                        value={editing.content}
                        onChange={(e) => setEditing({ id: m.id, content: e.target.value })}
                      />
                      <button onClick={() => void saveEdit()} disabled={busy}>
                        Save
                      </button>
                      <button onClick={() => setEditing(null)}>Cancel</button>
                    </div>
                  ) : (
                    <>
                      <div className="memory-meta">
                        <span className="chip kind">{KIND_LABELS[m.kind] ?? m.kind}</span>
                        {m.projectId && (
                          <span className="chip kind" title="Learned inside a project chat — injected only there">
                            project-scoped
                          </span>
                        )}
                        <span className="muted">conf {m.confidence.toFixed(2)}</span>
                        <span className="muted">importance {m.importance}</span>
                        <span className="muted">{fmtDate(m.createdAt)}</span>
                        <span className="muted">
                          {m.status !== "active" ? `· ${m.status}` : ""}
                          {m.origin === "user_created" ? " · edited by you" : ""}
                        </span>
                      </div>
                      <div className="memory-content">{m.content}</div>
                      <div className="memory-item-actions">
                        <button onClick={() => setEditing({ id: m.id, content: m.content })}>
                          Edit
                        </button>
                        {m.status === "active" && (
                          <button onClick={() => void retire(m.id)} disabled={busy}>
                            Forget
                          </button>
                        )}
                      </div>
                    </>
                  )}
                </li>
              ))}
              {shown.length === 0 && (
                <li className="muted memory-empty">
                  {status?.enabled
                    ? "Nothing here yet — the assistant learns as you chat."
                    : "Memory is off. Turn it on to let the assistant remember across chats."}
                </li>
              )}
            </ul>
          </>
        ) : (
          <div className="memory-audit">
            <p className="muted">
              Every write decision the memory pipeline has made — judge
              operations, document merges, and your own edits, newest first.
            </p>
            {ops === null ? (
              <span className="muted">Loading…</span>
            ) : ops.length === 0 ? (
              <span className="muted">Nothing logged yet.</span>
            ) : (
              <ul className="memory-ops-list">
                {ops.map((o) => (
                  <li
                    key={o.id}
                    className={`memory-op op-${o.operation.toLowerCase()}`}
                  >
                    <div className="memory-op-badge">{o.operation}</div>
                    <div className="memory-op-body">
                      <div className="memory-op-head">
                        <span className="memory-op-actor">{o.actor}</span>
                        <span className="muted">{fmtDate(o.ts)}</span>
                        {(o.targetIds ?? []).length > 0 && (
                          <span className="muted memory-op-targets">
                            {o.targetIds.length} target{o.targetIds.length > 1 ? "s" : ""}
                          </span>
                        )}
                      </div>
                      {o.candidate && (
                        <div className="memory-op-candidate">
                          {o.candidate.length > 160 ? `${o.candidate.slice(0, 160)}…` : o.candidate}
                        </div>
                      )}
                      {o.rationale && <div className="memory-op-note">{o.rationale}</div>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      {/* Destructive purge confirmation: in-app modal, gated on typing DELETE */}
      {confirmPurge && (
        <Modal
          title="Delete all memories?"
          onClose={() => {
            setConfirmPurge(false);
            setPurgeInput("");
          }}
          actions={
            <>
              <button
                onClick={() => {
                  setConfirmPurge(false);
                  setPurgeInput("");
                }}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                className="danger"
                disabled={busy || purgeInput.trim() !== "DELETE"}
                onClick={() => {
                  setConfirmPurge(false);
                  setPurgeInput("");
                  void purgeAll();
                }}
              >
                Delete everything
              </button>
            </>
          }
        >
          <p>
            This permanently erases the memory document, every raw fact entry,
            and the full history — including evidence quotes. It cannot be
            undone.
          </p>
          <input
            className="memory-purge-confirm"
            placeholder='Type DELETE to confirm'
            value={purgeInput}
            spellCheck={false}
            onChange={(e) => setPurgeInput(e.target.value)}
          />
        </Modal>
      )}
    </div>
  );
}
