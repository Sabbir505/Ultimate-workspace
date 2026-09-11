//! `browser::interactions` — agent page interactions (ref clicks/typing/hover, forms, keys, snapshot, evaluate, history, diagnostics) and description-resolution helpers.
//! Carved verbatim from the former browser.rs impl monolith
//! (mechanical split; see REFACTOR_PROGRESS.md).

use super::*;

impl BrowserManager {
    pub async fn click_ref(&self, r: i64) -> Result<String, String> {
        self.run_action(&click_js(r, None)).await
    }

    pub async fn type_into(&self, r: i64, text: &str) -> Result<String, String> {
        self.run_action(&type_js(r, text, None)).await
    }

    pub async fn scroll_by(&self, dy: i64) -> Result<String, String> {
        self.run_action(&scroll_js(dy)).await
    }

    /// Hover the element tagged with `data-relay-ref="{r}"` in the active
    /// pane. Dispatches real mouseover/mouseenter events so React/Vue hover
    /// handlers and CSS `:hover` activate. Backs the new `hover` MCP tool.
    pub async fn hover_ref(&self, r: i64) -> Result<String, String> {
        self.run_action(&hover_js(r)).await
    }

    /// Same as `hover_ref` but targets an explicit pane label.
    pub async fn hover_ref_for_pane(&self, label: &str, r: i64) -> Result<String, String> {
        self.run_action_for_pane(label, &hover_js(r)).await
    }

    /// Drive the webview's real history back/forward. Unlike the existing
    /// `go_back`/`go_forward` (fire-and-forget `eval`), this uses the awaited
    /// `run_action_for_pane` bridge so the tool result carries whether the
    /// navigation occurred and the post-nav URL. `direction` is "back" |
    /// "forward". Backs the new `back`/`forward` MCP tools.
    pub async fn history_for_pane(
        &self,
        label: &str,
        direction: &str,
    ) -> Result<String, String> {
        let dir = if direction == "forward" { "forward" } else { "back" };
        self.run_action_for_pane(label, &history_js(dir)).await
    }

    /// Evaluate arbitrary JS in the pane and return a JSON-serialized result.
    /// Used by the new `evaluate` MCP tool. Runs in the pane's own origin.
    pub async fn evaluate_for_pane(
        &self,
        label: &str,
        expression: &str,
    ) -> Result<String, String> {
        self.run_action_for_pane(label, &evaluate_js(expression)).await
    }

    /// Compact interactive snapshot (same ref numbering as click/type) — backs
    /// the `include_snapshot` action flag and the `find` tool (a query filters
    /// the listing without changing the numbering).
    pub async fn snapshot_for_pane(&self, label: &str, query: Option<&str>) -> Result<String, String> {
        self.run_action_for_pane(label, &snapshot_js(query)).await
    }

    /// Set multiple form fields directly by ref (fast path, no per-keystroke
    /// typing). `fields_json` is a validated `[{"ref":N,"text":"..."}]` array.
    pub async fn fill_form_for_pane(&self, label: &str, fields_json: &str) -> Result<String, String> {
        self.run_action_for_pane(label, &fill_form_js(fields_json)).await
    }

    /// Select an `<option>` by value or visible text — the direct semantic
    /// action that fixes the classic a11y-click-on-dropdown failure.
    pub async fn select_option_for_pane(&self, label: &str, r: i64, value: &str) -> Result<String, String> {
        self.run_action_for_pane(label, &select_option_js(r, value)).await
    }

    /// Press a key (Enter/Escape/arrows/…) on the focused element.
    pub async fn press_key_for_pane(&self, label: &str, key: &str) -> Result<String, String> {
        self.run_action_for_pane(label, &press_key_js(key)).await
    }

    /// Read the diagnostics ring buffer ("console" | "network") incrementally.
    pub async fn read_diag_for_pane(&self, label: &str, kind: &str, since: u64) -> Result<String, String> {
        self.run_action_for_pane(label, &diag_read_js(kind, since)).await
    }

    /// List a pane's tabs from the webviews map (tabs whose webview was
    /// activated at least once) with the active flag. Returns
    /// `Vec<(tab_id, is_active, has_webview)>` — URLs are read by the caller
    /// per tab via `evaluate_for_pane("location.href")` only when needed.
    pub fn list_tabs_for_pane(&self, pane_id: &str) -> Vec<(String, bool, bool)> {
        let prefix = format!("browser-{pane_id}-tab-");
        let active_tab = self.pane_active_tab.lock().get(pane_id).cloned();
        let mut out: Vec<(String, bool, bool)> = Vec::new();
        {
            let webviews = self.webviews.lock();
            for key in webviews.keys() {
                if let Some(tab) = key.strip_prefix(&prefix) {
                    let is_active = active_tab.as_deref() == Some(tab);
                    out.push((tab.to_string(), is_active, true));
                }
            }
        }
        // The active tab from the frontend's perspective may not have a
        // webview yet (lazy creation on first activation) — still report it.
        if let Some(active) = active_tab {
            if !out.iter().any(|(t, _, _)| *t == active) {
                out.push((active, true, false));
            }
        }
        out.sort_by(|a, b| a.0.cmp(&b.0));
        out
    }

    /// Capture a REGION of the pane as PNG via CDP `Page.captureScreenshot`
    /// with a clip rect (the `zoom` tool: small text, dense UI). Coordinates
    /// are viewport CSS pixels; `scale` upsamples the crop (default 2).
    #[cfg(windows)]
    pub fn capture_pane_png_clipped(
        &self,
        label: &str,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
        scale: f64,
    ) -> Option<Vec<u8>> {
        let params = serde_json::json!({
            "format": "png",
            "clip": {
                "x": x.max(0.0),
                "y": y.max(0.0),
                "width": width.max(1.0),
                "height": height.max(1.0),
                "scale": scale.clamp(0.5, 4.0),
            }
        });
        let json = self
            .call_devtools_protocol(label, "Page.captureScreenshot", &params.to_string())
            .ok()?;
        let v: serde_json::Value = serde_json::from_str(&json).ok()?;
        let b64 = v.get("data")?.as_str()?;
        use base64::Engine;
        base64::engine::general_purpose::STANDARD.decode(b64).ok()
    }

    #[cfg(not(windows))]
    pub fn capture_pane_png_clipped(
        &self,
        _label: &str,
        _x: f64,
        _y: f64,
        _width: f64,
        _height: f64,
        _scale: f64,
    ) -> Option<Vec<u8>> {
        None
    }

    pub(super) fn get(&self, label: &str) -> Result<BrowserPane, String> {
        self.webviews
            .lock()
            .get(label)
            .cloned()
            .ok_or_else(|| format!("no browser webview with label {label}"))
    }

    // --- Agent-driven description resolution (Task #5) ---------------------
    // These resolve a `selector_or_description` string to a concrete element
    // via bridge_resolve.js, then act on it. Used by the MCP WS dispatch
    // (browser_mcp::op_click / op_type_text). The click/type bodies are the
    // sync versions from click_js/type_js for now; Task #2 swaps in the
    // animated Promise-returning overlays on top of the same resolution.

    /// Resolve `desc` to an element ref in the pane labelled `label`. Returns
    /// the raw JSON the bridge emits: `{"ok":true,"ref":..,...}` or
    /// `{"ok":false,"error":"not_found","suggestions":[...]}`.
    pub async fn resolve_element(&self, label: &str, desc: &str, action: &str) -> Result<String, String> {
        let body = build_resolve_js(desc, action);
        self.run_action_for_pane(label, &body).await
    }

    /// Resolve + act with ONE self-healing retry (the Stagehand/Skyvern
    /// pattern). When the page's DOM changed between the agent's read_page
    /// and this action, the assigned `data-relay-ref` no longer matches
    /// anything ("ref N is stale") and the op used to fail — bouncing the
    /// agent through a manual re-read + retry round trip. A stale result now
    /// triggers an automatic re-resolve of the ORIGINAL description against
    /// the CURRENT page (bridge_resolve re-tags fresh refs) and a single
    /// retry with the new ref. A healed payload carries `healed: true` so
    /// the agent knows the page moved under it. `not_found` resolutions pass
    /// through untouched — nothing to heal when nothing matched to begin
    /// with.
    pub(super) async fn healed_action(
        &self,
        label: &str,
        desc: &str,
        resolve_action: &str,
        verb: &str,
        build_body: impl Fn(i64) -> String,
        opts: &ActionOpts,
    ) -> Result<String, String> {
        let stale = |s: &str| s.contains("is stale");
        let resolved = self.resolve_element(label, desc, resolve_action).await?;
        let v: serde_json::Value = serde_json::from_str(&resolved)
            .map_err(|e| format!("resolve_and_{verb}: bad resolution json: {e}"))?;
        if !v.get("ok").and_then(|x| x.as_bool()).unwrap_or(false) {
            return Ok(resolved);
        }
        let r = v.get("ref").and_then(|x| x.as_i64()).unwrap_or(-1);
        let mut result = self
            .run_action_for_pane_opts(label, &build_body(r), opts.clone())
            .await?;

        let mut healed = false;
        let mut v_final = v;
        let mut r_final = r;
        if stale(&result) {
            if let Ok(v2) = serde_json::from_str::<serde_json::Value>(
                &self.resolve_element(label, desc, resolve_action).await?,
            ) {
                if v2.get("ok").and_then(|x| x.as_bool()).unwrap_or(false) {
                    let r2 = v2.get("ref").and_then(|x| x.as_i64()).unwrap_or(-1);
                    let retry = self
                        .run_action_for_pane_opts(label, &build_body(r2), opts.clone())
                        .await?;
                    if !stale(&retry) {
                        healed = true;
                        v_final = v2;
                        r_final = r2;
                    }
                    result = retry;
                }
            }
        }

        let tag = v_final.get("tag").and_then(|x| x.as_str()).unwrap_or("");
        let lbl = v_final.get("label").and_then(|x| x.as_str()).unwrap_or("");
        let mut payload = serde_json::Map::new();
        payload.insert("ok".into(), serde_json::Value::Bool(true));
        payload.insert(
            verb.to_string(),
            serde_json::json!({ "ref": r_final, "tag": tag, "label": lbl }),
        );
        payload.insert("result".into(), serde_json::Value::String(result));
        if healed {
            payload.insert("healed".into(), serde_json::Value::Bool(true));
        }
        Ok(serde_json::Value::Object(payload).to_string())
    }

    /// Narrated resolve + click: `narration` (the agent's element description)
    /// shows as a label pinned to the synthetic cursor — the readable-agent
    /// trust primitive. Used by the MCP dispatch.
    pub async fn resolve_and_click_narrated(
        &self,
        label: &str,
        desc: &str,
        narration: Option<&str>,
        opts: &ActionOpts,
    ) -> Result<String, String> {
        let narration_owned = narration.map(|s| s.to_string());
        self.healed_action(label, desc, "click", "clicked", move |r| {
            click_js(r, narration_owned.as_deref())
        }, opts)
        .await
    }

    /// Narrated resolve + type. Same shape as resolve_and_click_narrated.
    pub async fn resolve_and_type_narrated(
        &self,
        label: &str,
        desc: &str,
        text: &str,
        narration: Option<&str>,
        opts: &ActionOpts,
    ) -> Result<String, String> {
        let text_owned = text.to_string();
        let narration_owned = narration.map(|s| s.to_string());
        self.healed_action(label, desc, "type", "typed", move |r| {
            type_js(r, &text_owned, narration_owned.as_deref())
        }, opts)
        .await
    }

    /// Resolve + click. Returns the bridge JSON (ok or not_found with
    /// suggestions) when resolution succeeds/fails; the click result string is
    /// folded into the ok payload's `result` field so the caller can surface
    /// both.
    pub async fn resolve_and_click(&self, label: &str, desc: &str) -> Result<String, String> {
        self.resolve_and_click_opts(label, desc, &ActionOpts::default()).await
    }

    /// Resolve + click with pacing opts. Same shape as resolve_and_click.
    pub async fn resolve_and_click_opts(&self, label: &str, desc: &str, opts: &ActionOpts) -> Result<String, String> {
        self.healed_action(label, desc, "click", "clicked", |r| click_js(r, None), opts)
            .await
    }

    /// Resolve + type. Same shape as resolve_and_click.
    pub async fn resolve_and_type(&self, label: &str, desc: &str, text: &str) -> Result<String, String> {
        self.resolve_and_type_opts(label, desc, text, &ActionOpts::default()).await
    }

    /// Resolve + type with pacing opts. Same shape as resolve_and_type.
    pub async fn resolve_and_type_opts(&self, label: &str, desc: &str, text: &str, opts: &ActionOpts) -> Result<String, String> {
        let text_owned = text.to_string();
        self.healed_action(label, desc, "type", "typed", move |r| type_js(r, &text_owned, None), opts)
            .await
    }

    /// Resolve + hover with pacing opts. Same shape as resolve_and_click but
    /// dispatches a hover sequence instead of a click — backs the `hover` MCP
    /// tool when the agent passes a description rather than a bare ref.
    pub async fn resolve_and_hover_opts(
        &self,
        label: &str,
        desc: &str,
        opts: &ActionOpts,
    ) -> Result<String, String> {
        // ACTION="click" is fine for resolution scoring — hover targets the
        // same interactive set and we don't penalize non-inputs the way type
        // does. We just swap the action body to hover_js.
        self.healed_action(label, desc, "click", "hovered", |r| hover_js(r), opts)
            .await
    }
}
