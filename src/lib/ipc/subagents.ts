// Extracted domain of lib/ipc.ts (see its header). Command names and
// payload shapes are binding (CONTRACT.md).
//
// Subagents (chat/subagent.rs): persisted, named subagent definitions — prompt
// body, tool allowlist, permission scope, engine/model, worktree policy, spawn
// budget. Phase 1 is the registry only (no run surface yet): the list/create/
// update/delete wrappers below back Settings → Agents → Subagent.
//
// Two deliberate normalizations happen at this boundary so every consumer sees
// one shape:
//  - `tools` is a nullable JSON *column* on the row but an array everywhere in
//    the app. `parseTools` is defensive on purpose: a hand-edited or
//    half-migrated row must never throw inside a list load — it degrades to
//    `null` (the "inherit the engine default" state), which is also the safest
//    reading of an unreadable allowlist.
//  - A null invoke result (the Tauri runtime isn't there — jsdom, plain
//    `vite dev`) resolves to an empty list / null row rather than throwing, the
//    same convention every other wrapper in this folder follows.
import { safeInvoke } from "../ipcCore";

/** One persisted subagent. Mirrors the Rust `Subagent` 1:1 (camelCase). */
export interface Subagent {
  id: string;
  /** Also the `Task` enum value; unique, case-insensitive. */
  name: string;
  /** One line, shown next to the name and used for delegation hints. */
  description: string;
  /** System-prompt body (markdown). */
  promptMd: string;
  /** Parsed from the JSON column; null = inherit the engine's default. */
  tools: string[] | null;
  /** "builtin" | "local" | "harness:<id>" | "acp:<id>"; null = inherit
   *  (chat.subagentModel, else the parent session's pick). */
  engine: string | null;
  /** "model" | "provider::model" | "engine::model"; null = inherit. */
  model: string | null;
  effort: string | null;
  /** "read_only" | "workspace_write" */
  sandboxPolicy: string;
  /** "on_request" | "auto_edit" | "full_access" */
  approvalPolicy: string;
  /** "inherit" | "always" | "never" */
  worktreePolicy: string;
  /** Model rounds per run, 1..=100. */
  maxRounds: number;
  /** Live-run budget for this agent, >= 1. */
  maxConcurrent: number;
  /** Seeded roles can't be deleted or renamed. */
  builtin: boolean;
  /** Who authored the row: null = the user (Subagent panel), "agent" = a model
   *  created it via the subagent chat tool (badged so the user can always see
   *  what their agents made). */
  origin?: string | null;
  /** The native `.md` this row was imported from, when it came from a CLI
   *  harness's own store (`~/.claude/agents/doc-writer.md`). null for builtin,
   *  hand-made and `.md`-imported rows.
   *
   *  A non-null value means the row FOLLOWS that file: the backend re-syncs the
   *  file's name/description/prompt/allowlist/model onto it when the file
   *  changes, and badges it when the file disappears. The editor never writes
   *  it — saving an agent keeps the link.
   */
  sourcePath?: string | null;
  createdAt: number;
  updatedAt: number;
}

/** The create/update payload: `Subagent` minus id/builtin/timestamps, every
 *  field defaulted on the Rust side so the UI can send a partial form.
 *  Arrays in the app, JSON on the wire — `tools` is the JSON-array *column*
 *  (the backend's `SubagentInput.tools` is `Option<String>`), and the
 *  wrappers below serialize it. `null`/omitted = inherit the engine default. */
export interface SubagentInput {
  name: string;
  description?: string;
  promptMd?: string;
  tools?: string[] | null;
  engine?: string | null;
  model?: string | null;
  effort?: string | null;
  sandboxPolicy?: string;
  approvalPolicy?: string;
  worktreePolicy?: string;
  maxRounds?: number;
  maxConcurrent?: number;
}

/** One row of run history (F.1 `subagent_runs`, mirrored by F.4). The registry is
 *  Phase 1; this lands with the spawn surfaces (Phases 2.5/3/5), and the subagent
 *  store keeps a `runs` map keyed by run id so the `chat:session-spawn` event
 *  has somewhere to land. No FKs on `agent_id`/`session_id` on purpose:
 *  history outlives both a deleted agent and a deleted chat. */
export interface SubagentRun {
  id: string;
  agentId: string | null;
  sessionId: string | null;
  /** "manual" | "task" | "mesh" | "automation" */
  trigger: string;
  task: string;
  engine: string;
  model: string;
  worktree: string | null;
  startedAt: number;
  finishedAt: number | null;
  /** "running" | "ok" | "error" | "cancelled" */
  status: string;
  summary: string | null;
}

/** The wire row: exactly `Subagent` except `tools` is still the raw column. */
type SubagentRow = Omit<Subagent, "tools"> & { tools: string | null };

/** JSON column → allowlist. Never throws: an absent, empty, unparseable, or
 *  non-array value all mean "no explicit allowlist" (`null`). Non-string
 *  entries are dropped and duplicates collapse, so one bad row can't widen a
 *  definition's effective set. */
export function parseSubagentTools(raw: string | null | undefined): string[] | null {
  if (raw == null || raw === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const out: string[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "string") continue;
    const name = entry.trim();
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

function intOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Input → wire payload. The only conversion is the allowlist: the column is a
 *  JSON array string, the app passes an array. An omitted `tools` stays omitted
 *  (the backend's `#[serde(default)]` then means "inherit"), while an explicit
 *  `null` clears the allowlist back to the engine default. */
function serializeInput(input: SubagentInput): Record<string, unknown> {
  const { tools, ...rest } = input;
  const payload: Record<string, unknown> = { ...rest };
  if (tools !== undefined) payload.tools = tools == null ? null : JSON.stringify(tools);
  return payload;
}

function strOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

/** Row → app shape. Tolerant of every optional column so a partially
 *  migrated row still renders (with defaults) instead of blanking the list. */
function normalizeSubagent(row: SubagentRow): Subagent {
  return {
    id: strOr(row.id, ""),
    name: strOr(row.name, ""),
    description: strOr(row.description, ""),
    promptMd: strOr(row.promptMd, ""),
    tools: parseSubagentTools(row.tools),
    engine: row.engine ?? null,
    model: row.model ?? null,
    effort: row.effort ?? null,
    sandboxPolicy: strOr(row.sandboxPolicy, "read_only"),
    approvalPolicy: strOr(row.approvalPolicy, "on_request"),
    worktreePolicy: strOr(row.worktreePolicy, "inherit"),
    maxRounds: intOr(row.maxRounds, 100),
    maxConcurrent: intOr(row.maxConcurrent, 2),
    builtin: row.builtin === true,
    origin: row.origin ?? null,
    // Coerce a blank path to null: it is the "not linked" state, and a link to
    // "" would show the "linked to file" badge with nothing to point at. The
    // Rust mapper does the same, so the two agree on every row.
    sourcePath: strOr(row.sourcePath, "") || null,
    createdAt: intOr(row.createdAt, 0),
    updatedAt: intOr(row.updatedAt, 0),
  };
}

export const listSubagents = async (): Promise<Subagent[]> => {
  const rows = await safeInvoke<SubagentRow[]>("list_subagents");
  return (rows ?? []).map(normalizeSubagent);
};

export const getSubagent = async (agentId: string): Promise<Subagent | null> => {
  const row = await safeInvoke<SubagentRow | null>("get_subagent", { agentId });
  return row ? normalizeSubagent(row) : null;
};

export const createSubagent = async (input: SubagentInput): Promise<Subagent | null> => {
  const row = await safeInvoke<SubagentRow | null>("create_subagent", {
    input: serializeInput(input),
  });
  return row ? normalizeSubagent(row) : null;
};

/** Returns the saved row so the caller can adopt the backend's normalized
 *  values (name slug, clamped rounds) instead of guessing them. */
export const updateSubagent = async (
  agentId: string,
  input: SubagentInput,
): Promise<Subagent | null> => {
  const row = await safeInvoke<SubagentRow | null>("update_subagent", {
    agentId,
    input: serializeInput(input),
  });
  return row ? normalizeSubagent(row) : null;
};

/** Void-safe: the backend refuses builtins and agents with live runs, which
 *  surfaces as a rejected promise the caller turns into an inline error. */
export const deleteSubagent = (agentId: string) =>
  safeInvoke<void>("delete_subagent", { agentId });

// ---------------------------------------------------------------------------
// Spawn + run history (Phase 2.5 manual run, Phase 3 mesh, Phase 5 history).
// The command names and argument keys below are CONTRACT-binding (research doc
// §F.3) — the Rust wave builds `run_subagent` against the same names, and
// `run_subagent` is the ONLY UI spawn door (the session mesh still exposes
// no Tauri commands of its own).

/** Row → app shape, tolerant like `normalizeSubagent`: a run row written by
 *  an older build, or one whose agent/chat has since been deleted, must still
 *  render as a row rather than blank the list. */
function normalizeRun(row: Partial<SubagentRun> | null | undefined): SubagentRun {
  return {
    id: strOr(row?.id, ""),
    agentId: row?.agentId ?? null,
    sessionId: row?.sessionId ?? null,
    trigger: strOr(row?.trigger, "manual"),
    task: strOr(row?.task, ""),
    engine: strOr(row?.engine, ""),
    model: strOr(row?.model, ""),
    worktree: row?.worktree ?? null,
    startedAt: intOr(row?.startedAt, 0),
    finishedAt: row?.finishedAt == null ? null : intOr(row.finishedAt, 0),
    status: strOr(row?.status, "running"),
    summary: row?.summary ?? null,
  };
}

/**
 * Run an agent on a task — the manual, human-initiated spawn (Phase 2.5).
 * Creates a normal chat session tagged with the agent and returns its id, so
 * the caller can drop the user straight into the streaming run. Works with
 * Session Mesh off; the mesh's per-parent child budget is NOT consumed.
 *
 * `projectId` binds the run to a project (its worktree/cwd root);
 * `wait` = true blocks the command until the first turn goes idle, false runs
 * it in the background and returns as soon as the session exists. Both are
 * optional on the Rust side, so they are sent as explicit nulls rather than
 * omitted — a `Tauri` command with an `Option<T>` accepts either.
 */
export const runSubagent = async (
  agentId: string,
  task: string,
  projectId?: string | null,
  wait?: boolean | null,
): Promise<string | null> => {
  const sessionId = await safeInvoke<string | null>("run_subagent", {
    agentId,
    task,
    projectId: projectId ?? null,
    wait: wait ?? null,
  });
  return sessionId ?? null;
};

/**
 * Export agents as concatenated `.md` docs (Claude-Code-compatible
 * frontmatter + the relay extensions — §F.6). Omit `agentIds` for the whole
 * registry. Returns the markdown text; the caller owns the save dialog.
 */
export const exportSubagents = (agentIds?: string[] | null): Promise<string | null> =>
  safeInvoke<string | null>("export_subagents", { agentIds: agentIds ?? null });

/** Import one agent from a `.md` doc. Strict: an unknown tool name, a bad
 *  name format, or non-frontmatter input is a rejected promise, never a
 *  silent drop. Returns the created row. */
export const importSubagent = async (markdown: string): Promise<Subagent | null> => {
  const row = await safeInvoke<SubagentRow | null>("import_subagent", { markdown });
  return row ? normalizeSubagent(row) : null;
};

/** Run history, newest first. Both filters are optional: omit `agentId` for
 *  every agent, omit `limit` for the backend's own default page. */
export const listSubagentRuns = async (
  agentId?: string | null,
  limit?: number | null,
): Promise<SubagentRun[]> => {
  const rows = await safeInvoke<Partial<SubagentRun>[] | null>("list_subagent_runs", {
    agentId: agentId ?? null,
    limit: limit ?? null,
  });
  return (rows ?? []).map(normalizeRun);
};

// ---------------------------------------------------------------------------
// Native harness stores (`~/.claude/agents/*.md` and friends).
//
// An import here is a LINK, not a copy: the backend stores the file's path on
// the row and re-syncs the file's identity/prompt/allowlist/model onto it when
// the file changes. That is what makes an agent a harness authored show up in
// the registry AND stay correct after someone edits its markdown.

/**
 * Import (or re-import) ONE native file. Idempotent: the first call creates a
 * row linked to `sourcePath`, later calls refresh that same row in place.
 *
 * The backend re-reads the file itself rather than trusting a client payload,
 * so a file that changed between listing and importing still lands with its
 * current content. `projectRoot` adds the project's own store to the walk
 * (omit it and only `~/`-level stores are searched).
 */
export const importHarnessSubagent = async (
  harnessId: string,
  sourcePath: string,
  projectRoot?: string | null,
): Promise<Subagent | null> => {
  const row = await safeInvoke<SubagentRow | null>("import_harness_subagent", {
    harnessId,
    sourcePath,
    projectRoot: projectRoot ?? null,
  });
  return row ? normalizeSubagent(row) : null;
};

/** What a bulk native-store sync did, per file. Returned so the card can say
 *  what happened instead of leaving the user to infer it from a list changing. */
export interface NativeSyncReport {
  /** Rows created from files that had no link yet. */
  created: string[];
  /** Rows refreshed because their file's fields changed. */
  updated: string[];
  /** Files that already matched their row. */
  unchanged: string[];
  /** Linked rows whose `.md` is gone. The rows are kept (they may have run
   *  history) and badged in the panel; this is the list behind that badge. */
  missing: string[];
}

/**
 * Reconcile the registry with every harness's native store: import what isn't
 * linked yet, refresh what is. This is the bulk, single-click counterpart to
 * `importHarnessSubagent` — the user has said "bring these in", so unlike the
 * filesystem watcher (which only refreshes rows already linked) this one
 * creates rows.
 *
 * `harnessIds` narrows the sweep; omit it for all five stores that have one.
 */
export const syncHarnessSubagents = async (
  harnessIds?: string[] | null,
  projectRoot?: string | null,
): Promise<NativeSyncReport> => {
  const report = await safeInvoke<NativeSyncReport | null>("sync_harness_subagents", {
    harnessIds: harnessIds ?? null,
    projectRoot: projectRoot ?? null,
  });
  return {
    created: report?.created ?? [],
    updated: report?.updated ?? [],
    unchanged: report?.unchanged ?? [],
    missing: report?.missing ?? [],
  };
};

/**
 * Stop a row from following its `.md` — "make this mine". The definition keeps
 * everything it has; it just stops being refreshed from the file, so a later
 * sync of that file imports a separate agent instead of overwriting this one.
 */
export const unlinkNativeSubagent = (agentId: string) =>
  safeInvoke<void>("unlink_native_subagent", { agentId });

// ---------------------------------------------------------------------------
// Enforcement tiers (research doc §C.1) — one engine, three tiers, shown in
// the UI rather than hidden. Exported from here (not from SubagentsPanel) because
// the Phase 4 origin-scoped-hooks work reuses it for the "guard this agent"
// affordance and the hook template copy.

export type SubagentTier = "enforced" | "advisory";

/** The enforcement tier a definition actually gets at spawn time. `engine` is
 *  the stored engine string, or null/undefined = inherit. Relay fully gates
 *  its own in-process tool loop (schema filter + execution check + the
 *  sandbox/approval policies), so `builtin` (provider API) and `local` (GGUF)
 *  are "enforced". A `harness:<id>` CLI runs its own native toolset that the
 *  app cannot restrict — only the Relay-bridge surface is gated — and `acp:<id>`
 *  has no permission channel at all, so both are "advisory". */
export function subagentEngineTier(engine: string | null | undefined): SubagentTier {
  if (!engine || engine === "builtin" || engine === "local") return "enforced";
  return "advisory";
}

/** Badge copy per tier. The advisory string spells out the boundary so no one
 *  reads the badge as a promise the runtime can't keep. */
export const SUBAGENT_TIER_LABELS: Record<SubagentTier, { label: string; detail: string }> = {
  enforced: {
    label: "enforced",
    detail: "Every tool call is gated by the allowlist, the sandbox and the approval policy.",
  },
  advisory: {
    label: "advisory",
    detail: "Advisory — the CLI's own tools can't be restricted; only Relay's tools are gated.",
  },
};

// ---------------------------------------------------------------------------
// Tool allowlist picker source of truth. One exported const so the Subagent editor
// and the Phase 2.5 subagent view offer the same choices, and so a rename lands in
// one place.
//
// The entries mirror the backend's enforcement ceiling (chat/subagent.rs's
// `BUILTIN_READ_ONLY_TOOLS` + `WORKSPACE_WRITE_TOOLS`) exactly: a "write" tool
// is listed as such because the backend intersects the allowlist with the
// engine's ceiling, and under `read_only` it is simply dropped. Offering a tool
// the runtime could never grant would be a picker that lies, and spawn-capable
// tools (Task, spawn_session, …) are deliberately absent so depth stays 1.
// For a harness/acp engine the allowlist governs the Relay-bridge surface —
// the CLI's own tools stay outside it (that's the advisory tier). Backend-side
// names are mirrored here as literals, like the sibling pickers do
// (PermissionRulesPanel's TOOL_OPTIONS).

export interface SubagentToolOption {
  /** The tool name as the backend knows it. */
  id: string;
  label: string;
  /** "read" = the engine's read-only default; "write" = needs workspace_write. */
  group: "read" | "write";
}

export const SUBAGENT_TOOL_OPTIONS: SubagentToolOption[] = [
  // Read-only — the default allowlist (BUILTIN_READ_ONLY_TOOLS)
  { id: "list_directory", label: "List files", group: "read" },
  { id: "read_file", label: "Read file", group: "read" },
  { id: "search_files", label: "Find files by name", group: "read" },
  { id: "search_content", label: "Search file contents", group: "read" },
  { id: "vault_list", label: "Vault: list notes", group: "read" },
  { id: "vault_read", label: "Vault: read note", group: "read" },
  { id: "vault_search", label: "Vault: search", group: "read" },
  { id: "fetch_url", label: "Fetch a URL", group: "read" },
  { id: "web_search", label: "Web search", group: "read" },
  { id: "add_source_note", label: "Add a source note", group: "read" },
  { id: "get_source_ledger", label: "Read the source ledger", group: "read" },
  { id: "get_capabilities", label: "Report connected capabilities", group: "read" },
  // Mutating half (WORKSPACE_WRITE_TOOLS) — reachable only under workspace_write
  { id: "write_file", label: "Write file", group: "write" },
  { id: "edit_file", label: "Edit file", group: "write" },
  { id: "delete_file", label: "Delete file", group: "write" },
  { id: "move_file", label: "Move file", group: "write" },
  { id: "copy_file", label: "Copy file", group: "write" },
  { id: "vault_write", label: "Vault: write note", group: "write" },
  { id: "vault_move", label: "Vault: move note", group: "write" },
  { id: "vault_delete", label: "Vault: delete note", group: "write" },
];

/** Flat id list — the import form of `SUBAGENT_TOOL_OPTIONS`, for validation and
 *  the Phase 5 `.md` import. */
export const SUBAGENT_TOOL_IDS: string[] = SUBAGENT_TOOL_OPTIONS.map((o) => o.id);
