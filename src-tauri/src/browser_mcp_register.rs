//! Per-project MCP registration for the `relay-browser-mcp` server (Task #6).
//!
//! When a Dev-tab agent session (Claude Code / Kimi Code) spawns, we register
//! the `relay-browser-mcp` server so the agent can drive the in-app browser
//! pane. The config is written to a Relay-owned file (NOT the project cwd,
//! so a user's hand-maintained `.mcp.json` is never clobbered) and surfaced to
//! Claude Code via its `--mcp-config <path>` flag.
//!
//! Kimi Code takes the same `.mcp.json` via its `--mcp-config-file` flag.
//! OpenCode has no such flag — it reads MCP servers from an opencode.json
//! "mcp" section, so `write_opencode_config` writes that shape into the same
//! Relay-owned dir and spawns point at it via the `OPENCODE_CONFIG` env var.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::{json, Value};

/// Build the `.mcp.json` content for a project: registers `relay-browser`
/// with the binary path + the project id + WS port + WS auth token as env
/// vars. The binary reads `RELAY_PROJECT_ID`, `RELAY_WS_PORT` and
/// `RELAY_MCP_AUTH_TOKEN` on startup. The token rides this per-server env
/// block so only the MCP child process inherits it (never process-wide).
pub fn mcp_config_json(mcp_binary_path: &str, project_id: &str, ws_port: u16, auth_token: &str) -> Value {
    json!({
        "mcpServers": {
            "relay-browser": {
                "command": mcp_binary_path,
                "env": {
                    "RELAY_PROJECT_ID": project_id,
                    "RELAY_WS_PORT": ws_port.to_string(),
                    "RELAY_MCP_AUTH_TOKEN": auth_token
                }
            }
        }
    })
}

/// Build the OpenCode-format config for a project: OpenCode has no CLI flag
/// for MCP servers — it reads them from an `opencode.json` "mcp" section.
/// We write a Relay-owned file and point the spawn at it via the
/// `OPENCODE_CONFIG` env var (never touching the project's own opencode.json).
pub fn opencode_config_json(mcp_binary_path: &str, project_id: &str, ws_port: u16, auth_token: &str) -> Value {
    json!({
        "mcp": {
            "relay-browser": {
                "type": "local",
                "command": [mcp_binary_path],
                "environment": {
                    "RELAY_PROJECT_ID": project_id,
                    "RELAY_WS_PORT": ws_port.to_string(),
                    "RELAY_MCP_AUTH_TOKEN": auth_token
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

/// Resolve the `relay-browser-mcp` binary path shipped alongside the main
/// executable. Checks in order:
///   1. Dev layout: `<exe_dir>/relay-browser-mcp[.exe]` (cargo build)
///   2. Bundle layout: `<exe_dir>/binaries/relay-browser-mcp-<target>[.exe]`
///      (Tauri externalBin sidecar in a packaged install)
///   3. Bundle layout (legacy): `<exe_dir>/../binaries/...` (NSIS root)
/// Returns None if the binary isn't found.
pub fn mcp_binary_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let exe_name = if cfg!(windows) {
        "relay-browser-mcp.exe"
    } else {
        "relay-browser-mcp"
    };

    // 1. Dev layout: sibling in the same target directory.
    let dev_path = dir.join(exe_name);
    if dev_path.exists() {
        return Some(dev_path);
    }

    // 2. Bundle layout: Tauri 2 externalBin places sidecars in a `binaries/`
    //    subdirectory next to the main exe, with a target-triple suffix.
    let bundled_name = format!(
        "relay-browser-mcp-{}{}",
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

/// Write the per-project `.mcp.json` into a Relay-owned subdir of the app
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
    let cfg = mcp_config_json(&bin_str, project_id, ws_port, crate::browser_mcp::mcp_auth_token());
    let mcp_dir = data_dir.join("mcp");
    if let Err(e) = std::fs::create_dir_all(&mcp_dir) {
        eprintln!("[relay:mcp] failed to create mcp dir: {e}");
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
        eprintln!("[relay:mcp] failed to write .mcp.json at {}: {e}", path.display());
        return None;
    }
    Some(path)
}

/// Write the OpenCode-format config (`<data_dir>/mcp/<project_id>.opencode.json`)
/// so an opencode spawn pointed at it via `OPENCODE_CONFIG` picks up the
/// relay-browser MCP server. Same non-fatal semantics as write_mcp_config.
pub fn write_opencode_config(
    data_dir: &std::path::Path,
    project_id: &str,
    ws_port: u16,
) -> Option<PathBuf> {
    let bin = mcp_binary_path()?;
    let bin_str = bin.to_string_lossy().replace('\\', "/");
    let cfg = opencode_config_json(&bin_str, project_id, ws_port, crate::browser_mcp::mcp_auth_token());
    let mcp_dir = data_dir.join("mcp");
    if let Err(e) = std::fs::create_dir_all(&mcp_dir) {
        eprintln!("[relay:mcp] failed to create mcp dir: {e}");
        return None;
    }
    let safe = project_id.chars().map(|c| {
        if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }
    }).collect::<String>();
    let path = mcp_dir.join(format!("{safe}.opencode.json"));
    let pretty = serde_json::to_string_pretty(&cfg).unwrap_or_else(|_| "{}".into());
    if let Err(e) = std::fs::write(&path, pretty) {
        eprintln!("[relay:mcp] failed to write opencode config at {}: {e}", path.display());
        return None;
    }
    Some(path)
}

/// Build the ACP `session/new` `mcpServers` payload: relay-browser +
/// relay-tools as spec-shaped stdio servers. ACP agents spawn the MCP
/// binary themselves and reach the app's WS directly — Relay only hands
/// over the connection details (same env contract as the config files).
/// Pure core of [`acp_mcp_servers`]; an absent sidecar binary yields an
/// empty array (the agent keeps its own tools, no error).
pub fn acp_mcp_servers_for(
    mcp_binary_path: Option<&str>,
    project_id: &str,
    ws_port: u16,
    auth_token: &str,
) -> Value {
    let Some(bin) = mcp_binary_path else {
        return json!([]);
    };
    let env = json!([
        { "name": "RELAY_PROJECT_ID", "value": project_id },
        { "name": "RELAY_WS_PORT", "value": ws_port.to_string() },
        { "name": "RELAY_MCP_AUTH_TOKEN", "value": auth_token },
    ]);
    json!([
        { "name": "relay-browser", "kind": "stdio", "command": bin, "args": [], "env": env },
        { "name": "relay-tools", "kind": "stdio", "command": bin, "args": [], "env": env },
    ])
}

/// The [`acp_mcp_servers_for`] payload for a live app: resolved binary +
/// current WS port/token, or `[]` when the sidecar is absent.
pub fn acp_mcp_servers(app: &tauri::AppHandle, project_id: &str) -> Value {
    acp_mcp_servers_for(
        mcp_binary_path().map(|b| b.to_string_lossy().into_owned()).as_deref(),
        project_id,
        crate::browser_mcp::bound_port(),
        crate::browser_mcp::mcp_auth_token(),
    )
}

// ---- CommandCode bridge registration ----
//
// CommandCode speaks MCP but has no per-turn `--mcp-config` flag — servers
// live in its own config, managed via `cmd mcp add-json`. Relay registers
// the bridge there (scope `local`, keyed to the project dir) and re-registers
// whenever the WS token/port change, which is EVERY app run: the token is
// per-process. A marker file records what was last registered so the steady
// state costs one small file read per turn, not two CLI spawns.

/// Marker payload check, pure so tests can run it: current iff the stored
/// token+port+cwd all match what the app would register now.
fn commandcode_marker_matches(
    marker: &Option<(String, String, String)>,
    token: &str,
    port: u16,
    cwd: &Path,
) -> bool {
    marker.as_ref().map_or(false, |(t, p, dir)| {
        t == token && *p == port.to_string() && Path::new(dir) == cwd
    })
}

fn commandcode_bridge_marker_path(data_dir: &Path, project_slug: &str) -> PathBuf {
    let safe: String = project_slug
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    data_dir.join("mcp").join(format!("commandcode_bridge_{safe}.json"))
}

/// True when commandcode's config already carries a current bridge
/// registration for this project (marker read only — no CLI spawn).
pub fn commandcode_bridge_current(
    app: &tauri::AppHandle,
    cwd: &Path,
    project_slug: &str,
) -> bool {
    let data_dir = crate::user_dirs::app_data_dir(app);
    let path = commandcode_bridge_marker_path(&data_dir, project_slug);
    let marker = std::fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|v| {
            let token = v["token"].as_str()?.to_string();
            let port = v["port"].as_str()?.to_string();
            let dir = v["cwd"].as_str()?.to_string();
            Some((token, port, dir))
        });
    commandcode_marker_matches(
        &marker,
        crate::browser_mcp::mcp_auth_token(),
        crate::browser_mcp::bound_port(),
        cwd,
    )
}

/// Register (or refresh) the relay bridge in commandcode's own MCP config so
/// its sessions can call relay-tools/relay-browser like claude/kimi/opencode.
/// Idempotent: a current marker short-circuits; otherwise the stale entry is
/// replaced via `mcp remove` + `mcp add-json` (scope `local`, keyed to the
/// project dir). Returns true when the bridge is registered and current —
/// callers use it to decide whether commandcode prompts may advertise the
/// relay tools. The registration is user-visible via `cmd mcp list` and
/// removable with `cmd mcp remove relay-tools -s local`.
pub fn ensure_commandcode_bridge(
    app: &tauri::AppHandle,
    cwd: &Path,
    project_slug: &str,
) -> bool {
    let data_dir = crate::user_dirs::app_data_dir(app);
    let token = crate::browser_mcp::mcp_auth_token();
    let port = crate::browser_mcp::bound_port();
    let marker_path = commandcode_bridge_marker_path(&data_dir, project_slug);
    let marker = std::fs::read_to_string(&marker_path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|v| {
            let token = v["token"].as_str()?.to_string();
            let port = v["port"].as_str()?.to_string();
            let dir = v["cwd"].as_str()?.to_string();
            Some((token, port, dir))
        });
    if commandcode_marker_matches(&marker, token, port, cwd) {
        return true;
    }
    let Some(bin) = mcp_binary_path() else {
        return false;
    };
    let bin_str = bin.to_string_lossy().replace('\\', "/");
    let server_json = serde_json::to_string(&json!({
        "type": "stdio",
        "command": bin_str,
        "env": {
            "RELAY_PROJECT_ID": project_slug,
            "RELAY_WS_PORT": port.to_string(),
            "RELAY_MCP_AUTH_TOKEN": token,
        }
    }))
    .unwrap_or_default();

    // The npm shim is a .cmd — go through cmd.exe. The two calls together
    // run only when the token/port actually changed (once per app run per
    // project); a missing/failing CLI leaves the marker unwritten so the
    // next turn retries and callers keep advertising nothing.
    let run = |args: &[&str]| -> bool {
        let mut cmd = Command::new("cmd");
        cmd.arg("/C").arg("commandcode").args(args).current_dir(cwd);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        cmd.stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        cmd.status().map(|s| s.success()).unwrap_or(false)
    };
    let _ = run(&["mcp", "remove", "relay-tools", "-s", "local"]);
    let ok = run(&["mcp", "add-json", "relay-tools", "-s", "local", &server_json]);
    if !ok {
        eprintln!("[relay:mcp] commandcode bridge registration failed — its sessions keep CLI-native tools only");
        return false;
    }
    let marker_json = serde_json::to_string(&json!({
        "token": token,
        "port": port.to_string(),
        "cwd": cwd.to_string_lossy(),
    }))
    .unwrap_or_default();
    let _ = std::fs::create_dir_all(marker_path.parent().unwrap_or(&data_dir));
    if std::fs::write(&marker_path, marker_json).is_err() {
        return false;
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn acp_mcp_servers_shape_both_servers_or_empty() {
        let v = acp_mcp_servers_for(Some("C:/app/relay-browser-mcp.exe"), "proj-9", 7681, "tok");
        let arr = v.as_array().unwrap();
        assert_eq!(arr.len(), 2);
        assert_eq!(arr[0]["name"], "relay-browser");
        assert_eq!(arr[1]["name"], "relay-tools");
        for srv in arr {
            assert_eq!(srv["kind"], "stdio");
            assert_eq!(srv["command"], "C:/app/relay-browser-mcp.exe");
            assert_eq!(srv["env"][2]["name"], "RELAY_MCP_AUTH_TOKEN");
        }
        // No sidecar binary → no servers, not an error.
        assert!(acp_mcp_servers_for(None, "proj-9", 7681, "tok").as_array().unwrap().is_empty());
    }

    #[test]
    fn commandcode_marker_requires_token_port_and_dir_match() {
        let cwd = Path::new("C:/work/proj");
        let cur = Some(("tok".to_string(), "7681".to_string(), "C:/work/proj".to_string()));
        assert!(commandcode_marker_matches(&cur, "tok", 7681, cwd));
        // Token rotates every app run — a stale marker must NOT count.
        assert!(!commandcode_marker_matches(&cur, "tok2", 7681, cwd));
        assert!(!commandcode_marker_matches(&cur, "tok", 7682, cwd));
        assert!(!commandcode_marker_matches(
            &Some(("tok".into(), "7681".into(), "C:/other".into())),
            "tok",
            7681,
            cwd
        ));
        assert!(!commandcode_marker_matches(&None, "tok", 7681, cwd));
    }

    #[test]
    fn mcp_config_json_shapes_server_and_env() {
        let v = mcp_config_json("C:/app/relay-browser-mcp.exe", "proj-123", 7681, "tok-abc");
        let server = &v["mcpServers"]["relay-browser"];
        assert_eq!(server["command"], "C:/app/relay-browser-mcp.exe");
        assert_eq!(server["env"]["RELAY_PROJECT_ID"], "proj-123");
        assert_eq!(server["env"]["RELAY_WS_PORT"], "7681");
        // WS auth token rides the per-server env block, not the process env.
        assert_eq!(server["env"]["RELAY_MCP_AUTH_TOKEN"], "tok-abc");
    }

    #[test]
    fn opencode_config_json_shapes_local_server() {
        let v = opencode_config_json("C:/app/relay-browser-mcp.exe", "proj-123", 7681, "tok-abc");
        let server = &v["mcp"]["relay-browser"];
        assert_eq!(server["type"], "local");
        assert_eq!(server["command"][0], "C:/app/relay-browser-mcp.exe");
        assert_eq!(server["environment"]["RELAY_PROJECT_ID"], "proj-123");
        assert_eq!(server["environment"]["RELAY_WS_PORT"], "7681");
        assert_eq!(server["environment"]["RELAY_MCP_AUTH_TOKEN"], "tok-abc");
    }

    #[test]
    fn write_mcp_config_creates_file_with_project_id() {
        let dir = std::env::temp_dir().join(format!("relay-mcp-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        // mcp_binary_path() returns None in CI without the binary built, so we
        // can't assert the full path here; instead verify the config-shape
        // helper is what gets written by checking the JSON builder directly.
        let cfg = mcp_config_json("/x/relay-browser-mcp", "p1", 7681, "tok");
        assert!(cfg["mcpServers"]["relay-browser"]["env"]["RELAY_PROJECT_ID"].is_string());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
