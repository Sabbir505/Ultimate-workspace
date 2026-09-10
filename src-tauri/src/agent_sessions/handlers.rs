//! per-harness event handlers (kimi/opencode/pi/commandcode) + subagent spawn/usage helpers — extracted carve of agent_sessions (see
//! mod.rs). `use super::*` inherits the parent's imports and private
//! helpers; items are pub(super) and glob-reimported by the parent.
use super::*;
/// Kimi stream-json: `{"role":"assistant","content":…}` messages, tool events
/// (see tool_marker_kimi), and a `session.resume_hint` meta line carrying the
/// resume id. (Verified against v0.31.1 output.)
/// Shared subagent-spawn path for the harness event handlers: extract the
/// claude-"Task"-style role/task/prompt from the tool input, emit the
/// SubAgent spawn marker into the stream.

pub(super) fn emit_subagent_spawn(
    tools: &mut ToolTracker,
    full: &mut String,
    app: Option<&AppHandle>,
    sid: &str,
    name: &str,
    value: Value,
    inp: &Value,
) {
    let role = inp
        .get("subagent_type")
        .and_then(|v| v.as_str())
        .unwrap_or("agent")
        .to_string();
    let task = inp
        .get("description")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let prompt = inp
        .get("prompt")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let marker = tools.subagent_use(name, value, app, sid, &role, &task, &prompt, "", false);
    full.push_str(&marker);
    emit_token(app, sid, &marker);
}

/// Shared usage-application tail for the harness event handlers: OR-merge
/// the per-stream running totals into the turn accumulators and refresh the
/// live IN/CACHE chips (harnesses report running totals — replace, never
/// accumulate). Callers differ only in WHERE they read the numbers.
pub(super) fn merge_round_usage(
    sid: &str,
    in_val: Option<i64>,
    out_val: Option<i64>,
    cr: Option<i64>,
    cc: Option<i64>,
    input: &mut Option<i64>,
    output: &mut Option<i64>,
    cache_read: &mut Option<i64>,
    cache_creation: &mut Option<i64>,
) {
    *input = in_val.or(*input);
    *output = out_val.or(*output);
    *cache_read = cr.or(*cache_read);
    *cache_creation = cc.or(*cache_creation);
    crate::chat::turn_perf::set_active_round_usage(
        sid,
        (*input).unwrap_or(0),
        (*cache_read).unwrap_or(0),
        (*cache_creation).unwrap_or(0),
        false,
    );
}

pub(super) fn handle_kimi_event(
    app: Option<&AppHandle>,
    sid: &str,
    v: &Value,
    full: &mut String,
    session_cell: &Arc<Mutex<Option<String>>>,
    input: &mut Option<i64>,
    output: &mut Option<i64>,
    cache_read: &mut Option<i64>,
    cache_creation: &mut Option<i64>,
    tools: &mut ToolTracker,
) {
    let role = v.get("role").and_then(|r| r.as_str()).unwrap_or("");
    match role {
        "assistant" => {
            // Assistant frames are model output — open/keep the generation
            // window so decode time (→ tok/s) is measurable.
            crate::chat::turn_perf::begin_active_gen(sid);
            if let Some(text) = v.get("content").and_then(|c| c.as_str()) {
                full.push_str(text);
                emit_token(app, sid, text);
            }
            // Tool calls ride along as structured blocks when present.
            if let Some(calls) = v.get("tool_calls").and_then(|t| t.as_array()) {
                for c in calls.iter() {
                    if let Some((name, values)) = tool_meta_kimi(c) {
                        if is_subagent_tool_name(&name) {
                            let input = c.get("function").and_then(|f| f.get("arguments"));
                            let args = match input {
                                Some(Value::String(s)) => {
                                    serde_json::from_str::<Value>(s).unwrap_or(json!({}))
                                }
                                Some(val) => val.clone(),
                                None => json!({}),
                            };
                            emit_subagent_spawn(
                                tools,
                                full,
                                app,
                                sid,
                                &name,
                                values.into_iter().next().unwrap_or(json!({})),
                                &args,
                            );
                        } else {
                            let marker = tools.tool_use(&name, values);
                            full.push_str(&marker);
                            emit_token(app, sid, &marker);
                        }
                    }
                }
                // A frame carrying tool_calls ends the model's round — the
                // CLI now executes the tools; close the window here so the
                // tool wait isn't billed as decode time.
                if !calls.is_empty() {
                    crate::chat::turn_perf::end_active_gen(sid);
                }
            }
        }
        // Tool results: kimi delivers one per call, in call order. Attach shell
        // output to its step; non-shell results are consumed for ordering only.
        "tool" => {
            // Defensive: a tool result also closes any open window (covers
            // streams where the tool_calls frame was missed).
            crate::chat::turn_perf::end_active_gen(sid);
            let text = extract_result_text(v.get("content"));
            if let Some(marker) = tools.tool_result(&text, false, app, sid, None) {
                full.push_str(&marker);
                emit_token(app, sid, &marker);
            }
        }
        "meta" => {
            if v.get("type").and_then(|t| t.as_str()) == Some("session.resume_hint") {
                if let Some(id) = v.get("session_id").and_then(|s| s.as_str()) {
                    if let Ok(mut g) = session_cell.lock() {
                        *g = Some(id.to_string());
                    }
                }
            }
            if v.get("type").and_then(|t| t.as_str()) == Some("usage") {
                if let Some(u) = v.get("usage") {
                    // Kimi rides on Anthropic-shaped provider reports; match
                    // both the snake_case and camelCase spellings rather
                    // than guess one.
                    merge_round_usage(
                        sid,
                        u.get("input_tokens").and_then(|t| t.as_i64()),
                        u.get("output_tokens").and_then(|t| t.as_i64()),
                        usage_i64(
                            u,
                            &[
                                "cache_read_input_tokens",
                                "cacheReadInputTokens",
                                "cacheRead",
                            ],
                        ),
                        usage_i64(
                            u,
                            &[
                                "cache_creation_input_tokens",
                                "cacheCreationInputTokens",
                                "cacheWrite",
                            ],
                        ),
                        input,
                        output,
                        cache_read,
                        cache_creation,
                    );
                }
            }
        }
        _ => {}
    }
}

/// Parse TodoWrite input and emit the FULL normalized todo list as a
/// `chat:plan-updated` event, so harness sessions (Claude Code etc. — which
/// do their own planning/task tracking) get the same Progress-list rendering
/// as the built-in agent. Claude Code rewrites the whole list each call, so
/// the event replaces the session's list authoritatively. Shared by the
/// per-turn and persistent-server OpenCode paths.
pub(super) fn emit_todowrite_steps(app: Option<&AppHandle>, sid: &str, name: &str, inp: &Value) {
    if !name.eq_ignore_ascii_case("TodoWrite") {
        return;
    }
    let Some(todos) = inp.get("todos").and_then(|v| v.as_array()) else {
        return;
    };
    let items: Vec<crate::types::PlanTodo> = todos
        .iter()
        .filter_map(|todo| {
            let content = todo
                .get("content")
                .and_then(|v| v.as_str())?
                .trim()
                .to_string();
            if content.is_empty() {
                return None;
            }
            let status = match todo.get("status").and_then(|v| v.as_str()) {
                Some("completed") => "completed",
                Some("in_progress") => "in_progress",
                _ => "pending",
            };
            let active_form = todo
                .get("activeForm")
                .or_else(|| todo.get("active_form"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .filter(|s| !s.is_empty());
            Some(crate::types::PlanTodo {
                content,
                status: status.to_string(),
                active_form,
            })
        })
        .collect();
    if items.is_empty() {
        return;
    }
    if let Some(app_handle) = app {
        let _ = app_handle.emit(
            "chat:plan-updated",
            crate::types::ChatPlanUpdatedPayload {
                chat_session_id: sid.to_string(),
                todos: items,
            },
        );
    }
}

/// OpenCode `--format json` events. (Shapes verified against `opencode run`
/// and the `opencode serve` SSE stream — both normalize onto these shapes.)
pub(super) fn handle_opencode_event(
    app: Option<&AppHandle>,
    sid: &str,
    v: &Value,
    full: &mut String,
    session_cell: &Arc<Mutex<Option<String>>>,
    input: &mut Option<i64>,
    output: &mut Option<i64>,
    cache_read: &mut Option<i64>,
    cache_creation: &mut Option<i64>,
    cost: &mut Option<f64>,
    last_text: &mut String,
    last_reasoning: &mut String,
    in_think: &mut bool,
    tools: &mut ToolTracker,
) {
    match v.get("type").and_then(|t| t.as_str()) {
        // {"type":"text","part":{"text":…}} — assistant text chunk. In `run`
        // mode opencode buffers deltas internally and fires one event per
        // completed text part with the FULL snapshot of that part's text, so
        // emit/append only the new suffix; a snapshot that doesn't extend the
        // previous one is a new part and is emitted whole. (Appending the
        // whole snapshot to `full` would duplicate it in the persisted
        // message.)
        Some("text") => {
            // Model output resumed — open/keep the generation window (per-step
            // windows: tool parts and step-finish close it).
            crate::chat::turn_perf::begin_active_gen(sid);
            // Text after reasoning closes the thinking block — same contract
            // as claude's stream reader (an unclosed <think> would swallow
            // the answer into the collapsible block).
            if *in_think {
                full.push_str("</think>");
                emit_token(app, sid, "</think>");
                *in_think = false;
                last_reasoning.clear();
            }
            if let Some(text) = v.pointer("/part/text").and_then(|t| t.as_str()) {
                let suffix = text.strip_prefix(last_text.as_str()).unwrap_or(text);
                if !suffix.is_empty() {
                    full.push_str(suffix);
                    emit_token(app, sid, suffix);
                }
                last_text.clear();
                last_text.push_str(text);
            }
        }
        // {"type":"reasoning","part":{"text":…}} — thinking part (server
        // SSE). Same full-snapshot-suffix rule as text; wrapped in
        // <think>…</think> so the frontend shows a live collapsible block.
        Some("reasoning") => {
            crate::chat::turn_perf::begin_active_gen(sid);
            if let Some(text) = v.pointer("/part/text").and_then(|t| t.as_str()) {
                if !*in_think {
                    full.push_str("<think>");
                    emit_token(app, sid, "<think>");
                    *in_think = true;
                    last_reasoning.clear();
                }
                let suffix = text.strip_prefix(last_reasoning.as_str()).unwrap_or(text);
                if !suffix.is_empty() {
                    full.push_str(suffix);
                    emit_token(app, sid, suffix);
                }
                last_reasoning.clear();
                last_reasoning.push_str(text);
            }
        }
        // {"type":"tool_use","part":{"tool":…,"state":{"input":…}}}
        Some("tool_use") => {
            // Tool execution begins — close the generation window so the tool
            // wait stays out of decode time/LLM time.
            crate::chat::turn_perf::end_active_gen(sid);
            let part = v.get("part").cloned().unwrap_or(json!({}));
            let name = part.get("tool").and_then(|t| t.as_str()).unwrap_or("tool");
            let inp = part.pointer("/state/input").cloned().unwrap_or(json!({}));
            // TodoWrite JSON emits structured plan-step progress so the
            // frontend tracks individual task items instead of a generic
            // "Updating task list" marker.
            emit_todowrite_steps(app, sid, name, &inp);
            let value = tool_meta_generic(name, &inp);
            if is_subagent_tool_name(name) {
                // Subagent spawn (claude "Agent"/"Task"): extract
                // role/task/prompt and emit a spawn event.
                emit_subagent_spawn(tools, full, app, sid, name, value, &inp);
            } else {
                // OpenCode reports a tool's completed output inline on the same
                // part (`state.output` / `state.error`); attach it for shell tools.
                let out_text = part.pointer("/state/output").and_then(|o| o.as_str());
                let err_text = part.pointer("/state/error").and_then(|e| e.as_str());
                let marker = tools.tool_use_with_output(name, value, out_text, err_text);
                full.push_str(&marker);
                emit_token(app, sid, &marker);
            }
        }
        // Session id / usage surfaces on step-finish.
        Some("step_finish") => {
            // The model round ended — close its generation window.
            crate::chat::turn_perf::end_active_gen(sid);
            if let Ok(mut g) = session_cell.lock() {
                if g.is_none() {
                    if let Some(id) = v.get("sessionID").and_then(|s| s.as_str()) {
                        *g = Some(id.to_string());
                    }
                }
            }
            if let Some(u) = v.pointer("/part/tokens") {
                // OpenCode nests cache counters under `cache` on the tokens
                // object; match the flat spellings too for older versions.
                merge_round_usage(
                    sid,
                    u.get("input").and_then(|t| t.as_i64()),
                    u.get("output").and_then(|t| t.as_i64()),
                    u.get("cacheRead")
                        .and_then(|t| t.as_i64())
                        .or_else(|| u.pointer("/cache/read").and_then(|t| t.as_i64())),
                    u.get("cacheWrite")
                        .and_then(|t| t.as_i64())
                        .or_else(|| u.pointer("/cache/write").and_then(|t| t.as_i64())),
                    input,
                    output,
                    cache_read,
                    cache_creation,
                );
            }
            // Free models report cost 0; Zen/relay models report real dollars.
            *cost = v.pointer("/part/cost").and_then(|c| c.as_f64()).or(*cost);
        }
        // Any event carrying the session id is a chance to capture it.
        _ => {
            if let Ok(mut g) = session_cell.lock() {
                if g.is_none() {
                    if let Some(id) = v.get("sessionID").and_then(|s| s.as_str()) {
                        *g = Some(id.to_string());
                    }
                }
            }
        }
    }
}

/// pi-lineage `--mode json` events (pi and omp — omp is a pi fork with the
/// same wire protocol; shapes verified against `pi -p --mode json` and the
/// upstream `docs/json.md`). Line 1 is the session header
/// (`{"type":"session","id":…}`); then JSONL deltas: `message_update` carries
/// cumulative `usage` plus an `assistantMessageEvent` (`text_delta`,
/// `thinking_delta`, `done`, `error`); tool runs surface as
/// `tool_execution_start/end`. Any other event type (omp's
/// `advisor_cost_changed`, compaction notices, …) is ignored.
pub(super) fn handle_pi_event(
    app: Option<&AppHandle>,
    sid: &str,
    v: &Value,
    full: &mut String,
    session_cell: &Arc<Mutex<Option<String>>>,
    input: &mut Option<i64>,
    output: &mut Option<i64>,
    cache_read: &mut Option<i64>,
    cache_creation: &mut Option<i64>,
    cost: &mut Option<f64>,
    in_think: &mut bool,
    tools: &mut ToolTracker,
) {
    match v.get("type").and_then(|t| t.as_str()) {
        // Session header line: our chance to bind the CLI's own session id
        // for resume (also accepted from any later event carrying `id`).
        Some("session") => {
            if let Some(id) = v.get("id").and_then(|s| s.as_str()) {
                if let Ok(mut g) = session_cell.lock() {
                    *g = Some(id.to_string());
                }
            }
        }
        Some("message_update") => {
            // Cumulative provider-reported usage; cost.total is relay-reported
            // and may stay 0 — finish_turn falls back to the session's model.
            if let Some(u) = v.get("usage") {
                // pi/omp report the cache halves alongside input/output
                // (cacheRead/cacheWrite); dropping them once made these
                // turns look nearly token-free.
                merge_round_usage(
                    sid,
                    u.get("input").and_then(|t| t.as_i64()),
                    u.get("output").and_then(|t| t.as_i64()),
                    usage_i64(u, &["cacheRead", "cache_read"]),
                    usage_i64(u, &["cacheWrite", "cache_write"]),
                    input,
                    output,
                    cache_read,
                    cache_creation,
                );
                *cost = u
                    .pointer("/cost/total")
                    .and_then(|c| c.as_f64())
                    .filter(|c| *c > 0.0)
                    .or(*cost);
            }
            let Some(ev) = v.get("assistantMessageEvent") else {
                return;
            };
            match ev.get("type").and_then(|t| t.as_str()) {
                Some("text_delta") => {
                    // Model output resumed — open/keep the generation window.
                    crate::chat::turn_perf::begin_active_gen(sid);
                    // Text closes an open thinking block — same contract as
                    // claude's stream reader (an unclosed <think> would
                    // swallow the answer into the collapsible block).
                    if *in_think {
                        full.push_str("</think>");
                        emit_token(app, sid, "</think>");
                        *in_think = false;
                    }
                    if let Some(delta) = ev.get("delta").and_then(|d| d.as_str()) {
                        full.push_str(delta);
                        emit_token(app, sid, delta);
                    }
                }
                Some("thinking_delta") => {
                    crate::chat::turn_perf::begin_active_gen(sid);
                    if !*in_think {
                        full.push_str("<think>");
                        emit_token(app, sid, "<think>");
                        *in_think = true;
                    }
                    if let Some(delta) = ev.get("delta").and_then(|d| d.as_str()) {
                        full.push_str(delta);
                        emit_token(app, sid, delta);
                    }
                }
                // Stream-level failure: surface the provider's message inline
                // so the turn doesn't close with an empty reply.
                Some("error") => {
                    let msg = pi_message_text(ev.get("error"))
                        .unwrap_or_else(|| "the CLI reported an error".to_string());
                    full.push_str(&msg);
                    emit_token(app, sid, &msg);
                }
                _ => {}
            }
        }
        // A tool starts executing with its complete parsed arguments.
        Some("tool_execution_start") => {
            // Tool execution begins — close the generation window so the tool
            // wait stays out of decode time/LLM time.
            crate::chat::turn_perf::end_active_gen(sid);
            let name = v.get("toolName").and_then(|t| t.as_str()).unwrap_or("tool");
            let inp = v.get("args").cloned().unwrap_or(json!({}));
            emit_todowrite_steps(app, sid, name, &inp);
            let value = tool_meta_generic(name, &inp);
            if is_subagent_tool_name(name) {
                emit_subagent_spawn(tools, full, app, sid, name, value, &inp);
            } else {
                // pi reports the tool's output separately (tool_execution_end),
                // so the start marker queues a pending slot for tool_result to
                // match — the plain tool_use, NOT the self-contained variant.
                let marker = tools.tool_use(name, vec![value]);
                full.push_str(&marker);
                emit_token(app, sid, &marker);
            }
        }
        // The tool finished: attach its output to the step for shell tools.
        Some("tool_execution_end") => {
            let text = extract_result_text(v.get("result"));
            let is_error = v.get("isError").and_then(|e| e.as_bool()).unwrap_or(false);
            if let Some(marker) = tools.tool_result(&text, is_error, app, sid, None) {
                full.push_str(&marker);
                emit_token(app, sid, &marker);
            }
        }
        _ => {}
    }
}

/// Flatten an assistant message value (`{content:[{type:"text",text},…]}`) to
/// its text blocks — used for pi error events, which carry a full
/// AssistantMessage rather than a plain string.
pub(super) fn pi_message_text(msg: Option<&Value>) -> Option<String> {
    let msg = msg?;
    let content = msg.get("content")?;
    if let Some(text) = content.as_str() {
        return (!text.trim().is_empty()).then(|| text.to_string());
    }
    let parts = content.as_array()?;
    let text = parts
        .iter()
        .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
        .collect::<Vec<_>>()
        .join("\n");
    (!text.trim().is_empty()).then(|| text)
}

/// CommandCode `-p --output-format json` NDJSON events. Verified live
/// (v1.44): frames are `{"type":"event","event":{…}}` wrapping inner
/// AgentEvents (`run_start` with `sessionId`, `turn_start`, `message_start`,
/// `model_request_start`, `tool_running` with `toolCallId`/`toolName`,
/// `run_error` with `error.message`, `run_end` with
/// `result.{finalText,usage}`), then one final
/// `{"type":"result","subtype":"success|error|max_turns",…}` line carrying
/// `sessionId`, `usage.{inputTokens,outputTokens,…}` and `finalText`. The
/// docs don't enumerate the streaming delta type names, so text/thinking
/// deltas are matched liberally (any inner event with a `delta` string whose
/// type mentions text/reasoning) and the `result.finalText` line is used as a
/// catch-up — any suffix the delta events never delivered still lands, so the
/// reply can't be lost to a renamed event type.
pub(super) fn handle_commandcode_event(
    app: Option<&AppHandle>,
    sid: &str,
    v: &Value,
    full: &mut String,
    session_cell: &Arc<Mutex<Option<String>>>,
    input: &mut Option<i64>,
    output: &mut Option<i64>,
    cache_read: &mut Option<i64>,
    cache_creation: &mut Option<i64>,
    in_think: &mut bool,
    tools: &mut ToolTracker,
    seen_tools: &mut std::collections::HashSet<String>,
) {
    // Capture the CLI session id from any frame that carries one.
    if let Some(id) = v.get("sessionId").and_then(|s| s.as_str()) {
        if let Ok(mut g) = session_cell.lock() {
            if g.is_none() || v.get("type").and_then(|t| t.as_str()) == Some("result") {
                *g = Some(id.to_string());
            }
        }
    }
    match v.get("type").and_then(|t| t.as_str()) {
        Some("event") => {
            let Some(inner) = v.get("event") else { return };
            let ty = inner.get("type").and_then(|t| t.as_str()).unwrap_or("");
            match ty {
                "run_error" => {
                    let msg = inner
                        .pointer("/error/message")
                        .and_then(|m| m.as_str())
                        .unwrap_or("the CLI reported an error");
                    full.push_str(msg);
                    emit_token(app, sid, msg);
                }
                "run_end" => {
                    if let Some(u) = inner.pointer("/result/usage") {
                        merge_round_usage(
                            sid,
                            u.get("inputTokens").and_then(|t| t.as_i64()),
                            u.get("outputTokens").and_then(|t| t.as_i64()),
                            usage_i64(u, &["cacheReadTokens", "cacheRead"]),
                            usage_i64(u, &["cacheWriteTokens", "cacheWrite"]),
                            input,
                            output,
                            cache_read,
                            cache_creation,
                        );
                    }
                }
                _ => {
                    // Tool frames: every variant carries toolCallId+toolName;
                    // mark once per call (the start marker), results attach via
                    // the pi-style completion frames when present.
                    if let (Some(call_id), Some(name)) = (
                        inner.get("toolCallId").and_then(|t| t.as_str()),
                        inner.get("toolName").and_then(|t| t.as_str()),
                    ) {
                        // Tool execution begins — close the generation window.
                        crate::chat::turn_perf::end_active_gen(sid);
                        if seen_tools.insert(call_id.to_string()) {
                            let inp = inner
                                .get("args")
                                .cloned()
                                .unwrap_or(inner.get("input").cloned().unwrap_or(json!({})));
                            emit_todowrite_steps(app, sid, name, &inp);
                            let value = tool_meta_generic(name, &inp);
                            let marker = tools.tool_use(name, vec![value]);
                            full.push_str(&marker);
                            emit_token(app, sid, &marker);
                        }
                        return;
                    }
                    // Streaming deltas (liberal match — see doc comment).
                    if let Some(delta) = inner.get("delta").and_then(|d| d.as_str()) {
                        // Model output — open/keep the generation window.
                        crate::chat::turn_perf::begin_active_gen(sid);
                        let thinking = ty.contains("think") || ty.contains("reason");
                        if thinking && !*in_think {
                            full.push_str("<think>");
                            emit_token(app, sid, "<think>");
                            *in_think = true;
                        } else if !thinking && *in_think {
                            full.push_str("</think>");
                            emit_token(app, sid, "</think>");
                            *in_think = false;
                        }
                        full.push_str(delta);
                        emit_token(app, sid, delta);
                    }
                }
            }
        }
        Some("result") => {
            // Usage is authoritative here (the docs: totals on the result
            // line). camelCase — commandcode, unlike claude, doesn't use
            // snake_case usage fields.
            if let Some(u) = v.get("usage") {
                merge_round_usage(
                    sid,
                    u.get("inputTokens").and_then(|t| t.as_i64()),
                    u.get("outputTokens").and_then(|t| t.as_i64()),
                    usage_i64(u, &["cacheReadTokens", "cacheRead"]),
                    usage_i64(u, &["cacheWriteTokens", "cacheWrite"]),
                    input,
                    output,
                    cache_read,
                    cache_creation,
                );
            }
            if v.get("subtype").and_then(|s| s.as_str()) == Some("error") {
                if let Some(err) = v.get("error").and_then(|e| e.as_str()) {
                    if !err.trim().is_empty() && !full.contains(err) {
                        full.push_str(err);
                        emit_token(app, sid, err);
                    }
                }
            }
            // finalText catch-up: append whatever the delta events never
            // delivered (nothing when streaming worked end-to-end).
            if let Some(text) = v.get("finalText").and_then(|t| t.as_str()) {
                if !text.is_empty() {
                    let suffix = text.strip_prefix(full.as_str()).unwrap_or(text);
                    if !suffix.is_empty() {
                        full.push_str(suffix);
                        emit_token(app, sid, suffix);
                    }
                }
            }
        }
        _ => {}
    }
}
