//! Background extraction orchestration (design §7.1) + the shared write path
//! used by the `memory_save` tool (§12.1). Spawned post-turn — NEVER awaited
//! on the reply path (P2). One LLM call for extraction + one per candidate
//! for the judge; embedding via the local sidecar (optional — store/retrieval
//! degrade gracefully without it).

use crate::chat::commands::{anthropic_oneshot, openai_oneshot};
use crate::chat::providers::{AnthropicProvider, OpenAIProvider, OpenRouterProvider};
use crate::db;
use crate::memory::consolidate::{apply_judge_op, judge_user_message, parse_judge_op, JudgeInput};
use crate::memory::extract::{
    extraction_user_message, filter_candidates, parse_candidates, EXTRACTION_SYSTEM,
};
use crate::memory::model::{MemoryCandidate, SIMILAR_TOP_S, SIMILARITY_GATE};
use tauri::{AppHandle, Manager};
use std::sync::Mutex as StdMutex;

/// Post-turn hook: fire-and-forget extraction for a finished chat turn.
/// Called from the assistant-persist point in `chat/mod.rs`. All failures are
/// logged and swallowed — a memory problem must never surface as a chat
/// error.
pub fn spawn_turn_extraction(app: &AppHandle, chat_session_id: &str) {
    let app = app.clone();
    let sid = chat_session_id.to_string();
    tokio::spawn(async move {
        if let Err(e) = extract_session(&app, &sid).await {
            eprintln!("[memory] extraction failed for {sid}: {e}");
        }
    });
}

/// In-process debounce (design §7.1): at most one extraction per session per
/// window. App-lifetime only — restarting the app just re-checks the cursor,
/// which is the real idempotency guarantee.
fn debounce_ok(sid: &str) -> bool {
    static LAST: StdMutex<Option<std::collections::HashMap<String, i64>>> = StdMutex::new(None);
    let now = crate::db::now_ts();
    let mut guard = LAST.lock().unwrap();
    let map = guard.get_or_insert_with(std::collections::HashMap::new);
    if let Some(t) = map.get(sid) {
        if now - *t < 60 {
            return false;
        }
    }
    map.insert(sid.to_string(), now);
    true
}

/// Extract memories for everything new in a session since the cursor.
pub async fn extract_session(app: &AppHandle, chat_session_id: &str) -> Result<(), String> {
    let db = app.state::<crate::DbState>();

    // Fast exits under a short lock: feature flag + cursor + debounce.
    let (cursor, project_id) = {
        let conn = db.0.lock();
        if !crate::memory::memory_enabled(&conn) {
            return Ok(());
        }
        let proj = db::get_chat_session(&conn, chat_session_id)
            .map_err(|e| e.to_string())?
            .and_then(|s| s.project_id);
        (db::get_cursor(&conn, chat_session_id).map_err(|e| e.to_string())?, proj)
    };
    if !debounce_ok(chat_session_id) {
        return Ok(());
    }

    // Transcript window since the cursor (paged read, cheap under the lock).
    let window: Vec<(i64, String, String)> = {
        let conn = db.0.lock();
        let all = db::list_active_chat_messages(&conn, chat_session_id)
            .map_err(|e| e.to_string())?;
        all.into_iter()
            .filter(|m| m.id > cursor && !m.content.trim().is_empty())
            .map(|m| (m.id, m.role, m.content))
            .collect::<Vec<_>>()
    };
    let window: Vec<_> = window.into_iter().rev().take(12).collect::<Vec<_>>().into_iter().rev().collect();
    // Need at least one user message with substance — an empty/error turn has
    // nothing to remember.
    if !window.iter().any(|( _, r, c)| r == "user" && c.len() > 24) {
        return Ok(());
    }

    // LLM resolution: same provider/model/key plumbing as generate_chat_title.
    let (provider_str, model, api_key, base_url) = {
        let conn = db.0.lock();
        let cs = db::get_chat_session(&conn, chat_session_id)
            .map_err(|e| e.to_string())?
            .ok_or("chat session not found")?;
        let key = crate::secrets::get_chat_api_key(&conn, &cs.provider).unwrap_or_default();
        let base = db::get_setting(&conn, &format!("chat.{}.base_url", cs.provider))
            .map_err(|e| e.to_string())?;
        // Dedicated extraction model override (cheap local/cloud model).
        let session_model = if cs.model.trim().is_empty() {
            db::get_setting(&conn, &format!("chat.{}.model", cs.provider)).unwrap_or(None)
        } else {
            Some(cs.model.clone())
        };
        let model = db::get_setting(&conn, crate::memory::SETTING_EXTRACT_MODEL)
            .unwrap_or(None)
            .filter(|m| !m.trim().is_empty())
            .or(session_model)
            .unwrap_or_default();
        (cs.provider, model, key, base)
    };
    if model.trim().is_empty() || (api_key.is_empty() && provider_str != "local_gguf") {
        return Ok(());
    }

    // Rolling summary: the two messages just before the window (Mem0's
    // rolling-summary input, cheap version — no extra LLM call).
    let rolling_summary: Option<String> = {
        let conn = db.0.lock();
        let all = db::list_active_chat_messages(&conn, chat_session_id)
            .map_err(|e| e.to_string())?;
        let prior: Vec<_> = all
            .into_iter()
            .filter(|m| m.id <= cursor)
            .rev()
            .take(2)
            .collect();
        if prior.is_empty() {
            None
        } else {
            let joined: String = prior
                .iter()
                .rev()
                .map(|m| {
                    let who = if m.role == "user" { "User" } else { "Assistant" };
                    format!("{who}: {}", crate::util::truncate_chars(m.content.trim(), 400))
                })
                .collect::<Vec<_>>()
                .join("\n");
            Some(joined)
        }
    };

    let user_msg = extraction_user_message(rolling_summary.as_deref(), &window);
    let raw = oneshot(app, &provider_str, &api_key, base_url.as_deref(), &model, EXTRACTION_SYSTEM, &user_msg, 2048).await?;

    let cands = parse_candidates(&raw);
    if cands.is_empty() {
        // Nothing memorable — still advance the cursor so we don't re-scan.
        let max_id = window.last().map(|(id, _, _)| *id).unwrap_or(cursor);
        let conn = db.0.lock();
        db::upsert_cursor(&conn, chat_session_id, max_id).map_err(|e| e_tostring(e))?;
        return Ok(());
    }

    // Cheap deterministic filters (secrets, shape, calibration).
    let report = filter_candidates(cands);
    if report.dropped_secrets > 0 {
        let conn = db.0.lock();
        let _ = db::log_memory_op(&conn, "filter", Some(chat_session_id), "", "DROP_SECRET",
                                  &[], &format!("{} candidate(s) contained credential-shaped text", report.dropped_secrets));
    }
    // Importance calibration guard (§8.2): a batch that rates everything
    // urgent gets uniformly capped.
    let mut cands = report.kept;
    let high = cands.iter().filter(|c| c.importance >= 8).count();
    if cands.len() >= 3 && high * 10 > cands.len() * 3 {
        for c in &mut cands {
            c.importance = c.importance.min(7);
        }
    }
    if cands.is_empty() {
        return Ok(());
    }

    // Embed the candidates once (sidecar optional).
    let embedding_base = embedding_base_url(app);
    let n = cands.len();
    let embeddings: Vec<Option<Vec<f32>>> = if n == 0 {
        Vec::new()
    } else if let Some(base) = &embedding_base {
        match crate::chat::local_models::embed_texts(
            base,
            &cands.iter().map(|c| c.content.clone()).collect::<Vec<_>>(),
        )
        .await {
            Ok(vs) => {
                let mut out: Vec<Option<Vec<f32>>> = vs.into_iter().map(Some).collect();
                out.resize(n, None); // sidecar returned fewer vectors than texts
                out
            }
            Err(_) => vec![None; n],
        }
    } else {
        vec![None; n]
    };

    // Judge + apply, one candidate at a time. The DB lock is taken per
    // candidate (never held across the judge await).
    let mut results: Vec<(String, String)> = Vec::new(); // (op, content)
    for (cand, emb) in cands.iter().zip(embeddings) {
        let similar = {
            let conn = db.0.lock();
            fetch_similar(&conn, "default", project_id.as_deref(), cand, emb.as_deref())
        };
        let judge_msg = judge_user_message(&JudgeInput { candidate: cand, similar: &similar });
        let raw = oneshot(app, &provider_str, &api_key, base_url.as_deref(), &model, crate::memory::consolidate::JUDGE_SYSTEM, &judge_msg, 512).await?;
        let valid_ids: Vec<String> = similar.iter().map(|(m, _)| m.id.clone()).collect();
        let op = parse_judge_op(&raw, &valid_ids);
        let applied = {
            let conn = db.0.lock();
            let applied = apply_judge_op(&conn, &JudgeInput { candidate: cand, similar: &similar }, &op,
                                         Some(chat_session_id), project_id.as_deref(), emb, crate::db::now_ts())
                .map_err(|e| e_tostring(e))?;
            let cand_json = serde_json::to_string(cand).unwrap_or_default();
            let _ = db::log_memory_op(&conn, "judge", Some(chat_session_id), &cand_json, &applied.op, &applied.target_ids, "");
            applied
        };
        results.push((applied.op, cand.content.clone()));
    }

    // Advance the cursor only after the batch committed (§7.4 idempotency).
    let max_id = window.last().map(|(id, _, _)| *id).unwrap_or(cursor);
    {
        let conn = db.0.lock();
        db::upsert_cursor(&conn, chat_session_id, max_id).map_err(|e| e_tostring(e))?;
    }
    eprintln!("[memory] extracted {}: {} candidates → {}", chat_session_id, results.len(),
              results.iter().map(|(op, _)| op.as_str()).collect::<Vec<_>>().join(","));

    // Reflection (§8.4): same background task, after the extraction commit —
    // usually a no-op threshold check. Failure never propagates: reflection
    // is an optimization, not a correctness requirement.
    if let Err(e) = maybe_reflect(
        app,
        &provider_str,
        &api_key,
        base_url.as_deref(),
        &model,
        project_id.as_deref(),
    )
    .await
    {
        eprintln!("[memory] reflection skipped: {e}");
    }
    Ok(())
}

/// Reflection pass (MEMORY_DESIGN_ARCHITECTURE.md §8.4): when unreflected
/// importance sum ≥ 150 (or ≥ 25 facts), synthesize up to 3 cited insights
/// from the top-importance sample in two LLM calls, store them as
/// `origin: reflection` memories with copied evidence, and mark the sample
/// reflected. Runs entirely in the background worker.
async fn maybe_reflect(
    app: &AppHandle,
    provider: &str,
    api_key: &str,
    base_url: Option<&str>,
    model: &str,
    project_id: Option<&str>,
) -> Result<(), String> {
    let db = app.state::<crate::DbState>();
    let input = {
        let conn = db.0.lock();
        crate::memory::reflect::reflection_due(&conn, "default", project_id)
            .map_err(|e| e_tostring(e))?
    };
    let Some(input) = input else {
        return Ok(());
    };

    // Step 1: salient synthesis questions (Generative Agents' 3-questions).
    let raw_q = oneshot(
        app,
        provider,
        api_key,
        base_url,
        model,
        crate::memory::reflect::QUESTIONS_SYSTEM,
        &crate::memory::reflect::questions_user_message(&input),
        256,
    )
    .await?;
    let questions = crate::memory::reflect::parse_questions(&raw_q);

    // Step 2 context: per-question FTS hits as extra retrieval lenses.
    let extra_context: Vec<(String, Vec<String>)> = if questions.is_empty() {
        Vec::new()
    } else {
        let conn = db.0.lock();
        questions
            .iter()
            .map(|q| {
                let hits = db::search_memories_fts(&conn, "default", project_id, q, 4)
                    .unwrap_or_default()
                    .into_iter()
                    .map(|m| m.content)
                    .collect();
                (q.clone(), hits)
            })
            .collect()
    };

    // Step 3: cited insights.
    let raw_i = oneshot(
        app,
        provider,
        api_key,
        base_url,
        model,
        crate::memory::reflect::INSIGHTS_SYSTEM,
        &crate::memory::reflect::insights_user_message(&input, &questions, &extra_context),
        512,
    )
    .await?;
    let insights = crate::memory::reflect::parse_insights(&raw_i);
    if insights.is_empty() {
        // Mark the sample reflected anyway so the trigger doesn't re-fire on
        // the same pool every turn with a model that can't synthesize.
        let conn = db.0.lock();
        let ids: Vec<String> = input.sample.iter().map(|m| m.id.clone()).collect();
        db::mark_reflected(&conn, &ids).map_err(|e| e_tostring(e))?;
        return Ok(());
    }

    let (applied, sample_len) = {
        let conn = db.0.lock();
        let n = crate::memory::reflect::apply_reflection(
            &conn,
            "default",
            project_id,
            &input.sample,
            &insights,
            None,
            crate::db::now_ts(),
        )
        .map_err(|e| e_tostring(e))?;
        (n, input.sample.len())
    };
    eprintln!(
        "[memory] reflection: {sample_len} facts → {applied} insights ({} questions)",
        questions.len()
    );
    Ok(())
}

fn e_tostring(e: rusqlite::Error) -> String {
    e.to_string()
}

/// Comparison fetch for the judge (§10.1 step 1): vector top-s when the
/// sidecar is up, else FTS on the candidate's own keywords. Must be called
/// while holding the DB lock.
pub fn fetch_similar(
    conn: &rusqlite::Connection,
    profile: &str,
    project_id: Option<&str>,
    cand: &MemoryCandidate,
    embedding: Option<&[f32]>,
) -> Vec<(crate::memory::model::MemoryRecord, f32)> {
    if let Some(ev) = embedding {
        if let Ok(hits) = db::similar_active_memories(conn, profile, project_id, ev, SIMILAR_TOP_S) {
            let gated: Vec<_> = hits.into_iter().filter(|(_, s)| *s >= SIMILARITY_GATE).collect();
            if !gated.is_empty() {
                return gated;
            }
        }
    }
    // Fallback: keyword overlap via FTS on the candidate's own words.
    let kws: Vec<&str> = cand
        .content
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| t.len() > 3)
        .take(6)
        .collect();
    let mut out = Vec::new();
    if let Ok(hits) = db::search_memories_fts(conn, profile, project_id, &kws.join(" "), SIMILAR_TOP_S) {
        for m in hits {
            out.push((m, 0.6)); // nominal similarity — above the gate
        }
    }
    out
}

/// Shared write path for `memory_save` (agent tool): judge-then-write, same
/// as background extraction (single write path, design §12.1). Returns a
/// human-readable summary of what happened.
pub async fn save_memory(
    app: &AppHandle,
    chat_session_id: &str,
    content: &str,
    kind: &str,
    subject: &str,
    importance_hint: Option<i64>,
) -> Result<String, String> {
    let db = app.state::<crate::DbState>();
    if !{
        let conn = db.0.lock();
        crate::memory::memory_enabled(&conn)
    } {
        return Err("memory is disabled in Settings".to_string());
    }
    let cand = MemoryCandidate {
        content: content.trim().to_string(),
        kind: kind.to_string(),
        subject: subject.to_string(),
        quote: String::new(),
        message_ids: Vec::new(),
        importance: importance_hint.unwrap_or(6).clamp(1, 9),
    };
    let report = filter_candidates(vec![cand]);
    let Some(cand) = report.kept.into_iter().next() else {
        return Err("rejected: content looks like a credential or is not a durable one-sentence fact".to_string());
    };

    let (provider_str, model, api_key, base_url, project_id) = {
        let conn = db.0.lock();
        let cs = db::get_chat_session(&conn, chat_session_id)
            .map_err(|e| e.to_string())?
            .ok_or("chat session not found")?;
        let key = crate::secrets::get_chat_api_key(&conn, &cs.provider).unwrap_or_default();
        let base = db::get_setting(&conn, &format!("chat.{}.base_url", cs.provider))
            .map_err(|e| e.to_string())?;
        let model = if cs.model.trim().is_empty() {
            db::get_setting(&conn, &format!("chat.{}.model", cs.provider)).unwrap_or(None)
        } else {
            Some(cs.model.clone())
        }
        .unwrap_or_default();
        (cs.provider, model, key, base, cs.project_id)
    };
    if model.trim().is_empty() || (api_key.is_empty() && provider_str != "local_gguf") {
        return Err("no chat model configured — cannot judge the memory write".to_string());
    }

    let emb = match embedding_base_url(app) {
        Some(base) => crate::chat::local_models::embed_texts(&base, &[cand.content.clone()])
            .await
            .ok()
            .and_then(|mut v| v.pop()),
        None => None,
    };

    let similar = {
        let conn = db.0.lock();
        fetch_similar(&conn, "default", project_id.as_deref(), &cand, emb.as_deref())
    };
    let judge_msg = judge_user_message(&JudgeInput { candidate: &cand, similar: &similar });
    let raw = oneshot(app, &provider_str, &api_key, base_url.as_deref(), &model, crate::memory::consolidate::JUDGE_SYSTEM, &judge_msg, 512).await?;
    let valid_ids: Vec<String> = similar.iter().map(|(m, _)| m.id.clone()).collect();
    let op = parse_judge_op(&raw, &valid_ids);
    let applied = {
        let conn = db.0.lock();
        let applied = apply_judge_op(&conn, &JudgeInput { candidate: &cand, similar: &similar }, &op,
                                     Some(chat_session_id), project_id.as_deref(), emb, crate::db::now_ts())
            .map_err(|e| e_tostring(e))?;
        let cand_json = serde_json::to_string(&cand).unwrap_or_default();
        let _ = db::log_memory_op(&conn, "agent_tool", Some(chat_session_id), &cand_json, &applied.op, &applied.target_ids, "");
        applied
    };
    let note = match &applied.op {
        op if op == "UPDATE" => "merged into an existing memory",
        op if op == "DELETE" => "replaced a memory it contradicted",
        op if op == "NOOP" => "already known — nothing new stored",
        _ => "stored as a new memory",
    };
    Ok(format!("Remembered: \"{}\" ({kind}, importance {}) — {note}.", cand.content, cand.importance))
}

/// Sidecar base URL if the embedding service is running (`None` otherwise).
pub fn embedding_base_url(app: &AppHandle) -> Option<String> {
    let state = app.try_state::<crate::chat::local_models::LocalModelState>()?;
    state.0.embedding_status().map(|a| a.base_url.to_string())
}

/// Provider-agnostic one-shot call (mirrors generate_chat_title's dispatch).
#[allow(clippy::too_many_arguments)]
async fn oneshot(
    _app: &AppHandle,
    provider: &str,
    api_key: &str,
    base_url: Option<&str>,
    model: &str,
    system: &str,
    user: &str,
    max_tokens: u32,
) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(20))
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| format!("failed to build HTTP client: {e}"))?;
    let base_url = base_url.filter(|b| !b.trim().is_empty());
    match provider {
        "openai" => {
            openai_oneshot(&client, api_key, base_url.unwrap_or(OpenAIProvider::DEFAULT_BASE), model, system, user).await
        }
        "openrouter" => {
            openai_oneshot(&client, api_key, base_url.unwrap_or(OpenRouterProvider::DEFAULT_BASE), model, system, user).await
        }
        "openai_compatible" | "local_gguf" => {
            let Some(base) = base_url else { return Ok(String::new()) };
            openai_oneshot(&client, api_key, base, model, system, user).await
        }
        "anthropic" => {
            anthropic_oneshot(&client, api_key, base_url.unwrap_or(AnthropicProvider::DEFAULT_BASE), model, system, user, max_tokens).await
        }
        "anthropic_compatible" => {
            let Some(base) = base_url else { return Ok(String::new()) };
            anthropic_oneshot(&client, api_key, base, model, system, user, max_tokens).await
        }
        _ => Err(format!("unsupported provider for memory extraction: {provider}")),
    }
}
