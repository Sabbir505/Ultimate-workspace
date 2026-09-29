// "Native subagents" — the Subagents page section below the registry (own
// file, one surface per file like the panel/runs-list siblings). The CLI
// harnesses keep their OWN subagent definitions as markdown files with YAML
// frontmatter (`~/.claude/agents/*.md` and friends — harness_config.rs owns
// the per-id paths and the tolerant reader). This card lists what each
// harness's store holds, per harness, and imports a row into Relay's registry
// with one click: the frontmatter body becomes the prompt, the tool list the
// allowlist, and the engine becomes `harness:<id>` so the imported definition
// runs on the CLI it came from.
//
// The listing stays collapsed until asked for: each harness's walk is a
// filesystem probe, and expanding is the user saying they want it. Collapsing
// unmounts the per-harness blocks, so re-expanding refetches — honest and
// cheap, since the backend's 30s TTL serves repeat expands.

import { Download, Wrench } from "lucide-react";
import { useEffect, useState } from "react";
import {
  createSubagent,
  listHarnessSubagents,
  type HarnessSubagentInfo,
  type SubagentInput,
} from "../../lib/ipc";
import { useSubagentStore } from "../../state/subagents";

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

/** Registry names are unique case-insensitively, so a native name that
 *  collides with an existing row gets -2, -3… — the import must never fail
 *  on a name the user already took. */
function uniqueAgentName(base: string, existing: string[]): string {
  const taken = new Set(existing.map((n) => n.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${base}-${Date.now()}`;
}

/** Native file → registry create payload. The scope/budget defaults are the
 *  editor's EMPTY_FORM ones, so an import lands exactly the shape a
 *  hand-entered row would; the user tunes from the editor afterwards. */
function subagentInputFor(
  harnessId: string,
  row: HarnessSubagentInfo,
  existingNames: string[],
): SubagentInput {
  return {
    name: uniqueAgentName(row.name, existingNames),
    description: row.description,
    promptMd: row.promptMd,
    // An empty native tool list means "the file named none" — the registry's
    // null (inherit the engine default), not an allow-all-empty allowlist.
    tools: row.tools.length > 0 ? row.tools : null,
    engine: `harness:${harnessId}`,
    model: row.model ?? null,
    effort: null,
    sandboxPolicy: "read_only",
    approvalPolicy: "on_request",
    worktreePolicy: "inherit",
    maxRounds: 100,
    maxConcurrent: 2,
  };
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
  imported,
  importingPath,
  onImport,
}: {
  harnessId: string;
  label: string;
  dir: string;
  imported: Set<string>;
  importingPath: string | null;
  onImport: (row: HarnessSubagentInfo) => void;
}) {
  /** null = the probe is in flight (distinct from an honest empty store). */
  const [rows, setRows] = useState<HarnessSubagentInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setError(null);
    listHarnessSubagents(harnessId)
      .then((list) => {
        if (!cancelled) setRows(list ?? []);
      })
      .catch((err) => {
        if (!cancelled) setError(errText(err));
      });
    return () => {
      cancelled = true;
    };
  }, [harnessId]);

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
            const done = imported.has(row.sourcePath);
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
                  </span>
                </span>
                <span className="subagent-agent-actions">
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => onImport(row)}
                    disabled={done || importing}
                    title={
                      done
                        ? "Already imported into the registry (this session)"
                        : "Copy this definition into Relay's registry"
                    }
                    aria-label={`Import ${row.name}`}
                  >
                    <Download size={16} />
                    {done ? "Imported" : importing ? "Importing…" : "Import"}
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
  const [expanded, setExpanded] = useState(false);
  const agents = useSubagentStore((s) => s.agents);
  const refresh = useSubagentStore((s) => s.load);
  /** source_paths imported this session — a display-affordance only, never a
   *  guarantee the registry still holds the row (it may have been deleted). */
  const [imported, setImported] = useState<Set<string>>(() => new Set());
  const [importingPath, setImportingPath] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  const importRow = async (harnessId: string, row: HarnessSubagentInfo) => {
    setImportError(null);
    setImportingPath(row.sourcePath);
    try {
      const input = subagentInputFor(
        harnessId,
        row,
        agents.map((a) => a.name),
      );
      const created = await createSubagent(input);
      if (!created) {
        setImportError(`Couldn't import ${row.name} — the backend refused the row.`);
        return;
      }
      setImported((prev) => {
        const next = new Set(prev);
        next.add(row.sourcePath);
        return next;
      });
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

  return (
    <div className="subagent-section">
      <div className="subagent-section-head">
        <h3>Native subagents</h3>
        <span className="subagent-spacer" />
        <button
          type="button"
          className="ghost"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? "Hide native stores" : "Show native stores"}
        </button>
      </div>

      <p className="subagent-native-hint">
        Definitions the CLI harnesses keep in their own stores. Import one to run
        it from Relay — or leave it where it is and the CLI keeps owning it.
      </p>

      {importError && <div className="settings-note subagent-error">{importError}</div>}

      {expanded && (
        <div className="subagent-native-list">
          {NATIVE_STORES.map((h) => (
            <NativeHarnessBlock
              key={h.id}
              harnessId={h.id}
              label={h.label}
              dir={h.dir}
              imported={imported}
              importingPath={importingPath}
              onImport={(row) => void importRow(h.id, row)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
