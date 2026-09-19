//! ToolTracker — per-harness tool-call bookkeeping for the Claude-Code
//! style turn readers: pending tool slots, live subagent metadata, the
//! <tool> marker emitters, and the tool_meta_* payload builders shared
//! with dispatch.rs. Child module of agent_sessions (inherits its imports
//! and private helpers via `use super::*`).
use super::*;

/// Kimi tool_call object → (name, marker values). Kimi names tools close to
/// Claude's (Edit/Write/Read/Bash/Grep/Glob…) with args under
/// `function.arguments` (JSON string) or directly as input — both handled.
pub(super) fn tool_meta_kimi(call: &Value) -> Option<(String, Vec<Value>)> {
    let func = call.get("function").cloned().unwrap_or(call.clone());
    let name = func.get("name").and_then(|n| n.as_str())?.to_string();
    let args = match func.get("arguments") {
        Some(Value::String(s)) => serde_json::from_str::<Value>(s).unwrap_or(json!({})),
        Some(v) => v.clone(),
        None => json!({}),
    };
    let vals = vec![tool_meta_generic(&name, &args)];
    Some((name, vals))
}

/// True for the shell/command tool names used across the harness CLIs.
pub(super) fn is_shell_name(name: &str) -> bool {
    matches!(
        name.to_lowercase().as_str(),
        "bash" | "shell" | "run_shell" | "run_command"
    )
}

/// True for the subagent-dispatch tool name across the harness CLIs: Claude
/// Code 2.x renamed its `Task` tool to `Agent` (same input shape —
/// subagent_type/description/prompt, verified in the CLI bundle); opencode
/// calls it `task`; kimi still uses `Task`. Every harness path must treat
/// both names as a subagent spawn, or the chip/sidebar/panel UI never sees
/// the agent (the screenshot bug: "Running tool Agent" + empty AGENTS list).
pub(super) fn is_subagent_tool_name(name: &str) -> bool {
    matches!(name.to_lowercase().as_str(), "task" | "agent")
}

/// True when a tool_result for an Agent/Task call is Claude Code's internal
/// async-launch receipt ("Async agent launched successfully. (This tool
/// result is internal metadata …)"). It carries the agentId and the output
/// file path, NOT the agent's work — forwarding it to the subagent panel
/// showed internal metadata as the OUTPUT while marking the agent Done while
/// it was still working. The real outcome arrives later as a
/// `task_notification` system event.
pub(super) fn is_async_launch_receipt(text: &str) -> bool {
    let t = text.trim_start();
    t.starts_with("Async agent launched successfully")
        || (t.contains("internal metadata") && t.contains("agentId:") && t.contains("output_file"))
}

/// Pull the background agent's id out of the launch receipt
/// ("agentId: a1b3914b301b8a387 (internal ID …)") — the fallback correlation
/// key when a task_notification lacks the Agent call's tool_use_id.
pub(super) fn launch_receipt_agent_id(text: &str) -> Option<String> {
    let idx = text.find("agentId:")?;
    let rest = text[idx + "agentId:".len()..].trim_start();
    let id: String = rest
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    if id.is_empty() {
        None
    } else {
        Some(id)
    }
}

/// Cap captured shell output so a huge dump can't bloat the stored message.
/// Shell output is usually most useful at the tail, so keep the last lines.
pub(super) fn truncate_output(s: &str) -> String {
    const MAX_LINES: usize = 60;
    const MAX_BYTES: usize = 8_000;
    let lines: Vec<&str> = s.lines().collect();
    let mut out = if lines.len() > MAX_LINES {
        let dropped = lines.len() - MAX_LINES;
        format!(
            "… [{} earlier lines truncated]\n{}",
            dropped,
            lines[lines.len() - MAX_LINES..].join("\n")
        )
    } else {
        s.to_string()
    };
    if out.len() > MAX_BYTES {
        // Char-safe tail: `&out[start..]` on a multibyte boundary panics —
        // and the panic unwinds past the turn thread's cleanup tail
        // (in_flight clear, perf unregister), wedging the chat. A
        // non-ASCII error body >8KB reaches here.
        out = format!("…\n{}", crate::util::tail_chars(&out, MAX_BYTES));
    }
    out
}

/// Pull the text out of a tool_result `content` field, which may be a plain
/// string or an array of content blocks (text/image). Only text is useful for
/// the shell preview; other blocks are ignored.
pub(super) fn extract_result_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|b| {
                if b.get("type").and_then(|t| t.as_str()) == Some("text") {
                    b.get("text").and_then(|t| t.as_str()).map(String::from)
                } else {
                    None
                }
            })
            .collect::<Vec<_>>()
            .join("\n"),
        Some(v) if !v.is_null() => v.to_string(),
        _ => String::new(),
    }
}

/// Tracks tool calls within a turn so each tool RESULT can be matched back to
/// its call. CLI streams deliver calls and results IN ORDER but interleave
/// non-shell tools with shell tools, so we keep a FIFO per call and pop one slot
/// per result. Each slot records whether the call was a shell command (its
/// result renders as a terminal preview) or a subagent Task (its result feeds a
/// subagent panel). Other tools are tracked solely to keep the order aligned.
pub(super) struct PendingTool {
    id: u64,
    shell: bool,
    /// Panel id when this call was a subagent Task/Agent.
    subagent_id: Option<String>,
    /// The CLI's tool_use id when the subagent registered one — such slots
    /// are finalized out-of-band (exact id match or task_notification) and
    /// are SKIPPED by FIFO pops.
    sub_tool_use_id: Option<String>,
}
/// One live (spawned, not yet finalized) subagent. Looked up by the CLI's own
/// tool_use id so late events can be attributed exactly.
pub(super) struct SubagentMeta {
    /// Panel id (`sub-<ts>-<n>`).
    pub(super) id: String,
    /// agentId parsed from the async launch receipt (claude background
    /// agents) — fallback correlation key for task_notification.
    pub(super) agent_id: Option<String>,
    /// run_in_background: true — the CLI answers the call with an internal
    /// launch receipt and reports the real outcome later via a
    /// `task_notification` system event.
    pub(super) background: bool,
    /// Whether any subagent-internal message already streamed into the panel
    /// output, so a completing result doesn't re-append the same text.
    pub(super) streamed: bool,
}

pub(super) struct ToolTracker {
    pub(super) seq: u64,
    pub(super) pending: VecDeque<PendingTool>,
    /// Live subagents keyed by the CLI's tool_use id. Inserted on spawn,
    /// removed on finalization. This is what makes background agents (whose
    /// call slot was long ago consumed by the launch receipt) and
    /// subagent-internal messages (`parent_tool_use_id`) routable.
    pub(super) by_tool_use: std::collections::HashMap<String, SubagentMeta>,
}

impl ToolTracker {
    pub(super) fn new() -> Self {
        Self {
            seq: 0,
            pending: VecDeque::new(),
            by_tool_use: std::collections::HashMap::new(),
        }
    }
    /// Wrap one tool call's marker Value(s) as `<tool>…</tool>`, injecting an
    /// `id` when the call is a shell command, and record the call's slot.
    pub(super) fn tool_use(&mut self, name: &str, values: Vec<Value>) -> String {
        let id = self.seq;
        self.seq += 1;
        let shell = is_shell_name(name);
        let mut out = String::new();
        for mut v in values {
            if shell {
                if let Some(obj) = v.as_object_mut() {
                    obj.insert("id".to_string(), json!(id));
                }
            }
            out.push_str(&format!("<tool>{v}</tool>"));
        }
        self.pending.push_back(PendingTool {
            id,
            shell,
            subagent_id: None,
            sub_tool_use_id: None,
        });
        out
    }
    /// Wrap a subagent Task tool call: emits a `chat:subagent-spawn` event,
    /// injects an `id` into the marker, and records the call. When the CLI
    /// exposes its tool_use id (claude stream-json), the live subagent is also
    /// registered in `by_tool_use` so late events — the launch receipt, the
    /// agent's internal messages, its completion notification — attribute to
    /// this panel entry exactly instead of by queue order.
    #[allow(clippy::too_many_arguments)]
    pub(super) fn subagent_use(
        &mut self,
        name: &str,
        value: Value,
        app: Option<&AppHandle>,
        sid: &str,
        role: &str,
        task: &str,
        prompt: &str,
        cli_tool_use_id: &str,
        background: bool,
    ) -> String {
        self.subagent_use_inner(
            name, value, app, sid, role, task, prompt, cli_tool_use_id, background, None,
        )
    }
    /// Self-contained subagent variant for CLIs that report the Task call AND
    /// its completed output in one event (opencode tool parts can arrive
    /// already finished). Emits the spawn event + correlated chip marker
    /// exactly like `subagent_use`, then finalizes the panel entry with the
    /// output immediately — and queues NO pending slot: nothing will arrive
    /// later to match, and a stale slot would eat the NEXT tool's result.
    #[allow(clippy::too_many_arguments)]
    pub(super) fn subagent_use_with_output(
        &mut self,
        name: &str,
        value: Value,
        app: Option<&AppHandle>,
        sid: &str,
        role: &str,
        task: &str,
        prompt: &str,
        output: Option<&str>,
        error: Option<&str>,
    ) -> String {
        self.subagent_use_inner(
            name,
            value,
            app,
            sid,
            role,
            task,
            prompt,
            "",
            false,
            Some((output.or(error).unwrap_or(""), error.is_some())),
        )
    }
    #[allow(clippy::too_many_arguments)]
    fn subagent_use_inner(
        &mut self,
        _name: &str,
        value: Value,
        app: Option<&AppHandle>,
        sid: &str,
        role: &str,
        task: &str,
        prompt: &str,
        cli_tool_use_id: &str,
        background: bool,
        final_output: Option<(&str, bool)>,
    ) -> String {
        let id = self.seq;
        self.seq += 1;
        // Unique across turns: `seq` resets every turn, so a plain `sub-0`
        // would clobber the previous turn's sub-0 in the frontend store
        // (same collision the built-in path fixed with a timestamp segment).
        static SUB_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        let sub_seq = SUB_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let sub_id = format!("sub-{}-{sub_seq}", crate::db::now_ts());
        let mut v = value;
        if let Some(obj) = v.as_object_mut() {
            obj.insert("id".to_string(), json!(id));
            // Carry the spawn event's store id in the marker too: the chat
            // chip correlates by it exactly. Task/role text matching breaks
            // when a model puts the summary under "task"/"summary" (store
            // task = "" vs chip task = text) or when two agents share a
            // description.
            obj.insert("subId".to_string(), json!(sub_id));
        }
        // Emit the spawn event so the frontend creates the subagent immediately.
        if let Some(app) = app {
            let _ = app.emit(
                "chat:subagent-spawn",
                crate::types::SubagentSpawnPayload {
                    chat_session_id: sid.to_string(),
                    id: sub_id.clone(),
                    role: role.to_string(),
                    task: task.to_string(),
                    prompt: prompt.to_string(),
                    // Relay only observes CLI-native subagents — the CLI owns
                    // their model choice, so there is nothing to report.
                    model: None,
                },
            );
        }
        let marker = format!("<tool>{v}</tool>");
        if let Some((text, is_error)) = final_output {
            // The part already carries its final output: finalize the panel
            // entry now (tokens + done) and skip the pending bookkeeping —
            // no result event will ever arrive for this call.
            self.finish_subagent(
                app,
                sid,
                &SubagentMeta {
                    id: sub_id,
                    agent_id: None,
                    background: false,
                    streamed: false,
                },
                Some(text),
                is_error,
            );
            return marker;
        }
        if !cli_tool_use_id.is_empty() {
            self.by_tool_use.insert(
                cli_tool_use_id.to_string(),
                SubagentMeta {
                    id: sub_id.clone(),
                    agent_id: None,
                    background,
                    streamed: false,
                },
            );
        }
        self.pending.push_back(PendingTool {
            id,
            shell: false,
            subagent_id: Some(sub_id.clone()),
            sub_tool_use_id: if cli_tool_use_id.is_empty() {
                None
            } else {
                Some(cli_tool_use_id.to_string())
            },
        });
        marker
    }
    /// Consume the next result slot (in call order, or — when the CLI exposes
    /// tool_use ids — the EXACT call the result belongs to). Returns a result
    /// marker carrying the output text only when that call was a shell
    /// command, and feeds the subagent panel when it was a subagent Task.
    pub(super) fn tool_result(
        &mut self,
        text: &str,
        is_error: bool,
        app: Option<&AppHandle>,
        sid: &str,
        cli_tool_use_id: Option<&str>,
    ) -> Option<String> {
        // Exact match first (claude). A background agent's launch receipt is
        // swallowed here: it is internal CLI metadata, NOT the agent's output,
        // and marking the agent done on it is the "Done ✓ but still working"
        // bug. The real completion arrives later via task_notification.
        if let Some(id) = cli_tool_use_id.filter(|s| !s.is_empty()) {
            if let Some(meta) = self.by_tool_use.get_mut(id) {
                if is_async_launch_receipt(text) {
                    meta.background = true;
                    meta.agent_id = launch_receipt_agent_id(text);
                    return None;
                }
            }
            if let Some(meta) = self.by_tool_use.remove(id) {
                self.drop_pending_sub(&meta.id);
                self.finish_subagent(app, sid, &meta, Some(text), is_error);
                return None;
            }
        }
        // Skip slots for REGISTERED subagents: their results finalize via the
        // exact tool_use id or a task_notification, never through this queue.
        // Without the skip, a background agent's receipt-consumed slot would
        // eat the NEXT tool's result (the FIFO desync that garbled panes).
        //
        // NOTE (audit M-8, deliberately NOT finalized here): discarding the
        // slot without finalizing looks like a leak, but finalizing here would
        // regress the "Done ✓ but still working" fix — a background agent's
        // launch receipt is swallowed above and its REAL completion can arrive
        // minutes later by exact id / task_notification. The failure modes are
        // covered instead by (a) reader-EOF `fail_pending` for a dead CLI and
        // (b) `finish_background` for the notification path.
        while let Some(front) = self.pending.front() {
            match &front.sub_tool_use_id {
                Some(t) if self.by_tool_use.contains_key(t) => {
                    self.pending.pop_front();
                }
                _ => break,
            }
        }
        let slot = self.pending.pop_front()?;
        if let Some(sub_id) = slot.subagent_id {
            // Adapters without tool_use ids (kimi/pi/omp): FIFO fallback.
            let meta = SubagentMeta {
                id: sub_id,
                agent_id: None,
                background: false,
                streamed: false,
            };
            self.finish_subagent(app, sid, &meta, Some(text), is_error);
            return None;
        }
        if !slot.shell {
            return None;
        }
        Some(result_marker_text(slot.id, text, is_error))
    }
    /// Emit the final subagent events: stream `text` only when nothing was
    /// already streamed live from the agent's own messages, then mark done.
    pub(super) fn finish_subagent(
        &self,
        app: Option<&AppHandle>,
        sid: &str,
        meta: &SubagentMeta,
        text: Option<&str>,
        is_error: bool,
    ) {
        let Some(app) = app else { return };
        let text = text.unwrap_or("");
        if !meta.streamed && !text.is_empty() {
            let _ = app.emit(
                "chat:subagent-tokens",
                crate::types::SubagentTokenPayload {
                    chat_session_id: sid.to_string(),
                    subagent_id: meta.id.clone(),
                    chunk: text.to_string(),
                },
            );
        }
        let _ = app.emit(
            "chat:subagent-done",
            crate::types::SubagentDonePayload {
                chat_session_id: sid.to_string(),
                id: meta.id.clone(),
                // Empty output keeps what already streamed (the frontend's
                // onSubagentDone falls back to the accumulated output).
                output: if meta.streamed {
                    String::new()
                } else {
                    text.to_string()
                },
                error: is_error.then(|| "subagent exited with an error".to_string()),
            },
        );
    }
    /// Remove the queued FIFO slot for a subagent finalized out-of-order (by
    /// exact tool_use id), so the remaining slots stay aligned with their
    /// results.
    pub(super) fn drop_pending_sub(&mut self, sub_id: &str) {
        self.pending
            .retain(|s| s.subagent_id.as_deref() != Some(sub_id));
    }
    /// Route ONE subagent-internal assistant message (claude tags every
    /// message produced inside a Task/Agent with `parent_tool_use_id`) into
    /// that agent's panel output: text and thinking stream as content, tool
    /// calls become the same `<tool>` markers the built-in panel parses. Must
    /// never touch the main transcript or the main tool FIFO — subagent
    /// activity would otherwise desync the queue and mis-attribute results.
    pub(super) fn route_subagent_assistant(
        &mut self,
        app: Option<&AppHandle>,
        sid: &str,
        parent_tool_use_id: &str,
        blocks: &[Value],
    ) -> bool {
        let Some(meta) = self.by_tool_use.get_mut(parent_tool_use_id) else {
            return false;
        };
        let mut chunks = String::new();
        for b in blocks {
            match b.get("type").and_then(|t| t.as_str()) {
                Some("text") => {
                    if let Some(t) = b.get("text").and_then(|v| v.as_str()) {
                        chunks.push_str(t);
                    }
                }
                Some("thinking") => {
                    if let Some(t) = b.get("thinking").and_then(|v| v.as_str()) {
                        if !t.is_empty() {
                            chunks.push_str("<think>");
                            chunks.push_str(t);
                            chunks.push_str("</think>");
                        }
                    }
                }
                Some("tool_use") => {
                    if let Some((name, values)) = tool_meta_claude(b) {
                        let _ = name;
                        for v in values {
                            chunks.push_str(&format!("<tool>{v}</tool>"));
                        }
                    }
                }
                _ => {}
            }
        }
        if chunks.is_empty() {
            return true;
        }
        meta.streamed = true;
        if let Some(app) = app {
            let _ = app.emit(
                "chat:subagent-tokens",
                crate::types::SubagentTokenPayload {
                    chat_session_id: sid.to_string(),
                    subagent_id: meta.id.clone(),
                    chunk: chunks,
                },
            );
        }
        true
    }
    /// Route ONE subagent-internal tool result into that agent's panel as a
    /// result marker (folded onto the most recent tool row by the parser).
    pub(super) fn route_subagent_result(
        &mut self,
        app: Option<&AppHandle>,
        sid: &str,
        parent_tool_use_id: &str,
        text: &str,
        is_error: bool,
    ) -> bool {
        let Some(meta) = self.by_tool_use.get_mut(parent_tool_use_id) else {
            return false;
        };
        meta.streamed = true;
        let sub_id = meta.id.clone();
        if let Some(app) = app {
            let marker = json!({
                "kind": "result",
                "result": sanitize(truncate_output(text)),
                "resultError": is_error,
            });
            let _ = app.emit(
                "chat:subagent-tokens",
                crate::types::SubagentTokenPayload {
                    chat_session_id: sid.to_string(),
                    subagent_id: sub_id,
                    chunk: format!("<tool>{marker}</tool>"),
                },
            );
        }
        true
    }
    /// Finalize a background agent from its `task_notification` system event
    /// (claude). The notification carries the Agent call's tool_use_id, the
    /// task's agent task_id, a status, and the report summary — any of the id
    /// keys may correlate; with none matching, a single awaiting background
    /// agent is the unambiguous fallback.
    pub(super) fn finish_background(&mut self, app: Option<&AppHandle>, sid: &str, v: &Value) {
        let status = v
            .get("status")
            .and_then(|s| s.as_str())
            .unwrap_or("completed");
        let summary = v.get("summary").and_then(|s| s.as_str()).unwrap_or("");
        let by_tool = v
            .get("tool_use_id")
            .and_then(|t| t.as_str())
            .filter(|s| !s.is_empty())
            .filter(|t| self.by_tool_use.contains_key(*t))
            .map(String::from);
        let key = by_tool.or_else(|| {
            let task_id = v.get("task_id").and_then(|t| t.as_str()).unwrap_or("");
            if !task_id.is_empty() {
                if let Some((k, m)) = self
                    .by_tool_use
                    .iter()
                    .find(|(_, m)| m.agent_id.as_deref() == Some(task_id))
                {
                    let id = k.clone();
                    let _ = m;
                    return Some(id);
                }
            }
            // Fallback: with exactly one background agent awaiting, the
            // notification is unambiguously its completion.
            let awaiting: Vec<String> = self
                .by_tool_use
                .iter()
                .filter(|(_, m)| m.background)
                .map(|(k, _)| k.clone())
                .collect();
            if awaiting.len() == 1 {
                return awaiting.into_iter().next();
            }
            None
        });
        let Some(key) = key else { return };
        let Some(meta) = self.by_tool_use.remove(&key) else {
            return;
        };
        self.drop_pending_sub(&meta.id);
        self.finish_subagent(app, sid, &meta, Some(summary), status != "completed");
    }
    /// The CLI process ended with agents still awaiting completion (crash,
    /// cancel, session delete). Finalize them as errors so no panel entry
    /// spins forever. Covers BOTH registrations: the by-tool-use map (claude)
    /// and the FIFO-only slots (kimi/pi/omp/commandcode, whose adapters pass
    /// no CLI tool_use id).
    pub(super) fn fail_pending(&mut self, app: Option<&AppHandle>, sid: &str, reason: &str) {
        self.settle_live_subagents(app, sid, Some(reason));
    }
    /// Finalize EVERY live subagent — registered and FIFO-queued — with no
    /// result on the wire. `error: None` settles them as completed (turn-end
    /// settlement for protocols that never report a subagent's completion
    /// inline, e.g. ACP: the agent's turn finished, so its dispatch is done);
    /// `Some(reason)` settles them as errored (process exit mid-subagent).
    pub(super) fn settle_live_subagents(
        &mut self,
        app: Option<&AppHandle>,
        sid: &str,
        error: Option<&str>,
    ) {
        let mut metas: Vec<SubagentMeta> = self.by_tool_use.drain().map(|(_, m)| m).collect();
        // Registered agents also hold a FIFO slot — drop it (deduped below,
        // so the same agent never finalizes twice).
        for meta in &metas {
            self.drop_pending_sub(&meta.id);
        }
        // FIFO-only subagents (adapters without tool_use ids queue them ONLY
        // in `pending`) — skip ids already drained from by_tool_use, or the
        // same agent finalizes twice.
        let queued: Vec<String> = self
            .pending
            .iter()
            .filter_map(|s| s.subagent_id.clone())
            .filter(|id| !metas.iter().any(|m| &m.id == id))
            .collect();
        for sub_id in queued {
            self.drop_pending_sub(&sub_id);
            metas.push(SubagentMeta {
                id: sub_id,
                agent_id: None,
                background: false,
                streamed: false,
            });
        }
        for meta in &metas {
            if let Some(app) = app {
                let _ = app.emit(
                    "chat:subagent-done",
                    crate::types::SubagentDonePayload {
                        chat_session_id: sid.to_string(),
                        id: meta.id.clone(),
                        output: String::new(),
                        error: error.map(|e| e.to_string()),
                    },
                );
            }
        }
    }
    /// Self-contained variant for CLIs that report a tool's call AND its
    /// completed output in one event (opencode). Assigns an id, emits the
    /// command marker, and — for shell tools whose output/error is present —
    /// appends a matching result marker. No pending slot (nothing to match
    /// later), so it can't desync a queue.
    pub(super) fn tool_use_with_output(
        &mut self,
        name: &str,
        value: Value,
        output: Option<&str>,
        error: Option<&str>,
    ) -> String {
        let id = self.seq;
        self.seq += 1;
        let shell = is_shell_name(name);
        let mut out = String::new();
        let mut v = value;
        if shell {
            if let Some(obj) = v.as_object_mut() {
                obj.insert("id".to_string(), json!(id));
            }
            out.push_str(&format!("<tool>{v}</tool>"));
            if let Some(text) = output.or(error) {
                out.push_str(&result_marker_text(id, text, error.is_some()));
            }
        } else {
            out.push_str(&format!("<tool>{v}</tool>"));
        }
        out
    }
}

/// Build a `<tool>{"kind":"result",…}</tool>` marker that the frontend merges
/// onto the shell step with the matching `id`.
pub(super) fn result_marker_text(id: u64, text: &str, is_error: bool) -> String {
    let body = json!({
        "kind": "result",
        "id": id,
        "result": sanitize(truncate_output(text)),
        "resultError": is_error,
    });
    format!("<tool>{body}</tool>")
}

/// Shared tool-name → marker-meta mapping across CLIs. Claude, Kimi and
/// OpenCode all converge on similar tool names; the edit-shaped tools map to
/// DiffCard payloads, everything else to activity-group steps. Also used by
/// the built-in subagent loop (chat/dispatch.rs) for its `<tool>` markers.
pub(crate) fn tool_meta_generic(name: &str, input: &Value) -> Value {
    // Tools emit args in different conventions: Claude Code uses snake_case
    // (`file_path` / `old_string` / `new_string`), OpenCode uses camelCase
    // (`filePath` / `oldString` / `newString`). Look up both keys per field;
    // the helper's existing priority (snake first) is preserved.
    let s = |keys: &[&str]| {
        for k in keys {
            if let Some(v) = input.get(*k).and_then(|v| v.as_str()) {
                if !v.is_empty() {
                    return v.to_string();
                }
            }
        }
        String::new()
    };
    let s_path = || s(&["file_path", "filePath", "path", "file_path_abs"]);
    let s_find = || s(&["old_string", "oldString", "find"]);
    let s_replace = || s(&["new_string", "newString", "replace", "newText"]);
    let s_content = || s(&["content", "fileContent", "text"]);
    // Normalize the common aliases the CLIs use for file edits.
    let lname = name.to_lowercase();
    let is_edit = matches!(
        lname.as_str(),
        "edit" | "edit_file" | "multiedit" | "str_replace_editor"
    );
    let is_write = matches!(lname.as_str(), "write" | "write_file" | "create_file");
    let is_shell = matches!(
        lname.as_str(),
        "bash" | "shell" | "run_shell" | "run_command"
    );

    if is_edit {
        let path = s_path();
        json!({
            "kind": "edit",
            "title": format!("Editing file \"{path}\""),
            "detail": path,
            "path": path,
            "edit": { "mode": "replace", "find": sanitize(s_find()), "replace": sanitize(s_replace()) },
        })
    } else if is_write {
        let path = s_path();
        json!({
            "kind": "edit",
            "title": format!("Writing file \"{path}\""),
            "detail": path,
            "path": path,
            "edit": { "mode": "write", "content": sanitize(s_content()) },
        })
    } else if is_shell {
        let cmd = s(&["command", "cmd"]);
        json!({ "kind": "code", "title": "Running shell command", "lang": "bash", "code": sanitize(cmd) })
    } else if let Some((server, tool)) = name.strip_prefix("mcp__").and_then(|r| r.split_once("__")) {
        mcp_tool_meta(server, tool, input)
    } else {
        match name {
            "Read" | "read" | "read_file" => {
                json!({ "kind": "tool", "title": "Reading file", "detail": s_path() })
            }
            "Grep" | "grep" => {
                json!({ "kind": "search", "title": "Searching code", "detail": s(&["pattern", "query"]) })
            }
            "Glob" | "glob" => {
                json!({ "kind": "search", "title": "Finding files", "detail": s(&["pattern", "glob", "query"]) })
            }
            "WebSearch" | "web_search" => {
                json!({ "kind": "search", "title": "Searching the web", "detail": s(&["query", "searchQuery"]) })
            }
            "WebFetch" | "web_fetch" | "fetch_url" => {
                json!({ "kind": "web", "title": "Reading a web page", "detail": s(&["url", "uri"]) })
            }
            "TodoWrite" | "todowrite" => json!({ "kind": "tool", "title": "Updating task list" }),
            _ if is_subagent_tool_name(name) => json!({
                "kind": "subagent",
                "title": "Running subagent",
                "detail": s(&["description", "task", "summary"]),
                "role": s(&["subagent_type", "type", "agent_type"]),
                "prompt": sanitize(s(&["prompt", "message", "input"])),
            }),
            _ => json!({ "kind": "tool", "title": format!("Running tool {name}") }),
        }
    }
}

/// Human card for an MCP tool call (`mcp__<server>__<tool>`). Connector ids
/// map to display names, vendor quirks are de-prefixed (Notion names its
/// tools `notion-get-tool-access`), high-traffic tools get hand-written
/// verbs, and the most useful argument rides along as the detail line —
/// `Running tool mcp__notion__notion-get-tool-access` becomes
/// `Notion · checking tool access`.
fn mcp_tool_meta(server: &str, tool: &str, input: &Value) -> Value {
    let s = |keys: &[&str]| {
        for k in keys {
            if let Some(v) = input.get(*k).and_then(|v| v.as_str()) {
                if !v.is_empty() {
                    return v.to_string();
                }
            }
        }
        String::new()
    };
    let server_pretty = match server {
        "relay-tools" => "Relay",
        "relay-browser" => "Browser",
        "gmail" => "Gmail",
        "notion" => "Notion",
        "github" => "GitHub",
        "kiwi" => "Kiwi",
        "gdrive" => "Drive",
        "gdocs" => "Docs",
        "gsheets" => "Sheets",
        "gslides" => "Slides",
        "gcalendar" => "Calendar",
        "gchat" => "Chat",
        "gpeople" => "Contacts",
        "youtube" => "YouTube",
        other => other,
    };
    // (title, detail) for the tools users hit constantly; the detail key list
    // is per tool so the card shows WHAT it is acting on, not just the verb.
    let known: Option<(&str, &str)> = match (server, tool) {
        // relay-tools (Relay's own surface)
        ("relay-tools", "generate_document") => Some(("Generating document", "filename")),
        ("relay-tools", "plan_document") => Some(("Planning document", "filename")),
        ("relay-tools", "revise_document") => Some(("Revising document", "path")),
        ("relay-tools", "generate_diagram") => Some(("Drawing a diagram", "filename")),
        ("relay-tools", "generate_image") => Some(("Generating an image", "prompt")),
        ("relay-tools", "generate_file") => Some(("Writing an artifact file", "filename")),
        ("relay-tools", "get_skill") => Some(("Loading a skill", "slug")),
        ("relay-tools", "list_skills") => Some(("Listing skills", "")),
        ("relay-tools", "list_artifacts") => Some(("Listing artifacts", "query")),
        ("relay-tools", "search_docs") => Some(("Searching local docs", "query")),
        ("relay-tools", "get_capabilities") => Some(("Checking capabilities", "")),
        ("relay-tools", "list_automations") => Some(("Listing automations", "")),
        ("relay-tools", "create_automation") => Some(("Creating an automation", "name")),
        ("relay-tools", "update_automation") => Some(("Updating an automation", "name")),
        ("relay-tools", "delete_automation") => Some(("Deleting an automation", "automation_id")),
        ("relay-tools", "run_automation_now") => Some(("Running an automation", "automation_id")),
        ("relay-tools", "list_sessions") => Some(("Listing chats", "")),
        ("relay-tools", "read_session") => Some(("Reading a chat", "session_id")),
        ("relay-tools", "search_sessions") => Some(("Searching chats", "query")),
        ("relay-tools", "message_session") => Some(("Messaging a chat", "session_id")),
        ("relay-tools", "spawn_session") => Some(("Spawning an agent", "task")),
        // relay-browser
        ("relay-browser", "navigate") => Some(("Opening a page", "url")),
        ("relay-browser", "read_page") => Some(("Reading the page", "")),
        ("relay-browser", "observe") => Some(("Scanning the page", "")),
        ("relay-browser", "extract") => Some(("Extracting from the page", "prompt")),
        ("relay-browser", "click") => Some(("Clicking", "selector_or_description")),
        ("relay-browser", "type_text") => Some(("Typing", "text")),
        ("relay-browser", "scroll") => Some(("Scrolling", "")),
        ("relay-browser", "screenshot") => Some(("Taking a screenshot", "")),
        ("relay-browser", "find") => Some(("Finding on the page", "query")),
        ("relay-browser", "fill_form") => Some(("Filling a form", "")),
        ("relay-browser", "evaluate") => Some(("Running page script", "expression")),
        ("relay-browser", "press_key") => Some(("Pressing a key", "key")),
        ("relay-browser", "print_to_pdf") => Some(("Saving page as PDF", "")),
        ("relay-browser", "read_console") => Some(("Reading browser console", "")),
        ("relay-browser", "read_network") => Some(("Reading network log", "")),
        ("relay-browser", "list_tabs") => Some(("Listing browser tabs", "")),
        ("relay-browser", "new_tab") => Some(("Opening a tab", "url")),
        ("relay-browser", "switch_tab") => Some(("Switching tab", "")),
        ("relay-browser", "close_tab") => Some(("Closing tab", "")),
        // notion — its tools all carry a redundant `notion-` prefix; the
        // generic de-prefixer handles the rest.
        ("notion", "notion-get-tool-access") => Some(("Checking Notion access", "")),
        // gmail
        ("relay-tools", "gmail_search_threads") => Some(("Searching Gmail", "query")),
        ("relay-tools", "gmail_get_thread") => Some(("Reading a Gmail thread", "thread_id")),
        ("relay-tools", "gmail_get_message") => Some(("Reading a Gmail message", "message_id")),
        ("relay-tools", "gmail_list_labels") => Some(("Listing Gmail labels", "")),
        ("relay-tools", "gmail_send_message") => Some(("Sending an email", "subject")),
        ("relay-tools", "gmail_create_draft") => Some(("Creating an email draft", "subject")),
        ("relay-tools", "gmail_label_thread") => Some(("Updating Gmail labels", "thread_id")),
        _ => None,
    };
    let (title, detail) = match known {
        Some((title, key)) => (title.to_string(), s(&[key])),
        None => {
            // Generic: drop a redundant server prefix (notion-get-tool-access
            // → get-tool-access), humanize separators, keep vendor casing.
            let stripped = tool
                .strip_prefix(&format!("{server}_"))
                .or_else(|| tool.strip_prefix(&format!("{server}-")))
                .unwrap_or(tool);
            let mut human = stripped.replace(['-', '_'], " ").to_lowercase();
            if let Some(first) = human.get_mut(0..1) {
                first.make_ascii_uppercase();
            }
            (format!("{server_pretty} · {human}"), String::new())
        }
    };
    // Detail fallback: the first recognizable locator argument.
    let detail = if detail.is_empty() {
        s(&[
            "query", "url", "q", "file_id", "thread_id", "message_id", "spreadsheet_id",
            "document_id", "presentation_id", "event_id", "playlist_id", "space", "pattern",
            "name", "subject", "summary", "slug", "task", "path", "filename", "id",
        ])
    } else {
        detail
    };
    let mut card = json!({ "kind": "tool", "title": title });
    if !detail.is_empty() {
        // Keep cards readable — long ids/prompts truncate on a char boundary
        // with an ellipsis.
        let chars: Vec<char> = detail.chars().collect();
        if chars.len() > 80 {
            let short: String = chars[..80].iter().collect();
            card["detail"] = json!(format!("{short}…"));
        } else {
            card["detail"] = json!(detail);
        }
    }
    card
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mcp_tool_cards_are_human_readable() {
        // The screenshot case: Notion's hyphenated vendor tool name.
        let card = tool_meta_generic("mcp__notion__notion-get-tool-access", &serde_json::json!({}));
        assert_eq!(card["title"], "Checking Notion access");
        // Other Notion tools de-prefix and humanize generically.
        let card = tool_meta_generic("mcp__notion__notion-create-pages", &serde_json::json!({}));
        assert_eq!(card["title"], "Notion · Create pages");
        // High-traffic tools get hand-written verbs plus the useful argument.
        let card = tool_meta_generic(
            "mcp__relay-tools__gmail_search_threads",
            &serde_json::json!({ "query": "from:alice is:unread" }),
        );
        assert_eq!(card["title"], "Searching Gmail");
        assert_eq!(card["detail"], "from:alice is:unread");
        // Writes read as actions too.
        let card = tool_meta_generic(
            "mcp__relay-tools__gmail_send_message",
            &serde_json::json!({ "to": ["a@b.com"], "subject": "Hello there" }),
        );
        assert_eq!(card["title"], "Sending an email");
        assert_eq!(card["detail"], "Hello there");
        // Known detail keys win; unrecognized tools fall back to the locator
        // scan, and unknown servers pass through prettified.
        let card = tool_meta_generic(
            "mcp__gcalendar__gcalendar_create_event",
            &serde_json::json!({ "summary": "Dentist", "start": "2026-09-21T14:00:00" }),
        );
        assert_eq!(card["title"], "Calendar · Create event");
        assert_eq!(card["detail"], "Dentist");
        let card = tool_meta_generic("mcp__kiwi__search-flight", &serde_json::json!({}));
        assert_eq!(card["title"], "Kiwi · Search flight");
        // Long details truncate on a char boundary.
        let card = tool_meta_generic(
            "mcp__relay-tools__generate_image",
            &serde_json::json!({ "prompt": "x".repeat(200) }),
        );
        assert_eq!(card["detail"].as_str().unwrap().chars().count(), 81); // 80 + ellipsis
    }
}
