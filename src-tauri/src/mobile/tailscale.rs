//! Tailscale integration for the mobile relay: cross-network access without
//! exposing the relay to the LAN.
//!
//! The relay binds 127.0.0.1 (security-first). `tailscale serve` fronts the
//! loopback port with TLS at a stable `https://<machine>.<tailnet>.ts.net`
//! URL, so a phone on any network — same LAN, a hotspot, or across the world
//! — can reach the desktop over the tailnet. This module provides pure
//! helpers for detecting the CLI, parsing status JSON, and building serve
//! subcommands; callers spawn via the existing `resolve_for_spawn` pattern.

use std::process::{Command, Stdio};

use serde::Deserialize;

use crate::harness_adapters::{binary_on_path, resolve_for_spawn, CommandSpec};

/// True when the `tailscale` CLI runs on PATH. Uses the same `--version`
/// probe as the harness detectors (actually executes the binary, not just a
/// file-exists check).
pub fn cli_present() -> bool {
    binary_on_path("tailscale")
}

/// The subset of `tailscale status --json` we care about. Tailscale's JSON
/// shape is large; we only read `Self` (this machine) and the backend state.
#[derive(Debug, Clone, Deserialize)]
struct TailscaleStatusJson {
    #[serde(rename = "BackendState")]
    backend_state: String,
    #[serde(rename = "Self")]
    self_node: Option<StatusNode>,
}

#[derive(Debug, Clone, Deserialize)]
struct StatusNode {
    #[serde(rename = "DNSName")]
    dns_name: Option<String>,
}

/// Aggregated Tailscale status for the settings UI.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TailscaleStatus {
    pub installed: bool,
    pub logged_in: bool,
    pub dns_name: Option<String>,
    pub backend_state: String,
}

/// Run `tailscale status --json` and parse the result. Returns
/// `installed: false` when the CLI is absent or the spawn fails.
pub fn status() -> TailscaleStatus {
    if !cli_present() {
        return TailscaleStatus {
            installed: false,
            logged_in: false,
            dns_name: None,
            backend_state: "not_installed".to_string(),
        };
    }
    let spec = resolve_for_spawn(&CommandSpec::new("tailscale", &["status", "--json"]));
    let mut cmd = Command::new(&spec.program);
    cmd.args(&spec.args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let output = match cmd.output() {
        Ok(o) => o,
        Err(_) => {
            return TailscaleStatus {
                installed: true,
                logged_in: false,
                dns_name: None,
                backend_state: "spawn_failed".to_string(),
            };
        }
    };
    let parsed: TailscaleStatusJson = match serde_json::from_slice(&output.stdout) {
        Ok(s) => s,
        Err(_) => {
            return TailscaleStatus {
                installed: true,
                logged_in: false,
                dns_name: None,
                backend_state: "parse_failed".to_string(),
            };
        }
    };
    let dns = parsed
        .self_node
        .as_ref()
        .and_then(|n| n.dns_name.as_ref())
        .map(|s| s.trim_end_matches('.').to_string());
    let logged_in = parsed.backend_state == "Running";
    TailscaleStatus {
        installed: true,
        logged_in,
        dns_name: dns,
        backend_state: parsed.backend_state,
    }
}

/// Build the `tailscale serve` subcommand for a given loopback port. The
/// resulting URL is `https://<machine>.<tailnet>.ts.net/` — TLS is terminated
/// by tailscaled, traffic to the relay stays on loopback. `--bg` detaches
/// so the spawn returns immediately.
pub fn serve_args(port: u16) -> Vec<String> {
    // `tailscale serve --bg --https=443 http://127.0.0.1:<port>`
    vec![
        "serve".to_string(),
        "--bg".to_string(),
        "--https=443".to_string(),
        format!("http://127.0.0.1:{port}"),
    ]
}

/// Build the `tailscale serve off` subcommand that tears down any serve
/// configuration. Note: `tailscale serve off` is config-wide (removes ALL
/// serve paths on this node), which is acceptable since Conduit is the only
/// serve user on a typical desktop.
pub fn serve_off_args() -> Vec<String> {
    vec!["serve".to_string(), "off".to_string()]
}

/// Returns true when `tailscale serve` is currently active (a non-empty
/// ServeConfig is present). Polling this lets the UI reflect external
/// changes without depending on the persisted DB setting alone.
pub fn serve_active() -> bool {
    if !cli_present() {
        return false;
    }
    match run_tailscale(&["serve".to_string(), "status".to_string(), "--json".to_string()]) {
        Ok(out) => {
            #[derive(serde::Deserialize)]
            struct ServeStatusJson {
                #[serde(rename = "ServeConfig")]
                serve_config: Option<serde_json::Value>,
            }
            match serde_json::from_str::<ServeStatusJson>(&out) {
                Ok(s) => s.serve_config.is_some(),
                Err(_) => false,
            }
        }
        Err(_) => false,
    }
}

/// Spawn `tailscale up` in the background to start the login flow. The CLI
/// opens the default browser automatically (or prints the auth URL) and
/// waits for the user to finish; this call returns immediately so the UI
/// can poll `status()` for the transition to "Running".
pub fn spawn_login() -> Result<(), String> {
    if !cli_present() {
        return Err("tailscale CLI not found on PATH".into());
    }
    let spec = resolve_for_spawn(&CommandSpec::new("tailscale", &["up"]));
    let mut cmd = Command::new(&spec.program);
    cmd.args(&spec.args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.spawn()
        .map_err(|e| format!("failed to spawn tailscale up: {e}"))?;
    Ok(())
}

/// Construct the `wss://` URL the phone should use when serve is active.
/// `dns_name` is the node's tailnet DNS name (e.g. "laptop.tailnet-name.ts.net").
/// A trailing dot (FQDN root) is stripped.
pub fn wss_url(dns_name: &str) -> String {
    let dns = dns_name.trim_end_matches('.');
    format!("wss://{dns}")
}

/// Run a `tailscale` subcommand, returning its stdout as a string. Used by
/// the enable/disable commands. Maps failures to error strings.
pub(crate) fn run_tailscale(args: &[String]) -> Result<String, String> {
    let arg_refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let spec = resolve_for_spawn(&CommandSpec::new("tailscale", &arg_refs));
    let mut cmd = Command::new(&spec.program);
    cmd.args(&spec.args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let output = cmd
        .output()
        .map_err(|e| format!("failed to spawn tailscale: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(format!("tailscale {} failed: {stderr}", args.join(" ")));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serve_args_for_port() {
        let args = serve_args(41362);
        assert_eq!(
            args,
            vec![
                "serve".to_string(),
                "--bg".to_string(),
                "--https=443".to_string(),
                "http://127.0.0.1:41362".to_string(),
            ]
        );
    }

    #[test]
    fn serve_off_args_shape() {
        let args = serve_off_args();
        assert_eq!(args, vec!["serve".to_string(), "off".to_string()]);
    }

    #[test]
    fn wss_url_strips_trailing_dot_from_dns() {
        let url = wss_url("laptop.tailnet-name.ts.net.");
        assert_eq!(url, "wss://laptop.tailnet-name.ts.net");
    }

    #[test]
    fn wss_url_no_dot() {
        let url = wss_url("desktop.tailnet.ts.net");
        assert_eq!(url, "wss://desktop.tailnet.ts.net");
    }

    #[test]
    fn status_parses_running_state_with_dns() {
        let json = br#"{"BackendState":"Running","Self":{"DNSName":"laptop.tailnet.ts.net.","HostName":"laptop","TailscaleIPs":["100.64.0.1"]}}"#;
        let parsed: TailscaleStatusJson = serde_json::from_slice(json).unwrap();
        assert_eq!(parsed.backend_state, "Running");
        assert_eq!(
            parsed.self_node.unwrap().dns_name.as_deref(),
            Some("laptop.tailnet.ts.net.")
        );
    }

    #[test]
    fn status_parses_logged_out_state() {
        let json = br#"{"BackendState":"Stopped","Self":null}"#;
        let parsed: TailscaleStatusJson = serde_json::from_slice(json).unwrap();
        assert_eq!(parsed.backend_state, "Stopped");
        assert!(parsed.self_node.is_none());
    }

    #[test]
    fn status_aggregate_from_running_json() {
        let st = status_from_json(
            br#"{"BackendState":"Running","Self":{"DNSName":"desk.tailnet.ts.net."}}"#,
        );
        assert!(st.installed);
        assert!(st.logged_in);
        assert_eq!(st.dns_name.as_deref(), Some("desk.tailnet.ts.net"));
        assert_eq!(st.backend_state, "Running");
    }

    fn status_from_json(json: &[u8]) -> TailscaleStatus {
        let parsed: TailscaleStatusJson = serde_json::from_slice(json).unwrap();
        let dns = parsed
            .self_node
            .as_ref()
            .and_then(|n| n.dns_name.as_ref())
            .map(|s| s.trim_end_matches('.').to_string());
        let logged_in = parsed.backend_state == "Running";
        TailscaleStatus {
            installed: true,
            logged_in,
            dns_name: dns,
            backend_state: parsed.backend_state,
        }
    }
}
