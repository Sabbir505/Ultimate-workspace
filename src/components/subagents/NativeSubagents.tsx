// "Native subagents" — the Subagents section below the registry (own file,
// one surface per file like the panel/runs-list siblings). The CLI harnesses
// keep their OWN subagent definitions as markdown files with YAML frontmatter
// (`~/.claude/agents/*.md` and friends — harness_config.rs owns the per-id
// paths and the tolerant reader). This card lists what each harness's store
// holds and brings a file into Relay's registry.
//
// Importing is a LINK, not a copy: the backend stores the file's path on the
// row and re-syncs the file's name/description/prompt/allowlist/model onto it
// whenever the file changes — including changes the harness itself makes, or
// that a human makes in a terminal, neither of which pass through the app. A
// filesystem watcher on the stores keeps linked rows fresh (see
// `harness_subagent_watch.rs`); this card is how a NEW file gets noticed and
// brought in.
//
// The card starts expanded. It used to be collapsed on the theory that each
// harness's walk is a filesystem probe the user should opt into — but the
// probe is one `read_dir` per store on a background thread behind a 30s
// cache, and the whole point of the section is that an agent a harness just
// wrote should be visible without hunting for a disclosure.

import { ChevronDown, Download, RefreshCw, Wrench } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { safeListen } from "../../lib/ipcCore";
import {
  importHarnessSubagent,
  listHarnessSubagents,
  type HarnessSubagentInfo,
} from "../../lib/ipc";
import { useSubagentStore } from "../../state/subagents";
import { useProjectsStore } from "../../state/projects";

/** The harnesses that HAVE a native subagent store, in a stable display
 *  order. pi is absent on purpose (no native concept — its probe is empty by
 *  definition). `dir` is the user-level store, shown shortened in the empty
 *  state; the backend, not this table, is where the real paths live. */
const NATIVE_STORES: { id: string; label: string; dir: string }[] = [
  { id: "claude_code", label: "Claude Code", dir: "~/.claude/agents" },
  { id: "opencode", label: "OpenCode", dir: "~/.config/opencode/agent" },
  { id: "kimi_code", label: "Kimi CLI", dir: "~/.kimi-code/agents" },
  { id: "omp", label: "Omp", dir: "~/.omp/agent/agents" },
  { id: "commandcode", label: "CommandCode", dir: "~/.commandcode/agents" },
];

/** Source paths → the registry row that follows them. This is the honest
 *  "already imported" answer: the old session-scoped `Set` remembered only
 *  what THIS component instance had imported, so re-mounting the card offered
 *  to import a file that already had a row, and a second click created a
 *  duplicate. */
function useLinkedPaths(): Set<string> {
  const agents = useSubagentStore((s) => s.agents);
  return useMemo(
    () => new Set(agents.map((a) => a.sourcePath).filter((p): p is string => !!p)),
    [agents],
  );
}

/** The active project's root, so the project's own store
 *  (`<root>/.claude/agents`) is walked too. Without it the backend only sees
 *  the `~/`-level directories, which is why a project-scoped `agent.md` used
 *  to be invisible here. */
function useProjectRoot(): string | null {
  const selectedProjectId = useProjectsStore((s) => s.selectedProjectId);
  const projects = useProjectsStore((s) => s.projects);
  return useMemo(
    () => projects.find((p) => p.id === selectedProjectId)?.path ?? null,
    [projects, selectedProjectId],
  );
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** One harness's store: its rows, or its empty/error state. Mounted only
 *  while the section is expanded, so the fetch-on-mount effect below is the
 *  "lazy per-harness fetch" the section promises. */
function NativeHarnessBlock({
  harnessId,
  label,
  dir,
  projectRoot,
  linked,
  importingPath,
  onImport,
  onPending,
}: {
  harnessId: string;
  label: string;
  dir: string;
  projectRoot: string | null;
  linked: Set<string>;
  importingPath: string | null;
  onImport: (row: HarnessSubagentInfo) => void;
  onPending: (harnessId: string, count: number) => void;
}) {
  /** null = the probe is in flight (distinct from an honest empty store). */
  const [rows, setRows] = useState<HarnessSubagentInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A counter, not a boolean: an in-flight probe that resolves after a newer
  // one started must not overwrite the newer result.
  const probe = useRef(0);

  const refetch = useCallback(() => {
    const ticket = ++probe.current;
    listHarnessSubagents(harnessId, projectRoot)
      .then((list) => {
        if (probe.current === ticket) {
          setRows(list ?? []);
          setError(null);
        }
      })
      .catch((err) => {
        if (probe.current === ticket) setError(errText(err));
      });
  }, [harnessId, projectRoot]);

  // Report how many of this store's files aren't linked yet, so the section
  // head can offer "Import all (N)" with a real number. Counted against the
  // same `linked` set the rows render from, so the badge can never disagree
  // with the rows underneath it.
  useEffect(() => {
    if (rows === null) {
      onPending(harnessId, 0);
      return;
    }
    onPending(harnessId, rows.filter((r) => !linked.has(r.sourcePath)).length);
  }, [rows, linked, harnessId, onPending]);

  useEffect(() => {
    setRows(null);
    setError(null);
    refetch();
  }, [refetch]);

  return (
    <div className="subagent-native-block">
      <div className="subagent-native-head">
        <span className="subagent-native-harness">{label}</span>
        {rows !== null && rows.length > 0 && (
          <span className="panel-count">
            {rows.length} native agent{rows.length === 1 ? "" : "s"}
          </span>
        )}
        <span className="subagent-meta-chip mono" title="The harness's own store directory">
          {dir}
        </span>
      </div>

      {/* A failed probe is inline and scoped to this harness — the other
          blocks and the section itself must stay alive. */}
      {error && (
        <div className="settings-note subagent-error">
          Couldn't list {label}'s native subagents: {error}
        </div>
      )}

      {rows === null && !error && (
        <div className="subagent-empty">Loading {label} native subagents…</div>
      )}

      {rows !== null && rows.length === 0 && (
        <div className="subagent-empty">
          <div>No native subagents found in {dir}</div>
          {/* omp's bundled agents don't exist on disk until unpacked — the
              one empty state that has a fix the user can run. */}
          {harnessId === "omp" && (
            <div>
              run <span className="mono">omp agents unpack</span> to materialize its
              bundled agents
            </div>
          )}
        </div>
      )}

      {rows !== null && rows.length > 0 && (
        <div className="subagent-agent-list">
          {rows.map((row) => {
            // Followed by a row already? Then this button is an UPDATE, and it
            // says so — the same click re-reads the file and writes the current
            // content onto the existing agent.
            const isLinked = linked.has(row.sourcePath);
            const importing = importingPath === row.sourcePath;
            return (
              <div className="subagent-agent-row" key={row.sourcePath}>
                <span className="subagent-agent-name">{row.name}</span>
                <span className="subagent-agent-main">
                  <span className="subagent-agent-desc">
                    {row.description || "(no description)"}
                  </span>
                  <span className="subagent-agent-meta">
                    {row.mode && (
                      <span className="subagent-meta-chip" title="Mode in the harness's own store">
                        {row.mode}
                      </span>
                    )}
                    <span className="subagent-meta-chip" title="Tools listed in the file's frontmatter">
                      <Wrench size={11} strokeWidth={1.8} aria-hidden="true" />
                      {row.tools.length} tool{row.tools.length === 1 ? "" : "s"}
                    </span>
                    {row.model && (
                      <span className="subagent-meta-chip mono" title="Model pinned in the file">
                        {row.model}
                      </span>
                    )}
                    {isLinked && (
                      <span
                        className="subagent-meta-chip ok"
                        title="This file is linked to a registry agent — edits to it are picked up automatically"
                      >
                        linked
                      </span>
                    )}
                  </span>
                </span>
                <span className="subagent-agent-actions">
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => onImport(row)}
                    disabled={importing}
                    title={
                      isLinked
                        ? "Re-read this file and update the linked agent"
                        : "Bring this definition into Relay's registry (linked — it will follow this file)"
                    }
                    aria-label={`${isLinked ? "Update" : "Import"} ${row.name}`}
                  >
                    {isLinked ? <RefreshCw size={16} /> : <Download size={16} />}
                    {importing ? "Syncing…" : isLinked ? "Update" : "Import"}
                  </button>
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function NativeSubagents() {
  const [expanded, setExpanded] = useState(true);
  /** Whether the per-harness blocks are mounted. Mounts instantly on expand
   *  (the transition needs content to reveal), unmounts only AFTER the
   *  collapse animation settles — unmounting at click time would cut the
   *  animation and also skip the CSS transition entirely. The timer is the
   *  deterministic unmount: a transitionend hook would never fire when
   *  prefers-reduced-motion removes the transition. */
  const [renderList, setRenderList] = useState(true);
  /** Bumped when the backend re-synced a linked row, which remounts the
   *  blocks so their listings re-probe against the backend's fresh cache. */
  const [probeEpoch, setProbeEpoch] = useState(0);
  const collapseTimer = useRef<number | null>(null);
  const refresh = useSubagentStore((s) => s.load);
  const syncNative = useSubagentStore((s) => s.syncNative);
  const linked = useLinkedPaths();
  const projectRoot = useProjectRoot();
  const [importingPath, setImportingPath] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  useEffect(
    () => () => {
      if (collapseTimer.current !== null) window.clearTimeout(collapseTimer.current);
    },
    [],
  );

  // The watcher fires this when a linked `.md` changed and the backend
  // refreshed its row. Reload the registry (the row's prompt may have moved)
  // and re-probe the listings. New, unlinked files only show up after a
  // re-probe too — which is why this listener is what makes a harness-authored
  // agent appear without the user doing anything.
  useEffect(() => {
    let cancelled = false;
    const unlisten = safeListen("harness:subagents-changed", () => {
      // The listener resolves asynchronously, so it can fire before `unlisten`
      // is assigned; the flag is what keeps a late-arriving event from
      // touching state on an unmounted card.
      if (cancelled) return;
      void refresh();
      setProbeEpoch((n) => n + 1);
    });
    return () => {
      cancelled = true;
      void unlisten.then((fn) => fn());
    };
  }, [refresh]);

  const toggle = () => {
    if (collapseTimer.current !== null) {
      window.clearTimeout(collapseTimer.current);
      collapseTimer.current = null;
    }
    if (!expanded) {
      setRenderList(true);
      setExpanded(true);
    } else {
      setExpanded(false);
      // Just past the 0.3s height transition in subagents.css.
      collapseTimer.current = window.setTimeout(() => {
        collapseTimer.current = null;
        setRenderList(false);
      }, 340);
    }
  };

  const importRow = async (harnessId: string, row: HarnessSubagentInfo) => {
    setImportError(null);
    setNotice(null);
    setImportingPath(row.sourcePath);
    try {
      const saved = await importHarnessSubagent(harnessId, row.sourcePath, projectRoot);
      if (!saved) {
        setImportError(`Couldn't import ${row.name} — the backend refused the row.`);
        return;
      }
      setNotice(
        linked.has(row.sourcePath)
          ? `Updated "${saved.name}" from ${row.name}.`
          : `Imported "${saved.name}" — it now follows ${row.name} in the harness's store.`,
      );
      // The registry list refetches through the store rather than patching
      // locally: the backend normalizes the name (collision suffix, slug) and
      // the panel below must show the row it actually stored.
      await refresh();
    } catch (err) {
      setImportError(`Couldn't import ${row.name}: ${errText(err)}`);
    } finally {
      setImportingPath(null);
    }
  };

  /** Bulk: bring in every file across every store that isn't linked yet, and
   *  refresh the ones that are. One user action, so it may create rows — the
   *  watcher deliberately never does this on its own. */
  const syncAll = async () => {
    setImportError(null);
    setSyncing(true);
    try {
      await syncNative(null, projectRoot);
      setNotice("Harness stores synced.");
    } finally {
      setSyncing(false);
    }
  };

  /** How many files across all stores aren't linked yet — the "Import all (N)"
   *  count. Per-harness, because each block owns its own listing; a block that
   *  hasn't probed yet simply contributes 0 rather than a made-up number. */
  const [pending, setPending] = useState<Record<string, number>>({});
  const onPending = useCallback((harnessId: string, count: number) => {
    setPending((prev) => (prev[harnessId] === count ? prev : { ...prev, [harnessId]: count }));
  }, []);
  const pendingCount = Object.values(pending).reduce((a, b) => a + b, 0);

  return (
    <div className="subagent-section">
      <div className="subagent-section-head">
        <h3>Native subagents</h3>
        <span className="subagent-spacer" />
        {renderList && pendingCount > 0 && (
          <button
            type="button"
            className="ghost"
            onClick={() => void syncAll()}
            disabled={syncing}
            title="Import every native subagent that isn't in the registry yet, and refresh the ones that are"
          >
            <Download size={14} strokeWidth={2} aria-hidden="true" />
            {syncing ? "Syncing…" : `Import all (${pendingCount})`}
          </button>
        )}
        <button
          type="button"
          className="ghost subagent-native-toggle"
          aria-expanded={expanded}
          onClick={toggle}
        >
          {expanded ? "Hide native stores" : "Show native stores"}
          <ChevronDown
            size={14}
            strokeWidth={2}
            aria-hidden="true"
            className={`subagent-native-caret${expanded ? " open" : ""}`}
          />
        </button>
      </div>

      <p className="subagent-native-hint">
        Definitions the CLI harnesses keep in their own stores. Import one and it
        becomes a registry agent that <em>follows the file</em> — a prompt edited
        here or by the harness itself is picked up automatically. Leave a file
        unimported and the CLI keeps owning it.
      </p>

      {notice && <div className="settings-note">{notice}</div>}
      {importError && <div className="settings-note subagent-error">{importError}</div>}

      {/* Height-animated disclosure: the 0fr→1fr grid transition tracks the
          content's real height (no measured max-height guess), and the inner
          clip keeps the reveal edge clean while the rows fade in. */}
      <div
        className={`subagent-native-disclosure${expanded ? " open" : ""}`}
        aria-hidden={!expanded}
      >
        <div className="subagent-native-clip">
          {renderList && (
            <div className="subagent-native-list" key={probeEpoch}>
              {NATIVE_STORES.map((h) => (
                <NativeHarnessBlock
                  key={h.id}
                  harnessId={h.id}
                  label={h.label}
                  dir={h.dir}
                  projectRoot={projectRoot}
                  linked={linked}
                  importingPath={importingPath}
                  onImport={(row) => void importRow(h.id, row)}
                  onPending={onPending}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
