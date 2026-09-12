//! harness bundle/context resolution (opencode config, gallery servers, context sections) — extracted carve of agent_sessions (see
//! mod.rs). `use super::*` inherits the parent's imports and private
//! helpers; items are pub(super) and glob-reimported by the parent.
use super::*;
/// Same as pty_cmds' browser-only `.mcp.json`, but OpenCode-format: opencode
/// has no `--mcp-config` flag — it reads MCP servers from an opencode.json
/// "mcp" section, pointed at via the OPENCODE_CONFIG env var on the spawn.
/// Legacy fallback for per-turn spawns when the full bundle failed to write.

pub(super) fn resolve_opencode_config(
    app: &AppHandle,
    project_id: Option<&str>,
) -> Option<std::path::PathBuf> {
    let data_dir = crate::user_dirs::app_data_dir(app);
    browser_mcp_register::write_opencode_config(&data_dir, project_id?, bound_port())
}

/// The artifacts dir the bundle should advertise: the configured
/// `storage.artifactsDir`, else the Documents/Relay default. This is where
/// the relay-tools MCP actually writes generated documents (`mcp_tools_bridge`
/// resolves `dispatch::artifacts_dir`), so the instructions, `--add-dir`, and
/// the claude settings' additionalDirectories must all name the SAME folder —
/// advertising the spawn dir instead sent harness CLIs writing with their own
/// file tools into the project root while relay-tools landed in the
/// configured dir. The spawn dir (`spawn_dir`) remains a separate concept: it
/// is only the CLI's working directory, never the advertised artifacts target.
pub(crate) fn artifacts_dir_for_bundle(app: &AppHandle, _cwd: Option<&str>) -> String {
    crate::chat::dispatch::artifacts_dir(app)
        .to_string_lossy()
        .into_owned()
}

/// Harness label used in the per-turn persona ("running on the … engine").
pub(super) fn harness_label(harness: &str) -> &str {
    match harness {
        "claude_code" => "Claude Code",
        "kimi_code" => "Kimi Code",
        "opencode" => "OpenCode",
        other => other,
    }
}

/// Adapters that have NO system-prompt flag for the bundle instructions:
/// claude gets `--append-system-prompt-file` and kimi `--agent-file`, but
/// OpenCode/pi/omp/commandcode read only the turn text — so the instructions
/// must ride the first turn's prompt instead (see the send path).
pub(super) fn harness_needs_prompt_instructions(harness: &str) -> bool {
    matches!(harness, "opencode" | "pi" | "omp" | "commandcode")
}

/// Installed Relay MCP-gallery servers (enabled only) as bundle entries.
/// The CLI spawns these stdio processes itself — Relay just translates the
/// persisted defs, so there is no session/process management on our side.
pub(super) fn gallery_servers_for_bundle(app: &AppHandle) -> Vec<crate::harness_bundle::GalleryMcpServer> {
    crate::mcp_gallery::load_defs(app)
        .into_iter()
        .filter(|d| d.enabled && !d.command.trim().is_empty())
        .map(|d| crate::harness_bundle::GalleryMcpServer {
            name: d.id,
            command: d.command,
            args: d.args,
            env: d.env,
        })
        .collect()
}

/// Additive context sections for the harness instructions — the static
/// equivalent of what the built-in chat assembles per turn: the connector/MCP
/// manifest (the CLIs have no attach tool, so this is informational) and the
/// standing memory identity core (on-demand loading is a per-turn job the
/// static bundle can't do). DB errors degrade to fewer sections; never fail
/// the bundle.
pub(super) fn harness_context_section(
    app: &AppHandle,
    project_id: Option<&str>,
    connectors: &[crate::connectors::HarnessMcpServer],
    gallery: &[crate::harness_bundle::GalleryMcpServer],
) -> String {
    let attached: Vec<String> = connectors.iter().map(|c| c.name.clone()).collect();
    let gallery_names: Vec<String> = gallery.iter().map(|g| g.name.clone()).collect();
    let mut parts: Vec<String> = Vec::new();
    let mcp = crate::harness_bundle::build_mcp_context_section(&attached, &gallery_names);
    if !mcp.is_empty() {
        parts.push(mcp);
    }
    if let Some(db) = app.try_state::<DbState>() {
        let conn = db.0.lock();
        if crate::memory::memory_enabled(&conn) {
            // Static bundle → no per-turn query, so this carries the
            // standing identity core (or the stored document when no core
            // facts qualify — see on_demand_injection); the harness CLIs
            // load more via their own memory channels/tools.
            if let Some(rendered) = crate::memory::on_demand_injection(
                &conn,
                None,
                project_id,
                crate::db::now_ts(),
                false,
            ) {
                if !rendered.trim().is_empty() {
                    parts.push(rendered);
                }
            }
        }
    }
    parts.join("\n\n")
}

/// Bundle slug for sessions with no selected project. Connectors and
/// relay-tools work project-less too, so a bundle is always written; the
/// tradeoff is that browser panes and artifacts of ALL project-less sessions
/// share this one scope.
pub(super) const NO_PROJECT_BUNDLE_SLUG: &str = "_no_project";

/// Resolve (write if needed) the per-project harness bundle. Project-less
/// sessions fall back to the `_no_project` slug so connectors + relay-tools
/// still reach the CLI. Returns None only when the app data dir or the write
/// fails — bundle failure must never fail the turn (same contract as the old
/// resolve_mcp_config). `connectors` are merged into the bundle's MCP configs
/// as remote servers (tokens already refreshed by the command layer).
/// Enabled MCP-gallery servers ride along as stdio entries the CLI spawns
/// itself. Shared by the headless chat paths here and the interactive PTY
/// spawn in `commands::pty_cmds`.
pub(crate) fn resolve_harness_bundle(
    app: &AppHandle,
    project_id: Option<&str>,
    cwd: Option<&str>,
    artifacts_dir: String,
    connectors: &[crate::connectors::HarnessMcpServer],
    sandbox: Option<&str>,
    approval: Option<&str>,
) -> Option<crate::harness_bundle::HarnessBundlePaths> {
    let data_dir = crate::user_dirs::app_data_dir(app);
    // Artifact awareness for the harness instructions: the CLI has no other
    // way to learn where Relay's artifacts live, so "open the report we made"
    // used to resolve to a shrug. Default export folder + the 10 most recent
    // artifacts (newest first, from the DB).
    let default_export_dir = crate::chat::dispatch::artifacts_dir(app)
        .to_string_lossy()
        .into_owned();
    let recent: Vec<String> = app
        .try_state::<DbState>()
        .map(|db| {
            let conn = db.0.lock();
            crate::db::list_artifacts(&conn)
                .unwrap_or_default()
                .iter()
                .take(10)
                .filter_map(|a| {
                    let date = chrono::DateTime::from_timestamp(a.created_at, 0)
                        .map(|d| d.format("%Y-%m-%d").to_string())
                        .unwrap_or_default();
                    Some(format!("- {} ({}, {})", a.filename, a.kind, date))
                })
                .collect()
        })
        .unwrap_or_default();
    let artifacts_section =
        crate::harness_bundle::build_artifacts_section(&default_export_dir, &recent);
    let gallery = gallery_servers_for_bundle(app);
    let context_section = harness_context_section(app, project_id, connectors, &gallery);
    crate::harness_bundle::write_bundle(
        &data_dir,
        project_id.unwrap_or(NO_PROJECT_BUNDLE_SLUG),
        cwd,
        Some(artifacts_dir.as_str()),
        sandbox,
        approval,
        crate::browser_mcp::bound_port(),
        connectors,
        &gallery,
        &artifacts_section,
        &context_section,
    )
}
