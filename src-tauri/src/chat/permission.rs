//! Per-session permission posture for filesystem tool calls.
//!
//! This module is the **single** place that decides, for a given chat
//! session's `PermissionMode`, whether a filesystem tool call runs straight
//! away or must pause for a per-action approval card. Every filesystem tool
//! handler routes through [`check_permission`] — the delete-always-gated rule
//! and the read-only exclusion live here, not duplicated across tools.
//!
//! The four modes mirror Claude Code's permission modes and Codex's
//! Suggest/Auto-Edit/Full-Auto modes:
//!
//! | Mode        | Reads | Writes/Edits      | Move/Copy          | Delete           |
//! |-------------|-------|-------------------|--------------------|------------------|
//! | `read_only` | run   | (tool absent)     | (tool absent)      | (tool absent)    |
//! | `manual`    | run   | approve each      | approve each       | approve each     |
//! | `auto_edit` | run   | run in roots      | approve (gated)    | approve (gated)  |
//! | `full_auto` | run   | run in roots      | run in roots       | **approve always**|
//!
//! `read_only` filtering happens earlier (the mutating tools are stripped
//! from the tool schema before the model sees them — see `tools.rs`), so
//! [`check_permission`] only ever runs for tools that are actually present.
//! It is still defensive: a mutating tool reaching it under `read_only`
//! (which shouldn't happen) is treated as `NeedsApproval`, never `AutoRun`.

use serde::{Deserialize, Serialize};

use super::tools::{
    COPY_FILE, DELETE_FILE, EDIT_FILE, LIST_DIRECTORY, MOVE_FILE, READ_FILE, SEARCH_FILES,
    WRITE_FILE,
};

/// A session's default posture for filesystem tool calls. Stored on the
/// `chat_sessions.permission_mode` column (per-session, not global) and read
/// at the start of every tool-enabled turn. New sessions start at `Manual`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionMode {
    /// Filesystem tools restricted to reads (`list_directory`, `read_file`,
    /// `search_files`). Mutating tools are absent from the tool schema.
    ReadOnly,
    /// All filesystem tools available; every mutating action pauses for a
    /// per-action approval card. The default for every new chat session.
    Manual,
    /// Reads and writes/edits within granted roots auto-run; delete, move and
    /// copy still require per-action approval.
    AutoEdit,
    /// Reads, writes, edits, copies and moves within granted roots auto-run.
    /// Delete is STILL gated with a per-action card in this mode — no mode
    /// bypasses the delete gate.
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

    /// The string persisted in the `permission_mode` column.
    pub fn as_db(self) -> &'static str {
        match self {
            PermissionMode::ReadOnly => "read_only",
            PermissionMode::Manual => "manual",
            PermissionMode::AutoEdit => "auto_edit",
            PermissionMode::FullAuto => "full_auto",
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
//     is ALWAYS gated — a hard rule in every mode, mirroring `delete_file`.
//     It is still present in the schema outside `read_only` so the model can
//     propose it, but it never auto-runs.
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
pub fn check_system_permission(mode: PermissionMode, tool: &str) -> PermissionDecision {
    match tool {
        // Tracking/cancelling tools — benign, auto-run in every mode.
        DOWNLOAD_PROGRESS | GET_TASK_STATUS | CANCEL_TASK => PermissionDecision::AutoRun,
        // Subagent delegation — auto-run; it's a model-level sub-turn, not a
        // shell/filesystem action.
        TASK => PermissionDecision::AutoRun,
        // Native shell execution: hard rule — always gated, every mode.
        RUN_SHELL => PermissionDecision::NeedsApproval,
        // Downloads write to disk; follow the connector-write posture.
        DOWNLOAD_FILE => match mode {
            PermissionMode::ReadOnly | PermissionMode::Manual => PermissionDecision::NeedsApproval,
            PermissionMode::AutoEdit | PermissionMode::FullAuto => PermissionDecision::AutoRun,
        },
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
/// Hard rules enforced here (not in UI copy):
/// - **Delete is always gated**, in every mode. No `PermissionMode` value
///   bypasses it. This is the filesystem task's destructive-action carve-out.
/// - **`read_only` never auto-runs a mutating tool** — mutating tools reaching
///   here under read-only is a bug (they should have been filtered from the
///   schema), but it is treated as `NeedsApproval` rather than executing.
/// - Reads (`list_directory` / `read_file` / `search_files`) auto-run in
///   every mode.
pub fn check_permission(
    mode: PermissionMode,
    tool: &str,
    path: &str,
    granted_roots: &[String],
) -> PermissionDecision {
    // Reads always run, in every mode.
    if matches!(tool, LIST_DIRECTORY | READ_FILE | SEARCH_FILES) {
        return PermissionDecision::AutoRun;
    }

    // Delete is ALWAYS gated, regardless of mode — hard rule.
    if tool == DELETE_FILE {
        return PermissionDecision::NeedsApproval;
    }

    // move/copy: gated under read_only/manual/auto_edit (the destructive-ish
    // carve-out). Only full_auto auto-runs them — and only within granted roots.
    if tool == MOVE_FILE || tool == COPY_FILE {
        return match mode {
            PermissionMode::FullAuto => {
                if path_within_granted_roots(path, granted_roots) {
                    PermissionDecision::AutoRun
                } else {
                    PermissionDecision::NeedsApproval
                }
            }
            // read_only / manual / auto_edit all gate move/copy.
            _ => PermissionDecision::NeedsApproval,
        };
    }

    // write_file / edit_file: gated under read_only/manual; auto-run within
    // granted roots under auto_edit and full_auto.
    if is_mutating_fs_tool(tool) {
        return match mode {
            // Mutating tools shouldn't reach here under read-only (they're
            // filtered from the schema), but if one does, never auto-run.
            PermissionMode::ReadOnly => PermissionDecision::NeedsApproval,
            // Manual approves every mutating action.
            PermissionMode::Manual => PermissionDecision::NeedsApproval,
            // Auto-edit / full-auto auto-run writes/edits WITHIN granted
            // roots; outside granted roots, still gate them.
            PermissionMode::AutoEdit | PermissionMode::FullAuto => {
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
    /// connected account. Gated per the session's permission mode: approval
    /// under `read_only`/`manual`, auto-run under `auto_edit`/`full_auto`.
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

/// The connector permission check. Reads auto-run in every mode. Writes follow
/// the session's permission mode — the same posture as filesystem writes:
/// `read_only` never auto-runs (Write tools are also filtered from the schema),
/// `manual` asks for per-action approval, `auto_edit`/`full_auto` auto-run.
pub fn check_connector_permission(
    mode: PermissionMode,
    kind: ConnectorToolKind,
) -> PermissionDecision {
    match kind {
        ConnectorToolKind::Read => PermissionDecision::AutoRun,
        ConnectorToolKind::Write => match mode {
            PermissionMode::ReadOnly | PermissionMode::Manual => {
                PermissionDecision::NeedsApproval
            }
            PermissionMode::AutoEdit | PermissionMode::FullAuto => PermissionDecision::AutoRun,
        },
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

/// Hard scope check: a mutating tool call is only allowed when its target
/// `path` lies within a granted root. Used in addition to the approval gate
/// so that a single approval cannot be re-used (intentionally or by mistake)
/// to write to an arbitrary absolute path. This is the wire that the
/// filesystem task's "granted roots" model needs: without it, `check_permission`
/// only changed approval *defaults*, not what's reachable.
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
    path_within_granted_roots(path, granted_roots)
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
            resolved.pop(); // drop the parent
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
        for mode in [
            PermissionMode::ReadOnly,
            PermissionMode::Manual,
            PermissionMode::AutoEdit,
            PermissionMode::FullAuto,
        ] {
            assert_eq!(
                check_permission(mode, READ_FILE, "C:/projects/alpha/notes.md", &roots()),
                PermissionDecision::AutoRun,
                "read_file should auto-run under {mode:?}"
            );
            assert_eq!(
                check_permission(mode, LIST_DIRECTORY, "C:/projects/alpha", &roots()),
                PermissionDecision::AutoRun,
                "list_directory should auto-run under {mode:?}"
            );
            assert_eq!(
                check_permission(mode, SEARCH_FILES, "C:/projects/alpha", &roots()),
                PermissionDecision::AutoRun,
                "search_files should auto-run under {mode:?}"
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

    #[test]
    fn delete_is_gated_under_full_auto() {
        // The acceptance test: delete_file under full_auto STILL needs approval.
        let d = check_permission(
            PermissionMode::FullAuto,
            DELETE_FILE,
            "C:/projects/alpha/throwaway.txt",
            &roots(),
        );
        assert_eq!(d, PermissionDecision::NeedsApproval);
    }

    #[test]
    fn delete_is_gated_under_every_mode() {
        for mode in [
            PermissionMode::ReadOnly,
            PermissionMode::Manual,
            PermissionMode::AutoEdit,
            PermissionMode::FullAuto,
        ] {
            assert_eq!(
                check_permission(mode, DELETE_FILE, "C:/projects/alpha/x", &roots()),
                PermissionDecision::NeedsApproval,
                "delete must be gated under {mode:?}"
            );
        }
    }

    // ---- manual gates every mutating action ----

    #[test]
    fn manual_gates_writes_edits_moves_copies() {
        for tool in [WRITE_FILE, EDIT_FILE, MOVE_FILE, COPY_FILE] {
            assert_eq!(
                check_permission(
                    PermissionMode::Manual,
                    tool,
                    "C:/projects/alpha/file",
                    &roots()
                ),
                PermissionDecision::NeedsApproval,
                "{tool} should be gated under manual"
            );
        }
    }

    // ---- auto_edit / full_auto auto-run mutating tools within granted roots ----

    #[test]
    fn auto_edit_auto_runs_write_within_granted_root() {
        assert_eq!(
            check_permission(
                PermissionMode::AutoEdit,
                WRITE_FILE,
                "C:/projects/alpha/src/main.rs",
                &roots()
            ),
            PermissionDecision::AutoRun
        );
        assert_eq!(
            check_permission(
                PermissionMode::FullAuto,
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
                PermissionMode::AutoEdit,
                WRITE_FILE,
                "C:/elsewhere/secret.txt",
                &roots()
            ),
            PermissionDecision::NeedsApproval
        );
        // Even full_auto gates a write OUTSIDE granted roots — the selector
        // only relaxes the default WITHIN already-granted roots; it never
        // expands what's reachable at all.
        assert_eq!(
            check_permission(
                PermissionMode::FullAuto,
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
                PermissionMode::ReadOnly,
                WRITE_FILE,
                "C:/projects/alpha/file",
                &roots()
            ),
            PermissionDecision::NeedsApproval
        );
        assert_eq!(
            check_permission(
                PermissionMode::ReadOnly,
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
        for mode in [
            PermissionMode::ReadOnly,
            PermissionMode::Manual,
            PermissionMode::AutoEdit,
            PermissionMode::FullAuto,
        ] {
            assert_eq!(PermissionMode::from_db(mode.as_db()), mode);
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
        // and full_auto auto-run them (the account is already connected).
        for mode in [PermissionMode::ReadOnly, PermissionMode::Manual] {
            assert_eq!(
                check_connector_permission(mode, ConnectorToolKind::Write),
                PermissionDecision::NeedsApproval,
                "connector write must be gated under {mode:?}"
            );
        }
        for mode in [PermissionMode::AutoEdit, PermissionMode::FullAuto] {
            assert_eq!(
                check_connector_permission(mode, ConnectorToolKind::Write),
                PermissionDecision::AutoRun,
                "connector write should auto-run under {mode:?}"
            );
        }
    }

    #[test]
    fn connector_read_auto_runs_in_every_mode() {
        // A "search my Notion for X" runs without friction in every mode.
        for mode in [
            PermissionMode::ReadOnly,
            PermissionMode::Manual,
            PermissionMode::AutoEdit,
            PermissionMode::FullAuto,
        ] {
            assert_eq!(
                check_connector_permission(mode, ConnectorToolKind::Read),
                PermissionDecision::AutoRun,
                "connector read should auto-run under {mode:?}"
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
                    PermissionMode::AutoEdit,
                    tool,
                    "C:/projects/alpha/file",
                    &roots()
                ),
                PermissionDecision::NeedsApproval,
                "{tool} should be gated under auto_edit"
            );
        }
        // But full_auto auto-runs move/copy within granted roots (delete stays gated).
        for tool in [MOVE_FILE, COPY_FILE] {
            assert_eq!(
                check_permission(
                    PermissionMode::FullAuto,
                    tool,
                    "C:/projects/alpha/file",
                    &roots()
                ),
                PermissionDecision::AutoRun,
                "{tool} should auto-run under full_auto within roots"
            );
        }
    }

    // ---- system tools (downloads + native shell) ----

    #[test]
    fn run_shell_always_gated_in_every_mode() {
        // Native code execution is a hard gate like delete_file — no mode
        // bypasses the approval card.
        for mode in [
            PermissionMode::ReadOnly,
            PermissionMode::Manual,
            PermissionMode::AutoEdit,
            PermissionMode::FullAuto,
        ] {
            assert_eq!(
                check_system_permission(mode, RUN_SHELL),
                PermissionDecision::NeedsApproval,
                "run_shell must be gated under {mode:?}"
            );
        }
    }

    #[test]
    fn download_file_follows_connector_write_posture() {
        // Approval under read_only/manual; auto-run under auto_edit/full_auto
        // (no granted-root scope — unrestricted filesystem access is the point).
        for mode in [PermissionMode::ReadOnly, PermissionMode::Manual] {
            assert_eq!(
                check_system_permission(mode, DOWNLOAD_FILE),
                PermissionDecision::NeedsApproval,
                "download_file must be gated under {mode:?}"
            );
        }
        for mode in [PermissionMode::AutoEdit, PermissionMode::FullAuto] {
            assert_eq!(
                check_system_permission(mode, DOWNLOAD_FILE),
                PermissionDecision::AutoRun,
                "download_file should auto-run under {mode:?}"
            );
        }
    }

    #[test]
    fn task_tracking_tools_auto_run_in_every_mode() {
        // download_progress / get_task_status / cancel_task are benign — they
        // only inspect or abort tasks the model itself started.
        for mode in [
            PermissionMode::ReadOnly,
            PermissionMode::Manual,
            PermissionMode::AutoEdit,
            PermissionMode::FullAuto,
        ] {
            for tool in [DOWNLOAD_PROGRESS, GET_TASK_STATUS, CANCEL_TASK] {
                assert_eq!(
                    check_system_permission(mode, tool),
                    PermissionDecision::AutoRun,
                    "{tool} should auto-run under {mode:?}"
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
}
