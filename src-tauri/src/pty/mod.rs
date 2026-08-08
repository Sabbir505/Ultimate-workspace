//! Pty lifecycle management (PRD §6.5, CONTRACT.md "PTY" + "Events").
//!
//! Pane lifecycle rules, restated because they are the decisions most likely
//! to be "simplified" incorrectly later:
//! - A pane's process is killed ONLY on explicit close (`kill_pty`) or app
//!   quit — never on blur/unfocus. Parallel unfocused panes staying alive is
//!   the whole point of the product.
//! - Resume-by-id: sessions persist on disk inside the harness, so a closed
//!   pane is cheap to resurrect via `claude --resume <id>` / `kimi -r <id>`.
//! - On app relaunch nothing auto-respawns (no surprise cost/resource spend).
//!
//! Each pane gets: a writer thread (mpsc channel -> pty stdin), a reader
//! thread (pty stdout -> `pty:output` events + transcript/scraping), and a
//! waiter thread (polls `try_wait` -> `pty:exit`). A single monitor thread
//! drives the working -> waiting/diff_ready silence heuristic for all panes.

use std::collections::HashMap;
use std::collections::HashSet;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::{Duration, Instant, SystemTime};

use parking_lot::Mutex;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use rusqlite::Connection;
use tauri::{AppHandle, Emitter};

use crate::db;
use crate::harness_adapters::{CommandSpec, HarnessAdapter, UsageInfo};
use crate::types::{BrowserUrlDetectedEvent, CostUpdatedEvent, PtyExitEvent, PtyOutputEvent, PtyStateEvent, SessionHarnessIdEvent};

/// True only for URLs that point at a local dev server / preview, which are the
/// only URLs allowed to auto-navigate the built-in browser pane. This keeps
/// arbitrary remote URLs printed by CLIs (git remotes, docs, GitHub links) from
/// hijacking the browser — those stay as plain terminal text.
fn is_local_dev_url(url: &str) -> bool {
    // Strip scheme, then take the host portion up to the first '/', ':', or end.
    let after_scheme = url
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(url);
    let authority = after_scheme
        .split(['/', '?', '#'])
        .next()
        .unwrap_or("");
    // Drop userinfo and port; handle bracketed IPv6 like [::1]:5173.
    let host = authority.rsplit('@').next().unwrap_or(authority);
    let host = if let Some(end) = host.strip_prefix('[').and_then(|h| h.split_once(']')) {
        end.0
    } else {
        host.split(':').next().unwrap_or(host)
    };
    let host = host.to_ascii_lowercase();
    host == "localhost"
        || host == "0.0.0.0"
        || host == "::1"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        // 127/8 is loopback — but only on a strict IPv4 parse: a bare
        // `starts_with("127.")` also matches valid PUBLIC DNS names like
        // `127.evil.com`, which would auto-open an arbitrary remote site.
        // Rust's parser rejects hex/octal/integer shorthand, so those
        // obfuscated forms fail closed here too.
        || host
            .parse::<std::net::Ipv4Addr>()
            .map(|ip| ip.octets()[0] == 127)
            .unwrap_or(false)
}

/// Rolling stripped transcript cap per pane (CONTRACT.md: ~1MB). Used for
/// `export_session_markdown`.
const TRANSCRIPT_CAP: usize = 1024 * 1024;
/// How much recent stripped output pattern matchers get to see. Session-id /
/// diff-prompt hints can straddle read chunk boundaries, so matching runs
/// against this tail instead of individual chunks.
const TAIL_LEN: usize = 4096;
/// Scrollback kept by each pane's vt100 screen model (used for phone display).
const SCREEN_SCROLLBACK: usize = 400;
/// How many lines of scrollback above the live screen a phone snapshot
/// includes. Screenfuls tile exactly, so this rounds down to whole screens.
const PHONE_HISTORY_ROWS: usize = 150;
/// Silence after output activity that flips a pane from working -> waiting
/// (or diff_ready). 1.5s per CONTRACT.md `pty:state` docs.
const SILENCE_BEFORE_WAITING: Duration = Duration::from_millis(1500);
/// How long after spawn we keep polling Claude's session-file dir for the
/// id-capture fallback. Two minutes covers slow first-run auth flows; the
/// polling is cheap (one read_dir per second per unbound Claude pane).
const CLAUDE_PROBE_WINDOW: Duration = Duration::from_secs(120);

type SharedDb = Arc<Mutex<Connection>>;

pub struct Pane {
    id: String,
    /// Conduit session id (None for shell/quick-action/login panes).
    session_id: Option<String>,
    /// None for plain shell panes (no scraping, but the state heuristic still runs).
    adapter: Option<Arc<dyn HarnessAdapter>>,
    cwd: PathBuf,
    writer_tx: Mutex<Option<mpsc::Sender<Vec<u8>>>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    /// ANSI-stripped rolling transcript for export. Raw output (with escape
    /// codes) goes to the frontend; this stripped copy is for parsing/export.
    transcript: Mutex<String>,
    /// Virtual terminal screen fed the raw output stream. The phone app polls
    /// a rendered snapshot of this (TUI apps redraw via cursor-movement
    /// sequences, which are unreadable when the raw stream is concatenated).
    screen: Mutex<vt100::Parser>,
    /// Last ~4KB of stripped output for pattern matching.
    tail: Mutex<String>,
    state: Mutex<&'static str>,
    last_output_at: Mutex<Instant>,
    spawned_at: Instant,
    spawned_at_system: SystemTime,
    exited: AtomicBool,
    killed: AtomicBool,
    harness_id_reported: AtomicBool,
    /// The harness's own session id once known (from output scraping, the
    /// fs probe, or the session record when a pane is a resume). Drives the
    /// on-disk usage sync for the cost dashboard.
    harness_session_id: Mutex<Option<String>>,
    last_claude_probe: Mutex<Instant>,
    /// Last time we synced usage from the harness's on-disk session log.
    last_usage_sync: Mutex<Instant>,
    /// Deduplication guard: harness TUIs redraw usage lines constantly, and
    /// re-writing identical cost events would flood cost_events. We only
    /// insert when the parsed usage actually changes.
    last_usage: Mutex<Option<UsageInfo>>,
}

impl Pane {
    /// The spawned child's OS process id, if still resolvable. Used by the
    /// dev-mode memory counter (`pane_memory`) to look up the process's RSS
    /// via sysinfo. Returns None for panes whose child has already exited.
    pub fn pid(&self) -> Option<u32> {
        self.child.lock().process_id()
    }

    fn append_stripped(&self, text: &str) {
        {
            let mut t = self.transcript.lock();
            t.push_str(text);
            if t.len() > TRANSCRIPT_CAP {
                // Drop the oldest quarter on a char boundary.
                let mut start = t.len() - (TRANSCRIPT_CAP * 3 / 4);
                while !t.is_char_boundary(start) {
                    start += 1;
                }
                t.drain(..start);
            }
        }
        let mut tail = self.tail.lock();
        tail.push_str(text);
        if tail.len() > TAIL_LEN {
            let mut start = tail.len() - TAIL_LEN;
            while !tail.is_char_boundary(start) {
                start += 1;
            }
            tail.drain(..start);
        }
    }

    /// Render the pane's current terminal screen (plus up to
    /// PHONE_HISTORY_ROWS of scrollback above it) as SGR-styled text rows for
    /// the phone app. This is what a real terminal shows right now — unlike
    /// the raw output stream, TUI redraws land in the right grid cells.
    fn screen_snapshot(&self) -> String {
        let mut parser = self.screen.lock();
        let screen = parser.screen_mut();
        let (rows, cols) = screen.size();
        let rows = rows.max(1) as usize;
        // Deepest available scrollback offset (clamped by vt100).
        screen.set_scrollback(usize::MAX);
        let max = screen.scrollback();
        // Tile whole screenfuls from the oldest wanted offset down to the
        // live screen (offset 0) so chunks adjoin without duplicating lines;
        // the odd remainder of oldest lines is dropped.
        let deepest = max.min(PHONE_HISTORY_ROWS) / rows * rows;
        let mut out: Vec<u8> = Vec::new();
        let mut offset = deepest;
        loop {
            screen.set_scrollback(offset);
            for row in screen.rows_formatted(0, cols) {
                out.extend_from_slice(&row);
                out.push(b'\n');
            }
            if offset == 0 {
                break;
            }
            offset = offset.saturating_sub(rows);
        }
        screen.set_scrollback(0);
        String::from_utf8_lossy(&out).into_owned()
    }

    fn set_state(&self, app: &AppHandle, new_state: &'static str) {
        let changed = {
            let mut s = self.state.lock();
            if *s == new_state {
                false
            } else {
                *s = new_state;
                true
            }
        };
        if changed {
            let _ = app.emit(
                "pty:state",
                PtyStateEvent {
                    pane_id: self.id.clone(),
                    state: new_state.to_string(),
                },
            );
        }
    }

    /// Called from the reader thread for every output chunk.
    fn on_output(&self, app: &AppHandle, db: &SharedDb, stripped: &str) {
        *self.last_output_at.lock() = Instant::now();
        self.append_stripped(stripped);
        // Any output means the agent (or shell) is doing something. This also
        // flips a diff_ready pane back to working once the user answers.
        self.set_state(app, "working");

        let Some(adapter) = &self.adapter else { return };
        let tail = self.tail.lock().clone();

        // Session-id capture (only for panes bound to a Conduit session).
        if !self.harness_id_reported.load(Ordering::Relaxed) {
            if let Some(hid) = adapter.parse_session_id(&tail) {
                self.report_harness_id(app, db, &hid);
            }
        }

        // Usage/cost scraping (only meaningful with a session to attach to).
        if let Some(usage) = adapter.parse_usage(&tail) {
            self.record_usage(app, db, usage, None);
        }
    }

    /// Insert a cost event for the DELTA since the last recorded usage.
    /// Both usage sources (pty scraping, on-disk logs) report cumulative
    /// session totals, but the dashboard's rollups SUM events — inserting
    /// cumulative snapshots would multiply-count. Zero deltas are skipped,
    /// which also handles TUI redraw dedup. Price is computed per-delta using
    /// the model parsed from the session log when available (see price_for).
    fn record_usage(&self, app: &AppHandle, db: &SharedDb, usage: UsageInfo, model: Option<&str>) {
        let Some(session_id) = &self.session_id else { return };
        let mut delta = {
            let mut last = self.last_usage.lock();
            let prev = *last;
            *last = Some(usage);
            match prev {
                Some(p) => UsageInfo {
                    input_tokens: usage
                        .input_tokens
                        .zip(p.input_tokens)
                        .map(|(a, b)| (a - b).max(0)),
                    output_tokens: usage
                        .output_tokens
                        .zip(p.output_tokens)
                        .map(|(a, b)| (a - b).max(0)),
                    cache_creation_input_tokens: usage
                        .cache_creation_input_tokens
                        .zip(p.cache_creation_input_tokens)
                        .map(|(a, b)| (a - b).max(0)),
                    cache_read_input_tokens: usage
                        .cache_read_input_tokens
                        .zip(p.cache_read_input_tokens)
                        .map(|(a, b)| (a - b).max(0)),
                    reasoning_output_tokens: usage
                        .reasoning_output_tokens
                        .zip(p.reasoning_output_tokens)
                        .map(|(a, b)| (a - b).max(0)),
                    cost_usd: usage.cost_usd.zip(p.cost_usd).map(|(a, b)| (a - b).max(0.0)),
                },
                None => usage,
            }
        };
        let is_zero = delta.input_tokens.unwrap_or(0) == 0
            && delta.output_tokens.unwrap_or(0) == 0
            && delta.cost_usd.unwrap_or(0.0) == 0.0;
        if is_zero {
            return;
        }
        if delta.cost_usd.is_none() {
            delta.cost_usd = self.price_for(db, &delta, model);
        }
        let pricing_estimated_usd = delta.cost_usd;
        let adapter_id = self.adapter.as_ref().map(|a| a.id()).unwrap_or("unknown");
        let conn = db.lock();
        if db::insert_cost_event(&conn, session_id, &delta, adapter_id, "pty", pricing_estimated_usd).is_ok() {
            let _ = app.emit(
                "cost:updated",
                CostUpdatedEvent {
                    session_id: session_id.clone(),
                    version: 2,
                },
            );
        }
    }

    /// Estimate a delta's cost using per-model rates. The model id comes from
    /// the harness's session log (e.g. "claude-sonnet-4-5-…", "kimi-k3",
    /// "glm-5.2"); unknown models fall back to the harness's default model.
    /// Rates: Settings keys `price.<model-key>.input_per_mtok` /
    /// `.output_per_mtok`, else the built-in table (official list prices, see
    /// harness_adapters::default_rates). Labeled an estimate per PRD §7.12.
    fn price_for(&self, db: &SharedDb, delta: &UsageInfo, model: Option<&str>) -> Option<f64> {
        use crate::harness_adapters::{canonical_model_key, default_rates, harness_default_model_key};
        let adapter = self.adapter.as_ref()?;
        let key = model
            .and_then(canonical_model_key)
            .unwrap_or_else(|| harness_default_model_key(adapter.id()));
        let (default_in, default_out) = default_rates(key)?;
        let conn = db.lock();
        let rate = |suffix: &str, default: f64| {
            db::get_setting(&conn, &format!("price.{key}.{suffix}"))
                .ok()
                .flatten()
                .and_then(|v| v.parse::<f64>().ok())
                .unwrap_or(default)
        };
        let in_rate = rate("input_per_mtok", default_in);
        let out_rate = rate("output_per_mtok", default_out);
        let cost = (delta.input_tokens.unwrap_or(0) as f64 * in_rate
            + delta.output_tokens.unwrap_or(0) as f64 * out_rate)
            / 1_000_000.0;
        (cost > 0.0).then_some(cost)
    }

    fn report_harness_id(&self, app: &AppHandle, db: &SharedDb, harness_id: &str) {
        if self.harness_id_reported.swap(true, Ordering::Relaxed) {
            return; // already reported by a racing path (regex vs fs probe)
        }
        *self.harness_session_id.lock() = Some(harness_id.to_string());
        if let Some(session_id) = &self.session_id {
            {
                let conn = db.lock();
                let _ = db::set_session_harness_id(&conn, session_id, harness_id);
            }
            let _ = app.emit(
                "session:harness-id",
                SessionHarnessIdEvent {
                    session_id: session_id.clone(),
                    harness_session_id: harness_id.to_string(),
                },
            );
        }
    }

    fn kill(&self) {
        self.killed.store(true, Ordering::Relaxed);
        // On Windows the child is typically a `cmd.exe` wrapper (npm `.cmd`
        // shims can't be spawned directly — see resolve_for_spawn). Killing
        // only the wrapper would orphan the real agent process, so kill the
        // whole tree first; fall back to portable-pty's TerminateProcess.
        #[cfg(windows)]
        {
            if let Some(pid) = self.child.lock().process_id() {
                use std::os::windows::process::CommandExt;
                const CREATE_NO_WINDOW: u32 = 0x0800_0000;
                let _ = std::process::Command::new("taskkill")
                    .args(["/PID", &pid.to_string(), "/T", "/F"])
                    .creation_flags(CREATE_NO_WINDOW)
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .status();
            }
        }
        // portable-pty's kill() is TerminateProcess on Windows / SIGKILL on
        // unix — there is no SIGTERM-then-escalate granularity in the crate,
        // so this single call *is* the escalation path (see BUILD_LOG.md).
        let _ = self.child.lock().kill();
        // Closing the channel lets the writer thread exit.
        self.writer_tx.lock().take();
    }
}

pub struct PtyManager {
    panes: Arc<Mutex<HashMap<String, Arc<Pane>>>>,
    /// Maps session_id → pane_id so the mobile relay can route messages
    /// to the correct pty. A session_id may map to at most one live pane.
    session_to_pane: Arc<Mutex<HashMap<String, String>>>,
    app: AppHandle,
    db: SharedDb,
}

impl PtyManager {
    pub fn new(app: AppHandle, db: SharedDb) -> Arc<Self> {
        let mgr = Arc::new(Self {
            panes: Arc::new(Mutex::new(HashMap::new())),
            session_to_pane: Arc::new(Mutex::new(HashMap::new())),
            app,
            db,
        });
        PtyManager::spawn_monitor(Arc::clone(&mgr));
        mgr
    }

    /// Spawn a process in a new pty and bind it to `pane_id`. Reusing a pane id
    /// kills the old process and starts a fresh transcript (CONTRACT.md:
    /// spawn "marks pane transcript buffer fresh").
    #[allow(clippy::too_many_arguments)]
    pub fn spawn(
        &self,
        pane_id: &str,
        session_id: Option<String>,
        adapter: Option<Arc<dyn HarnessAdapter>>,
        cwd: &Path,
        spec: &CommandSpec,
        extra_env: Vec<(String, String)>,
    ) -> Result<(), String> {
        self.kill_pane(pane_id); // no-op if absent/dead

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("failed to open pty: {e}"))?;

        // npm-installed CLIs are `.cmd` shims on Windows; resolve through
        // cmd.exe so they actually spawn (see resolve_for_spawn docs).
        let resolved = crate::harness_adapters::resolve_for_spawn(spec);
        let mut cmd = CommandBuilder::new(&resolved.program);
        for arg in &resolved.args {
            cmd.arg(arg);
        }
        // Inherit the full parent environment so tools like Claude Code receive
        // their config (e.g. CLAUDE_CODE_CHILD_SESSION, API keys, PATH tweaks).
        cmd.env_clear();
        for (k, v) in std::env::vars() {
            cmd.env(k, v);
        }
        // Legacy DB rows may hold \\?\ extended-length paths; cmd.exe rejects
        // those as cwd ("UNC paths are not supported"), so sanitize here too —
        // this is the single choke point every pane spawn goes through.
        let cwd_str = crate::util::strip_unc_prefix(&cwd.to_string_lossy());
        cmd.cwd(Path::new(&cwd_str));
        // Advertise full color support: without TERM/COLORTERM, chalk-style
        // color detection in agent TUIs (Claude Code's orange, Kimi's blue)
        // degrades to monochrome — the pane is xterm.js, which is 256-color
        // truecolor capable. FORCE_COLOR=3 is the explicit override every
        // color-detection library (chalk/supports-color/ink, and Bun's shims)
        // honors first — Claude Code still came up monochrome with just
        // TERM+COLORTERM. Only set when the caller didn't override.
        if !extra_env.iter().any(|(k, _)| k == "TERM") {
            cmd.env("TERM", "xterm-256color");
        }
        if !extra_env.iter().any(|(k, _)| k == "COLORTERM") {
            cmd.env("COLORTERM", "truecolor");
        }
        if !extra_env.iter().any(|(k, _)| k == "FORCE_COLOR") {
            cmd.env("FORCE_COLOR", "3");
        }
        for (k, v) in extra_env {
            cmd.env(k, v);
        }

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("failed to spawn `{}`: {e}", spec.program))?;
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("failed to clone pty reader: {e}"))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("failed to take pty writer: {e}"))?;
        // Dropping the slave side lets the reader observe EOF when the child
        // exits; keeping it open can make the read loop hang forever.
        drop(pair.slave);

        let sid_for_pane = session_id.clone();
        let pane = Arc::new(Pane {
            id: pane_id.to_string(),
            session_id: sid_for_pane,
            adapter,
            cwd: cwd.to_path_buf(),
            writer_tx: Mutex::new(None),
            master: Mutex::new(pair.master),
            child: Mutex::new(child),
            transcript: Mutex::new(String::new()),
            screen: Mutex::new(vt100::Parser::new(24, 80, SCREEN_SCROLLBACK)),
            tail: Mutex::new(String::new()),
            state: Mutex::new("idle"),
            last_output_at: Mutex::new(Instant::now()),
            spawned_at: Instant::now(),
            spawned_at_system: SystemTime::now(),
            exited: AtomicBool::new(false),
            killed: AtomicBool::new(false),
            harness_id_reported: AtomicBool::new(false),
            harness_session_id: Mutex::new(None),
            last_claude_probe: Mutex::new(Instant::now()),
            last_usage_sync: Mutex::new(Instant::now() - Duration::from_secs(60)),
            last_usage: Mutex::new(None),
        });

        // Writer thread: write_pty commands land on this channel.
        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        *pane.writer_tx.lock() = Some(tx);
        thread::spawn(move || {
            let mut writer = writer;
            while let Ok(data) = rx.recv() {
                if writer.write_all(&data).and_then(|_| writer.flush()).is_err() {
                    break; // pty gone; thread exits when the pane is dropped
                }
            }
        });

        // Reader thread: raw bytes -> frontend; stripped bytes -> transcript
        // and scraping.
        {
            let pane = Arc::clone(&pane);
            let app = self.app.clone();
            let db = Arc::clone(&self.db);
            // Regex for detecting URLs in CLI output — matches http(s) URLs
            // that CLI agents print when they want the user to open a preview.
            let url_re: Option<regex::Regex> = regex::Regex::new(
                r#"https?://[^\s<>"'()\]]+"#
            ).ok();
            thread::spawn(move || {
                let mut buf = [0u8; 8192];
                let mut tail = String::new();
                let mut seen_urls: HashSet<String> = HashSet::new();
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            let raw = &buf[..n];
                            let _ = app.emit(
                                "pty:output",
                                PtyOutputEvent {
                                    pane_id: pane.id.clone(),
                                    data: String::from_utf8_lossy(raw).into_owned(),
                                },
                            );
                            // Feed the virtual terminal screen (phone display).
                            pane.screen.lock().process(raw);
                            let stripped =
                                String::from_utf8_lossy(&strip_ansi_escapes::strip(raw))
                                    .into_owned();
                            // Scan for URLs and emit browser:url_detected.
                            let scan = tail.clone() + &stripped;
                            tail.clear();
                            if let Some(ref re) = url_re {
                                for m in re.find_iter(&scan) {
                                    let url = m.as_str().to_string();
                                    // Only auto-open URLs that point at a local
                                    // dev server / preview (localhost, 127.x,
                                    // 0.0.0.0, [::1], *.local). Arbitrary remote
                                    // URLs printed by CLIs (git remotes, docs,
                                    // GitHub links) must NOT hijack the browser.
                                    if !is_local_dev_url(&url) {
                                        continue;
                                    }
                                    // Only emit each unique URL once per pane
                                    // to avoid re-opening a browser pane the
                                    // user just closed. Prune periodically
                                    // (keep most-recent 800 of 1000) instead of
                                    // a hard clear that would re-open the most
                                    // recently detected local URL.
                                    if seen_urls.insert(url.clone()) {
                                        if seen_urls.len() > 1000 {
                                            // Drop the oldest 200 entries rather
                                            // than clearing — a full clear lets
                                            // a just-detected URL re-fire on the
                                            // next matching line.
                                            let keep: Vec<String> =
                                                seen_urls.iter().skip(200).cloned().collect();
                                            seen_urls.clear();
                                            seen_urls.extend(keep);
                                        }
                                        let _ = app.emit(
                                            "browser:url_detected",
                                            BrowserUrlDetectedEvent {
                                                pane_id: pane.id.clone(),
                                                url,
                                            },
                                        );
                                    }
                                }
                                // Preserve trailing text for URLs split across
                                // read chunks (up to 128 chars). Use char_indices
                                // to avoid slicing in the middle of a multi-byte
                                // UTF-8 character (e.g. box-drawing chars).
                                let keep = scan.char_indices().rev().nth(128).map(|(i, _)| i).unwrap_or(0);
                                tail.push_str(&scan[keep..]);
                            }
                            pane.on_output(&app, &db, &stripped);
                        }
                        Err(_) => break,
                    }
                }
            });
        }

        // Waiter thread: polls try_wait (never holds the child lock across a
        // blocking wait, so kill_pty can always get in).
        {
            let pane = Arc::clone(&pane);
            let app = self.app.clone();
            let session_to_pane = Arc::clone(&self.session_to_pane);
            thread::spawn(move || {
                // Poll try_wait rather than a blocking wait: a blocking wait
                // would hold the child lock and prevent kill_pty from getting
                // in to terminate the process.
                let code = loop {
                    match pane.child.lock().try_wait() {
                        Ok(Some(s)) => break Some(s.exit_code() as i64),
                        Ok(None) => thread::sleep(Duration::from_millis(120)),
                        Err(_) => break None,
                    }
                };
                pane.exited.store(true, Ordering::Relaxed);
                // Drop any session→pane mapping pointing at this pane so the
                // mobile relay stops reporting the dead session as live (and
                // SendToSession stops writing into the void). kill_pane is
                // covered too: the kill makes try_wait return, landing here.
                session_to_pane.lock().retain(|_, v| *v != pane.id);
                // Dropping the sender closes the writer thread's channel.
                pane.writer_tx.lock().take();
                let _ = app.emit(
                    "pty:exit",
                    PtyExitEvent {
                        pane_id: pane.id.clone(),
                        code,
                    },
                );
            });
        }

        self.panes.lock().insert(pane_id.to_string(), pane);

        // Register session_id → pane_id mapping for the mobile relay.
        if let Some(ref sid) = session_id {
            self.session_to_pane.lock().insert(sid.clone(), pane_id.to_string());
        }

        // Fresh spawn with no output yet = idle (CONTRACT.md pty:state).
        let _ = self.app.emit(
            "pty:state",
            PtyStateEvent {
                pane_id: pane_id.to_string(),
                state: "idle".to_string(),
            },
        );
        Ok(())
    }

    pub fn write(&self, pane_id: &str, data: &str) -> Result<(), String> {
        let pane = self.get_pane(pane_id)?;
        let tx = pane.writer_tx.lock().clone();
        match tx {
            Some(tx) => tx
                .send(data.as_bytes().to_vec())
                .map_err(|_| "pty writer channel closed".to_string()),
            None => Err("pane process is not running".to_string()),
        }
    }

    pub fn resize(&self, pane_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let pane = self.get_pane(pane_id)?;
        // Keep the phone-display screen model in lockstep with the real pty.
        pane.screen.lock().screen_mut().set_size(rows, cols);
        let master = pane.master.lock();
        master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("resize failed: {e}"))
    }

    pub fn kill_pane(&self, pane_id: &str) {
        let pane = self.panes.lock().get(pane_id).cloned();
        if let Some(pane) = pane {
            if !pane.exited.load(Ordering::Relaxed) {
                pane.kill();
            }
        }
    }

    /// App-quit cleanup (PRD §8): no orphaned agent processes after exit.
    pub fn kill_all(&self) {
        let panes: Vec<Arc<Pane>> = self.panes.lock().values().cloned().collect();
        for pane in panes {
            if !pane.exited.load(Ordering::Relaxed) {
                pane.kill();
            }
        }
    }

    /// Transcript accessor for `export_session_markdown`. The buffer survives
    /// pane kill/exit so a just-closed session can still be exported.
    pub fn transcript(&self, pane_id: &str) -> Option<String> {
        self.panes
            .lock()
            .get(pane_id)
            .map(|p| p.transcript.lock().clone())
    }

    fn get_pane(&self, pane_id: &str) -> Result<Arc<Pane>, String> {
        self.panes
            .lock()
            .get(pane_id)
            .cloned()
            .ok_or_else(|| format!("no pane with id {pane_id}"))
    }

    /// Bind a harness session id to a live pane (used when a pane is spawned
    /// as a resume — the id is already known from the session record, so the
    /// usage sync can start immediately without waiting for the probe).
    pub fn set_harness_session_id(&self, pane_id: &str, harness_session_id: &str) {
        if let Ok(pane) = self.get_pane(pane_id) {
            *pane.harness_session_id.lock() = Some(harness_session_id.to_string());
            // Mark as reported so the monitor-thread probe doesn't
            // redundantly fire report_harness_id for a resume pane.
            pane.harness_id_reported.store(true, Ordering::Relaxed);
        }
    }

    /// Resolve a session_id to the current pane_id (if the session has a
    /// live pty). Used by the mobile relay to route `SendToSession`.
    pub fn pane_id_for_session(&self, session_id: &str) -> Option<String> {
        let pane_id = self.session_to_pane.lock().get(session_id).cloned()?;
        // Stale-entry guard: the waiter thread removes mappings on exit, but
        // never trust the map alone — a pane that exited before the cleanup
        // existed (or a mapping written by an older build) must not be
        // reported as live.
        let panes = self.panes.lock();
        match panes.get(&pane_id) {
            Some(p) if !p.exited.load(Ordering::Relaxed) => Some(pane_id),
            _ => None,
        }
    }

    /// Get the pty transcript for a session (if it has a live pane).
    pub fn transcript_for_session(&self, session_id: &str) -> Option<String> {
        let pane_id = self.pane_id_for_session(session_id)?;
        self.transcript(&pane_id)
    }

    /// Rendered screen snapshot (SGR-styled rows) for a session's live pane —
    /// what the phone app displays instead of the raw output stream. Includes
    /// the screen size so the phone can fit the font to the terminal width.
    pub fn screen_for_session(&self, session_id: &str) -> Option<(String, u16, u16)> {
        let pane_id = self.pane_id_for_session(session_id)?;
        self.panes.lock().get(&pane_id).map(|p| {
            let size = p.screen.lock().screen().size();
            (p.screen_snapshot(), size.0, size.1)
        })
    }

    /// Get the current state of a pane by its pane_id.
    pub fn pane_state(&self, pane_id: &str) -> Option<String> {
        self.panes.lock().get(pane_id).map(|p| p.state.lock().to_string())
    }

    /// Get the spawned child's PID for a pane (dev-mode memory counter).
    pub fn pane_pid(&self, pane_id: &str) -> Option<u32> {
        self.panes.lock().get(pane_id).and_then(|p| p.pid())
    }

    /// One monitor thread for all panes: drives the silence heuristic and the
    /// Claude session-file fallback probe.
    fn spawn_monitor(mgr: Arc<PtyManager>) {
        thread::spawn(move || loop {
            thread::sleep(Duration::from_millis(200));
            let panes: Vec<Arc<Pane>> = mgr.panes.lock().values().cloned().collect();
            for pane in panes {
                if pane.exited.load(Ordering::Relaxed) || pane.killed.load(Ordering::Relaxed) {
                    continue;
                }

                // working -> (diff_ready | waiting) after ~1.5s of silence.
                let is_working = *pane.state.lock() == "working";
                if is_working && pane.last_output_at.lock().elapsed() >= SILENCE_BEFORE_WAITING {
                    let new_state = match &pane.adapter {
                        Some(adapter) => {
                            let tail = pane.tail.lock();
                            if adapter.diff_prompt_patterns().iter().any(|re| re.is_match(&tail)) {
                                "diff_ready"
                            } else {
                                "waiting"
                            }
                        }
                        None => "waiting",
                    };
                    pane.set_state(&mgr.app, new_state);
                }

                // Session-id filesystem fallback (any adapter): neither
                // harness reliably prints its id in the TUI, so we poll the
                // harness's on-disk session store for a short window after
                // spawn (see find_session_id_on_disk impls for details).
                let needs_probe = pane.session_id.is_some()
                    && pane.adapter.is_some()
                    && !pane.harness_id_reported.load(Ordering::Relaxed)
                    && pane.spawned_at.elapsed() < CLAUDE_PROBE_WINDOW
                    && pane.last_claude_probe.lock().elapsed() >= Duration::from_secs(1);
                if needs_probe {
                    *pane.last_claude_probe.lock() = Instant::now();
                    let adapter = pane.adapter.as_ref().unwrap();
                    if let Some(hid) =
                        adapter.find_session_id_on_disk(&pane.cwd, pane.spawned_at_system)
                    {
                        pane.report_harness_id(&mgr.app, &mgr.db, &hid);
                    }
                }

                // On-disk usage sync for the cost dashboard (PRD §7.12 prefers
                // harness session logs over pty scraping). Cheap cadence; each
                // adapter no-ops when its log has no usage yet.
                if pane.last_usage_sync.lock().elapsed() >= Duration::from_secs(5) {
                    *pane.last_usage_sync.lock() = Instant::now();
                    let hid = pane.harness_session_id.lock().clone();
                    if let (Some(adapter), Some(hid)) = (&pane.adapter, hid) {
                        if let Some(su) = adapter.usage_from_disk(&pane.cwd, &hid) {
                            pane.record_usage(&mgr.app, &mgr.db, su.usage, su.model.as_deref());
                        }
                    }
                }
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::is_local_dev_url;

    #[test]
    fn local_dev_urls_are_detected() {
        assert!(is_local_dev_url("http://localhost:5173/"));
        assert!(is_local_dev_url("http://127.0.0.1:3000"));
        // Any 127/8 address is loopback, not just 127.0.0.1.
        assert!(is_local_dev_url("http://127.9.9.9:8080"));
        assert!(is_local_dev_url("https://0.0.0.0:8080/app"));
        assert!(is_local_dev_url("http://[::1]:5173/"));
        assert!(is_local_dev_url("http://myapp.local/"));
        assert!(is_local_dev_url("http://foo.localhost:1234"));
    }

    #[test]
    fn remote_urls_are_ignored() {
        assert!(!is_local_dev_url("https://github.com/org/repo"));
        assert!(!is_local_dev_url("https://example.com/localhost"));
        assert!(!is_local_dev_url("http://192.168.1.5:3000"));
        assert!(!is_local_dev_url("https://docs.rs/tokio"));
        assert!(!is_local_dev_url("http://user@evil.com/localhost"));
        // M19 regression: bare `starts_with("127.")` matched these VALID
        // PUBLIC DNS names and auto-opened them.
        assert!(!is_local_dev_url("http://127.evil.com"));
        assert!(!is_local_dev_url("http://127.0.0.1.evil.com"));
        assert!(!is_local_dev_url("http://1270.evil.com/path"));
        // Obfuscated loopback spellings fail closed (Rust's parser rejects
        // hex/octal/integer shorthand) — conservative beats clever here.
        assert!(!is_local_dev_url("http://0x7f.0.0.1"));
        assert!(!is_local_dev_url("http://2130706433"));
    }
}
