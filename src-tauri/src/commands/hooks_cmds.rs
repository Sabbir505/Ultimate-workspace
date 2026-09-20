//! Settings → Hooks IPC: run one configured hook against a synthetic
//! `pre_tool_use` payload (the panel's Test button). Config itself needs no
//! dedicated commands — it rides the generic `get_setting`/`set_setting` pair
//! under the `hooks` key (same pattern as `permissions.rules`).
//!
//! The test goes through the SAME exec-gate trust as live turns, so allowing
//! the native dialog here also trusts the hook for real calls.

use crate::hooks::{self, HookDef, HookTestReport};

/// Run a hook definition against a synthetic write_file payload and report
/// the raw outcome (exit code, streams, parsed decision) for the panel.
#[tauri::command(async)]
pub async fn hooks_test(
    app: tauri::AppHandle,
    def: HookDef,
) -> Result<HookTestReport, String> {
    Ok(hooks::test_hook(&app, &def).await)
}

/// Import command-type hooks from the user's `~/.claude/settings.json` into
/// Relay's hook config (deduped against what's already configured). Claude
/// runs command hooks through a shell; the import wraps each line as
/// `cmd /C <line>` so existing Claude hook scripts work unchanged.
#[tauri::command(async)]
pub async fn hooks_import_claude(
    app: tauri::AppHandle,
) -> Result<crate::hooks::ClaudeImportReport, String> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| "no home directory".to_string())?;
    let path = std::path::Path::new(&home).join(".claude").join("settings.json");
    if !path.exists() {
        return Ok(crate::hooks::ClaudeImportReport {
            imported: Vec::new(),
            skipped_duplicates: 0,
            skipped_non_command: 0,
            file_found: false,
        });
    }
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| format!("read {}: {e}", path.display()))?;
    let existing = crate::hooks::load_config(&app);
    let (mut imported, report) = crate::hooks::parse_claude_hooks(&raw, &existing);
    if !imported.is_empty() {
        let mut next = existing;
        next.append(&mut imported);
        crate::hooks::save_config(&app, &next)?;
    }
    Ok(report)
}
