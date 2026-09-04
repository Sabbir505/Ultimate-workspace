//! Background extraction orchestration (design §7.1) + the shared write path
//! used by the `memory_save` tool (§12.1). Spawned post-turn — NEVER awaited
//! on the reply path (P2) — and TURN-GATED: the pipeline runs only every
//! 3–5 assistant turns (cost control; pending turns batch up past the
//! cursor) and the backlog then drains oldest-first in bounded chunks, so
//! every deferred turn is still covered. One LLM call per chunk for
//! extraction + one per candidate for the judge; embedding via the local
//! sidecar (optional — store/retrieval degrade gracefully without it).

use crate::chat::commands::{anthropic_oneshot, openai_oneshot};
use crate::chat::providers::{AnthropicProvider, OpenAIProvider, OpenRouterProvider};
use crate::db;
use crate::memory::consolidate::{apply_judge_op, judge_user_message, parse_judge_op, JudgeInput};
use crate::memory::document::{
    parse_rewritten, rewrite_user_message, set_document, stored_document, REWRITE_SYSTEM,
};
use crate::memory::extract::{
    extraction_user_message, filter_candidates, parse_candidates, EXTRACTION_SYSTEM,
};
use crate::memory::model::{MemoryCandidate, SIMILAR_TOP_S, SIMILARITY_GATE};
use tauri::{AppHandle, Emitter, Manager};
use std::sync::Mutex as StdMutex;

/// Cost gate: extraction runs only every `EXTRACT_MIN_TURNS..=EXTRACT_MAX_TURNS`
/// completed assistant turns instead of every turn — each run costs an LLM
/// call for extraction plus one per candidate for the judge. Pending turns
/// accumulate past the cursor until the gate opens (nothing is lost, just
/// batched); the exact threshold is re-drawn from the range each check so
/// runs don't land predictably.
const EXTRACT_MIN_TURNS: usize = 3;
const EXTRACT_MAX_TURNS: usize = 5;

/// When the gate opens, the backlog drains OLDEST-FIRST in
/// `EXTRACT_WINDOW`-message chunks, up to `EXTRACT_MAX_CHUNKS` chunks in one
/// run (so a long cold spell costs at most that many extraction calls; the
/// rest continues on the next gated run). Chunks keep every extraction within
/// the model's reliable context and preserve chronology for the judge.
const EXTRACT_WINDOW: usize = 12;
const EXTRACT_MAX_CHUNKS: usize = 6;

/// Cheap xorshift draw in `[lo, hi]` — jitter source for the turn gate.
fn jitter(lo: usize, hi: usize) -> usize {
    static STATE: StdMutex<u64> = StdMutex::new(0x9E37_79B9_7F4A_7C15);
    let mut s = STATE.lock().unwrap();
    *s ^= *s << 13;
    *s ^= *s >> 7;
    *s ^= *s << 17;
    lo + (*s as usize) % (hi - lo + 1)
}

/// The gate decision: has enough turned passed since the cursor?
fn extraction_due(new_turns: usize) -> bool {
    new_turns >= jitter(EXTRACT_MIN_TURNS, EXTRACT_MAX_TURNS)
}

/// A pending batch older than this is flushed regardless of the turn gate —
/// the conversation went cold mid-batch, and the tail turns would otherwise
/// sit unextracted forever.
const STALE_PENDING_SECS: i64 = 24 * 60 * 60;

/// The user's extraction-model pick (memory panel), parsed from
/// `memory.extractModel`. `Some((provider, model))` — a value without the
/// `provider::` prefix is a legacy bare model id (provider = session's);
/// empty/absent = no override.
fn parse_extract_override(conn: &rusqlite::Connection) -> Option<(String, String)> {
    let raw = db::get_setting(conn, crate::memory::SETTING_EXTRACT_MODEL)
        .ok()
        .flatten()?;
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    match raw.split_once("::") {
        Some((p, m)) if !p.is_empty() && !m.is_empty() => {
            Some((p.to_string(), m.to_string()))
        }
        _ => Some((String::new(), raw.to_string())),
    }
}

/// Apply the extraction-model override on top of the session-derived
/// resolution. An override pointing at ANOTHER cloud provider resolves that
/// provider's own key + base URL; a `local_gguf` override needs the sidecar
/// actually running that model right now. Anything unresolvable keeps the
/// session resolution (logged) — memory writes never fail on a bad pick.
fn maybe_apply_extract_override(
    app: &AppHandle,
    provider: String,
    model: String,
    api_key: String,
    base_url: Option<String>,
) -> (String, String, String, Option<String>) {
    let db = app.state::<crate::DbState>();
    let Some((override_provider, override_model)) = ({
        let conn = db.0.lock();
        parse_extract_override(&conn)
    }) else {
        return (provider, model, api_key, base_url);
    };
    if override_provider.is_empty() || override_provider == provider {
        // Same provider (or legacy bare id): swap the model only.
        return (provider, override_model, api_key, base_url);
    }
    if override_provider == "local_gguf" {
        if let Some(state) = app.try_state::<crate::chat::local_models::LocalModelState>() {
            if let Some(active) = state.0.status() {
                if active.model_id == override_model {
                    return (
                        override_provider,
                        override_model,
                        String::new(),
                        Some(active.base_url),
                    );
                }
            }
        }
        eprintln!(
            "[memory] extract-model override local_gguf::{override_model} ignored — sidecar not running it"
        );
        return (provider, model, api_key, base_url);
    }
    // Cloud provider override: its own saved key + base URL.
    let (override_key, override_base) = {
        let conn = db.0.lock();
        (
            crate::secrets::get_chat_api_key(&conn, &override_provider).unwrap_or_default(),
            db::get_setting(&conn, &format!("chat.{override_provider}.base_url"))
                .unwrap_or(None),
        )
    };
    if override_key.is_empty() {
        eprintln!(
            "[memory] extract-model override {override_provider}::{override_model} ignored — no API key saved for {override_provider}"
        );
        return (provider, model, api_key, base_url);
    }
    (
        override_provider,
        override_model,
        override_key,
        override_base,
    )
}

/// Resolve the model the memory pipeline should use: the explicit cheap-model
/// override (`memory.extractModel`) when set, else the session's model.
/// Honored by EVERY stage (extraction, judge, document merge) so costs stay
/// predictable no matter which path triggered the write.
fn resolve_memory_model(
    conn: &rusqlite::Connection,
    session_model: Option<String>,
) -> String {
    db::get_setting(conn, crate::memory::SETTING_EXTRACT_MODEL)
        .unwrap_or(None)
        .filter(|m| !m.trim().is_empty())
        .or(session_model)
        .unwrap_or_default()
}

/// Post-turn hook: fire-and-forget extraction for a finished chat turn.
/// Called from the assistant-persist point in `chat/mod.rs`. All failures are
/// logged and swallowed — a memory problem must never surface as a chat
/// error. Gated: fires only every 3–5 turns (see `EXTRACT_MIN_TURNS`).
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

    // Transcript backlog since the cursor (paged read, cheap under the lock).
    // `oldest_pending` feeds the stale-flush bypass below.
    let (pending, oldest_pending): (Vec<(i64, String, String)>, Option<i64>) = {
        let conn = db.0.lock();
        let all = db::list_active_chat_messages(&conn, chat_session_id)
            .map_err(|e| e_tostring(e))?;
        let mut oldest: Option<i64> = None;
        let mut out: Vec<(i64, String, String)> = Vec::new();
        for m in all {
            if m.id > cursor && !m.content.trim().is_empty() {
                if oldest.is_none() {
                    oldest = Some(m.created_at);
                }
                out.push((m.id, m.role, m.content));
            }
        }
        (out, oldest)
    };
    // Turn gate (cost): an assistant reply is one turn; skip until 3–5 have
    // piled up past the cursor — UNLESS the pending batch is stale (the
    // conversation went cold mid-batch), in which case flush now. The backlog
    // is fully drained in chunks when the gate opens, so nothing is lost,
    // just deferred.
    let new_turns = pending.iter().filter(|(_, role, _)| role == "assistant").count();
    let stale = oldest_pending
        .map_or(false, |t| crate::db::now_ts() - t > STALE_PENDING_SECS);
    if !extraction_due(new_turns) && !stale {
        // Still worth refreshing vectors for records written while the
        // sidecar was down — a cheap no-op when the queue is empty.
        maybe_backfill_embeddings(&app).await;
        return Ok(());
    }

    // LLM resolution: same provider/model/key plumbing as generate_chat_title.
    let (provider_str, model, api_key, base_url) = {
        let conn = db.0.lock();
        let cs = db::get_chat_session(&conn, chat_session_id)
            .map_err(|e| e_tostring(e))?
            .ok_or("chat session not found")?;
        let key = crate::secrets::get_chat_api_key(&conn, &cs.provider).unwrap_or_default();
        let base = db::get_setting(&conn, &format!("chat.{}.base_url", cs.provider))
            .map_err(|e| e_tostring(e))?;
        // Dedicated extraction model override (cheap local/cloud model) —
        // honored by every memory stage (judge + document merge included).
        let session_model = if cs.model.trim().is_empty() {
            db::get_setting(&conn, &format!("chat.{}.model", cs.provider)).unwrap_or(None)
        } else {
            Some(cs.model.clone())
        };
        let model = resolve_memory_model(&conn, session_model);
        (cs.provider, model, key, base)
    };
    let (provider_str, model, api_key, base_url) =
        maybe_apply_extract_override(app, provider_str, model, api_key, base_url);
    if model.trim().is_empty() || (api_key.is_empty() && provider_str != "local_gguf") {
        return Ok(());
    }

    // Drain the backlog OLDEST-FIRST in bounded chunks: each chunk gets its
    // own extraction call (with a rolling summary of the two messages right
    // before it, Mem0-style) and its own judge pass, and the cursor advances
    // per chunk only after that chunk committed (§7.4 idempotency). The
    // chunk cap bounds a single run's cost — a backlog longer than the cap
    // continues on a later gated run.
    let mut results: Vec<(String, String, String)> = Vec::new(); // (op, kind, content)
    let mut chunk_start = cursor;
    for _ in 0..EXTRACT_MAX_CHUNKS {
        let chunk: Vec<(i64, String, String)> = pending
            .iter()
            .filter(|(id, _, _)| *id > chunk_start)
            .take(EXTRACT_WINDOW)
            .map(|(id, role, content)| (*id, role.clone(), content.clone()))
            .collect();
        if chunk.is_empty() {
            break;
        }
        let chunk_first_id = chunk[0].0;
        let chunk_last_id = chunk.last().map(|(id, _, _)| *id).unwrap_or(chunk_first_id);

        // Need at least one user message with substance — an empty/error
        // stretch has nothing to remember. The chunk still commits so it is
        // never re-scanned.
        if !chunk.iter().any(|(_, r, c)| r == "user" && c.len() > 24) {
            chunk_start = chunk_last_id;
            let conn = db.0.lock();
            db::upsert_cursor(&conn, chat_session_id, chunk_last_id)
                .map_err(|e| e_tostring(e))?;
            continue;
        }

        // Rolling summary: the two messages just before this chunk (Mem0's
        // rolling-summary input, cheap version — no extra LLM call).
        let rolling_summary: Option<String> = {
            let conn = db.0.lock();
            let prior: Vec<_> = db::list_active_chat_messages(&conn, chat_session_id)
                .map_err(|e| e_tostring(e))?
                .into_iter()
                .filter(|m| m.id < chunk_first_id)
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

        let user_msg = extraction_user_message(rolling_summary.as_deref(), &chunk);
        // On an LLM failure the `?` aborts BEFORE the cursor moves, so this
        // chunk is retried next turn.
        let raw = oneshot(app, &provider_str, &api_key, base_url.as_deref(), &model, EXTRACTION_SYSTEM, &user_msg, 2048).await?;

        let cands = parse_candidates(&raw);
        if cands.is_empty() {
            // Nothing memorable in this chunk — commit it so we don't re-scan.
            chunk_start = chunk_last_id;
            let conn = db.0.lock();
            db::upsert_cursor(&conn, chat_session_id, chunk_last_id)
                .map_err(|e| e_tostring(e))?;
            continue;
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
            chunk_start = chunk_last_id;
            let conn = db.0.lock();
            db::upsert_cursor(&conn, chat_session_id, chunk_last_id)
                .map_err(|e| e_tostring(e))?;
            continue;
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
            results.push((applied.op, cand.kind.clone(), cand.content.clone()));
        }

        // Chunk fully committed (extracted + judged) — advance the cursor
        // past it only now (§7.4 idempotency): a judge failure aborts the run
        // with the cursor still on this chunk, so it retries next turn.
        chunk_start = chunk_last_id;
        {
            let conn = db.0.lock();
            db::upsert_cursor(&conn, chat_session_id, chunk_last_id)
                .map_err(|e| e_tostring(e))?;
        }
    }
    eprintln!("[memory] extracted {}: {} candidates → {}", chat_session_id, results.len(),
              results.iter().map(|(op, _, _)| op.as_str()).collect::<Vec<_>>().join(","));

    // Document merge (§11 amendment): one LLM call folds the applied changes
    // into the single human-readable memory document. Changes that applied
    // (non-NOOP) only — NOOPs corroborate existing facts, nothing to merge.
    let changes: Vec<(String, String, String)> = results
        .iter()
        .filter(|(op, _, _)| op != "NOOP")
        .cloned()
        .collect();
    if !changes.is_empty() {
        if let Err(e) = merge_document(
            app, &provider_str, &api_key, base_url.as_deref(), &model,
            Some(chat_session_id), &changes,
        )
        .await
        {
            eprintln!("[memory] document merge skipped: {e}");
        }
    }

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
    // Fold the insights into the memory document too — without this they'd
    // live only in the record store, reachable via memory_recall but never
    // injected (a dead-end tier).
    if applied > 0 {
        let changes: Vec<(String, String, String)> = insights
            .iter()
            .map(|i| ("ADD".to_string(), "insight".to_string(), i.content.clone()))
            .collect();
        if let Err(e) = merge_document(
            app, provider, api_key, base_url, model, None, &changes,
        )
        .await
        {
            eprintln!("[memory] document merge (reflection) skipped: {e}");
        }
    }
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
        // Same cheap-model override as background extraction — the judge and
        // the document merge never silently fall back to the chat model.
        let session_model = if cs.model.trim().is_empty() {
            db::get_setting(&conn, &format!("chat.{}.model", cs.provider)).unwrap_or(None)
        } else {
            Some(cs.model.clone())
        };
        let model = resolve_memory_model(&conn, session_model);
        (cs.provider, model, key, base, cs.project_id)
    };
    let (provider_str, model, api_key, base_url) =
        maybe_apply_extract_override(app, provider_str, model, api_key, base_url);
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
    // Fold the change into the single memory document (non-NOOP only).
    if applied.op != "NOOP" {
        let changes = vec![(applied.op.clone(), kind.to_string(), cand.content.clone())];
        if let Err(e) = merge_document(
            app, &provider_str, &api_key, base_url.as_deref(), &model,
            Some(chat_session_id), &changes,
        )
        .await
        {
            eprintln!("[memory] document merge skipped: {e}");
        }
    }
    Ok(format!("Remembered: \"{}\" ({kind}, importance {}) — {note}.", cand.content, cand.importance))
}

/// Merge applied changes into the single memory document (design §11
/// amendment): one LLM call rewrites the whole document with the changes
/// folded in — duplicates merged, superseded details rewritten, sections kept
/// tidy — capped at the injection budget in code. Emits `memory:updated` with
/// a change summary so the bell panel records what happened. On ANY failure
/// the stored document is cleared so injection falls back to a deterministic
/// render from the records: correctness never depends on this call succeeding.
pub async fn merge_document(
    app: &AppHandle,
    provider: &str,
    api_key: &str,
    base_url: Option<&str>,
    model: &str,
    chat_session_id: Option<&str>,
    changes: &[(String, String, String)], // (op, kind, content)
) -> Result<(), String> {
    let db = app.state::<crate::DbState>();
    let current = {
        let conn = db.0.lock();
        stored_document(&conn)
    };
    let user_msg = rewrite_user_message(current.as_deref(), changes);
    let raw = oneshot(app, provider, api_key, base_url, model, REWRITE_SYSTEM, &user_msg, 2048)
        .await?;
    let parsed = parse_rewritten(&raw);
    let (doc, trimmed) = match parsed {
        Some(d) => crate::memory::render::enforce_budget(d),
        None => (String::new(), false),
    };
    {
        let conn = db.0.lock();
        if doc.is_empty() {
            // Unusable reply → clear and let the deterministic fallback render.
            set_document(&conn, None, "").map_err(|e| e.to_string())?;
            let _ = db::log_memory_op(&conn, "document", chat_session_id, "", "MERGE", &[], "rewrite unusable — cleared to fallback render");
        } else {
            set_document(&conn, Some(&doc), "merge").map_err(|e| e.to_string())?;
            let _ = db::log_memory_op(
                &conn, "document", chat_session_id, &doc, "MERGE", &[],
                &format!("{} change(s) merged{}", changes.len(), if trimmed { ", trimmed to budget" } else { "" }),
            );
        }
    }
    // Bell-panel record: what changed, in one line.
    let mut counts: std::collections::BTreeMap<&str, usize> = Default::default();
    for (op, _, _) in changes {
        *counts.entry(op.as_str()).or_default() += 1;
    }
    let summary = counts
        .iter()
        .map(|(op, n)| format!("{n} {}", op.to_lowercase()))
        .collect::<Vec<_>>()
        .join(", ");
    let _ = app.emit(
        "memory:updated",
        serde_json::json!({
            "chatSessionId": chat_session_id,
            "summary": if summary.is_empty() { "document refreshed".to_string() } else { summary },
            "trimmed": trimmed,
        }),
    );
    eprintln!(
        "[memory-audit] document_merge_chars={} trimmed={trimmed}",
        doc.len()
    );
    Ok(())
}

/// Backfill vectors for records written while the embedding sidecar was down
/// (model.rs §6 note: "backfilled on a later pass" — this is that pass).
/// Bounded per run; a near-no-op when the queue is empty or the sidecar is
/// down. Called on the extraction path so cost stays tied to it.
async fn maybe_backfill_embeddings(app: &AppHandle) -> usize {
    let Some(base) = embedding_base_url(app) else {
        return 0;
    };
    let db = app.state::<crate::DbState>();
    let missing = {
        let conn = db.0.lock();
        db::memories_missing_embedding(&conn, "default", 64).unwrap_or_default()
    };
    if missing.is_empty() {
        return 0;
    }
    let texts: Vec<String> = missing.iter().map(|m| m.content.clone()).collect();
    let Ok(vectors) = crate::chat::local_models::embed_texts(&base, &texts).await else {
        return 0;
    };
    let mut n = 0usize;
    {
        let conn = db.0.lock();
        for (m, v) in missing.iter().zip(vectors) {
            if db::set_memory_embedding(&conn, &m.id, &v).is_ok() {
                n += 1;
            }
        }
    }
    if n > 0 {
        eprintln!("[memory] backfilled {n} embedding(s)");
        let conn = db.0.lock();
        let _ = db::log_memory_op(&conn, "backfill", None, "", "EMBED", &[],
                                  &format!("{n} vector(s) backfilled"));
    }
    n
}

/// Sidecar base URL if the embedding service is running (`None` otherwise).
pub fn embedding_base_url(app: &AppHandle) -> Option<String> {
    let state = app.try_state::<crate::chat::local_models::LocalModelState>()?;
    state.0.embedding_status().map(|a| a.base_url.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gate_never_fires_below_min_turns() {
        for n in 0..EXTRACT_MIN_TURNS {
            assert!(!extraction_due(n), "fired early at {n} turns");
        }
    }

    #[test]
    fn gate_always_fires_at_max_turns() {
        assert!(extraction_due(EXTRACT_MAX_TURNS));
        assert!(extraction_due(EXTRACT_MAX_TURNS * 4));
    }

    #[test]
    fn jitter_stays_in_range_and_varies() {
        let draws: std::collections::HashSet<usize> =
            (0..200).map(|_| jitter(EXTRACT_MIN_TURNS, EXTRACT_MAX_TURNS)).collect();
        assert!(draws.iter().all(|d| (EXTRACT_MIN_TURNS..=EXTRACT_MAX_TURNS).contains(d)));
        assert!(draws.len() > 1, "jitter collapsed to one value: {draws:?}");
    }
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
