//! `browser::tabs` — pane visibility/project wiring, pane- and tab-request plumbing, the trust layer (tab urls, pause, cancel, gate approval, timeline), and tab switch/new/close.
//! Carved verbatim from the former browser.rs impl monolith
//! (mechanical split; see REFACTOR_PROGRESS.md).

use super::*;

impl BrowserManager {

    // --- Pane registry + MCP roundtrip helpers ---------------------------
    // The MCP WebSocket server (Task #4) needs to target a specific browser
    // pane by pane_id, or resolve a project_id to the best pane via a
    // frontend roundtrip. These methods wire that resolution path.

    /// True if the pane is currently visible (set via `set_visible`; defaults
    /// to true on create). Backgrounded panes skip watch-mode pacing.
    pub fn pane_is_visible(&self, pane_id: &str) -> bool {
        self.pane_visible.lock().get(pane_id).copied().unwrap_or(true)
    }

    /// Register a browser pane's project association (called by the frontend
    /// after creating a browser pane).
    pub fn register_browser_pane_project(&self, pane_id: &str, project_id: &str) {
        self.project_pane_registry.lock().insert(pane_id.to_string(), project_id.to_string());
    }

    /// Remove a pane from the registry + visibility + active-tab maps (called
    /// when a pane is closed).
    pub fn unregister_browser_pane_project(&self, pane_id: &str) {
        self.project_pane_registry.lock().remove(pane_id);
        self.pane_visible.lock().remove(pane_id);
        let prefix = format!("browser-{pane_id}-tab-");
        self.tab_visible.lock().retain(|k, _| !k.starts_with(&prefix));
        self.pane_active_tab.lock().remove(pane_id);
    }

    /// Emit a `browser:resolve-pane-request` event to the frontend, asking it
    /// to pick the best browser pane for `project_id`. Returns a req_id the
    /// caller awaits via `resolve_pane_request_resolve`.
    pub fn resolve_pane_request_emit(&self, project_id: &str) -> u64 {
        let req_id = self.next_resolve_req.fetch_add(1, Ordering::SeqCst);
        let (tx, _rx) = oneshot::channel::<Option<String>>();
        self.pane_resolve_pending.lock().insert(req_id, tx);
        let payload = serde_json::json!({ "reqId": req_id, "projectId": project_id });
        let _ = self.app.emit("browser:resolve-pane-request", payload);
        req_id
    }

    /// Receive the frontend's answer for a resolve-pane request.
    pub fn resolve_pane_request_resolve(&self, req_id: u64, pane_id: Option<String>) {
        if let Some(tx) = self.pane_resolve_pending.lock().remove(&req_id) {
            let _ = tx.send(pane_id);
        }
    }

    /// Emit a `browser:open-browser-request` event asking the frontend to
    /// create (or reveal) a browser pane for `project_id` pointed at `url`.
    /// Returns a req_id the caller awaits via `open_pane_request_resolve`.
    pub fn open_pane_request_emit(&self, project_id: &str, url: &str) -> u64 {
        let req_id = self.next_open_req.fetch_add(1, Ordering::SeqCst);
        let (tx, _rx) = oneshot::channel::<Option<(String, Option<String>)>>();
        self.pane_open_pending.lock().insert(req_id, tx);
        let payload = serde_json::json!({ "reqId": req_id, "projectId": project_id, "url": url });
        let _ = self.app.emit("browser:open-browser-request", payload);
        req_id
    }

    /// Receive the frontend's answer for an open-browser request.
    pub fn open_pane_request_resolve(
        &self,
        req_id: u64,
        pane_id: Option<String>,
        tab_id: Option<String>,
    ) {
        if let Some(tx) = self.pane_open_pending.lock().remove(&req_id) {
            let _ = tx.send(pane_id.map(|p| (p, tab_id)));
        }
    }

    /// Receive the frontend's answer for a tab roundtrip (switch/new/close).
    /// `tab_id` is the affected tab (echoed for switch/new; None = failure).
    pub fn tab_request_resolve(&self, req_id: u64, tab_id: Option<String>) {
        if let Some(tx) = self.tab_pending.lock().remove(&req_id) {
            let _ = tx.send(tab_id);
        }
    }

    // ---- Phase 2 trust layer ---------------------------------------------

    /// Remember a tab's current URL (origin source for per-site consent).
    pub fn remember_tab_url(&self, label: &str, url: &str) {
        self.tab_urls.lock().insert(label.to_string(), url.to_string());
    }

    pub fn tab_url(&self, label: &str) -> Option<String> {
        self.tab_urls.lock().get(label).cloned()
    }

    /// Pause/unpause agent actions for a pane. Paused actions fail with a
    /// resumable error; the page and the user's own browsing are unaffected.
    pub fn set_paused(&self, pane_id: &str, paused: bool) {
        self.paused.lock().insert(pane_id.to_string(), paused);
        if paused {
            self.append_timeline(
                pane_id,
                "control",
                "pause",
                "ok",
                None,
                Some("agent paused by user".into()),
            );
        }
    }

    pub fn is_paused(&self, pane_id: &str) -> bool {
        self.paused.lock().get(pane_id).copied().unwrap_or(false)
    }

    /// Stop the agent for a pane: sticky cancel flag + drain every pending
    /// action with `cancelled_by_user` so in-flight tool calls return
    /// immediately instead of hanging out their 45 s timeout.
    pub fn cancel_agent(&self, pane_id: &str) {
        self.cancelled.lock().insert(pane_id.to_string(), true);
        // Drain ONLY this pane's in-flight actions (oneshot senders are not
        // cloneable — collect the ids first, then remove+resolve each).
        let prefix = format!("browser-{pane_id}-tab-");
        let ids: Vec<u64> = {
            self.pending
                .lock()
                .iter()
                .filter(|(_, p)| p.label.starts_with(&prefix))
                .map(|(k, _)| *k)
                .collect()
        };
        for id in ids {
            if let Some(p) = self.pending.lock().remove(&id) {
                let _ = p
                    .tx
                    .send("ERROR: cancelled_by_user — the user stopped the agent".to_string());
            }
        }
        self.append_timeline(pane_id, "control", "stop", "ok", None, Some("agent stopped by user".into()));
    }

    pub fn is_cancelled(&self, pane_id: &str) -> bool {
        self.cancelled.lock().get(pane_id).copied().unwrap_or(false)
    }

    /// Clear the sticky cancel flag — the user manually navigating the pane
    /// signals "I'm driving now; the agent may act again".
    pub fn clear_cancelled(&self, pane_id: &str) {
        self.cancelled.lock().remove(pane_id);
    }

    /// Emit a gate confirmation request to the frontend and await the answer.
    /// 120 s timeout: a human must respond; silence denies.
    pub async fn request_gate_approval(
        &self,
        pane_id: &str,
        op: &str,
        target: &str,
        url: &str,
        risk_class: &str,
        reason: &str,
    ) -> Option<GateAnswer> {
        let req_id = self.next_gate_req.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel::<GateAnswer>();
        self.gate_pending.lock().insert(req_id, tx);
        let payload = serde_json::json!({
            "reqId": req_id,
            "paneId": pane_id,
            "op": op,
            "target": target,
            "url": url,
            "riskClass": risk_class,
            "reason": reason,
        });
        let _ = self.app.emit("browser:confirm-request", payload);
        match tokio::time::timeout(Duration::from_secs(120), rx).await {
            Ok(Ok(answer)) => Some(answer),
            _ => None,
        }
    }

    /// Receive the frontend's answer for a gate confirmation.
    pub fn gate_request_resolve(&self, req_id: u64, answer: GateAnswer) {
        if let Some(tx) = self.gate_pending.lock().remove(&req_id) {
            let _ = tx.send(answer);
        }
    }

    /// Append one user-owned timeline record and push it to the UI live.
    pub fn append_timeline(
        &self,
        pane_id: &str,
        op: &str,
        target: &str,
        outcome: &str,
        risk_class: Option<&str>,
        detail: Option<String>,
    ) {
        let entry = TimelineEntry {
            ts_ms: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0),
            op: op.to_string(),
            target: target.chars().take(160).collect(),
            outcome: outcome.to_string(),
            risk_class: risk_class.map(|s| s.to_string()),
            detail,
        };
        {
            let mut map = self.timeline.lock();
            let list = map.entry(pane_id.to_string()).or_default();
            list.push(entry.clone());
            let len = list.len();
            if len > TIMELINE_CAP {
                list.drain(..len - TIMELINE_CAP);
            }
        }
        let _ = self.app.emit(
            "browser:timeline-entry",
            serde_json::json!({ "paneId": pane_id, "entry": entry }),
        );
    }

    /// Snapshot a pane's timeline (oldest first).
    pub fn timeline_for_pane(&self, pane_id: &str) -> Vec<TimelineEntry> {
        self.timeline
            .lock()
            .get(pane_id)
            .cloned()
            .unwrap_or_default()
    }

    /// Ask the frontend to perform a tab operation in a pane and await the
    /// outcome. `kind` is "switch" | "new" | "close"; `arg` is the tabId
    /// (switch/close) or the URL (new). Emits `browser:{kind}-tab-request`
    /// and awaits `tab_request_resolve` (5 s timeout).
    pub(super) async fn tab_request(&self, kind: &str, pane_id: &str, arg: &str) -> Result<String, String> {
        let req_id = self.next_tab_req.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel::<Option<String>>();
        self.tab_pending.lock().insert(req_id, tx);
        let payload = if kind == "new" {
            serde_json::json!({ "reqId": req_id, "paneId": pane_id, "url": arg })
        } else {
            serde_json::json!({ "reqId": req_id, "paneId": pane_id, "tabId": arg })
        };
        let event = format!("browser:{kind}-tab-request");
        let _ = self.app.emit(&event, payload);

        match tokio::time::timeout(Duration::from_secs(5), rx).await {
            Ok(Ok(Some(tab_id))) => Ok(tab_id),
            Ok(Ok(None)) => Err(format!(
                "frontend could not {kind} tab (may be the last tab, an unknown tab, or the pane is gone)"
            )),
            Ok(Err(_)) => Err("tab request channel closed".to_string()),
            Err(_) => Err("tab request timed out waiting for the frontend".to_string()),
        }
    }

    /// Public awaited tab ops used by the MCP dispatch. `switch`/`new` poll
    /// for the tab's webview to register (lazy creation runs async on the
    /// frontend) so the agent can act on the tab immediately after.
    pub async fn switch_tab_for_pane(&self, pane_id: &str, tab_id: &str) -> Result<String, String> {
        let _ = self.tab_request("switch", pane_id, tab_id).await?;
        let label = browser_label(pane_id, tab_id);
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        loop {
            if self.webviews.lock().contains_key(&label) {
                self.pane_active_tab.lock().insert(pane_id.to_string(), tab_id.to_string());
                *self.active.lock() = Some((pane_id.to_string(), tab_id.to_string()));
                return Ok(label);
            }
            if std::time::Instant::now() >= deadline {
                // The store switched even if the webview hasn't registered —
                // good enough for list/read flows that lazily create later.
                self.pane_active_tab.lock().insert(pane_id.to_string(), tab_id.to_string());
                return Ok(label);
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    pub async fn new_tab_for_pane(&self, pane_id: &str, url: &str) -> Result<String, String> {
        let tab_id = self.tab_request("new", pane_id, url).await?;
        let label = browser_label(pane_id, &tab_id);
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        loop {
            if self.webviews.lock().contains_key(&label) {
                break;
            }
            if std::time::Instant::now() >= deadline {
                return Err(format!(
                    "tab {tab_id} created but its webview did not register within 3s"
                ));
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        self.pane_active_tab.lock().insert(pane_id.to_string(), tab_id.clone());
        *self.active.lock() = Some((pane_id.to_string(), tab_id.clone()));
        Ok(label)
    }

    pub async fn close_tab_for_pane(&self, pane_id: &str, tab_id: &str) -> Result<String, String> {
        self.tab_request("close", pane_id, tab_id).await?;
        // Defensive: drop our own map entry + visibility state in case the
        // frontend's browser_close raced or was skipped.
        let label = browser_label(pane_id, tab_id);
        self.tab_visible.lock().remove(&label);
        self.webviews.lock().remove(&label);
        Ok(tab_id.to_string())
    }

    /// High-level helper used by the MCP WS dispatch (Task #4) to resolve a
    /// `pane_id` and/or `project_id` into a concrete webview label. The label
    /// can then be passed to `run_action_for_pane` / `read_page_for_pane`.
    ///
    /// Resolution order:
    /// 1. `explicit_pane_id` -> look up its active tab from `pane_active_tab`.
    /// 2. `project_id` -> ask the frontend for the best pane (roundtrip, 5s
    ///    timeout), then resolve its tab. Falls back to global active if the
    ///    roundtrip times out.
    /// 3. Neither -> global `active_label()`.
    pub async fn resolve_pane_label(
        &self,
        project_id: Option<&str>,
        explicit_pane_id: Option<&str>,
    ) -> Result<String, String> {
        // Case 1: explicit pane_id — look up its active tab.
        if let Some(pid) = explicit_pane_id {
            let tab = self
                .pane_active_tab
                .lock()
                .get(pid)
                .cloned()
                .ok_or_else(|| format!("no active tab for pane {pid}"))?;
            return Ok(browser_label(pid, &tab));
        }

        // Case 2: project_id — roundtrip through the frontend.
        if let Some(pid) = project_id {
            // Create our own channel for this async resolution. The emit
            // method creates its own sender (for the resolve command path),
            // but here we need to await the receiver directly.
            let req_id = self.next_resolve_req.fetch_add(1, Ordering::SeqCst);
            let (tx, rx) = oneshot::channel::<Option<String>>();
            self.pane_resolve_pending.lock().insert(req_id, tx);
            let payload = serde_json::json!({ "reqId": req_id, "projectId": pid });
            let _ = self.app.emit("browser:resolve-pane-request", payload);

            match tokio::time::timeout(Duration::from_secs(5), rx).await {
                Ok(Ok(Some(best_pane_id))) => {
                    let tab = self
                        .pane_active_tab
                        .lock()
                        .get(&best_pane_id)
                        .cloned()
                        .ok_or_else(|| {
                            format!("no active tab for resolved pane {best_pane_id}")
                        })?;
                    return Ok(browser_label(&best_pane_id, &tab));
                }
                Ok(Ok(None)) => {
                    // No pane exists for this project — caller should auto-open.
                    return Err("pane_not_found".to_string());
                }
                Ok(Err(_)) | Err(_) => {
                    // Channel closed or timeout — fall through to global active.
                }
            }
            // Fallback: try the global active pane.
            return self.active_label();
        }

        // Case 3: neither — use the global active pane.
        self.active_label()
    }

    /// Convenience helper: ask the frontend to open a new browser pane for
    /// `project_id` pointed at `url`, wait for the pane to be created (5s
    /// timeout), and return the new pane's webview label. Used by the MCP WS
    /// dispatch (Task #4) for auto-open on navigate when no pane exists.
    pub async fn open_pane_for_project(
        &self,
        project_id: &str,
        url: &str,
    ) -> Result<String, String> {
        let req_id = self.next_open_req.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel::<Option<(String, Option<String>)>>();
        self.pane_open_pending.lock().insert(req_id, tx);
        let payload = serde_json::json!({ "reqId": req_id, "projectId": project_id, "url": url });
        let _ = self.app.emit("browser:open-browser-request", payload);

        match tokio::time::timeout(Duration::from_secs(5), rx).await {
            Ok(Ok(Some((new_pane_id, answered_tab)))) => {
                // The frontend created the pane and returned its id + active
                // tab id, but the native webview (`browser_create` →
                // `create()`) may still be initializing async on the main
                // thread — `pane_active_tab` / `webviews` aren't populated
                // until `create()` finishes. Poll for THAT tab's label in the
                // webviews map (create() inserts it last), up to ~3s, rather
                // than relying on a fixed sleep that races the webview init.
                // (The tab id used to be hardcoded "default", which broke
                // whenever the frontend's first tab id differed.)
                let tab = answered_tab.unwrap_or_else(|| "default".to_string());
                let label = browser_label(&new_pane_id, &tab);
                let deadline = std::time::Instant::now() + Duration::from_secs(3);
                loop {
                    if self.webviews.lock().contains_key(&label) {
                        return Ok(label);
                    }
                    if std::time::Instant::now() >= deadline {
                        return Err(format!(
                            "open_pane_for_project: pane {new_pane_id} webview did not register within 3s"
                        ));
                    }
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            }
            Ok(Ok(None)) => Err("open_pane_for_project: frontend returned null pane_id".to_string()),
            Ok(Err(_)) => Err("open_pane_for_project: channel closed".to_string()),
            Err(_) => Err("open_pane_for_project: timed out waiting for pane creation".to_string()),
        }
    }

}
