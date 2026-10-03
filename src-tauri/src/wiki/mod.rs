//! Project wiki (§6.15) — the generation + freshness engine.
//!
//! A per-project knowledge base of generated markdown pages, built in three
//! phases (docs/research/PROJECT_WIKI_RESEARCH.md §4.2):
//!   1. repo analysis — DETERMINISTIC (walk + git log, no model);
//!   2. outline — one model call turns the analysis into a page list;
//!   3. pages — one read-only model call per page, every page ending in a
//!      Grounded-Claims ledger (claim → repo-relative path + line range +
//!      blob SHA).
//!
//! Freshness is COMPUTED, not guessed (§4.3): the update pass diffs
//! `old..new` HEADs, joins changed paths against `wiki_claims.evidence_path`,
//! re-derives only the affected pages from their stored briefs, and no-ops
//! (zero model calls) when nothing relevant changed. A background task
//! re-checks HEADs every minute, so commits update the wiki without any
//! user action.
//!
//! Deliberate scope cuts vs the research doc: no in-repo export (pages live
//! in SQLite; the Vault export is Phase D), no LLM-judge groundedness pass
//! (mechanical evidence validation only — Phase D), FTS-only search (no
//! embedding leg over pages).

pub mod commands;
pub mod tools_impl;

use std::collections::{HashMap, VecDeque};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use rusqlite::Connection;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use notify::Watcher;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::chat::docs as corpus_docs;
use crate::db;
use crate::util::normalize_canonical_path;

pub(crate) const PROGRESS_EVENT: &str = "wiki:build:progress";

/// Freshness is on by default: a tick that finds no relevant diff costs one
/// `git rev-parse` per wiki and ZERO model calls, so the default only ever
/// spends money when a page's evidence actually changed.
pub(crate) const SETTING_AUTO_UPDATE: &str = "wiki.auto_update";
/// Layer the page index into chat/harness prompts (default on; capped, and
/// passed through the prompt firewall like every injected block).
pub(crate) const SETTING_LAYER_INDEX: &str = "wiki.layer_index";
pub(crate) const SETTING_MAX_PAGES: &str = "wiki.max_pages";
/// Optional explicit build model ("provider" + "model"). Unset → the
/// cloud-summarizer chain (anthropic → openai → openrouter, the same "which
/// cloud brain" resolver compaction uses). `local_gguf` is not offered: the
/// chat sidecar's context window can't carry page-sized file bundles.
pub(crate) const SETTING_BUILD_PROVIDER: &str = "wiki.build_provider";
pub(crate) const SETTING_BUILD_MODEL: &str = "wiki.build_model";

const DEFAULT_MAX_PAGES: usize = 20;
/// Char budgets. Page file bundles are the input-cost driver; heads only —
/// the wiki describes structure, not every line.
const MAX_OUTLINE_INPUT_CHARS: usize = 16_000;
const MAX_PAGE_INPUT_CHARS: usize = 48_000;
const MAX_FILE_CHARS: usize = 12_000;
const MAX_CLAIMS_PER_PAGE: usize = 64;
/// Cap for the layered prompt section (chars) — same prompt-cache logic as
/// `agents_md::MAX_CONTEXT_CHARS`, which this section rides next to.
pub(crate) const MAX_INDEX_CHARS: usize = 4_000;
/// Safety valve for the analysis walk (mirrors the corpus-walk philosophy:
/// a hard cap beats an unbounded walk on a pathological tree). Stats-only
/// work per file, so the cap is generous.
const MAX_ANALYSIS_FILES: usize = 20_000;
const CLAIMS_MARKER: &str = "<!-- relay:claims -->";
const MAX_STALE_REASON_FILES: usize = 5;

pub(crate) const PAGE_KINDS: &[&str] = &[
    "overview", "architecture", "module", "howto", "glossary", "history",
];

// ── progress events ───────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WikiProgress {
    pub path: String,
    /// "build" | "update"
    pub mode: String,
    /// "running" | "done" | "cancelled" | "error"
    pub state: String,
    /// "analysis" | "outline" | "pages" | "finalizing"
    pub phase: String,
    pub page_slug: Option<String>,
    pub pages_done: usize,
    pub pages_total: usize,
    pub error: Option<String>,
    /// Human step text ("Exploring the project structure", "Wrote page:
    /// Mesh (2/4)") — the UI renders these as a live step feed.
    pub step: Option<String>,
}

#[allow(clippy::too_many_arguments)]
fn emit_progress<R: Runtime>(
    app: &AppHandle<R>,
    path: &str,
    mode: &str,
    state: &str,
    phase: &str,
    slug: Option<&str>,
    done: usize,
    total: usize,
    error: Option<String>,
    step: Option<String>,
) {
    let _ = app.emit(
        PROGRESS_EVENT,
        WikiProgress {
            path: path.to_string(),
            mode: mode.to_string(),
            state: state.to_string(),
            phase: phase.to_string(),
            page_slug: slug.map(str::to_string),
            pages_done: done,
            pages_total: total,
            error,
            step,
        },
    );
}

// ── job registry (the docs_index::IndexRegistry shape) ────────────────────

pub struct WikiJobSlot {
    /// Cancel is a level-triggered flag, not a one-shot channel: `wiki_cancel`
    /// can fire repeatedly, and the build loops poll it between pages without
    /// consuming it. (A `oneshot::Sender` had to be *moved* to signal, which
    /// meant the cancel command had to take the slot out of the registry to
    /// reach it — releasing the slot while the job was still winding down and
    /// letting a second build interleave its writes with the dying one.)
    pub cancel: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct WikiJobRegistry {
    pub active: Mutex<HashMap<String, WikiJobSlot>>,
}

/// Removes the slot on drop (early return, `?`, panic — the key never sticks
/// around blocking future builds).
struct JobGuard {
    registry: Arc<WikiJobRegistry>,
    key: String,
}

impl Drop for JobGuard {
    fn drop(&mut self) {
        self.registry.active.lock().remove(&self.key);
    }
}

/// Acquire the per-project job slot. Err when a build/update is already
/// running for the project (commands surface that; the freshness tick skips).
/// The returned flag is BOTH the job's cancel signal and its proof of
/// holding the slot; the registry entry is dropped only by `JobGuard`.
fn try_acquire(
    registry: &Arc<WikiJobRegistry>,
    key: &str,
) -> Result<(JobGuard, Arc<AtomicBool>), String> {
    let mut active = registry.active.lock();
    if active.contains_key(key) {
        return Err("a wiki build or update is already running for this project".to_string());
    }
    let cancel = Arc::new(AtomicBool::new(false));
    active.insert(
        key.to_string(),
        WikiJobSlot {
            cancel: Arc::clone(&cancel),
        },
    );
    Ok((
        JobGuard {
            registry: Arc::clone(registry),
            key: key.to_string(),
        },
        cancel,
    ))
}

fn cancelled(flag: &AtomicBool) -> bool {
    flag.load(Ordering::SeqCst)
}

// ── the model caller (real provider, or scripted for tests) ───────────────

pub(crate) enum Caller {
    Real {
        provider: String,
        api_key: String,
        base: String,
        model: String,
    },
    /// A harness CLI (claude_code / opencode / pi / omp / commandcode) runs
    /// each generation call as a headless one-shot turn — the CLI's OWN auth
    /// (subscription or free tier), no Relay-held API key. The established
    /// precedent is the artifact generator's harness arm
    /// (artifacts/generator.rs call_harness_structured).
    Harness {
        harness_id: String,
        /// Empty string = the CLI's own configured default model.
        model: String,
    },
    /// Test seam (unit + live `#[ignore]` tests): canned responses popped in
    /// call order. Never constructed outside test targets. Mutex (not
    /// RefCell) so `Caller` stays Send — the build/update futures hold it
    /// across await points and tauri spawns them.
    #[cfg_attr(not(test), allow(dead_code))]
    Scripted(std::sync::Mutex<VecDeque<String>>),
}

impl Caller {
    async fn call(
        &self,
        system: &str,
        user: &str,
        anthropic_max_tokens: u32,
    ) -> Result<String, String> {
        match self {
            Caller::Real {
                provider,
                api_key,
                base,
                model,
            } => {
                // Page generation runs long (big prompts, stealth/reasoning
                // models, 4k output tokens) — llm_client's shared 120 s
                // oneshot client cut REAL builds off mid-body (the live test
                // caught it). 10 minutes, still bounded.
                let client = reqwest::Client::builder()
                    .connect_timeout(std::time::Duration::from_secs(20))
                    .timeout(std::time::Duration::from_secs(600))
                    .build()
                    .map_err(|e| format!("failed to build HTTP client: {e}"))?;
                crate::chat::llm_client::oneshot(
                    provider,
                    &client,
                    api_key,
                    Some(base),
                    model,
                    system,
                    user,
                    anthropic_max_tokens,
                )
                .await
                .and_then(|out| {
                    out.ok_or_else(|| "no usable provider/base for the wiki build model".to_string())
                })
            }
            Caller::Harness { harness_id, model } => {
                // Harness CLIs have no system-prompt slot — fold both halves
                // into one self-contained prompt (the oneshot contract:
                // "self-contained prompt in, final text out").
                let prompt = format!("{system}

---

{user}");
                crate::agent_sessions::harness_oneshot_text(harness_id, model, &prompt, None)
                    .await
            }
            Caller::Scripted(queue) => queue
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .pop_front()
                .ok_or_else(|| "scripted wiki caller exhausted".to_string()),
        }
    }

    fn label(&self) -> String {
        match self {
            Caller::Real { provider, model, .. } => format!("{provider}:{model}"),
            Caller::Harness { harness_id, model } => {
                if model.is_empty() {
                    format!("harness:{harness_id}")
                } else {
                    format!("harness:{harness_id}:{model}")
                }
            }
            Caller::Scripted(_) => "scripted".to_string(),
        }
    }
}

/// Which brain builds pages: the explicit `wiki.build_provider`/`model`
/// pair when configured (API key required), else the cloud-summarizer
/// chain — the "one place decides" resolver compaction shares.
pub(crate) fn resolve_build_model(conn: &Connection) -> Result<Caller, String> {
    let provider = db::get_setting(conn, SETTING_BUILD_PROVIDER)
        .ok()
        .flatten()
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty());
    if let Some(provider) = provider {
        // Harness engines own their auth — model OPTIONAL (empty = the CLI's
        // configured default), no API-key gate. `harness:<id>` and bare ids
        // both accepted; ACP has no unattended path (same refusal as
        // automations).
        if let Some(harness_id) = harness_engine_of(&provider) {
            let model = db::get_setting(conn, SETTING_BUILD_MODEL)
                .ok()
                .flatten()
                .map(|m| m.trim().to_string())
                .unwrap_or_default();
            return Ok(Caller::Harness { harness_id, model });
        }
        let model = db::get_setting(conn, SETTING_BUILD_MODEL)
            .ok()
            .flatten()
            .map(|m| m.trim().to_string())
            .filter(|m| !m.is_empty())
            .ok_or_else(|| {
                format!("{SETTING_BUILD_PROVIDER} is set but {SETTING_BUILD_MODEL} is empty")
            })?;
        let api_key = crate::secrets::get_chat_api_key(conn, &provider).ok_or_else(|| {
            format!("no API key configured for wiki build provider '{provider}'")
        })?;
        let base_setting = db::get_setting(conn, &format!("chat.{provider}.base_url"))
            .ok()
            .flatten();
        let base = crate::chat::llm_client::resolve_base_url(&provider, base_setting.as_deref())
            .ok_or_else(|| {
                format!("provider '{provider}' needs a configured base URL to build the wiki")
            })?
            .to_string();
        return Ok(Caller::Real {
            provider,
            api_key,
            base,
            model,
        });
    }
    let (provider_id, base, api_key, model) =
        crate::chat::commands::resolve_cloud_summarizer(conn).ok_or_else(|| {
            "no provider configured for the wiki build — pick one in Settings → Wiki".to_string()
        })?;
    Ok(Caller::Real {
        provider: provider_id.as_str().to_string(),
        api_key,
        base,
        model,
    })
}

/// `harness:<id>` or a bare engine id → the bare id, when it names a CLI
/// engine that has a headless one-shot path. `acp:*` is None (callers reject
/// it — no unattended channel).
fn harness_engine_of(provider: &str) -> Option<String> {
    let bare = provider
        .strip_prefix("harness:")
        .unwrap_or(provider)
        .trim()
        .to_string();
    if bare.starts_with("acp:") {
        return None;
    }
    if crate::chat::subagent_model::HARNESS_ENGINE_IDS.contains(&bare.as_str()) {
        Some(bare)
    } else {
        None
    }
}

// ── git plumbing (run_git_env: trimmed stdout / stderr string) ────────────

pub(crate) fn git_head(root: &Path) -> Option<String> {
    crate::git::run_git_env(root, &["rev-parse", "HEAD"], &[])
        .ok()
        .filter(|s| !s.is_empty())
}

/// All paths touched between two revisions — BOTH sides of a rename, so a
/// renamed module's page is affected under its old and its new name.
pub(crate) fn git_changed_paths(
    root: &Path,
    old: &str,
    new: &str,
) -> Result<Vec<String>, String> {
    let out = crate::git::run_git_env(
        root,
        &["diff", "--name-status", &format!("{old}..{new}")],
        &[],
    )?;
    let mut paths = Vec::new();
    for line in out.lines() {
        let mut fields = line.split('\t');
        let status = fields.next().unwrap_or("");
        if status.is_empty() {
            continue;
        }
        for field in fields {
            let p = field.trim().replace('\\', "/");
            if !p.is_empty() {
                paths.push(p);
            }
        }
    }
    paths.sort();
    paths.dedup();
    Ok(paths)
}

/// Blob SHAs for MANY working-tree files in ONE `git hash-object` call.
/// `git hash-object -- a b c` prints one SHA per line, in argument order, so
/// the whole page's grounding costs a single subprocess instead of one per
/// claim (each git spawn pays a ~50ms reaping floor — 64 claims on a page
/// meant 3+ seconds of blocked worker per page).
///
/// A failed call degrades to per-file hashing so a single unreadable path
/// never costs the whole page its evidence. A path with no SHA is
/// "unverifiable" — never read as "fresh".
pub(crate) fn git_blob_shas(root: &Path, rels: &[String]) -> HashMap<String, String> {
    let mut out = HashMap::with_capacity(rels.len());
    if rels.is_empty() {
        return out;
    }
    if rels.len() == 1 {
        if let Some(sha) = git_blob_sha(root, &rels[0]) {
            out.insert(rels[0].clone(), sha);
        }
        return out;
    }
    let mut args: Vec<&str> = vec!["hash-object", "--"];
    args.extend(rels.iter().map(String::as_str));
    match crate::git::run_git_env(root, &args, &[]) {
        Ok(stdout) => {
            let shas: Vec<&str> = stdout.lines().map(str::trim).collect();
            // Git prints one line per path, in order. A short output means a
            // path was skipped — fall back per-file rather than mis-aligning
            // every subsequent SHA onto the wrong file.
            if shas.len() == rels.len() {
                for (rel, sha) in rels.iter().zip(shas) {
                    if !sha.is_empty() {
                        out.insert(rel.clone(), sha.to_string());
                    }
                }
            } else {
                out = per_file_blob_shas(root, rels);
            }
        }
        Err(_) => out = per_file_blob_shas(root, rels),
    }
    out
}

fn per_file_blob_shas(root: &Path, rels: &[String]) -> HashMap<String, String> {
    let mut out = HashMap::with_capacity(rels.len());
    for rel in rels {
        if let Some(sha) = git_blob_sha(root, rel) {
            out.insert(rel.clone(), sha);
        }
    }
    out
}

/// Blob SHA of a working-tree file (the claim's version stamp). None when
/// the file vanished or git is unavailable — a missing SHA reads as
/// "unverifiable", never as "fresh".
pub(crate) fn git_blob_sha(root: &Path, rel: &str) -> Option<String> {
    crate::git::run_git_env(root, &["hash-object", "--", rel], &[])
        .ok()
        .filter(|s| !s.is_empty())
}

// ── repo analysis (phase 1 — deterministic, no model) ─────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LangStat {
    pub ext: String,
    pub files: usize,
    pub loc: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoAnalysis {
    pub root: String,
    pub is_git_repo: bool,
    pub total_files: usize,
    pub total_loc: usize,
    pub languages: Vec<LangStat>,
    pub key_files: Vec<String>,
    pub docs: Vec<String>,
    pub recent_activity: Vec<String>,
    pub truncated: bool,
}

/// Canonical repo-relative path of `p` under `root`, or None when it escapes
/// the root. Doubles as the claim-path validator. BOTH sides canonicalize:
/// on Windows `canonicalize` yields `\\?\C:\…` and comparing that against a
/// plain root failed EVERY strip_prefix (the live walk test caught it —
/// thousands of files, zero LOC).
fn rel_under_root(root: &Path, p: &Path) -> Option<String> {
    let canon = std::fs::canonicalize(p).ok()?;
    let root_canon = std::fs::canonicalize(root).ok()?;
    let rel = canon.strip_prefix(root_canon).ok()?;
    if rel.as_os_str().is_empty() {
        return None;
    }
    Some(rel.to_string_lossy().replace('\\', "/"))
}

/// The phase-1 repo map: extension/LOC statistics, key files, docs, and the
/// recent commit themes. Walk caps mirror the corpus walk; a file counts its
/// first 4k lines for LOC — analysis describes shape, not bytes.
pub fn analyze_repo(root: &Path) -> RepoAnalysis {
    let mut total_files = 0usize;
    let mut total_loc = 0usize;
    let mut stats: HashMap<String, (usize, usize)> = HashMap::new();
    let mut key_hits: Vec<String> = Vec::new();
    let mut docs: Vec<String> = Vec::new();
    let mut biggest: Vec<(usize, String)> = Vec::new();
    let mut truncated = false;

    const KEY_FILES: &[&str] = &[
        "README.md",
        "AGENTS.md",
        "CLAUDE.md",
        "package.json",
        "Cargo.toml",
        "pyproject.toml",
        "go.mod",
        "pom.xml",
        "src-tauri/tauri.conf.json",
        "src/App.tsx",
        "src/main.tsx",
        "src/index.ts",
        "src/main.py",
        "src-tauri/src/main.rs",
        "src-tauri/src/lib.rs",
    ];
    let key_set: std::collections::HashSet<&str> = KEY_FILES.iter().copied().collect();

    // Canonicalize the ROOT once and walk lexically under it. (Per-file
    // canonicalize made a 20k-file walk take a minute — the live test caught
    // it. Paths produced by read_dir under a real root need no re-resolving.)
    let root_canon = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let mut stack = vec![root_canon.clone()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            if total_files >= MAX_ANALYSIS_FILES {
                truncated = true;
                break;
            }
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            let name = entry.file_name().to_string_lossy().to_string();
            let path = entry.path();
            if file_type.is_dir() {
                if corpus_docs::SKIP_DIRS.contains(&name.as_str()) || name.starts_with('.') {
                    continue;
                }
                stack.push(path);
                continue;
            }
            total_files += 1;
            let ext = path
                .extension()
                .map(|e| e.to_string_lossy().to_lowercase())
                .unwrap_or_default();
            if ext == "md" {
                if let Ok(rel) = path.strip_prefix(&root_canon) {
                    if docs.len() < 40 {
                        docs.push(rel.to_string_lossy().replace('\\', "/"));
                    }
                }
            }
            if !corpus_docs::TEXT_EXTENSIONS.contains(&ext.as_str()) {
                continue;
            }
            let rel = match path.strip_prefix(&root_canon).ok() {
                Some(r) if !r.as_os_str().is_empty() => r.to_string_lossy().replace('\\', "/"),
                _ => continue,
            };
            if key_set.contains(rel.as_str()) && key_hits.len() < 16 {
                key_hits.push(rel.clone());
            }
            let loc = count_lines_capped(&path, 4_000);
            let entry_stats = stats.entry(ext.clone()).or_insert((0, 0));
            entry_stats.0 += 1;
            entry_stats.1 += loc;
            total_loc += loc;
            if biggest.len() < 24 {
                biggest.push((loc, rel));
                biggest.sort_by(|a, b| b.0.cmp(&a.0));
            } else {
                let last = biggest.len() - 1;
                if loc > biggest[last].0 {
                    biggest[last] = (loc, rel);
                    biggest.sort_by(|a, b| b.0.cmp(&a.0));
                }
            }
        }
        if total_files >= MAX_ANALYSIS_FILES {
            truncated = true;
        }
    }

    let mut languages: Vec<LangStat> = stats
        .into_iter()
        .map(|(ext, (files, loc))| LangStat { ext, files, loc })
        .collect();
    languages.sort_by(|a, b| b.loc.cmp(&a.loc));
    languages.truncate(8);

    let key_files = key_files_from(root, &key_hits, &biggest);
    let recent_activity = git_recent_activity(root);

    RepoAnalysis {
        root: root.to_string_lossy().to_string(),
        is_git_repo: !recent_activity.is_empty(),
        total_files,
        total_loc,
        languages,
        key_files,
        docs,
        recent_activity,
        truncated,
    }
}

fn count_lines_capped(path: &Path, max_lines: usize) -> usize {
    let Ok(mut file) = std::fs::File::open(path) else {
        return 0;
    };
    let mut buf = Vec::new();
    if file.take(200_000).read_to_end(&mut buf).is_err() {
        return 0;
    }
    if buf.contains(&0) {
        return 0; // binary
    }
    String::from_utf8_lossy(&buf).lines().take(max_lines).count()
}

fn key_files_from(root: &Path, key_hits: &[String], biggest: &[(usize, String)]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for rel in key_hits {
        if root.join(rel).is_file() && !out.contains(rel) {
            out.push(rel.clone());
        }
    }
    for (_, rel) in biggest.iter().take(8) {
        if !out.contains(rel) {
            out.push(rel.clone());
        }
    }
    out.truncate(16);
    out
}

fn git_recent_activity(root: &Path) -> Vec<String> {
    crate::git::run_git_env(root, &["log", "--oneline", "-40"], &[])
        .map(|out| out.lines().map(str::to_string).collect())
        .unwrap_or_default()
}

// ── outline (phase 2) ─────────────────────────────────────────────────────

#[derive(Debug, Clone, serde::Deserialize)]
pub(crate) struct PageBrief {
    #[serde(default)]
    pub slug: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub brief: String,
    #[serde(default)]
    pub files: Vec<String>,
}

#[derive(Debug, serde::Deserialize)]
struct OutlineShape {
    #[serde(default)]
    pages: Vec<PageBrief>,
}

pub(crate) fn sanitize_slug(raw: &str, fallback: &str) -> String {
    let cleaned: String = raw
        .trim()
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    let slug: String = cleaned.chars().take(48).collect();
    if slug.is_empty() {
        return sanitize_slug(fallback, "page");
    }
    slug
}

/// Parse + normalize the outline response: fenced JSON tolerated, bare
/// arrays tolerated, slugs sanitized (collisions suffixed), kinds folded to
/// the known set, empty briefs dropped, page cap enforced, read order =
/// contributor order.
pub(crate) fn normalize_outline(raw: &str, max_pages: usize) -> Result<Vec<PageBrief>, String> {
    let json_str = extract_json(raw)
        .ok_or_else(|| "outline response contained no JSON object".to_string())?;
    let mut briefs: Vec<PageBrief> = if let Ok(shape) = serde_json::from_str::<OutlineShape>(json_str)
    {
        shape.pages
    } else if let Ok(list) = serde_json::from_str::<Vec<PageBrief>>(json_str) {
        list
    } else {
        return Err("outline JSON did not match {\"pages\":[…]} or [……]".to_string());
    };

    let mut out: Vec<PageBrief> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for (n, mut b) in briefs.drain(..).enumerate() {
        if b.brief.trim().is_empty() {
            continue;
        }
        let mut slug = sanitize_slug(&b.slug, &b.title);
        while !seen.insert(slug.clone()) {
            slug = format!("{slug}-{}", n + 1);
        }
        b.slug = slug;
        b.title = b.title.trim().to_string();
        if b.title.is_empty() {
            b.title = b.slug.clone();
        }
        let kind = b.kind.trim().to_lowercase();
        b.kind = if PAGE_KINDS.contains(&kind.as_str()) {
            kind
        } else {
            "module".to_string()
        };
        b.summary = b.summary.trim().to_string();
        b.files = b
            .files
            .iter()
            .map(|f| f.trim().trim_start_matches("./").replace('\\', "/"))
            .filter(|f| !f.is_empty() && !f.contains("..") && !f.starts_with('/'))
            .collect();
        out.push(b);
        if out.len() >= max_pages {
            break;
        }
    }
    if out.is_empty() {
        return Err("outline produced no usable pages".to_string());
    }
    out.sort_by_key(|b| match b.kind.as_str() {
        "overview" => 0,
        "architecture" => 1,
        "module" => 2,
        "howto" => 3,
        "glossary" => 4,
        "history" => 5,
        _ => 6,
    });
    Ok(out)
}

// ── single-call build (cost/latency mode) ─────────────────────────────────

/// The whole wiki in ONE model call: outline + pages together. Cuts N+1
/// calls to 1 — one prompt overhead instead of N+1, one round-trip of
/// latency, and every page is written against the SAME context so
/// cross-page duplication drops out naturally. The trade is shallower
/// pages (one shared file budget), so this is the FAST path: any parse
/// problem falls back to the outline + per-page pipeline below.
const SINGLE_SYSTEM: &str = "You are a project-wiki generator. You get a JSON summary of a repository (languages, key files, docs, recent commit themes). Produce the COMPLETE wiki in ONE response — the outline and every page together.

Return STRICT JSON only — no prose, no code fences: {\"pages\":[{\"slug\":\"kebab-slug\",\"title\":\"...\",\"kind\":\"overview|architecture|module|howto|glossary|history\",\"summary\":\"one sentence\",\"body\":\"full page markdown\",\"claims\":[{\"claim\":\"...\",\"path\":\"repo/relative.ext\",\"lines\":[1,20]}]}]}

Page rules: between 4 and the stated cap; the first page is the overview; one module page per major subsystem; a history page only when commit themes justify one; 250-700 words per page, short sections, bullet lists, `code` references with repo-relative paths; at most 2 ```mermaid fenced diagrams per page, only for structure visible in the summary; the body is the page's PROSE ONLY — do NOT put an evidence ledger, a <!-- relay:claims --> marker or a ```relay-claims fence inside it: on this path the sibling \"claims\" array IS the ledger, and a marker left in the body renders as raw text in the reader. GROUNDED: never invent modules, flags, commands or file names; paths must come from the input summary. Order pages the way a new contributor should read them.";

#[derive(Debug, serde::Deserialize)]
struct SinglePage {
    #[serde(default)]
    slug: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    kind: String,
    #[serde(default)]
    summary: String,
    #[serde(default)]
    body: String,
    #[serde(default)]
    claims: Vec<RawClaim>,
}

#[derive(Debug, serde::Deserialize)]
struct SingleWikiShape {
    #[serde(default)]
    pages: Vec<SinglePage>,
}

/// One parsed single-call page: its normalized brief plus the body and raw
/// claims that came with it.
pub(crate) struct SinglePageParsed {
    pub brief: PageBrief,
    pub body: String,
    pub claims: Vec<RawClaim>,
}

/// Parse the one-shot wiki response. Deliberately STRICT: a response
/// missing bodies (e.g. an outline-shaped answer), with too few pages, or
/// unparseable JSON returns Err and the caller falls back to the
/// outline + per-page pipeline.
fn parse_single_wiki(raw: &str, max_pages: usize) -> Result<Vec<SinglePageParsed>, String> {
    let json_str = extract_json(raw)
        .ok_or_else(|| "single-call response contained no JSON".to_string())?;
    let mut parsed = serde_json::from_str::<SingleWikiShape>(json_str)
        .map_err(|e| format!("single-call JSON did not match: {e}"))?;
    if parsed.pages.len() < 2 {
        return Err("single-call produced fewer than 2 pages".to_string());
    }
    let mut out = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for (n, p) in parsed.pages.drain(..).enumerate() {
        if p.body.trim().len() < 80 {
            return Err("single-call page body missing or too short".to_string());
        }
        let mut slug = sanitize_slug(&p.slug, &p.title);
        // Pages are upserted on UNIQUE(project_id, slug), so two pages
        // sharing a slug means the SECOND SILENTLY OVERWRITES the first
        // while the build still reports N pages stored. Dedupe exactly the
        // way `normalize_outline` does.
        while !seen.insert(slug.clone()) {
            slug = format!("{slug}-{}", n + 1);
        }
        let title = {
            let t = p.title.trim().to_string();
            if t.is_empty() { slug.clone() } else { t }
        };
        let kind = {
            let k = p.kind.trim().to_lowercase();
            if PAGE_KINDS.contains(&k.as_str()) { k } else { "module".to_string() }
        };
        // Update passes re-derive the page from brief + files, so a
        // single-call page carries its evidence paths as its file set and a
        // summary-derived brief.
        let files: Vec<String> = {
            let mut f: Vec<String> = p
                .claims
                .iter()
                .map(|c| c.path.trim().trim_start_matches("./").replace('\\', "/"))
                .filter(|f| !f.is_empty() && !f.contains("..") && !f.starts_with('/'))
                .collect();
            f.sort();
            f.dedup();
            f
        };
        let brief_text = if p.summary.trim().is_empty() {
            format!("Rewrite the full \"{title}\" page for this project.")
        } else {
            format!(
                "{} Rewrite the full page, keeping every claim grounded.",
                p.summary.trim()
            )
        };
        out.push(SinglePageParsed {
            brief: PageBrief {
                slug,
                title,
                kind,
                summary: p.summary.trim().to_string(),
                brief: brief_text,
                files,
            },
            body: strip_claims_ledger(&p.body),
            claims: p.claims,
        });
        if out.len() >= max_pages {
            break;
        }
    }
    Ok(out)
}

// ── page generation (phase 3) ─────────────────────────────────────────────

#[derive(Debug, Clone, serde::Deserialize)]
pub(crate) struct RawClaim {
    #[serde(default)]
    pub claim: String,
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub lines: Vec<i64>,
}

const OUTLINE_SYSTEM: &str = "You are the architect layer of a project-wiki generator. You get a \
JSON summary of a repository (languages, key files, docs, recent commit themes). Produce the page \
outline for a concise developer wiki that orients a new contributor in minutes.\
\n\nReturn STRICT JSON only — no prose, no code fences: \
{\"pages\":[{\"slug\":\"kebab-slug\",\"title\":\"...\",\"kind\":\"overview|architecture|module|\
howto|glossary|history\",\"summary\":\"one sentence\",\"brief\":\"2-4 sentences telling the page \
writer exactly what to cover\",\"files\":[\"repo/relative/path.ext\"]}]}\
\n\nRules: between 4 and the stated page cap; the first page is the overview; one module page \
per major subsystem with its most important files listed; a history page only when the commit \
themes show meaningful churn stories; every \"files\" entry must be a real repo-relative path \
from the input (or an obvious direct member of a listed directory); order pages the way a new \
contributor should read them.";

const PAGE_SYSTEM: &str = "You write ONE page of a project wiki, in GitHub-flavored Markdown.\
\n\nRules:\
\n- GROUNDED: every non-obvious factual sentence must be backed by the provided file excerpts. \
Never invent modules, flags, commands or file names. If the excerpts don't cover part of the \
brief, say plainly that it isn't visible in the provided sources.\
\n- At most 2 ```mermaid fenced diagrams (flowchart / sequence / class) clarifying structure you \
can see in the sources. Never draw invented components.\
\n- Concise: 300-900 words, short sections, bullet lists, `code` references with repo-relative \
paths.\
\n- TERMINATE the page with the evidence ledger: on its own line the marker \
<!-- relay:claims --> followed by a ```relay-claims fenced JSON block:\
\n{\"claims\":[{\"claim\":\"<one self-contained factual sentence>\",\"path\":\"<repo-relative \
path you were given>\",\"lines\":[<start>,<end>]}]}\
\nList 3 to 12 claims — one per load-bearing fact. The ledger is machine-validated: paths are \
checked against the repository.";

fn outline_user(analysis: &RepoAnalysis, max_pages: usize) -> String {
    let json = serde_json::to_string(analysis).unwrap_or_else(|_| "{}".to_string());
    let json = crate::util::truncate_chars(&json, MAX_OUTLINE_INPUT_CHARS);
    format!("Repository summary:\n{json}\n\nPage cap: {max_pages}.")
}

/// The single-call prompt. Unlike the two-phase pipeline (which hands each
/// page its own file excerpts) the one-pass path writes EVERY page from one
/// context, so it needs a bounded slice of real file content itself —
/// without it the model writes from a file *listing* while its `claims` are
/// then validated and stamped with real blob SHAs, producing a DB that
/// records confident evidence for prose the model never read.
fn single_call_user(
    analysis: &RepoAnalysis,
    max_pages: usize,
    bundle: &str,
) -> String {
    let mut user = outline_user(analysis, max_pages);
    if !bundle.trim().is_empty() {
        user.push_str(&format!(
            "\nFILE EXCERPTS (heads only; repo-relative paths) — ground every \
page in these, and cite a path you can actually see here:\n\n{bundle}"
        ));
    }
    user
}

/// Read the brief's file heads, under the page char budget. Missing/binary
/// files are skipped silently — the model is instructed to flag gaps itself.
fn read_file_bundle(root: &Path, files: &[String]) -> String {
    let mut out = String::new();
    let mut budget = MAX_PAGE_INPUT_CHARS;
    for rel in files {
        if budget == 0 {
            break;
        }
        if rel.contains("..") || Path::new(rel).is_absolute() {
            continue;
        }
        let full = root.join(rel);
        // Size-check BEFORE reading: `fs::read` allocates the whole file, so a
        // model-invented path to a multi-GB artifact would OOM the process
        // rather than being skipped.
        match std::fs::metadata(&full) {
            Ok(md) if md.is_file() && md.len() <= 2_000_000 => {}
            _ => continue,
        }
        let Ok(bytes) = std::fs::read(&full) else {
            continue;
        };
        if bytes.contains(&0) {
            continue;
        }
        let text = String::from_utf8_lossy(&bytes);
        let head: String = text.chars().take(budget.min(MAX_FILE_CHARS)).collect();
        budget = budget.saturating_sub(head.chars().count());
        if head.is_empty() {
            continue;
        }
        out.push_str(&format!("=== {rel} ===\n{head}\n\n"));
    }
    out
}

fn page_user(brief: &PageBrief, bundle: &str, freshness_note: Option<&str>) -> String {
    let mut user = format!(
        "PAGE: {} ({}) — {}\nBRIEF: {}\n",
        brief.slug, brief.kind, brief.title, brief.brief
    );
    if let Some(note) = freshness_note {
        user.push_str(&format!(
            "\nFRESHNESS: this page is being refreshed after its sources changed. \
{note}\n"
        ));
    }
    user.push_str(&format!(
        "\nFILE EXCERPTS (heads only; repo-relative paths):\n\n{bundle}"
    ));
    user
}

/// Extract the JSON payload from a model response: direct parse span, else
/// the span between the first brace/bracket and the last (fence-tolerant).
pub(crate) fn extract_json(raw: &str) -> Option<&str> {
    let trimmed = raw.trim();
    if (trimmed.starts_with('{') || trimmed.starts_with('['))
        && (trimmed.ends_with('}') || trimmed.ends_with(']'))
    {
        return Some(trimmed);
    }
    let start = raw.find(['{', '['])?;
    let end = raw.rfind(['}', ']'])?;
    if end < start {
        return None;
    }
    Some(&raw[start..=end])
}

/// Split a page response into (body, raw claims). A missing/invalid ledger
/// degrades to zero claims — the page still reads fine, it just never trips
/// the freshness join. Per-claim validation lives in `validate_claims`.
/// Strip evidence-ledger residue out of a page body: every `<!-- relay:claims -->`
/// marker plus the ```relay-claims fenced block that follows it.
///
/// The reader renders `body` as markdown, so anything left here shows up as raw
/// text right above the real evidence list. `parse_page` removes only the LAST
/// marker (a model that repeats it leaves the earlier ones behind) and the
/// single-call path stores the body verbatim, so both go through here.
/// Idempotent, and a no-op on a clean body.
fn strip_claims_ledger(body: &str) -> String {
    if !body.contains(CLAIMS_MARKER) {
        return body.trim().to_string();
    }
    let mut out = String::with_capacity(body.len());
    let mut rest = body;
    while let Some(idx) = rest.find(CLAIMS_MARKER) {
        out.push_str(&rest[..idx]);
        rest = &rest[idx + CLAIMS_MARKER.len()..];
        // Remove the ledger BLOCK wherever it is, but nothing else. The old
        // code searched forward for ```relay-claims anywhere in the
        // remainder and deleted everything from the marker to that block's
        // close — so a model that put real prose between the marker and the
        // fence lost that prose from the stored page, silently. Cutting only
        // the fence's own span keeps the prose AND removes the ledger.
        //
        // An unterminated fence is left alone rather than truncating the
        // rest of the page: losing visible prose is worse than showing a
        // stray fence.
        let Some(open) = rest.find("```relay-claims") else {
            continue;
        };
        let after = open + "```relay-claims".len();
        match rest[after..].find("```") {
            Some(close) => {
                let end = after + close + 3;
                out.push_str(&rest[..open]);
                rest = &rest[end..];
            }
            None => {
                out.push_str(rest);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out.trim().to_string()
}

pub(crate) fn parse_page(raw: &str) -> (String, Vec<RawClaim>) {
    let Some(idx) = raw.rfind(CLAIMS_MARKER) else {
        return (raw.trim().to_string(), Vec::new());
    };
    let body = strip_claims_ledger(&raw[..idx]);
    let tail = &raw[idx + CLAIMS_MARKER.len()..];
    let Some(json_str) = extract_json(tail) else {
        return (body, Vec::new());
    };
    #[derive(serde::Deserialize)]
    struct ClaimsShape {
        #[serde(default)]
        claims: Vec<RawClaim>,
    }
    let claims = serde_json::from_str::<ClaimsShape>(json_str)
        .map(|s| s.claims)
        .unwrap_or_default();
    (body, claims)
}

/// Normalize a model-supplied evidence path to a repo-relative form, or None
/// when it is not a plain in-repo path. Claim paths come from untrusted model
/// output, so this is a security boundary, not a formatting nicety:
///   - `..` segments and absolute paths are rejected. `starts_with('/')` alone
///     only catches Unix absolutes — on Windows `Path::join` DISCARDS the base
///     for `C:/…` or `\\server\…`, which would let a claim hash and render a
///     file outside the repo entirely.
///   - the result must resolve to a real file under the root, verified
///     through `rel_under_root`'s canonicalize-and-strip so symlinks and
///     junction points can't smuggle a path out either.
fn normalize_claim_path(root: &Path, raw: &str) -> Option<String> {
    let rel = raw.trim().replace('\\', "/");
    let rel = rel.trim_start_matches("./");
    if rel.is_empty() || rel.contains("..") || rel.starts_with('/') {
        return None;
    }
    let rel = Path::new(&rel);
    if rel.is_absolute() {
        return None;
    }
    // A symlink whose target lives outside the repo canonicalizes out of
    // root; `is_file` alone would accept it.
    rel_under_root(root, &root.join(rel))
}

/// Turn raw model claims into storable ones: the path must resolve to a real
/// file inside the repo, line ranges must be sane, the blob SHA comes from
/// the working tree. Bad claims are DROPPED, never guessed into validity.
///
/// Blob SHAs are resolved in ONE batched `git hash-object` (see
/// `git_blob_shas`) — a per-claim subprocess was the single largest blocking
/// cost in a build. Purely synchronous; callers on an async path must wrap
/// this in `spawn_blocking`.
pub(crate) fn validate_claims(root: &Path, raw: &[RawClaim]) -> Vec<db::WikiClaim> {
    let mut kept: Vec<db::WikiClaim> = Vec::new();
    let mut paths: Vec<String> = Vec::new();
    for c in raw {
        // The cap is a hard stop; an empty claim is a per-entry defect and
        // must NOT discard every later claim with it (claims are also the
        // page's freshness join key, so a truncated ledger froze the page).
        if kept.len() >= MAX_CLAIMS_PER_PAGE {
            break;
        }
        if c.claim.trim().is_empty() {
            continue;
        }
        let Some(path) = normalize_claim_path(root, &c.path) else {
            continue;
        };
        let (line_start, line_end) = match c.lines.as_slice() {
            [a, b] if a >= &1 && b >= a => (Some(*a), Some(*b)),
            _ => (None, None),
        };
        paths.push(path.clone());
        kept.push(db::WikiClaim {
            claim: c.claim.trim().to_string(),
            evidence_path: path,
            line_start,
            line_end,
            blob_sha: None,
        });
    }
    let shas = git_blob_shas(root, &paths);
    for claim in &mut kept {
        claim.blob_sha = shas.get(&claim.evidence_path).cloned();
    }
    kept
}

// ── build + update orchestration ──────────────────────────────────────────

/// One retry around a page-generation call. Harness one-shots transiently
/// return empty (CLI session hiccups) and cloud endpoints occasionally drop
/// a request; the outline call just proved the engine alive, so a single
/// retry rescues the build instead of failing it (and, pre-fix, loosing the
/// freshness tick into a silent hourly rebuild loop).
async fn call_page_with_retry(
    caller: &Caller,
    user: &str,
) -> Result<String, String> {
    match caller.call(PAGE_SYSTEM, user, 4_096).await {
        Ok(raw) => Ok(raw),
        Err(first) => match caller.call(PAGE_SYSTEM, user, 4_096).await {
            Ok(raw) => Ok(raw),
            Err(second) => Err(format!(
                "{second} (retry after a first failure: {first})"
            )),
        },
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildOutcome {
    pub pages: usize,
    pub model: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateReport {
    /// "updated" | "up_to_date" | "rebuilt" | "not_git" | "no_wiki"
    pub status: String,
    pub pages_refreshed: usize,
    pub changed_paths: usize,
}

fn max_pages_from(conn: &Connection) -> usize {
    db::get_setting(conn, SETTING_MAX_PAGES)
        .ok()
        .flatten()
        .and_then(|v| v.trim().parse::<usize>().ok())
        .filter(|v| (2..=60).contains(v))
        .unwrap_or(DEFAULT_MAX_PAGES)
}

fn db_access<R: Runtime>(app: &AppHandle<R>) -> Arc<Mutex<Connection>> {
    Arc::clone(&app.state::<crate::DbState>().0)
}

/// Full build: analyze → outline → pages → stamp. The model resolves BEFORE
/// any clearing — a missing provider must leave the existing wiki intact.
/// Cancellation is checked between pages; a cancelled build leaves the wiki
/// cleared (a half wiki claiming freshness would be worse).
pub(crate) async fn run_build<R: Runtime>(
    app: &AppHandle<R>,
    root: &Path,
) -> Result<BuildOutcome, String> {
    let caller = {
        let conn = db_access(app);
        let conn = conn.lock();
        resolve_build_model(&conn)
    }
    .inspect_err(|e| {
        if let Ok(canonical) = canonical_root(root) {
            emit_progress(
                app,
                &canonical,
                "build",
                "error",
                "outline",
                None,
                0,
                0,
                Some(e.clone()),
        Some("Failed".to_string()));
        }
    })?;
    run_build_with(app, root, caller).await
}

/// The build core with the model injected (test seam; `run_build` resolves
/// from settings). The model resolves BEFORE any clearing — a missing
/// provider must leave the existing wiki intact. Cancellation is checked
/// between pages; a cancelled build leaves the wiki cleared (a half wiki
/// claiming freshness would be worse).
pub(crate) async fn run_build_with<R: Runtime>(
    app: &AppHandle<R>,
    root: &Path,
    caller: Caller,
) -> Result<BuildOutcome, String> {
    let canonical = canonical_root(root)?;
    let result = run_build_acquired(app, &canonical, caller).await;
    // EVERY failure must reach the UI. Page-call errors used to `?` out
    // with no event at all — the feed froze at the last running step while
    // the freshness tick silently restarted the build every minute (the
    // stuck/repeating loop the live test of the tool panel exposed).
    if let Err(e) = &result {
        if e != "cancelled" {
            emit_progress(
                app,
                &canonical,
                "build",
                "error",
                "pages",
                None,
                0,
                0,
                Some(e.clone()),
                Some(format!(
                    "Build failed: {}",
                    crate::util::truncate_chars(e, 160)
                )),
            );
        }
    }
    result
}

async fn run_build_acquired<R: Runtime>(
    app: &AppHandle<R>,
    canonical: &str,
    caller: Caller,
) -> Result<BuildOutcome, String> {
    let registry = Arc::clone(app.state::<Arc<WikiJobRegistry>>().inner());
    let (_guard, cancel_flag) = try_acquire(&registry, canonical)?;

    let head_root = PathBuf::from(canonical);
    let head = tauri::async_runtime::spawn_blocking(move || git_head(&head_root))
        .await
        .map_err(|e| e.to_string())?;

    emit_progress(app, &canonical, "build", "running", "analysis", None, 0, 0, None,
        Some("Exploring the project structure".to_string()));
    let analysis_root = PathBuf::from(&canonical);
    let analysis = tauri::async_runtime::spawn_blocking(move || analyze_repo(&analysis_root))
        .await
        .map_err(|e| e.to_string())?;

    let fail = |e: String| {
        emit_progress(
            app,
            canonical,
            "build",
            "error",
            "outline",
            None,
            0,
            0,
            Some(e.clone()),
        Some("Failed".to_string()));
        e
    };
    let model_label = caller.label();

    let (project_id, max_pages) = {
        let conn = db_access(app);
        let conn = conn.lock();
        let project = db::wiki_ensure_project(&conn, canonical).map_err(|e| e.to_string())?;
        db::wiki_clear_pages(&conn, &project.id).map_err(|e| e.to_string())?;
        // Clearing the pages WITHOUT dropping the build stamp left a wiki that
        // no update pass could ever repair: zero pages, but the OLD head_sha
        // intact, so the freshness tick saw "HEAD unchanged" and
        // `run_update` short-circuited to up_to_date. A failed REBUILD (as
        // opposed to a first build, which self-heals on `head_sha.is_none()`)
        // was wedged until the user clicked Build again by hand. An honest
        // empty state is "never built": the next tick rebuilds.
        db::wiki_clear_build_stamp(&conn, &project.id).map_err(|e| e.to_string())?;
        (project.id, max_pages_from(&conn))
    };
    let root_path = PathBuf::from(canonical);
    // ── FAST PATH: the whole wiki in ONE call. N+1 model calls → 1: one
    // prompt overhead, one round-trip of latency, and every page written
    // against the same context. Any parse problem (truncation, outline-
    // shaped answer) falls through to the two-phase pipeline below.
    {
        emit_progress(
            app,
            canonical,
            "build",
            "running",
            "outline",
            None,
            0,
            0,
            None,
            Some("Writing the whole wiki in one pass".to_string()),
        );
        let single = {
            // Ground the one-pass build in real content: the key files the
            // analysis already ranked, read under a hard char budget.
            let bundle_root = PathBuf::from(canonical);
            let bundle_files = analysis.key_files.clone();
            let bundle = tauri::async_runtime::spawn_blocking(move || {
                read_file_bundle(&bundle_root, &bundle_files)
            })
            .await
            .map_err(|e| e.to_string())?;
            caller
                .call(
                    SINGLE_SYSTEM,
                    &single_call_user(&analysis, max_pages, &bundle),
                    16_000,
                )
                .await
        };
        if let Ok(raw) = single {
            if let Ok(single_pages) = parse_single_wiki(&raw, max_pages) {
                let total = single_pages.len();
                emit_progress(
                    app,
                    canonical,
                    "build",
                    "running",
                    "pages",
                    None,
                    0,
                    total,
                    None,
                    Some(format!("One pass produced {total} pages — grounding them")),
                );
                let mut stored = 0usize;
                for sp in &single_pages {
                    if cancelled(&cancel_flag) {
                        emit_progress(
                            app,
                            canonical,
                            "build",
                            "cancelled",
                            "pages",
                            Some(&sp.brief.slug),
                            stored,
                            total,
                            None,
                            Some("Cancelled".to_string()),
                        );
                        return Err("cancelled".to_string());
                    }
                    let claims_root = root_path.clone();
                    let raw_claims = sp.claims.clone();
                    let claims = tauri::async_runtime::spawn_blocking(move || {
                        validate_claims(&claims_root, &raw_claims)
                    })
                    .await
                    .map_err(|e| e.to_string())?;
                    {
                        let conn = db_access(app);
                        let conn = conn.lock();
                        db::wiki_replace_page(
                            &conn,
                            &project_id,
                            &sp.brief.slug,
                            &sp.brief.title,
                            &sp.brief.kind,
                            &sp.brief.summary,
                            &sp.body,
                            &sp.brief.brief,
                            &sp.brief.files,
                            "fresh",
                            Some(&model_label),
                            &claims,
                        )
                        .map_err(|e| e.to_string())?;
                    }
                    stored += 1;
                    emit_progress(
                        app,
                        canonical,
                        "build",
                        "running",
                        "pages",
                        Some(&sp.brief.slug),
                        stored,
                        total,
                        None,
                        Some(format!(
                            "Stored page: {} ({stored}/{total})",
                            sp.brief.title
                        )),
                    );
                }
                {
                    let conn = db_access(app);
                    let conn = conn.lock();
                    db::wiki_stamp_build(&conn, &project_id, head.as_deref(), Some(&model_label))
                        .map_err(|e| e.to_string())?;
                }
                emit_progress(
                    app,
                    canonical,
                    "build",
                    "done",
                    "finalizing",
                    None,
                    stored,
                    total,
                    None,
                    Some(format!("Wiki ready — {stored} pages (one pass)")),
                );
                // The fast path used to `return` before the watcher install
                // below, so the DEFAULT build — the one almost every wiki
                // actually takes — got no commit-triggered freshness and
                // silently fell back to the 15-minute sweep until restart.
                install_wiki_git_watcher(app, canonical);
                return Ok(BuildOutcome {
                    pages: stored,
                    model: model_label,
                });
            }
        }
        emit_progress(
            app,
            canonical,
            "build",
            "running",
            "outline",
            None,
            0,
            0,
            None,
            Some(
                "One pass didn't hold up — drafting the outline, then pages"
                    .to_string(),
            ),
        );
    }

    let outline_raw = caller
        .call(
            OUTLINE_SYSTEM,
            &outline_user(&analysis, max_pages),
            2_000,
        )
        .await
        .map_err(fail)?;
    let briefs = normalize_outline(&outline_raw, max_pages).map_err(fail)?;
    let total = briefs.len();
    emit_progress(
        app,
        &canonical,
        "build",
        "running",
        "pages",
        None,
        0,
        total,
        None,
        Some(format!("Drafted {total} pages — writing them now")));

    let mut pages_done = 0usize;
    for brief in &briefs {
        if cancelled(&cancel_flag) {
            emit_progress(
                app,
                canonical,
                "build",
                "cancelled",
                "pages",
                Some(&brief.slug),
                pages_done,
                total,
                None,
        Some("Cancelled".to_string()));
            return Err("cancelled".to_string());
        }
        let root_for_bundle = root_path.clone();
        let files = brief.files.clone();
        let bundle =
            tauri::async_runtime::spawn_blocking(move || read_file_bundle(&root_for_bundle, &files))
                .await
                .map_err(|e| e.to_string())?;
        let raw = call_page_with_retry(&caller, &page_user(brief, &bundle, None)).await?;
        let (body, raw_claims) = parse_page(&raw);
        let claims_root = root_path.clone();
        let claims = tauri::async_runtime::spawn_blocking(move || {
            validate_claims(&claims_root, &raw_claims)
        })
        .await
        .map_err(|e| e.to_string())?;
        {
            let conn = db_access(app);
            let conn = conn.lock();
            db::wiki_replace_page(
                &conn,
                &project_id,
                &brief.slug,
                &brief.title,
                &brief.kind,
                &brief.summary,
                &body,
                &brief.brief,
                &brief.files,
                "fresh",
                Some(&model_label),
                &claims,
            )
            .map_err(|e| e.to_string())?;
        }
        pages_done += 1;
        emit_progress(
            app,
            canonical,
            "build",
            "running",
            "pages",
            Some(&brief.slug),
            pages_done,
            total,
            None,
        Some(format!("Wrote page: {} ({pages_done}/{total})", brief.title)));
    }

    {
        let conn = db_access(app);
        let conn = conn.lock();
        db::wiki_stamp_build(&conn, &project_id, head.as_deref(), Some(&model_label))
            .map_err(|e| e.to_string())?;
    }
    install_wiki_git_watcher(app, canonical);
    emit_progress(
        app,
        &canonical,
        "build",
        "done",
        "finalizing",
        None,
        pages_done,
        total,
        None,
        Some(format!("Wiki ready — {pages_done} pages")));
    Ok(BuildOutcome {
        pages: pages_done,
        model: model_label,
    })
}

/// Affected-page detection: changed paths ∩ (claim evidence ∪ stored file
/// set). The file set is a fallback for pages whose claims were all dropped
/// by `validate_claims` — those pages have no `wiki_claims` rows at all, and
/// joining on claims alone made them permanently unreachable by the freshness
/// engine (the update passed them as unaffected and advanced the HEAD stamp
/// past every commit that could have repaired them).
fn affected_pages(
    conn: &Connection,
    project_id: &str,
    changed: &[String],
) -> Result<Vec<String>, rusqlite::Error> {
    let evidence = db::wiki_evidence_paths(conn, project_id)?;
    let changed_set: std::collections::HashSet<&str> = changed.iter().map(String::as_str).collect();
    let mut affected: Vec<String> = evidence
        .into_iter()
        .filter(|(_, path)| changed_set.contains(path.as_str()))
        .map(|(slug, _)| slug)
        .collect();
    // "We cannot check this page at all" is not "this page is still current":
    // with commits landing, refresh it rather than certify it.
    affected.extend(db::wiki_pages_without_evidence(conn, project_id)?);
    affected.sort();
    affected.dedup();
    Ok(affected)
}

/// Flag every affected page stale BEFORE any model call. Otherwise a failure
/// part-way through the refresh loop (`?` on the model call) left the
/// untouched remainder still labelled "fresh" while their cited evidence had
/// demonstrably changed, and `wiki_stamp_update` never ran — the LLM (via
/// `index_prompt_section`) and the reader (via the status badge) were both
/// told stale content was current. `replace_page` resets each page to
/// "fresh" as it is successfully regenerated.
fn mark_affected_stale(
    conn: &Connection,
    project_id: &str,
    affected: &[String],
    changed: &[String],
) -> Result<(), rusqlite::Error> {
    let changed_set: std::collections::HashSet<&str> = changed.iter().map(String::as_str).collect();
    for slug in affected {
        let (brief, files) = match db::wiki_page_brief(conn, project_id, slug)? {
            Some(v) => v,
            None => continue,
        };
        let _ = brief;
        let files_set: std::collections::HashSet<&str> = files.iter().map(String::as_str).collect();
        let mut hits: Vec<String> = changed
            .iter()
            .filter(|c| changed_set.contains(c.as_str()) && files_set.contains(c.as_str()))
            .cloned()
            .collect();
        if hits.is_empty() {
            // Affected via claims or via "no evidence" — name the diff as the
            // reason rather than inventing a file attribution.
            hits = changed.iter().take(MAX_STALE_REASON_FILES).cloned().collect();
        }
        db::wiki_set_page_status(conn, project_id, slug, "stale", Some(&stale_reason_for(&hits)))?;
    }
    Ok(())
}

fn stale_reason_for(changed: &[String]) -> String {
    let mut reason: String = changed
        .iter()
        .take(MAX_STALE_REASON_FILES)
        .cloned()
        .collect::<Vec<_>>()
        .join(", ");
    if changed.len() > MAX_STALE_REASON_FILES {
        reason.push_str(&format!(" +{} more", changed.len() - MAX_STALE_REASON_FILES));
    }
    reason
}

/// Freshness pass (§4.3): diff HEADs, join against claim evidence, re-derive
/// only affected pages from their stored briefs. A clean repo — or a diff
/// that touches nothing the wiki cites — costs ZERO model calls; the no-op
/// is the feature.
pub(crate) async fn run_update<R: Runtime>(
    app: &AppHandle<R>,
    root: &Path,
) -> Result<UpdateReport, String> {
    let caller = {
        let conn = db_access(app);
        let conn = conn.lock();
        resolve_build_model(&conn)
    }?;
    run_update_with(app, root, caller).await
}

/// The update core with the model injected (test seam; the no-op paths never
/// touch it, which is how the zero-model-call guarantee is tested).
pub(crate) async fn run_update_with<R: Runtime>(
    app: &AppHandle<R>,
    root: &Path,
    caller: Caller,
) -> Result<UpdateReport, String> {
    let canonical = canonical_root(root)?;
    let registry = Arc::clone(app.state::<Arc<WikiJobRegistry>>().inner());
    let (guard, cancel_flag) = try_acquire(&registry, &canonical)?;

    let project = {
        let conn = db_access(app);
        let conn = conn.lock();
        match db::wiki_get_project_by_path(&conn, &canonical).map_err(|e| e.to_string())? {
            Some(p) => p,
            None => {
                return Ok(UpdateReport {
                    status: "no_wiki".to_string(),
                    pages_refreshed: 0,
                    changed_paths: 0,
                })
            }
        }
    };

    let root_for_head = PathBuf::from(&canonical);
    let head_now = tauri::async_runtime::spawn_blocking(move || git_head(&root_for_head))
        .await
        .map_err(|e| e.to_string())?;
    let Some(head_now) = head_now else {
        return Ok(UpdateReport {
            status: "not_git".to_string(),
            pages_refreshed: 0,
            changed_paths: 0,
        });
    };

    // Never built, or the page format moved on: only a full rebuild is honest.
    if project.head_sha.is_none() || project.schema_version < db::WIKI_SCHEMA_VERSION {
        // Release the slot so the rebuild can take it. The cancel flag is an
        // Arc held by this scope, so it stays valid (and false) across the
        // hand-off rather than going dead with the registry entry.
        drop(guard);
        let out = run_build_with(app, root, caller).await?;
        return Ok(UpdateReport {
            status: "rebuilt".to_string(),
            pages_refreshed: out.pages,
            changed_paths: 0,
        });
    }
    let old_head = project.head_sha.clone().unwrap_or_default();
    if old_head == head_now {
        return Ok(UpdateReport {
            status: "up_to_date".to_string(),
            pages_refreshed: 0,
            changed_paths: 0,
        });
    }

    let root_for_diff = PathBuf::from(&canonical);
    let old = old_head.clone();
    let now = head_now.clone();
    let changed = tauri::async_runtime::spawn_blocking(move || {
        git_changed_paths(&root_for_diff, &old, &now)
    })
    .await
    .map_err(|e| e.to_string())?;
    // A failed diff (force-push, shallow clone, rewritten history) must NOT
    // read as "nothing changed" — rebuild instead of lying.
    let changed = match changed {
        Ok(c) => c,
        Err(_) => {
            drop(guard);
            let out = run_build_with(app, root, caller).await?;
            return Ok(UpdateReport {
                status: "rebuilt".to_string(),
                pages_refreshed: out.pages,
                changed_paths: 0,
            });
        }
    };
    if changed.is_empty() {
        let conn = db_access(app);
        let conn = conn.lock();
        db::wiki_stamp_update(&conn, &project.id, Some(&head_now)).map_err(|e| e.to_string())?;
        return Ok(UpdateReport {
            status: "up_to_date".to_string(),
            pages_refreshed: 0,
            changed_paths: 0,
        });
    }

    let affected = {
        let conn = db_access(app);
        let conn = conn.lock();
        affected_pages(&conn, &project.id, &changed).map_err(|e| e.to_string())?
    };
    if affected.is_empty() {
        let conn = db_access(app);
        let conn = conn.lock();
        db::wiki_stamp_update(&conn, &project.id, Some(&head_now)).map_err(|e| e.to_string())?;
        return Ok(UpdateReport {
            status: "up_to_date".to_string(),
            pages_refreshed: 0,
            changed_paths: changed.len(),
        });
    }

    let model_label = caller.label();
    let total = affected.len();
    // Flag them stale up front — see `mark_affected_stale`.
    {
        let conn = db_access(app);
        let conn = conn.lock();
        mark_affected_stale(&conn, &project.id, &affected, &changed)
            .map_err(|e| e.to_string())?;
    }
    emit_progress(
        app,
        &canonical,
        "update",
        "running",
        "pages",
        None,
        0,
        total,
        None,
        Some(format!("{total} page(s) cite changed sources — refreshing")));

    let root_path = PathBuf::from(&canonical);
    let mut refreshed = 0usize;
    for slug in &affected {
        if cancelled(&cancel_flag) {
            emit_progress(
                app,
                &canonical,
                "update",
                "cancelled",
                "pages",
                Some(slug),
                refreshed,
                total,
                None,
        Some("Cancelled".to_string()));
            return Err("cancelled".to_string());
        }
        let (brief_text, files, title, kind, summary) = {
            let conn = db_access(app);
            let conn = conn.lock();
            let pages = db::wiki_list_pages(&conn, &project.id).map_err(|e| e.to_string())?;
            let page = pages
                .iter()
                .find(|p| p.slug == *slug)
                .ok_or_else(|| format!("page '{slug}' vanished mid-update"))?
                .clone();
            let (brief_text, files) = db::wiki_page_brief(&conn, &project.id, slug)
                .map_err(|e| e.to_string())?
                .ok_or_else(|| format!("brief for '{slug}' vanished mid-update"))?;
            (brief_text, files, page.title, page.kind, page.summary)
        };
        let files_set: std::collections::HashSet<&str> = files.iter().map(String::as_str).collect();
        let changed_for_page: Vec<String> = changed
            .iter()
            .filter(|c| files_set.contains(c.as_str()))
            .cloned()
            .collect();
        let note = format!(
            "These of this page's evidence files changed: {}. Re-check every claim against the \
current excerpts; drop or re-evidence claims that no longer hold.",
            stale_reason_for(&changed_for_page)
        );
        let brief = PageBrief {
            slug: slug.clone(),
            title,
            kind,
            summary,
            brief: brief_text,
            files: files.clone(),
        };
        let root_for_bundle = root_path.clone();
        let bundle_files = files.clone();
        let bundle = tauri::async_runtime::spawn_blocking(move || {
            read_file_bundle(&root_for_bundle, &bundle_files)
        })
        .await
        .map_err(|e| e.to_string())?;
        let raw =
            call_page_with_retry(&caller, &page_user(&brief, &bundle, Some(&note))).await?;
        let (body, raw_claims) = parse_page(&raw);
        let claims_root = root_path.clone();
        let claims = tauri::async_runtime::spawn_blocking(move || {
            validate_claims(&claims_root, &raw_claims)
        })
        .await
        .map_err(|e| e.to_string())?;
        {
            let conn = db_access(app);
            let conn = conn.lock();
            db::wiki_replace_page(
                &conn,
                &project.id,
                slug,
                &brief.title,
                &brief.kind,
                &brief.summary,
                &body,
                &brief.brief,
                &files,
                "fresh",
                Some(&model_label),
                &claims,
            )
            .map_err(|e| e.to_string())?;
        }
        refreshed += 1;
        emit_progress(
            app,
            &canonical,
            "update",
            "running",
            "pages",
            Some(slug),
            refreshed,
            total,
            None,
        Some(format!("Refreshing page: {slug} ({refreshed}/{total})")));
    }

    {
        let conn = db_access(app);
        let conn = conn.lock();
        db::wiki_stamp_update(&conn, &project.id, Some(&head_now)).map_err(|e| e.to_string())?;
    }
    emit_progress(
        app,
        &canonical,
        "update",
        "done",
        "finalizing",
        None,
        refreshed,
        total,
        None,
        Some(format!("Up to date — {refreshed} page(s) refreshed")));
    Ok(UpdateReport {
        status: "updated".to_string(),
        pages_refreshed: refreshed,
        changed_paths: changed.len(),
    })
}

fn canonical_root(root: &Path) -> Result<String, String> {
    canonical_root_str(&root.to_string_lossy())
}

pub(crate) fn canonical_root_str(path: &str) -> Result<String, String> {
    let canon =
        std::fs::canonicalize(path).map_err(|e| format!("project folder not readable: {e}"))?;
    Ok(normalize_canonical_path(&canon.to_string_lossy()))
}

// ── freshness (commit-triggered, not polled) ──────────────────────────────

/// Keep-alive registry for the per-wiki `.git` watchers (notify stops when
/// the watcher handle drops) + the sender watchers push root paths through.
/// Managed once by [`spawn_freshness_task`].
pub struct WikiGitWatchState {
    pub tx: tokio::sync::mpsc::UnboundedSender<String>,
    pub watchers: Mutex<HashMap<String, notify::RecommendedWatcher>>,
}

/// Watch `<root>/.git` for changes. A commit touches `logs/HEAD` /
/// `refs/heads` / `COMMIT_EDITMSG` — all inside `.git` — so one recursive
/// watch per wiki catches every commit (plus a few unrelated git writes,
/// which the HEAD-SHA compare inside the update pass filters for free:
/// equal HEADs are a cheap no-op). Idempotent per root.
pub fn install_wiki_git_watcher<R: Runtime>(app: &AppHandle<R>, root: &str) {
    let Some(state) = app.try_state::<WikiGitWatchState>() else {
        return;
    };
    let mut watchers = state.watchers.lock();
    if watchers.contains_key(root) {
        return;
    }
    let git_dir = std::path::PathBuf::from(root).join(".git");
    if !git_dir.is_dir() {
        return;
    }
    let tx = state.tx.clone();
    let root_for_event = root.to_string();
    let watcher = notify::recommended_watcher(
        move |res: Result<notify::Event, notify::Error>| {
            if res.is_ok() {
                let _ = tx.send(root_for_event.clone());
            }
        },
    );
    match watcher {
        Ok(mut w) => {
            if let Err(e) = w.watch(&git_dir, notify::RecursiveMode::Recursive) {
                eprintln!("[wiki] git watch install failed for {root}: {e}");
                return;
            }
            watchers.insert(root.to_string(), w);
        }
        Err(e) => eprintln!("[wiki] git watcher create failed for {root}: {e}"),
    }
}

/// Boot: manage the watch state, install watchers for every existing wiki,
/// then run the event loop — debounced per-root checks on `.git` events
/// (i.e. on COMMIT) plus a slow safety sweep for anything the events miss
/// (packed-refs updates, watchers that failed to install). Replaces the old
/// 60s interval: wikis are event-driven now.
pub fn spawn_freshness_task(app: AppHandle) {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    if app.try_state::<WikiGitWatchState>().is_none() {
        app.manage(WikiGitWatchState {
            tx,
            watchers: Mutex::new(HashMap::new()),
        });
    } else {
        // spawn_freshness_task runs once from lib.rs setup; a second call
        // would orphan the first loop's receiver.
        eprintln!("[wiki] freshness task spawned twice; keeping existing watch state");
        return;
    }
    for project in {
        let conn = db_access(&app);
        let conn = conn.lock();
        db::wiki_list_projects(&conn).unwrap_or_default()
    } {
        install_wiki_git_watcher(&app, &project.path);
    }
    let state = app.state::<WikiGitWatchState>();
    let loop_tx = state.tx.clone();
    drop(state);
    tauri::async_runtime::spawn(async move {
        let mut rx = rx;
        let mut sweep = tokio::time::interval(Duration::from_secs(15 * 60));
        sweep.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            // Batch of roots to check: a `.git` burst debounces into one
            // check, and the sweep fans out to every wiki.
            let roots: Vec<String> = tokio::select! {
                r = rx.recv() => match r {
                    Some(root) => {
                        // 2s quiet window: a commit bursts several .git
                        // events; collapse them into one check. The drained
                        // roots are KEPT — discarding them silently lost a
                        // project's trigger whenever two repos committed
                        // inside the same window.
                        let mut batch = vec![root];
                        while let Ok(Some(more)) =
                            tokio::time::timeout(Duration::from_secs(2), rx.recv()).await
                        {
                            if !batch.contains(&more) {
                                batch.push(more);
                            }
                        }
                        batch
                    }
                    None => return,
                },
                _ = sweep.tick() => {
                    let conn = db_access(&app);
                    let conn = conn.lock();
                    db::wiki_list_projects(&conn)
                        .unwrap_or_default()
                        .into_iter()
                        .map(|p| p.path)
                        .collect()
                }
            };
            // One slow wiki used to stall this single loop for as long as its
            // model calls took (pages x up to 10 minutes), which also delayed
            // the 15-minute sweep and every other project's event. Each root
            // is checked independently now; the per-project job registry is
            // what keeps two checks for the SAME project from overlapping.
            for root in roots {
                let app_for_root = app.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = freshness_check(&app_for_root, &root).await {
                        if e != "cancelled" {
                            eprintln!("[wiki] freshness check failed for {root}: {e}");
                        }
                    }
                });
            }
        }
    });
    // The loop's sender clone: watchers hold their own clones from managed
    // state; this one just keeps the manage-state sender from being the
    // only one (dropping it is harmless, but keep symmetry explicit).
    let _ = loop_tx;
}

/// Check one root (or ALL wikis when `root` is empty — the safety sweep):
/// run the update pass when the stored HEAD moved and auto-update is on.
/// Never fires for a wiki with no stored HEAD — first builds are strictly
/// user-initiated (the old tick auto-rebuilding FAILED builds forever was
/// the loop that shipped).
async fn freshness_check<R: Runtime>(app: &AppHandle<R>, root: &str) -> Result<(), String> {
    let auto_update = {
        let conn = db_access(app);
        let conn = conn.lock();
        db::get_setting(&conn, SETTING_AUTO_UPDATE)
            .ok()
            .flatten()
            .map(|v| v.trim() != "false")
            .unwrap_or(true)
    };
    if !auto_update {
        return Ok(());
    }
    let roots: Vec<String> = if root.is_empty() {
        let conn = db_access(app);
        let conn = conn.lock();
        db::wiki_list_projects(&conn)
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|p| p.path)
            .collect()
    } else {
        vec![root.to_string()]
    };
    for path in roots {
        let stored_head = {
            let conn = db_access(app);
            let conn = conn.lock();
            db::wiki_get_project_by_path(&conn, &path)
                .ok()
                .flatten()
                .and_then(|p| p.head_sha)
        };
        let root_path = PathBuf::from(&path);
        let head = tauri::async_runtime::spawn_blocking(move || git_head(&root_path))
            .await
            .map_err(|e| e.to_string())?;
        if head.is_some() && stored_head.is_some() && head != stored_head {
            if let Err(e) = run_update(app, Path::new(&path)).await {
                if e != "cancelled" {
                    eprintln!("[wiki] auto-update for {path} failed: {e}");
                }
            }
        }
    }
    Ok(())
}

// ── prompt layering (the index page, beside AGENTS.md) ────────────────────

/// The layered "project knowledge" section: the page index (slug, title,
/// summary, status) plus an instruction to pull pages via the tools — never
/// the pages themselves. Absent when the wiki has no pages, so prompt
/// prefixes stay stable. Firewalled like every other injected block: the
/// wiki is GENERATED FROM repo content, which is untrusted input.
pub fn index_prompt_section(conn: &Connection, root: &str) -> Option<String> {
    index_prompt_section_canonical(conn, &canonical_project_root(root))
}

/// Canonical (filesystem-resolved) form of a project root, the key the wiki
/// tables are stored under. Split out from [`index_prompt_section`] because
/// it is the only BLOCKING filesystem call in the lookup: a caller that holds
/// the global DB mutex (an async command) must not run it under the guard.
pub fn canonical_project_root(root: &str) -> String {
    std::fs::canonicalize(root)
        .map(|p| normalize_canonical_path(&p.to_string_lossy()))
        .unwrap_or_else(|_| root.to_string())
}

/// [`index_prompt_section`] for a root that has ALREADY been resolved with
/// [`canonical_project_root`] — pure DB work, safe to call under the DB lock.
pub fn index_prompt_section_canonical(conn: &Connection, canonical: &str) -> Option<String> {
    let project = db::wiki_get_project_by_path(conn, canonical).ok()??;
    let pages = db::wiki_list_pages(conn, &project.id).ok()?;
    if pages.is_empty() {
        return None;
    }
    let mut body = String::from(
        "An auto-generated project wiki exists for this repository. For project \
questions, use the `search_wiki` and `read_wiki_page` tools; respect a page's \
`status` — stale pages carry the reason.\n\nPages:\n",
    );
    for page in &pages {
        body.push_str(&format!(
            "- `{}` {} — {}{}\n",
            page.slug,
            page.title,
            page.summary,
            if page.status == "fresh" {
                String::new()
            } else {
                format!(" [{}]", page.status)
            }
        ));
    }
    if body.len() > MAX_INDEX_CHARS {
        let mut cut = MAX_INDEX_CHARS.min(body.len());
        while cut > 0 && !body.is_char_boundary(cut) {
            cut -= 1;
        }
        body.truncate(cut);
        body.push_str("\n- … [index truncated]\n");
    }
    let section = format!("## Project knowledge (Relay wiki)\n\n{body}");
    Some(crate::prompt_firewall::guard_db(conn, &section))
}

/// Per-turn tool gate: does the bound project have wiki pages? Same shape as
/// the `local_docs` computation in chat/mod.rs.
pub fn has_pages(conn: &Connection, root: &str) -> bool {
    let canonical = std::fs::canonicalize(root)
        .map(|p| normalize_canonical_path(&p.to_string_lossy()))
        .unwrap_or_else(|_| root.to_string());
    db::wiki_get_project_by_path(conn, &canonical)
        .ok()
        .flatten()
        .map(|p| db::wiki_page_count(conn, &p.id).unwrap_or(0) > 0)
        .unwrap_or(false)
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
