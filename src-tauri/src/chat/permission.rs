//! Per-session permission posture for filesystem tool calls.
//!
//! This module is the **single** place that decides, for a given chat
//! session's [`SandboxPolicy`] + [`ApprovalPolicy`], whether a filesystem
//! tool call runs straight away or must pause for a per-action approval
//! card. Every filesystem tool handler routes through [`check_permission`].
//!
//! Two orthogonal dimensions (mirrors Codex's sandbox/approval split):
//!
//! **SandboxPolicy** — which tools are *visible* to the model:
//! | Sandbox          | Reads | Writes/Edits | Move/Copy | Delete | Shell |
//! |------------------|-------|--------------|-----------|--------|-------|
//! | `read_only`      | yes   | (absent)     | (absent)  | (absent)| (absent) |
//! | `workspace_write`| yes   | yes          | yes       | yes    | yes   |
//!
//! **ApprovalPolicy** — when a visible tool *pauses* for approval:
//! | Approval     | Writes/Edits      | Move/Copy          | Delete                        | Shell      |
//! |--------------|-------------------|--------------------|-------------------------------|------------|
//! | `on_request` | approve each      | approve each       | approve each                  | approve    |
//! | `auto_edit`  | run in roots      | approve (gated)    | approve (gated)               | approve    |
//! | `full_access`| run in roots      | run in roots       | run in roots (gated outside)  | run        |
//!
//! Legacy `PermissionMode` values map to presets:
//! `read_only`→(ReadOnly, OnRequest), `manual`→(WorkspaceWrite, OnRequest),
//! `auto_edit`→(WorkspaceWrite, AutoEdit), `full_auto`→(WorkspaceWrite, FullAccess).

use serde::{Deserialize, Serialize};

use super::tools::{
    COPY_FILE, DELETE_FILE, EDIT_FILE, LIST_DIRECTORY, MOVE_FILE, READ_FILE, SEARCH_FILES,
    WRITE_FILE,
};

/// Sandbox scope: which tools are *visible* to the model (what it can do).
/// Stored on the `chat_sessions.sandbox_policy` column (per-session, not
/// global). Mutating tools are stripped from the tool schema under
/// `ReadOnly` before the model sees them — see `tools::specs`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SandboxPolicy {
    /// Only read-only tools: `list_directory`, `read_file`, `search_files`.
    /// Mutating tools are absent from the tool schema entirely.
    ReadOnly,
    /// All filesystem tools visible. Writes/edits/moves/copies/deletes/shell
    /// are present; their execution is governed by [`ApprovalPolicy`].
    /// A hard `path_within_scope` gate still blocks writes outside granted
    /// roots regardless of approval level.
    WorkspaceWrite,
}

impl SandboxPolicy {
    pub fn from_db(s: &str) -> Self {
        match s.trim().to_ascii_lowercase().as_str() {
            "read_only" => SandboxPolicy::ReadOnly,
            _ => SandboxPolicy::WorkspaceWrite, // "workspace_write", "", unknown
        }
    }

    pub fn as_db(self) -> &'static str {
        match self {
            SandboxPolicy::ReadOnly => "read_only",
            SandboxPolicy::WorkspaceWrite => "workspace_write",
        }
    }

    /// Whether mutating tools should appear in the tool schema under this
    /// sandbox. Used by `tools::specs` to decide whether to include
    /// write/edit/delete/move/copy/download_file/run_shell.
    pub fn allows_mutating_tools(self) -> bool {
        !matches!(self, SandboxPolicy::ReadOnly)
    }
}

impl Default for SandboxPolicy {
    fn default() -> Self {
        SandboxPolicy::WorkspaceWrite
    }
}

/// Approval posture: when a visible tool *pauses* for a per-action card.
/// Stored on the `chat_sessions.approval_policy` column (per-session).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalPolicy {
    /// Every mutating action pauses for approval (the safe default). New
    /// sessions start here. Equivalent to the legacy `manual` posture.
    OnRequest,
    /// Writes/edits within granted roots auto-run; delete, move and copy
    /// still require per-action approval. Equivalent to legacy `auto_edit`.
    AutoEdit,
    /// Reads, writes, edits, copies, moves, deletes within granted roots,
    /// and native shell commands all auto-run. Outside granted roots,
    /// mutating calls still gate. The one-time Full Access modal is the
    /// explicit user consent. Equivalent to legacy `full_auto`.
    FullAccess,
}

impl ApprovalPolicy {
    pub fn from_db(s: &str) -> Self {
        match s.trim().to_ascii_lowercase().as_str() {
            "auto_edit" => ApprovalPolicy::AutoEdit,
            "full_access" => ApprovalPolicy::FullAccess,
            _ => ApprovalPolicy::OnRequest, // "on_request", "", unknown
        }
    }

    pub fn as_db(self) -> &'static str {
        match self {
            ApprovalPolicy::OnRequest => "on_request",
            ApprovalPolicy::AutoEdit => "auto_edit",
            ApprovalPolicy::FullAccess => "full_access",
        }
    }
}

impl Default for ApprovalPolicy {
    fn default() -> Self {
        ApprovalPolicy::OnRequest
    }
}

/// Legacy single-dimension mode. Retained only to map old DB rows (where
/// `sandbox_policy` / `approval_policy` columns are absent) into the new
/// dual-policy model via [`PermissionMode::to_policies`]. Not used in any
/// decision path after migration.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionMode {
    ReadOnly,
    Manual,
    AutoEdit,
    FullAuto,
}

impl PermissionMode {
    /// Parse the DB-stored string back into a mode. Unknown / empty values
    /// fall back to `Manual` (the safe default) rather than erroring, so a
    /// corrupt or future-named row never locks the user out of chat.
    pub fn from_db(s: &str) -> Self {
        match s.trim().to_ascii_lowercase().as_str() {
            "read_only" => PermissionMode::ReadOnly,
            "auto_edit" => PermissionMode::AutoEdit,
            "full_auto" => PermissionMode::FullAuto,
            _ => PermissionMode::Manual, // "manual", "", anything unknown
        }
    }

    /// Map a legacy mode into the new dual-policy model. Used during
    /// migration to backfill `sandbox_policy` + `approval_policy` columns
    /// from the old `permission_mode` value.
    pub fn to_policies(self) -> (SandboxPolicy, ApprovalPolicy) {
        match self {
            PermissionMode::ReadOnly => (SandboxPolicy::ReadOnly, ApprovalPolicy::OnRequest),
            PermissionMode::Manual => (SandboxPolicy::WorkspaceWrite, ApprovalPolicy::OnRequest),
            PermissionMode::AutoEdit => (SandboxPolicy::WorkspaceWrite, ApprovalPolicy::AutoEdit),
            PermissionMode::FullAuto => (SandboxPolicy::WorkspaceWrite, ApprovalPolicy::FullAccess),
        }
    }
}

impl Default for PermissionMode {
    fn default() -> Self {
        PermissionMode::Manual
    }
}

/// The decision returned by [`check_permission`] for one tool call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PermissionDecision {
    /// Run the tool immediately — no approval card. The mode authorizes this
    /// action within already-granted roots.
    AutoRun,
    /// Pause the turn and surface a per-action approval card. The tool must
    /// NOT execute until the user resolves it (or denies it).
    NeedsApproval,
}

/// The mutating filesystem tools — the ones that change disk state. Used to
/// classify a tool name without a giant `matches!` sprinkled through the
/// check function. Kept in sync with the tool-name constants in `tools.rs`.
pub fn is_mutating_fs_tool(name: &str) -> bool {
    matches!(
        name,
        WRITE_FILE | EDIT_FILE | DELETE_FILE | MOVE_FILE | COPY_FILE
    )
}

/// Whether a filesystem tool is read-only (no disk mutation). Tools outside
/// the filesystem family are neither mutating nor read-only here and are
/// not governed by the permission gate at all (they route elsewhere).
pub fn is_filesystem_tool(name: &str) -> bool {
    matches!(
        name,
        LIST_DIRECTORY | READ_FILE | SEARCH_FILES
            | WRITE_FILE | EDIT_FILE | DELETE_FILE | MOVE_FILE | COPY_FILE
    )
}

// ===========================================================================
// System tools (background downloads + native shell) — chat/tasks.rs
// ===========================================================================
//
// These are the "do it for me" capabilities: `download_file` writes a file
// to an absolute local path (any drive — the user wants unrestricted access
// to D:\ models etc.), and `run_shell` executes a native command with full
// user privileges. Both run as background tasks, but the *permission* posture
// is decided here, BEFORE the task starts:
//
//   * `download_file` follows the connector-write posture: approval under
//     `read_only`/`manual`, auto-run under `auto_edit`/`full_auto`. There is
//     NO granted-root scope check — the point of this tool is unrestricted
//     filesystem access beyond workspace boundaries; the approval card is the
//     gate. Stripped from the schema under `read_only` (see tools/specs.rs).
//   * `run_shell` is native code execution with the user's privileges, so it
//     is gated in every mode except `full_auto` — the one-time Full Auto
//     modal is the explicit consent that lets it auto-run (mirroring Claude
//     Code's bypassPermissions / Codex full-access). It is present in the
//     schema outside `read_only` so the model can propose it in every mode.
//   * The tracking tools (`download_progress`, `get_task_status`,
//     `cancel_task`) are read-only/benign — they only inspect or abort tasks
//     the model itself started in this conversation. Auto-run everywhere,
//     including `read_only`.

use super::tools::{
    CANCEL_TASK, DOWNLOAD_FILE, DOWNLOAD_PROGRESS, GET_TASK_STATUS, RUN_SHELL, TASK,
};

/// Whether a tool belongs to the system-tool family (chat/tasks.rs).
pub fn is_system_tool(name: &str) -> bool {
    matches!(
        name,
        DOWNLOAD_FILE
            | DOWNLOAD_PROGRESS
            | RUN_SHELL
            | GET_TASK_STATUS
            | CANCEL_TASK
            | TASK
    )
}

/// The permission decision for a system tool call. See the module comment
/// above for the posture of each tool.
pub fn check_system_permission(
    sandbox: SandboxPolicy,
    approval: ApprovalPolicy,
    tool: &str,
) -> PermissionDecision {
    match tool {
        // Tracking/cancelling tools — benign, auto-run in every posture.
        DOWNLOAD_PROGRESS | GET_TASK_STATUS | CANCEL_TASK => PermissionDecision::AutoRun,
        // Subagent delegation — auto-run; it's a model-level sub-turn, not a
        // shell/filesystem action.
        TASK => PermissionDecision::AutoRun,
        // Native shell execution: gated in every posture EXCEPT full_access —
        // the one-time Full Access modal is the explicit user consent that
        // shell commands may run without per-action cards (Claude Code's
        // bypassPermissions / Codex full-access work the same way).
        RUN_SHELL => match approval {
            ApprovalPolicy::FullAccess => PermissionDecision::AutoRun,
            _ => PermissionDecision::NeedsApproval,
        },
        // Downloads write to disk; follow the connector-write posture:
        // auto-run under AutoEdit and FullAccess, gated under OnRequest.
        // Under ReadOnly (sandbox-level), downloads are absent from the
        // schema, but if one reaches here it is never auto-run.
        DOWNLOAD_FILE => {
            if !sandbox.allows_mutating_tools() {
                PermissionDecision::NeedsApproval
            } else {
                match approval {
                    ApprovalPolicy::OnRequest => PermissionDecision::NeedsApproval,
                    ApprovalPolicy::AutoEdit | ApprovalPolicy::FullAccess => {
                        PermissionDecision::AutoRun
                    }
                }
            }
        }
        _ => PermissionDecision::AutoRun,
    }
}

/// The central permission check. Called uniformly by every filesystem tool's
/// handler before it touches disk. **Never** duplicate this logic per-tool.
///
/// `path` is the absolute target path the tool intends to act on (taken from
/// the call's `path`/`dest`/etc. arg), used only to confirm it lies within a
/// granted root for the auto-run modes. `granted_roots` is the per-session
/// set of directory roots the user has already approved writing into.
///
/// Hard rules enforced here:
/// - **Delete is gated under every approval level except `full_access`** —
///   and even there only within granted roots. No other level auto-runs a
///   delete.
/// - **`read_only` sandbox never auto-runs a mutating tool** — mutating
///   tools reaching here under read-only is a bug (they should have been
///   filtered from the schema), but it is treated as `NeedsApproval`.
/// - Reads (`list_directory` / `read_file` / `search_files`) auto-run in
///   every posture.
pub fn check_permission(
    sandbox: SandboxPolicy,
    approval: ApprovalPolicy,
    tool: &str,
    path: &str,
    granted_roots: &[String],
) -> PermissionDecision {
    // Reads always run, in every posture.
    if matches!(tool, LIST_DIRECTORY | READ_FILE | SEARCH_FILES) {
        return PermissionDecision::AutoRun;
    }

    // ReadOnly sandbox: mutating tools shouldn't reach here (stripped from
    // schema), but defensively gate if they do.
    if !sandbox.allows_mutating_tools() {
        return PermissionDecision::NeedsApproval;
    }

    // Delete: gated under OnRequest and AutoEdit. Under FullAccess it
    // auto-runs ONLY within granted roots (the user consented via the
    // one-time Full Access modal); outside the roots it still gates so a
    // stray delete of e.g. C:\Windows\… never runs silently.
    if tool == DELETE_FILE {
        return match approval {
            ApprovalPolicy::FullAccess => {
                if path_within_granted_roots(path, granted_roots) {
                    PermissionDecision::AutoRun
                } else {
                    PermissionDecision::NeedsApproval
                }
            }
            _ => PermissionDecision::NeedsApproval,
        };
    }

    // move/copy: gated under OnRequest and AutoEdit (the destructive-ish
    // carve-out). Only FullAccess auto-runs them — and only within roots.
    if tool == MOVE_FILE || tool == COPY_FILE {
        return match approval {
            ApprovalPolicy::FullAccess => {
                if path_within_granted_roots(path, granted_roots) {
                    PermissionDecision::AutoRun
                } else {
                    PermissionDecision::NeedsApproval
                }
            }
            // OnRequest / AutoEdit both gate move/copy.
            _ => PermissionDecision::NeedsApproval,
        };
    }

    // write_file / edit_file: gated under OnRequest; auto-run within granted
    // roots under AutoEdit and FullAccess.
    if is_mutating_fs_tool(tool) {
        return match approval {
            // Every mutating action pauses.
            ApprovalPolicy::OnRequest => PermissionDecision::NeedsApproval,
            // Auto-edit / full-access auto-run writes/edits WITHIN granted
            // roots; outside granted roots, still gate them.
            ApprovalPolicy::AutoEdit | ApprovalPolicy::FullAccess => {
                if path_within_granted_roots(path, granted_roots) {
                    PermissionDecision::AutoRun
                } else {
                    PermissionDecision::NeedsApproval
                }
            }
        };
    }

    // A non-filesystem tool reaching here isn't governed by the gate — let it
    // run. (In practice the dispatcher only calls this for FS tools.)
    PermissionDecision::AutoRun
}

// ===========================================================================
// Connector-originated tool calls (OAuth-backed remote MCP tools, e.g. Notion)
// ===========================================================================
//
// Connector tool names are NOT known ahead of time — they come from the
// vendor's `tools/list` response. So unlike filesystem tools, we cannot
// hardcode the carve-out by tool-name constant. Instead, each remote tool is
// classified as Read or Write at registration time (see
// `classify_connector_tool`) and the kind travels with the tool into the
// dispatcher, which routes Write tools through this same approval flow.
//
// Hard rule (mirrors `delete_file` above): a connector Write/Create/Delete
// action under `read_only`/`manual` is `NeedsApproval`. Unlike filesystem
// tools there is no delete-only carve-out: the vendor classifies the tool and
// we trust that classification, so `auto_edit` and `full_auto` auto-run
// connector writes (the account is already connected, i.e. user-granted).
// `read_only` strips Write tools from the schema (see `tools::specs`), and if
// one still reaches the gate it is never auto-run. Connector Reads auto-run in
// every mode (like filesystem reads), so a "search my Notion for X" runs
// without friction regardless of permission mode.

/// A connector tool's mutating intent, classified from its name/description
/// when its schema is fetched from the vendor's MCP server.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnectorToolKind {
    /// Search / read / list / query — no mutation of the connected account.
    Read,
    /// Create / update / delete / insert / move / archive — mutates the
    /// connected account. Gated per the session's approval policy: approval
    /// under `OnRequest` (or `ReadOnly` sandbox), auto-run under
    /// `AutoEdit`/`FullAccess`.
    Write,
}

/// Classify a remote connector tool as Read or Write from its name + the
/// description the vendor's MCP server returned.
///
/// The tool NAME is authoritative: vendors name tools after their intent
/// (`gmail_send_message`, `api_create_page`, `search-flight`), so a read or
/// write verb in the name decides. The description is only consulted when the
/// name carries no verb — long vendor descriptions routinely contain write
/// words describing *how to present results* (e.g. Kiwi's search-flight
/// instructions say "add the inbound equivalents for return flights"), which
/// would misclassify a pure read as a Write.
///
/// Conservative fallback: when neither name nor description yields a keyword,
/// treat as Write — the safe side is to over-gate, never to silently auto-run
/// a mutating action on a connected third-party account.
pub fn classify_connector_tool(name: &str, description: Option<&str>) -> ConnectorToolKind {
    // Whole-word keyword matching, lowercased: "send" must not match
    // "senders", "create" must not match "recreate" etc. Splitting on
    // non-alphanumerics handles underscores (api_create_page → api, create,
    // page) and full-sentence descriptions alike.
    fn tokens(s: &str) -> Vec<String> {
        s.to_ascii_lowercase()
            .split(|c: char| !c.is_alphanumeric())
            .filter(|t| !t.is_empty())
            .map(|t| t.to_string())
            .collect()
    }
    // Write keywords — any whole-word match ⇒ Write. Ordered roughly by
    // specificity (checked before read keywords).
    let write_kw = [
        "create", "insert", "add", "write", "update", "edit", "patch", "modify",
        "delete", "remove", "trash", "archive", "move", "rename", "publish",
        "send", "post", "comment", "assign", "share", "grant", "revoke",
    ];
    // Read keywords — a clear read verb with no write verb ⇒ Read.
    let read_kw = [
        "search", "find", "get", "read", "list", "query", "fetch", "retrieve",
        "show", "view", "inspect", "describe",
    ];
    let has_any = |ks: &[&str], toks: &[String]| ks.iter().any(|kw| toks.iter().any(|t| t == kw));

    let name_tokens = tokens(name);
    if has_any(&write_kw, &name_tokens) {
        return ConnectorToolKind::Write;
    }
    if has_any(&read_kw, &name_tokens) {
        return ConnectorToolKind::Read;
    }
    let desc_tokens = tokens(description.unwrap_or(""));
    if has_any(&write_kw, &desc_tokens) {
        return ConnectorToolKind::Write;
    }
    if has_any(&read_kw, &desc_tokens) {
        return ConnectorToolKind::Read;
    }
    // Unknown intent: gate it (treat as Write). Better to ask than to mutate.
    ConnectorToolKind::Write
}

/// The connector permission check. Reads auto-run in every posture. Writes
/// follow the session's approval policy — the same posture as filesystem
/// writes: `ReadOnly` sandbox never auto-runs (Write tools are also filtered
/// from the schema), `OnRequest` asks for per-action approval,
/// `AutoEdit`/`FullAccess` auto-run.
pub fn check_connector_permission(
    sandbox: SandboxPolicy,
    approval: ApprovalPolicy,
    kind: ConnectorToolKind,
) -> PermissionDecision {
    match kind {
        ConnectorToolKind::Read => PermissionDecision::AutoRun,
        ConnectorToolKind::Write => {
            if !sandbox.allows_mutating_tools() {
                PermissionDecision::NeedsApproval
            } else {
                match approval {
                    ApprovalPolicy::OnRequest => PermissionDecision::NeedsApproval,
                    ApprovalPolicy::AutoEdit | ApprovalPolicy::FullAccess => {
                        PermissionDecision::AutoRun
                    }
                }
            }
        }
    }
}

/// True when `path` is equal to or nested under one of the granted roots.
/// Comparison is canonicalized (lexicographic, separators normalized) so
/// `C:\foo` and `C:/foo/` match the same root. Empty/relative paths are
/// treated as outside any root (granted roots are always absolute).
pub fn path_within_granted_roots(path: &str, granted_roots: &[String]) -> bool {
    if path.trim().is_empty() {
        return false;
    }
    let needle = canonicalize(path);
    granted_roots
        .iter()
        .map(|r| canonicalize(r))
        .any(|root| {
            if needle == root {
                return true;
            }
            // Segment boundary required: with granted root `c:/projects/alpha`,
            // a raw `starts_with` would also pass the sibling `c:/projects/alpha2/…`
            // (or `alpha-evil/…`), silently widening the granted scope.
            let root_with_sep = if root.ends_with('/') { root } else { format!("{root}/") };
            needle.starts_with(&root_with_sep)
        })
}

/// Resolve a path through the FILESYSTEM (junctions/symlinks included).
/// Falls back to resolving only the existing parent chain and reattaching
/// the leaf — write_file targets often don't exist yet, but their parent
/// directory does, and the parent's links are what matter for containment.
/// Returns None when neither the path nor its parent resolves (nothing on
/// disk to consult — caller falls back to the lexical result).
fn fs_resolved(p: &std::path::Path) -> Option<std::path::PathBuf> {
    if let Ok(c) = std::fs::canonicalize(p) {
        return Some(c);
    }
    let parent = p.parent()?;
    let leaf = p.file_name()?;
    let cp = std::fs::canonicalize(parent).ok()?;
    Some(cp.join(leaf))
}

/// Hard scope check: a mutating tool call is only allowed when its target
/// `path` lies within a granted root. Used in addition to the approval gate
/// so that a single approval cannot be re-used (intentionally or by mistake)
/// to write to an arbitrary absolute path. This is the wire that the
/// filesystem task's "granted roots" model needs: without it, `check_permission`
/// only changed approval *defaults*, not what's reachable.
///
/// The authoritative comparison resolves the FILESYSTEM: a junction or
/// symlink inside a granted root (pnpm `node_modules`, OneDrive placeholders,
/// temp-dir junctions) that points OUTSIDE it must not let a write escape —
/// the FS tools operate on the original path, so the lexical check alone
/// would pass while the bytes land outside every root.
///
/// Reads (list_directory / read_file / search_files / search_content) remain
/// unscoped — a user explicitly opening a file is a deliberate act and reading
/// a file the model can see the path of is needed for legitimate workflows
/// (e.g. "summarize this CSV"). Mutating actions are the dangerous ones, and
/// the read-then-write flow is gated behind a per-action approval card on top.
pub fn path_within_scope(path: &str, granted_roots: &[String]) -> bool {
    if granted_roots.is_empty() {
        // No roots granted → no mutating tool is allowed to touch disk.
        // (Approval cards still fire under Manual mode, but the write is
        // rejected at the gate.)
        return false;
    }
    let lexical = path_within_granted_roots(path, granted_roots);
    let Some(needle) = fs_resolved(std::path::Path::new(path)) else {
        // Neither the path nor its parent exists on disk — there are no
        // links to resolve, so the lexicographic result is authoritative.
        return lexical;
    };
    // The write's REAL target must sit inside a granted root whose own
    // filesystem form is used for the comparison (both sides come back from
    // canonicalize in the same `\\?\` verbatim form on Windows).
    granted_roots.iter().any(|r| {
        let root = fs_resolved(std::path::Path::new(r))
            .unwrap_or_else(|| std::path::PathBuf::from(r));
        crate::util::path_starts_with_ci(&needle, &root)
    })
}

/// Normalize a path for comparison: lowercase, strip the Windows drive `\\?\`
/// prefix, forward-slash separators, drop trailing separators. Good enough
/// for the granted-root containment check (NOT a security boundary — the hard
/// denylist / granted-roots model from the filesystem task is authoritative;
/// this selector only changes approval *defaults* within already-granted roots).
fn canonicalize(p: &str) -> String {
    let mut s = p.trim().to_string();
    // Strip a leading \\?\ verbatim prefix (UNC-mapped canonical form).
    if s.starts_with(r"\\?\") {
        s = s[4..].to_string();
    }
    // Normalize separators to '/'.
    s = s.replace('\\', "/");
    // Resolve `..` and `.` components to prevent path traversal escaping
    // the granted root (e.g. C:/projects/alpha/../../etc would escape
    // without this step). This is a lexicographic resolve — not a
    // filesystem canonicalize; the actual filesystem tools operate on
    // the original path, so this only affects the containment check.
    let segments: Vec<&str> = s.split('/').filter(|seg| !seg.is_empty() && *seg != ".").collect();
    let mut resolved: Vec<&str> = Vec::with_capacity(segments.len());
    for seg in segments {
        if seg == ".." {
            resolved.pop(); // safe: pop() returns Option; no panic on empty vec
        } else {
            resolved.push(seg);
        }
    }
    s = resolved.join("/");
    // Preserve leading slash for absolute paths (e.g. /home/user/projects).
    if p.trim().starts_with('/') || p.trim().starts_with('\\') {
        s.insert(0, '/');
    }
    // Lowercase for case-insensitive match (Windows roots).
    s = s.to_ascii_lowercase();
    // Drop trailing slash so a root matches its nested paths cleanly.
    while s.ends_with('/') && s.len() > 1 {
        s.pop();
    }
    s
}

// ===========================================================================
// Approval rules engine ("always allow tool + glob", roadmap #8)
// ===========================================================================
//
// A user-defined rule auto-approves a filesystem tool call when BOTH the tool
// name and the target path match. This is pure opt-in ergonomics layered on
// top of `check_permission`: rules bypass the per-action approval card but are
// still bounded by the authoritative `path_within_scope` gate in the
// dispatcher, so a rule can never grant writes outside the user's enabled /
// working-directory scope (arbitrary system-file mutation stays impossible).

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRule {
    pub id: String,
    /// The filesystem tool this rule governs: `write_file` / `edit_file` /
    /// `delete_file` / `move_file` / `copy_file`. An empty string matches any
    /// mutating filesystem tool.
    #[serde(default)]
    pub tool: String,
    /// Glob matched against the tool's target path (write-side for move/copy).
    /// An empty string matches every path (still scope-gated by the dispatcher).
    #[serde(default)]
    pub pattern: String,
    #[serde(default)]
    pub created_at: i64,
}

impl ApprovalRule {
    fn matches(&self, tool: &str, path: &str) -> bool {
        // Tool match: exact (case-insensitive) or empty=any.
        if !self.tool.is_empty() && !self.tool.eq_ignore_ascii_case(tool) {
            return false;
        }
        // Pattern: empty=any path; otherwise glob (case-insensitive on leaves).
        self.pattern.is_empty() || glob_match(&self.pattern, path)
    }
}

/// True when any rule's (tool, path) pair matches — i.e. the call should
/// auto-run past the approval gate. Rules never affect the scope gate.
pub fn any_rule_allows(rules: &[ApprovalRule], tool: &str, path: &str) -> bool {
    rules.iter().any(|r| r.matches(tool, path))
}

/// Home-grown glob matcher (~`glob` crate subset): supports `*` (matches any
/// run of chars within a path segment) and `**` (matches across any number of
/// segments, including zero). `?` and `[...]` are not supported in v1. Path
/// matching is case-insensitive on Windows, sensitive elsewhere.
pub fn glob_match(pattern: &str, path: &str) -> bool {
    let pat = pattern.replace('\\', "/");
    let pth = path.replace('\\', "/");
    let pat_lower = pat.to_ascii_lowercase();
    let pth_lower = pth.to_ascii_lowercase();
    // Case-insensitive on Windows, sensitive elsewhere (so the compare below
    // uses the lowered forms only under cfg(windows)).
    let pat_segs: Vec<String> = {
        let s = if cfg!(windows) { pat_lower.as_str() } else { pat.as_str() };
        s.split('/').filter(|x| !x.is_empty()).map(|x| x.to_string()).collect()
    };
    let path_segs: Vec<String> = {
        let s = if cfg!(windows) { pth_lower.as_str() } else { pth.as_str() };
        s.split('/').filter(|x| !x.is_empty()).map(|x| x.to_string()).collect()
    };

    fn seg_match(pat: &str, seg: &str) -> bool {
        if pat == seg {
            return true;
        }
        if !pat.contains('*') {
            return false;
        }
        // Split on '*'; the literal pieces must appear in order within `seg`.
        // If the pattern does NOT start with '*', the first literal is anchored
        // at start; if it doesn't end with '*', everything after the last
        // literal must be consumed at the tail.
        let anchored_start = !pat.starts_with('*');
        let anchored_end = !pat.ends_with('*');
        let mut rem = seg;
        let mut first = true;
        for part in pat.split('*') {
            if part.is_empty() {
                continue;
            }
            if first {
                if anchored_start {
                    if !rem.starts_with(part) {
                        return false;
                    }
                    rem = &rem[part.len()..];
                } else {
                    match rem.find(part) {
                        Some(idx) => rem = &rem[idx + part.len()..],
                        None => return false,
                    }
                }
                first = false;
            } else {
                match rem.find(part) {
                    Some(idx) => rem = &rem[idx + part.len()..],
                    None => return false,
                }
            }
        }
        // If the pattern had a trailing '*', any remainder is allowed;
        // otherwise (anchored_end) the whole segment must have been consumed.
        if anchored_end {
            rem.is_empty()
        } else {
            true
        }
    }

    fn rec(p: &[String], s: &[String]) -> bool {
        match (p.first(), s.first()) {
            (None, None) => true,
            (None, Some(_)) => false,
            // Path exhausted but pattern remains — only ** can match zero.
            // (This arm fully covers the former unreachable `(Some(_), None)`
            // duplicate below it, which the compiler flagged; removed.)
            (Some(seg_p), None) => seg_p == "**" && rec(&p[1..], &[]),
            (Some(seg_p), Some(seg_s)) => {
                if seg_p == "**" {
                    rec(&p[1..], s) || rec(p, &s[1..])
                } else if seg_match(seg_p, seg_s) {
                    rec(&p[1..], &s[1..])
                } else {
                    false
                }
            }
        }
    }

    rec(&pat_segs, &path_segs)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ROOTS: &[&str] = &["C:/projects/alpha", "C:\\projects\\beta"];

    fn roots() -> Vec<String> {
        ROOTS.iter().map(|s| s.to_string()).collect()
    }

    // ---- reads run in every mode ----

    #[test]
    fn reads_auto_run_in_every_mode() {
        for (sandbox, approval) in [
            (SandboxPolicy::ReadOnly, ApprovalPolicy::OnRequest),
            (SandboxPolicy::WorkspaceWrite, ApprovalPolicy::OnRequest),
            (SandboxPolicy::WorkspaceWrite, ApprovalPolicy::AutoEdit),
            (SandboxPolicy::WorkspaceWrite, ApprovalPolicy::FullAccess),
        ] {
            assert_eq!(
                check_permission(sandbox, approval, READ_FILE, "C:/projects/alpha/notes.md", &roots()),
                PermissionDecision::AutoRun,
                "read_file should auto-run under {sandbox:?} + {approval:?}"
            );
            assert_eq!(
                check_permission(sandbox, approval, LIST_DIRECTORY, "C:/projects/alpha", &roots()),
                PermissionDecision::AutoRun,
                "list_directory should auto-run under {sandbox:?} + {approval:?}"
            );
            assert_eq!(
                check_permission(sandbox, approval, SEARCH_FILES, "C:/projects/alpha", &roots()),
                PermissionDecision::AutoRun,
                "search_files should auto-run under {sandbox:?} + {approval:?}"
            );
        }
    }

    // ---- the delete-always-gated hard rule ----

    #[test]
    fn granted_root_requires_segment_boundary() {
        // Sibling directories that share a name prefix with a granted root
        // must NOT be treated as inside it.
        assert!(!path_within_granted_roots("C:/projects/alpha2/secret.txt", &roots()));
        assert!(!path_within_granted_roots("C:/projects/alpha-evil/x", &roots()));
        assert!(!path_within_granted_roots("C:/projects/beta2/y", &roots()));
        // …while exact-root and nested paths still pass.
        assert!(path_within_granted_roots("C:/projects/alpha", &roots()));
        assert!(path_within_granted_roots("C:/projects/alpha/sub/file.txt", &roots()));
        assert!(path_within_granted_roots("C:/projects/beta/src/main.rs", &roots()));
    }

    /// B1 (round 2): a junction/symlink INSIDE a granted root that points
    /// OUTSIDE it must not let a mutating tool escape the sandbox — the
    /// lexical check passes but the write's real target is elsewhere.
    #[test]
    fn junction_inside_root_pointing_outside_is_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("root");
        let outside = tmp.path().join("outside");
        let link = root.join("link");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        // Junction on Windows (`mklink /J` needs no privileges), symlink on
        // Unix. If the platform refuses link creation, skip the test rather
        // than fail — the code path is still covered by the sibling test.
        #[cfg(windows)]
        let linked = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(&outside)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        #[cfg(not(windows))]
        let linked = std::os::unix::fs::symlink(&outside, &link).is_ok();
        if !linked {
            eprintln!("skipping: could not create link in {}", tmp.path().display());
            return;
        }
        let roots = vec![root.to_string_lossy().to_string()];
        // A file under the junction resolves to `outside/…` — outside the root.
        assert!(!path_within_scope(
            &link.join("escape.txt").to_string_lossy(),
            &roots
        ));
        // A plain nested path still passes, and the root itself still passes.
        assert!(path_within_scope(
            &root.join("normal.txt").to_string_lossy(),
            &roots
        ));
        assert!(path_within_scope(&root.to_string_lossy(), &roots));
    }

    #[test]
    fn delete_auto_runs_under_full_auto_within_roots_but_gates_outside() {
        // Full Access (explicitly confirmed via the one-time modal) auto-runs
        // deletes inside granted roots…
        let d = check_permission(
            SandboxPolicy::WorkspaceWrite,
            ApprovalPolicy::FullAccess,
            DELETE_FILE,
            "C:/projects/alpha/throwaway.txt",
            &roots(),
        );
        assert_eq!(d, PermissionDecision::AutoRun);
        // …and still gates them outside the roots.
        assert_eq!(
            check_permission(
                SandboxPolicy::WorkspaceWrite,
                ApprovalPolicy::FullAccess,
                DELETE_FILE,
                "C:/elsewhere/throwaway.txt",
                &roots()
            ),
            PermissionDecision::NeedsApproval
        );
    }

    #[test]
    fn delete_is_gated_under_every_other_mode() {
        // ReadOnly gates via sandbox; Manual (OnRequest) and AutoEdit gate
        // via approval. None of these auto-run a delete.
        for (sandbox, approval) in [
            (SandboxPolicy::ReadOnly, ApprovalPolicy::OnRequest),
            (SandboxPolicy::WorkspaceWrite, ApprovalPolicy::OnRequest),
            (SandboxPolicy::WorkspaceWrite, ApprovalPolicy::AutoEdit),
        ] {
            assert_eq!(
                check_permission(sandbox, approval, DELETE_FILE, "C:/projects/alpha/x", &roots()),
                PermissionDecision::NeedsApproval,
                "delete must be gated under {sandbox:?} + {approval:?}"
            );
        }
    }

    // ---- manual gates every mutating action ----

    #[test]
    fn manual_gates_writes_edits_moves_copies() {
        // Manual maps to (WorkspaceWrite, OnRequest): every mutating action
        // pauses for a per-action approval card.
        for tool in [WRITE_FILE, EDIT_FILE, MOVE_FILE, COPY_FILE] {
            assert_eq!(
                check_permission(
                    SandboxPolicy::WorkspaceWrite,
                    ApprovalPolicy::OnRequest,
                    tool,
                    "C:/projects/alpha/file",
                    &roots()
                ),
                PermissionDecision::NeedsApproval,
                "{tool} should be gated under manual (on_request)"
            );
        }
    }

    // ---- auto_edit / full_auto auto-run mutating tools within granted roots ----

    #[test]
    fn auto_edit_auto_runs_write_within_granted_root() {
        assert_eq!(
            check_permission(
                SandboxPolicy::WorkspaceWrite,
                ApprovalPolicy::AutoEdit,
                WRITE_FILE,
                "C:/projects/alpha/src/main.rs",
                &roots()
            ),
            PermissionDecision::AutoRun
        );
        assert_eq!(
            check_permission(
                SandboxPolicy::WorkspaceWrite,
                ApprovalPolicy::FullAccess,
                WRITE_FILE,
                "C:/projects/alpha/src/main.rs",
                &roots()
            ),
            PermissionDecision::AutoRun
        );
    }

    #[test]
    fn auto_edit_gates_write_outside_granted_root() {
        assert_eq!(
            check_permission(
                SandboxPolicy::WorkspaceWrite,
                ApprovalPolicy::AutoEdit,
                WRITE_FILE,
                "C:/elsewhere/secret.txt",
                &roots()
            ),
            PermissionDecision::NeedsApproval
        );
        // Even full_access gates a write OUTSIDE granted roots — the selector
        // only relaxes the default WITHIN already-granted roots; it never
        // expands what's reachable at all.
        assert_eq!(
            check_permission(
                SandboxPolicy::WorkspaceWrite,
                ApprovalPolicy::FullAccess,
                WRITE_FILE,
                "C:/elsewhere/secret.txt",
                &roots()
            ),
            PermissionDecision::NeedsApproval
        );
    }

    // ---- read_only never auto-runs a mutating tool ----

    #[test]
    fn read_only_never_auto_runs_mutating_tool() {
        // A mutating tool shouldn't reach check_permission under read-only
        // (the schema filters it out first), but if it does it must NOT run.
        assert_eq!(
            check_permission(
                SandboxPolicy::ReadOnly,
                ApprovalPolicy::OnRequest,
                WRITE_FILE,
                "C:/projects/alpha/file",
                &roots()
            ),
            PermissionDecision::NeedsApproval
        );
        assert_eq!(
            check_permission(
                SandboxPolicy::ReadOnly,
                ApprovalPolicy::OnRequest,
                EDIT_FILE,
                "C:/projects/alpha/file",
                &roots()
            ),
            PermissionDecision::NeedsApproval
        );
    }

    // ---- path containment helpers ----

    #[test]
    fn path_within_root_matches_exact_and_nested() {
        let roots = vec!["C:/projects/alpha".to_string()];
        assert!(path_within_granted_roots("C:/projects/alpha", &roots));
        assert!(path_within_granted_roots("C:/projects/alpha/src/main.rs", &roots));
        assert!(!path_within_granted_roots("C:/projects/alpha/../../etc", &roots));
        // But a legit nested path with .. that stays inside should still pass.
        assert!(path_within_granted_roots("C:/projects/alpha/subdir/../src/main.rs", &roots));
    }

    #[test]
    fn path_within_root_is_separator_and_case_insensitive() {
        let roots = vec!["C:\\Projects\\Alpha".to_string()];
        assert!(path_within_granted_roots("c:/projects/alpha/file", &roots));
        assert!(path_within_granted_roots("C:\\Projects\\Alpha\\file", &roots));
    }

    #[test]
    fn path_outside_roots_is_false() {
        let roots = vec!["C:/projects/alpha".to_string()];
        assert!(!path_within_granted_roots("C:/projects/beta/file", &roots));
        assert!(!path_within_granted_roots("C:/elsewhere", &roots));
        assert!(!path_within_granted_roots("", &roots));
    }

    // ---- db round-trip ----

    #[test]
    fn permission_mode_db_round_trip() {
        // DB-only legacy compat shim: round-trip the old permission_mode
        // string → PermissionMode (no mode-dependent check here). Legacy
        // PermissionMode no longer carries `as_db`; map each variant to its
        // canonical DB string explicitly to keep this a pure string test.
        for (mode, db_str) in [
            (PermissionMode::ReadOnly, "read_only"),
            (PermissionMode::Manual, "manual"),
            (PermissionMode::AutoEdit, "auto_edit"),
            (PermissionMode::FullAuto, "full_auto"),
        ] {
            assert_eq!(PermissionMode::from_db(db_str), mode);
        }
    }

    #[test]
    fn permission_mode_unknown_falls_back_to_manual() {
        assert_eq!(PermissionMode::from_db(""), PermissionMode::Manual);
        assert_eq!(PermissionMode::from_db("nonsense"), PermissionMode::Manual);
        assert_eq!(PermissionMode::from_db("MANUAL"), PermissionMode::Manual);
    }

    #[test]
    fn default_is_manual() {
        assert_eq!(PermissionMode::default(), PermissionMode::Manual);
    }

    // ---- connector tool classification + always-gate-write carve-out ----

    #[test]
    fn connector_classifies_read_tools() {
        for (name, desc) in [
            ("search", "Search pages in the user's workspace"),
            ("api_get_page", "Retrieve a page by id"),
            ("list_databases", "List all databases"),
            ("api_search", "Full-text query across content"),
            ("search-flight", "# Search for flights"),
        ] {
            assert_eq!(
                classify_connector_tool(name, Some(desc)),
                ConnectorToolKind::Read,
                "{name} should classify as Read"
            );
        }
    }

    #[test]
    fn read_tool_name_wins_over_write_words_in_description() {
        // Regression: Kiwi's search-flight description tells the model how to
        // present results ("add the inbound equivalents for return flights"),
        // which would misclassify the pure search as a Write if the description
        // were consulted first. The name ("search") is authoritative.
        assert_eq!(
            classify_connector_tool(
                "search-flight",
                Some(
                    "# Search for flights\n\nSearches Kiwi.com for available flights. \
                     ... add the inbound equivalents for return flights, then summarise \
                     the best price and give a recommendation."
                ),
            ),
            ConnectorToolKind::Read,
            "search-flight is read-only, idempotent — description noise must not gate it"
        );
        // But a write verb in the NAME still classifies as Write, even with a
        // read-y description.
        assert_eq!(
            classify_connector_tool(
                "send_message",
                Some("List and display messages in the inbox"),
            ),
            ConnectorToolKind::Write
        );
    }

    #[test]
    fn connector_classifies_write_tools() {
        for (name, desc) in [
            ("api_create_page", "Create a new page"),
            ("api_update_page", "Update page properties"),
            ("archive_page", "Move a page to the trash"),
            ("api_delete_page", "Permanently delete a page"),
            ("add_comment", "Add a comment to a page"),
        ] {
            assert_eq!(
                classify_connector_tool(name, Some(desc)),
                ConnectorToolKind::Write,
                "{name} should classify as Write"
            );
        }
    }

    #[test]
    fn connector_unknown_intent_defaults_to_write_gated() {
        // No read or write keyword → conservative: treat as Write (gate it).
        assert_eq!(
            classify_connector_tool("mystery_tool", Some("does something unspecified")),
            ConnectorToolKind::Write
        );
    }

    #[test]
    fn connector_keywords_match_whole_words_not_substrings() {
        // Regression: "send" must not match "senders" (a read-y Gmail context),
        // and "create" must not match "recreate"/"creative".
        assert_eq!(
            classify_connector_tool(
                "gmail_get_thread",
                Some("Fetch a thread with senders, dates and plaintext bodies")
            ),
            ConnectorToolKind::Read
        );
        assert_eq!(
            classify_connector_tool(
                "api_get_page",
                Some("Retrieve a page by id from the user's workspace")
            ),
            ConnectorToolKind::Read
        );
        assert_eq!(
            classify_connector_tool(
                "recreate_snippet",
                Some("Show a creative snippet of content")
            ),
            ConnectorToolKind::Read
        );
    }

    #[test]
    fn connector_write_follows_permission_mode() {
        // read_only / manual gate every connector write with a card; auto_edit
        // and full_access auto-run them (the account is already connected).
        for (sandbox, approval) in [
            (SandboxPolicy::ReadOnly, ApprovalPolicy::OnRequest),
            (SandboxPolicy::WorkspaceWrite, ApprovalPolicy::OnRequest),
        ] {
            assert_eq!(
                check_connector_permission(sandbox, approval, ConnectorToolKind::Write),
                PermissionDecision::NeedsApproval,
                "connector write must be gated under {sandbox:?} + {approval:?}"
            );
        }
        for (sandbox, approval) in [
            (SandboxPolicy::WorkspaceWrite, ApprovalPolicy::AutoEdit),
            (SandboxPolicy::WorkspaceWrite, ApprovalPolicy::FullAccess),
        ] {
            assert_eq!(
                check_connector_permission(sandbox, approval, ConnectorToolKind::Write),
                PermissionDecision::AutoRun,
                "connector write should auto-run under {sandbox:?} + {approval:?}"
            );
        }
    }

    #[test]
    fn connector_read_auto_runs_in_every_mode() {
        // A "search my Notion for X" runs without friction in every posture.
        for (sandbox, approval) in [
            (SandboxPolicy::ReadOnly, ApprovalPolicy::OnRequest),
            (SandboxPolicy::WorkspaceWrite, ApprovalPolicy::OnRequest),
            (SandboxPolicy::WorkspaceWrite, ApprovalPolicy::AutoEdit),
            (SandboxPolicy::WorkspaceWrite, ApprovalPolicy::FullAccess),
        ] {
            assert_eq!(
                check_connector_permission(sandbox, approval, ConnectorToolKind::Read),
                PermissionDecision::AutoRun,
                "connector read should auto-run under {sandbox:?} + {approval:?}"
            );
        }
    }

    // ---- move/copy get gated under auto_edit too (carve-out) ----

    #[test]
    fn move_and_copy_gated_under_auto_edit() {
        // Per the table: auto_edit still gates move/copy (destructive-ish).
        for tool in [MOVE_FILE, COPY_FILE] {
            assert_eq!(
                check_permission(
                    SandboxPolicy::WorkspaceWrite,
                    ApprovalPolicy::AutoEdit,
                    tool,
                    "C:/projects/alpha/file",
                    &roots()
                ),
                PermissionDecision::NeedsApproval,
                "{tool} should be gated under auto_edit"
            );
        }
        // But full_access auto-runs move/copy/delete within granted roots.
        for tool in [MOVE_FILE, COPY_FILE] {
            assert_eq!(
                check_permission(
                    SandboxPolicy::WorkspaceWrite,
                    ApprovalPolicy::FullAccess,
                    tool,
                    "C:/projects/alpha/file",
                    &roots()
                ),
                PermissionDecision::AutoRun,
                "{tool} should auto-run under full_access within roots"
            );
        }
    }

    // ---- system tools (downloads + native shell) ----

    #[test]
    fn run_shell_gated_except_full_auto() {
        // Native code execution stays gated in every posture except full_access
        // — the one-time Full Access modal is the explicit consent that shell
        // commands run without per-action cards (bug report #2). Sandbox level
        // (read_only vs workspace_write) does NOT relax this; only approval
        // == FullAccess does, so a WorkspaceWrite + non-FullAccess pairing
        // covers the gated cases.
        for (sandbox, approval) in [
            (SandboxPolicy::ReadOnly, ApprovalPolicy::OnRequest),
            (SandboxPolicy::WorkspaceWrite, ApprovalPolicy::OnRequest),
            (SandboxPolicy::WorkspaceWrite, ApprovalPolicy::AutoEdit),
        ] {
            assert_eq!(
                check_system_permission(sandbox, approval, RUN_SHELL),
                PermissionDecision::NeedsApproval,
                "run_shell must be gated under {sandbox:?} + {approval:?}"
            );
        }
        assert_eq!(
            check_system_permission(SandboxPolicy::WorkspaceWrite, ApprovalPolicy::FullAccess, RUN_SHELL),
            PermissionDecision::AutoRun
        );
    }

    #[test]
    fn download_file_follows_connector_write_posture() {
        // Approval under read_only/manual (ReadOnly sandbox or OnRequest
        // approval); auto-run under auto_edit/full_access (no granted-root
        // scope — unrestricted filesystem access is the point).
        for (sandbox, approval) in [
            (SandboxPolicy::ReadOnly, ApprovalPolicy::OnRequest),
            (SandboxPolicy::WorkspaceWrite, ApprovalPolicy::OnRequest),
        ] {
            assert_eq!(
                check_system_permission(sandbox, approval, DOWNLOAD_FILE),
                PermissionDecision::NeedsApproval,
                "download_file must be gated under {sandbox:?} + {approval:?}"
            );
        }
        for (sandbox, approval) in [
            (SandboxPolicy::WorkspaceWrite, ApprovalPolicy::AutoEdit),
            (SandboxPolicy::WorkspaceWrite, ApprovalPolicy::FullAccess),
        ] {
            assert_eq!(
                check_system_permission(sandbox, approval, DOWNLOAD_FILE),
                PermissionDecision::AutoRun,
                "download_file should auto-run under {sandbox:?} + {approval:?}"
            );
        }
    }

    #[test]
    fn task_tracking_tools_auto_run_in_every_mode() {
        // download_progress / get_task_status / cancel_task are benign — they
        // only inspect or abort tasks the model itself started.
        for (sandbox, approval) in [
            (SandboxPolicy::ReadOnly, ApprovalPolicy::OnRequest),
            (SandboxPolicy::WorkspaceWrite, ApprovalPolicy::OnRequest),
            (SandboxPolicy::WorkspaceWrite, ApprovalPolicy::AutoEdit),
            (SandboxPolicy::WorkspaceWrite, ApprovalPolicy::FullAccess),
        ] {
            for tool in [DOWNLOAD_PROGRESS, GET_TASK_STATUS, CANCEL_TASK] {
                assert_eq!(
                    check_system_permission(sandbox, approval, tool),
                    PermissionDecision::AutoRun,
                    "{tool} should auto-run under {sandbox:?} + {approval:?}"
                );
            }
        }
    }

    #[test]
    fn system_tool_family_detection() {
        assert!(is_system_tool(DOWNLOAD_FILE));
        assert!(is_system_tool(RUN_SHELL));
        assert!(is_system_tool(GET_TASK_STATUS));
        assert!(!is_system_tool(WRITE_FILE));
        assert!(!is_system_tool(READ_FILE));
        assert!(!is_system_tool("web_search"));
    }

    // ---- Approval rules engine ----

    #[test]
    fn glob_star_single_segment() {
        assert!(glob_match("*.ts", "foo.ts"));
        assert!(!glob_match("*.ts", "a/b/foo.ts")); // single * does NOT cross '/'
        assert!(!glob_match("*.ts", "foo.js"));
        // A single * matches within one segment only.
        assert!(glob_match("src/*.ts", "src/main.ts"));
        assert!(!glob_match("src/*.ts", "src/sub/main.ts"));
    }

    #[test]
    fn glob_double_star_crosses_segments() {
        assert!(glob_match("**/*.test.ts", "src/app/foo.test.ts"));
        assert!(glob_match("**/*.test.ts", "foo.test.ts"));
        assert!(glob_match("**/*.test.ts", "a/b/c/d.test.ts"));
        assert!(!glob_match("**/*.test.ts", "src/app/foo.spec.ts"));
        assert!(!glob_match("**/*.test.ts", "src/app/foo.test.js"));
    }

    #[test]
    fn glob_double_star_zero_segments() {
        assert!(glob_match("dist/**", "dist"));
        assert!(glob_match("dist/**", "dist/"));
        assert!(glob_match("dist/**", "dist/out.js"));
        assert!(glob_match("dist/**", "dist/a/b/c.js"));
        assert!(!glob_match("dist/**", "dist-other"));
    }

    #[test]
    fn glob_exact_and_prefix() {
        assert!(glob_match("**/notes.md", "notes.md"));
        assert!(glob_match("**/notes.md", "docs/notes.md"));
        assert!(glob_match("/C:/projects/alpha/**", "/C:/projects/alpha/src/main.rs"));
        assert!(glob_match("src/*.ts", "src/main.ts"));
        assert!(!glob_match("src/*.ts", "src/sub/main.ts"));
    }

    #[test]
    fn glob_prefix_mid_segment() {
        assert!(glob_match("**/*perf*", "metrics/perf_report.md"));
        assert!(glob_match("**/*perf*", "perf.md"));
        assert!(!glob_match("**/*perf*", "metrics/plain.md"));
    }

    #[test]
    fn rule_matches_tool_and_pattern() {
        let r = ApprovalRule {
            id: "1".to_string(),
            tool: "write_file".to_string(),
            pattern: "**/*.test.ts".to_string(),
            created_at: 0,
        };
        assert!(any_rule_allows(&[r.clone()], "write_file", "/p/src/foo.test.ts"));
        assert!(!any_rule_allows(&[r.clone()], "write_file", "/p/src/foo.spec.ts"));
        // Tool mismatch → no match.
        assert!(!any_rule_allows(&[r.clone()], "delete_file", "/p/src/foo.test.ts"));
    }

    #[test]
    fn rule_empty_tool_matches_any_mutator() {
        let r = ApprovalRule {
            id: "1".to_string(),
            tool: String::new(),
            pattern: "**/dist/*".to_string(),
            created_at: 0,
        };
        assert!(any_rule_allows(&[r.clone()], "write_file", "/p/dist/app.js"));
        assert!(any_rule_allows(&[r], "delete_file", "/p/dist/app.js"));
    }

    #[test]
    fn rule_empty_pattern_matches_any_path() {
        let r = ApprovalRule {
            id: "1".to_string(),
            tool: "edit_file".to_string(),
            pattern: String::new(),
            created_at: 0,
        };
        assert!(any_rule_allows(&[r], "edit_file", "/anything/at/all"));
    }

    #[test]
    fn rule_is_case_insensitive_on_tool() {
        let r = ApprovalRule {
            id: "1".to_string(),
            tool: "Delete_File".to_string(),
            pattern: String::new(),
            created_at: 0,
        };
        assert!(any_rule_allows(&[r], "delete_file", "/p/x"));
    }
}
