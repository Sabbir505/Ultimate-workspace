//! Boot-time sweep for ORPHANED sidecar processes (llama-server,
//! whisper-server, sd-server) left behind by a previous Relay instance.
//!
//! Why this exists: the exit cleanup in `lib.rs` (RunEvent::ExitRequested /
//! Exit) stops every sidecar on a graceful quit, but a dev restart (Ctrl+C on
//! `tauri dev`), a crash, or a taskkill skips that path entirely — and the
//! sidecars are real GPU holders (CUDA contexts + model weights) that then
//! sit there forever. Six orphaned whisper-servers were observed on one
//! machine after a day of dev restarts, each pinning VRAM on a dead port.
//!
//! The sweep runs EARLY in setup — before this instance starts any sidecar
//! of its own — so every matching process it sees belongs to a previous
//! instance. A process is killed only when ALL of these hold:
//!
//! 1. its executable file stem is one of our sidecar names,
//! 2. the executable lives under the app's managed `bin/` dir
//!    (`AppData/<…>/dev.relay.app/bin` — user-set custom sidecar paths are
//!    deliberately NOT matched; they're not ours to kill),
//! 3. its PARENT process no longer exists (the orphan test — a sidecar of a
//!    concurrently running second Relay instance has a live parent and is
//!    spared; parent-PID recycling can false-negative the spare, which is
//!    the safe direction: a stale sidecar survives one more boot and gets
//!    reaped then, while a live one is never killed).

use std::path::Path;

use sysinfo::{ProcessesToUpdate, ProcessRefreshKind, System, UpdateKind};

/// Sidecar binary file stems managed by Relay (matched case-insensitively,
/// with or without the Windows `.exe` suffix — file_stem strips it anyway).
const SIDECAR_STEMS: &[&str] = &["llama-server", "whisper-server", "sd-server"];

/// True when `exe` is a Relay-managed sidecar binary under `bin_root`
/// (both sides already canonicalized by the caller).
fn is_managed_sidecar(exe: &Path, bin_root: &Path) -> bool {
    let Some(stem) = exe.file_stem().and_then(|s| s.to_str()) else {
        return false;
    };
    if !SIDECAR_STEMS.contains(&stem.to_ascii_lowercase().as_str()) {
        return false;
    }
    exe.starts_with(bin_root)
}

/// Kill every orphaned managed sidecar. `bin_root` is the app's canonical
/// `bin` dir. Returns how many processes were killed. Errors are not fatal —
/// a missed sweep just means the old behavior (sidecars linger until the
/// next graceful exit reaps nothing / the user reboots).
pub fn sweep(bin_root: &Path) -> usize {
    let mut sys = System::new();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        false,
        ProcessRefreshKind::new().with_exe(UpdateKind::Always),
    );
    let mut killed = 0usize;
    for (pid, process) in sys.processes() {
        let Some(exe) = process.exe() else { continue };
        let Ok(exe_canon) = exe.canonicalize() else { continue };
        if !is_managed_sidecar(&exe_canon, bin_root) {
            continue;
        }
        // The orphan test: a live parent means another (or our own) instance
        // owns this sidecar — spare it.
        let parent_alive = process
            .parent()
            .map(|pp| sys.process(pp).is_some())
            .unwrap_or(false);
        if parent_alive {
            continue;
        }
        if process.kill() {
            killed += 1;
            eprintln!(
                "[sidecar-sweep] killed orphaned sidecar {} (pid {})",
                exe_canon.display(),
                pid.as_u32()
            );
        }
    }
    killed
}

#[cfg(test)]
mod tests {
    use super::*;

    fn win(path: &str) -> std::path::PathBuf {
        std::path::PathBuf::from(path)
    }

    #[test]
    fn managed_sidecar_matching_is_name_and_root_scoped() {
        let root = win("C:/Users/x/AppData/Roaming/dev.relay.app/bin");
        // Managed: right names under the bin root.
        assert!(is_managed_sidecar(
            &root.join("whisper-cpp-cuda/whisper-server.exe"),
            &root
        ));
        assert!(is_managed_sidecar(
            &root.join("llama-cpp-cuda/llama-server.exe"),
            &root
        ));
        assert!(is_managed_sidecar(&root.join("sd/sd-server.exe"), &root));
        // Right name, OUTSIDE our bin root (user-set custom path) — spared.
        assert!(!is_managed_sidecar(
            &win("D:/tools/llama-server.exe"),
            &root
        ));
        // Under the bin root but NOT a sidecar name (e.g. an updater or
        // helper binary that lives there) — spared.
        assert!(!is_managed_sidecar(&root.join("relay.exe"), &root));
        // Case-insensitive stem match (Windows filesystems).
        assert!(is_managed_sidecar(
            &root.join("x/LLAMA-SERVER.exe"),
            &root
        ));
    }

    #[test]
    fn canonical_prefix_does_not_match_sibling_dirs() {
        let root = win("C:/data/dev.relay.app/bin");
        // A sibling dir sharing a prefix ("bin-backup") must not match —
        // starts_with on components, not bytes.
        assert!(!is_managed_sidecar(
            &win("C:/data/dev.relay.app/bin-backup/llama-server.exe"),
            &root
        ));
    }
}
