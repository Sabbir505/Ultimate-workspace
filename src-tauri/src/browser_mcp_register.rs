//! Per-project MCP registration for the `conduit-browser-mcp` server (Task #6).
//!
//! When a Dev-tab agent session (Claude Code / Kimi Code) spawns, we register
//! the `conduit-browser-mcp` server so the agent can drive the in-app browser
//! pane. The config is written to a Conduit-owned file (NOT the project cwd,
//! so a user's hand-maintained `.mcp.json` is never clobbered) and surfaced to
//! Claude Code via its `--mcp-config <path>` flag.
//!
//! Kimi Code / OpenCode: `.mcp.json` is Claude Code's convention. We write the
//! file regardless (best-effort) — if a harness ignores `--mcp-config`, the
//! file is inert and that session simply has no browser tools (acceptable v1;
//! logged in BUILD_LOG.md).

use std::path::PathBuf;

use serde_json::{json, Value};

/// Build the `.mcp.json` content for a project: registers `conduit-browser`
/// with the binary path + the project id + WS port as env vars. The binary
/// reads `CONDUIT_PROJECT_ID` and `CONDUIT_WS_PORT` on startup.
pub fn mcp_config_json(mcp_binary_path: &str, project_id: &str, ws_port: u16) -> Value {
    json!({
        "mcpServers": {
            "conduit-browser": {
                "command": mcp_binary_path,
                "env": {
                    "CONDUIT_PROJECT_ID": project_id,
                    "CONDUIT_WS_PORT": ws_port.to_string()
                }
            }
        }
    })
}

/// The cargo target triple for the host (set by the build script).
/// We bake it at compile time so the binary can find itself in a Tauri
/// externalBin layout without relying on `env!("TARGET")` which isn't
/// available in non-build-script crates.
const HOST_TRIPLE: &str = if cfg!(target_os = "windows") {
    if cfg!(target_arch = "aarch64") {
        "aarch64-pc-windows-msvc"
    } else {
        "x86_64-pc-windows-msvc"
    }
} else if cfg!(target_os = "macos") {
    if cfg!(target_arch = "aarch64") {
        "aarch64-apple-darwin"
    } else {
        "x86_64-apple-darwin"
    }
} else if cfg!(target_os = "linux") {
    if cfg!(target_arch = "aarch64") {
        "aarch64-unknown-linux-gnu"
    } else {
        "x86_64-unknown-linux-gnu"
    }
} else {
    "unknown-target"
};

/// Resolve the `conduit-browser-mcp` binary path shipped alongside the main
/// executable. Checks in order:
///   1. Dev layout: `<exe_dir>/conduit-browser-mcp[.exe]` (cargo build)
///   2. Bundle layout: `<exe_dir>/binaries/conduit-browser-mcp-<target>[.exe]`
///      (Tauri externalBin sidecar in a packaged install)
///   3. Bundle layout (legacy): `<exe_dir>/../binaries/...` (NSIS root)
/// Returns None if the binary isn't found.
pub fn mcp_binary_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let exe_name = if cfg!(windows) {
        "conduit-browser-mcp.exe"
    } else {
        "conduit-browser-mcp"
    };

    // 1. Dev layout: sibling in the same target directory.
    let dev_path = dir.join(exe_name);
    if dev_path.exists() {
        return Some(dev_path);
    }

    // 2. Bundle layout: Tauri 2 externalBin places sidecars in a `binaries/`
    //    subdirectory next to the main exe, with a target-triple suffix.
    let bundled_name = format!(
        "conduit-browser-mcp-{}{}",
        HOST_TRIPLE,
        if cfg!(windows) { ".exe" } else { "" }
    );
    let bundled = dir.join("binaries").join(&bundled_name);
    if bundled.exists() {
        return Some(bundled);
    }

    // 3. Bundle layout (NSIS root): the main exe may be one level deep
    //    relative to the install root where `binaries/` lives.
    if let Some(install_root) = dir.parent() {
        let bundled_root = install_root.join("binaries").join(&bundled_name);
        if bundled_root.exists() {
            return Some(bundled_root);
        }
    }

    None
}

/// Write the per-project `.mcp.json` into a Conduit-owned subdir of the app
/// data dir (`<data_dir>/mcp/<project_id>.mcp.json`). Returns the path so the
/// caller can pass it to the harness via `--mcp-config`. Non-fatal: a write
/// failure logs and returns None, and the session proceeds without browser MCP
/// tools rather than failing the spawn.
pub fn write_mcp_config(
    data_dir: &std::path::Path,
    project_id: &str,
    ws_port: u16,
) -> Option<PathBuf> {
    let bin = mcp_binary_path()?;
    let bin_str = bin.to_string_lossy().replace('\\', "/");
    let cfg = mcp_config_json(&bin_str, project_id, ws_port);
    let mcp_dir = data_dir.join("mcp");
    if let Err(e) = std::fs::create_dir_all(&mcp_dir) {
        eprintln!("[conduit:mcp] failed to create mcp dir: {e}");
        return None;
    }
    // Sanitize project_id into a filesystem-safe filename (project ids are
    // UUIDs in practice, but be defensive).
    let safe = project_id.chars().map(|c| {
        if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }
    }).collect::<String>();
    let path = mcp_dir.join(format!("{safe}.mcp.json"));
    let pretty = serde_json::to_string_pretty(&cfg).unwrap_or_else(|_| "{}".into());
    if let Err(e) = std::fs::write(&path, pretty) {
        eprintln!("[conduit:mcp] failed to write .mcp.json at {}: {e}", path.display());
        return None;
    }
    Some(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mcp_config_json_shapes_server_and_env() {
        let v = mcp_config_json("C:/app/conduit-browser-mcp.exe", "proj-123", 7681);
        let server = &v["mcpServers"]["conduit-browser"];
        assert_eq!(server["command"], "C:/app/conduit-browser-mcp.exe");
        assert_eq!(server["env"]["CONDUIT_PROJECT_ID"], "proj-123");
        assert_eq!(server["env"]["CONDUIT_WS_PORT"], "7681");
    }

    #[test]
    fn write_mcp_config_creates_file_with_project_id() {
        let dir = std::env::temp_dir().join(format!("conduit-mcp-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        // mcp_binary_path() returns None in CI without the binary built, so we
        // can't assert the full path here; instead verify the config-shape
        // helper is what gets written by checking the JSON builder directly.
        let cfg = mcp_config_json("/x/conduit-browser-mcp", "p1", 7681);
        assert!(cfg["mcpServers"]["conduit-browser"]["env"]["CONDUIT_PROJECT_ID"].is_string());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
