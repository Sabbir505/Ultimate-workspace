import { useCallback, useEffect, useMemo, useState } from "react";
import {
  memoryCreate,
  memoryDelete,
  memoryExport,
  memoryList,
  memoryPurge,
  memorySetEnabled,
  memoryStatus,
  memoryUpdate,
  type MemoryRecordView,
  type MemoryStatusView,
} from "../../lib/ipc";

/**
 * Settings → Memory browser (MEMORY_DESIGN_ARCHITECTURE.md §12.2).
 * The anti-black-box commitment: everything the assistant remembers is
 * listed here with kind/confidence/provenance, and the user can edit,
 * retire, purge, export, or turn the feature off. No hidden inference.
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

  const refresh = useCallback(async () => {
    const [s, list] = await Promise.all([memoryStatus(), memoryList(true)]);
    setStatus(s);
    setMemories(list ?? []);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return memories
      .filter((m) => (filter === "all" ? true : m.status === filter))
      .filter((m) => (q ? m.content.toLowerCase().includes(q) : true));
  }, [memories, filter, query]);

  const toggle = async (enabled: boolean) => {
    setBusy(true);
    await memorySetEnabled(enabled);
    await refresh();
    setBusy(false);
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
    // Destructive + irreversible — require an explicit typed confirmation.
    const answer = window.prompt(
      "Type DELETE to permanently erase ALL memories (including history):",
    );
    if (answer !== "DELETE") return;
    setBusy(true);
    await memoryPurge();
    await refresh();
    setBusy(false);
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
            Facts the assistant remembers across chats. Everything is stored
            locally and shown here — nothing hidden.
          </p>
        </div>
        <label className="toggle-row">
          <input
            type="checkbox"
            checked={status?.enabled ?? true}
            disabled={busy}
            onChange={(e) => void toggle(e.target.checked)}
          />
          <span>Remember across chats</span>
        </label>
      </div>

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
          <button className="danger" onClick={() => void purgeAll()} disabled={busy}>
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
    </div>
  );
}
