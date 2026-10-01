//! GitHub REST client for the Pulls surface (list / create / review PRs;
//! issues since §4.4.6).
//!
//! Auth resolves in two steps: the GitHub connector's stored OAuth token
//! (`connectors::oauth::ensure_valid_access_token`) first — the connector
//! requests `repo` scope at authorize time, which covers pulls + reviews +
//! check reads + issues — then a Personal Access Token from the OS keychain
//! (`Settings → Pull Requests` field) for users who don't want the OAuth
//! dance. The hosted GitHub MCP server is intentionally NOT used here: the
//! panel needs typed, paginated REST shapes (files with patches, review
//! submission), not MCP tool-call round-trips.
//!
//! All commands resolve the repo identity from the project's `origin` remote
//! (SSH and HTTPS forms both parse). A project without a GitHub remote — or
//! without either auth path — returns the typed "unavailable" error string
//! the panel renders as an empty/connect state.

use std::path::Path;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, State};

use crate::chat::commands::CmdResult;
use crate::db;
use crate::DbState;
use crate::types::*;

const API: &str = "https://api.github.com";
/// Cap on files fetched per PR (100/page, 3 pages) — review panels beyond
/// that are pathological and the patch payloads get enormous.
const MAX_PR_FILES: usize = 300;
const PER_PAGE: usize = 100;

/// (owner, repo) parsed from a git remote URL. Accepts:
///   git@github.com:owner/repo.git     https://github.com/owner/repo
///   https://github.com/owner/repo.git ssh://git@github.com/owner/repo
/// Non-GitHub hosts (GitLab, Bitbucket, self-hosted) return None — the panel
/// shows its "not a GitHub repo" empty state.
pub fn parse_github_remote(url: &str) -> Option<(String, String)> {
    let u = url.trim();
    // SCP-like SSH: git@github.com:owner/repo(.git)
    if let Some(rest) = u.strip_prefix("git@github.com:") {
        return split_owner_repo(rest);
    }
    // URL forms: https://github.com/…, ssh://git@github.com/…, git://github.com/…
    let after_scheme = u.split("://").nth(1)?;
    let path = match after_scheme.split_once('/') {
        Some((host, path)) => {
            // Strip any userinfo (git@) from the host before comparing.
            let host = host.rsplit('@').next().unwrap_or(host);
            if !host.eq_ignore_ascii_case("github.com") {
                return None;
            }
            path
        }
        None => return None,
    };
    split_owner_repo(path)
}

fn split_owner_repo(path: &str) -> Option<(String, String)> {
    let (owner, repo) = path.split_once('/')?;
    let repo = repo.trim_end_matches(".git").trim_matches('/');
    if owner.is_empty() || repo.is_empty() {
        return None;
    }
    Some((owner.to_string(), repo.to_string()))
}

/// Resolve (owner, repo, token) for a project, or a friendly error naming
/// which prerequisite is missing (drives the panel's empty states).
async fn resolve_repo(
    app: &AppHandle,
    db: &DbState,
    project_id: &str,
) -> Result<(String, String, String), String> {
    let project_path = {
        let conn = db.0.lock();
        db::get_project(&conn, project_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "project not found".to_string())?
            .path
    };
    // `git remote get-url` is a blocking subprocess — keep it off the async
    // runtime worker this command shares with every other in-flight task.
    let remote = tauri::async_runtime::spawn_blocking(move || {
        crate::git::get_remote_url(Path::new(&project_path))
    })
    .await
    .map_err(|e| format!("git remote lookup failed: {e}"))?
    .ok_or_else(|| "this project has no git remote".to_string())?;
    let (owner, repo) = parse_github_remote(&remote)
        .ok_or_else(|| format!("remote `{remote}` is not a GitHub repository"))?;
    let token = resolve_github_token(app, db, project_id).await?;
    Ok((owner, repo, token))
}

/// GitHub token resolution (§4.4.6 PAT fallback): OAuth connector first, then
/// a Personal Access Token stored in the OS keychain (Settings → Pull
/// Requests field). Covers EVERY panel command — issues, reviews, checks,
/// PR CRUD — because it sits in the shared `resolve_repo` choke point.
async fn resolve_github_token(
    app: &AppHandle,
    db: &DbState,
    project_id: &str,
) -> Result<String, String> {
    if let Ok(token) = crate::connectors::oauth::ensure_valid_access_token(app, "github").await {
        if !token.is_empty() {
            return Ok(token);
        }
    }
    // OAuth missing/expired/unusable → PAT from the keychain. Read under a
    // short lock (spawn_blocking: keyring calls can block on IPC).
    let db2 = std::sync::Arc::clone(&db.0);
    let project = project_id.to_string();
    let pat = tauri::async_runtime::spawn_blocking(move || {
        let conn = db2.lock();
        crate::secrets::platform_load(&conn, PAT_NAMESPACE, PAT_KEY)
    })
    .await
    .map_err(|e| format!("keychain read failed: {e}"))?
    .filter(|t| !t.trim().is_empty());
    if let Some(pat) = pat {
        return Ok(pat);
    }
    Err("GitHub is not connected — connect the connector in Settings → Connectors,          or paste a Personal Access Token in Settings → Pull Requests"
        .to_string())
}

/// Keychain namespace/key for the GitHub PAT (HF-token pattern).
const PAT_NAMESPACE: &str = "github";
const PAT_KEY: &str = "pat";

/// Store the PAT. Empty/whitespace is rejected — clearing is its own command.
#[tauri::command(async)]
pub fn github_set_pat(db: State<'_, DbState>, pat: String) -> CmdResult<()> {
    let pat = pat.trim().to_string();
    if pat.is_empty() {
        return Err("token must not be empty".to_string());
    }
    let conn = db.0.lock();
    crate::secrets::platform_store(&conn, PAT_NAMESPACE, PAT_KEY, &pat)
        .map_err(|e| format!("keychain store failed: {e}"))
}

#[tauri::command(async)]
pub fn github_clear_pat(db: State<'_, DbState>) -> CmdResult<()> {
    let conn = db.0.lock();
    crate::secrets::platform_remove(&conn, PAT_NAMESPACE, PAT_KEY);
    Ok(())
}

/// Frontend only ever learns WHETHER a PAT is set — never the value.
#[tauri::command(async)]
pub fn github_has_pat(db: State<'_, DbState>) -> CmdResult<bool> {
    let conn = db.0.lock();
    let has = crate::secrets::platform_load(&conn, PAT_NAMESPACE, PAT_KEY)
        .is_some_and(|t| !t.trim().is_empty());
    Ok(has)
}

fn client(token: &str) -> Result<reqwest::Client, String> {
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        reqwest::header::AUTHORIZATION,
        format!("Bearer {token}").parse().map_err(|e| format!("bad token header: {e}"))?,
    );
    headers.insert(
        reqwest::header::ACCEPT,
        "application/vnd.github+json".parse().unwrap(),
    );
    let mut builder = reqwest::Client::builder()
        .default_headers(headers)
        .user_agent("relay-desktop")
        // Same bounds every other outbound call site uses (automations
        // post_json, pty_cmds npm probes): without them a wedged request
        // (VPN handoff, proxy stall) hangs the PR panel command forever.
        .timeout(Duration::from_secs(30))
        .connect_timeout(Duration::from_secs(10));
    // Route API traffic through the same proxy the user's git uses. Many
    // environments reach github.com ONLY via a local proxy (git push/pull
    // work while api.github.com times out) — a desktop app launched from the
    // shell doesn't inherit shell env vars, so read git's OWN proxy config:
    // https.proxy first, then http.proxy (git applies http.proxy to https
    // URLs too when no https.proxy is set).
    if let Some(proxy) = git_config_proxy() {
        // socks5:// proxies need reqwest's socks feature — if the URL scheme
        // isn't supported, skip gracefully rather than breaking every call.
        if let Ok(p) = reqwest::Proxy::all(&proxy) {
            builder = builder.proxy(p);
        }
    }
    builder.build().map_err(|e| format!("bad HTTP client: {e}"))
}

/// The user's git-configured HTTP(S) proxy, if any.
///
/// E-9g: cached for the process lifetime — this spawns up to two `git`
/// subprocesses per call, and `client()` runs per command (per page of a
/// file diff). The global git config doesn't change mid-session often
/// enough to matter; re-reads were pure subprocess churn.
fn git_config_proxy() -> Option<String> {
    static PROXY_CACHE: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    PROXY_CACHE
        .get_or_init(|| {
            for key in ["https.proxy", "http.proxy"] {
                let mut cmd = std::process::Command::new("git");
                cmd.args(["config", "--global", "--get", key]);
                crate::util::no_console_window(&mut cmd);
                let out = cmd.output().ok()?;
                let v = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !v.is_empty() {
                    return Some(v);
                }
            }
            None
        })
        .clone()
}

/// Map a GitHub error response to a friendly string. 422s on create carry
/// structured `errors[]` we translate (existing PR, missing head ref).
async fn gh_error(resp: reqwest::Response, action: &str) -> String {
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    let parsed: Option<Value> = serde_json::from_str(&body).ok();
    let message = parsed
        .as_ref()
        .and_then(|v| v.get("message"))
        .and_then(|m| m.as_str())
        .unwrap_or("");
    if status.as_u16() == 422 {
        let errors = parsed
            .as_ref()
            .and_then(|v| v.get("errors"))
            .and_then(|e| e.as_array())
            .cloned()
            .unwrap_or_default();
        let joined = errors
            .iter()
            .filter_map(|e| e.get("message").and_then(|m| m.as_str()))
            .collect::<Vec<_>>()
            .join("; ");
        if joined.contains("already exists") || message.contains("already exists") {
            return "A pull request for this branch already exists".to_string();
        }
        if joined.contains("No commits between") || message.contains("No commits between") {
            return "No commits between the base and head branches".to_string();
        }
        if !joined.is_empty() {
            return format!("GitHub rejected the {action}: {joined}");
        }
        return format!("GitHub rejected the {action}: {message}");
    }
    if status.as_u16() == 404 {
        return format!("Not found — is the branch pushed to GitHub? ({action})");
    }
    if status.as_u16() == 401 || status.as_u16() == 403 {
        return "GitHub token rejected or missing scope — reconnect the GitHub connector".to_string();
    }
    format!("GitHub {action} failed ({status}): {message}")
}

fn map_pr_summary(v: &Value) -> PullRequestSummary {
    PullRequestSummary {
        number: v["number"].as_i64().unwrap_or(0),
        title: v["title"].as_str().unwrap_or("").to_string(),
        author: v["user"]["login"].as_str().unwrap_or("").to_string(),
        author_avatar: v["user"]["avatar_url"].as_str().map(|s| s.to_string()),
        head_branch: v["head"]["ref"].as_str().unwrap_or("").to_string(),
        base_branch: v["base"]["ref"].as_str().unwrap_or("").to_string(),
        draft: v["draft"].as_bool().unwrap_or(false),
        state: v["state"].as_str().unwrap_or("open").to_string(),
        html_url: v["html_url"].as_str().unwrap_or("").to_string(),
        created_at: v["created_at"].as_str().unwrap_or("").to_string(),
        updated_at: v["updated_at"].as_str().unwrap_or("").to_string(),
    }
}

/// List PRs for the project's repo. `state`: "open" | "closed" | "all".
#[tauri::command]
pub async fn github_list_prs(
    project_id: String,
    state: Option<String>,
    db: State<'_, DbState>,
    app: AppHandle,
) -> CmdResult<Vec<PullRequestSummary>> {
    let (owner, repo, token) = resolve_repo(&app, &db, &project_id).await?;
    let state = state.as_deref().unwrap_or("open");
    let resp = client(&token)?
        .get(format!("{API}/repos/{owner}/{repo}/pulls"))
        .query(&[("state", state), ("per_page", "50"), ("sort", "updated"), ("direction", "desc")])
        .send()
        .await
        .map_err(|e| format!("GitHub list PRs failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(gh_error(resp, "list").await);
    }
    let rows: Vec<Value> = resp.json().await.map_err(|e| e.to_string())?;
    Ok(rows.iter().map(map_pr_summary).collect())
}

/// Create a PR. `head` is the branch with changes, `base` the target.
#[tauri::command]
pub async fn github_create_pr(
    project_id: String,
    title: String,
    body: String,
    head: String,
    base: String,
    draft: bool,
    db: State<'_, DbState>,
    app: AppHandle,
) -> CmdResult<PullRequestSummary> {
    if title.trim().is_empty() {
        return Err("title is required".to_string());
    }
    let (owner, repo, token) = resolve_repo(&app, &db, &project_id).await?;
    let resp = client(&token)?
        .post(format!("{API}/repos/{owner}/{repo}/pulls"))
        .json(&json!({
            "title": title,
            "body": body,
            "head": head,
            "base": base,
            "draft": draft,
        }))
        .send()
        .await
        .map_err(|e| format!("GitHub create PR failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(gh_error(resp, "create").await);
    }
    let v: Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(map_pr_summary(&v))
}

/// PR detail: summary + markdown body + head SHA (for the checks rollup).
#[tauri::command]
pub async fn github_get_pr(
    project_id: String,
    number: i64,
    db: State<'_, DbState>,
    app: AppHandle,
) -> CmdResult<PullRequestDetail> {
    let (owner, repo, token) = resolve_repo(&app, &db, &project_id).await?;
    let resp = client(&token)?
        .get(format!("{API}/repos/{owner}/{repo}/pulls/{number}"))
        .send()
        .await
        .map_err(|e| format!("GitHub get PR failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(gh_error(resp, "get").await);
    }
    let v: Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(PullRequestDetail {
        summary: map_pr_summary(&v),
        body: v["body"].as_str().unwrap_or("").to_string(),
        head_sha: v["head"]["sha"].as_str().unwrap_or("").to_string(),
        additions: v["additions"].as_i64().unwrap_or(0),
        deletions: v["deletions"].as_i64().unwrap_or(0),
        changed_files: v["changed_files"].as_i64().unwrap_or(0),
        mergeable: v["mergeable"].as_bool(),
    })
}

/// Changed files of a PR, with patches for inline review rendering.
/// Paginates up to MAX_PR_FILES.
#[tauri::command]
pub async fn github_pr_files(
    project_id: String,
    number: i64,
    db: State<'_, DbState>,
    app: AppHandle,
) -> CmdResult<Vec<PullRequestFile>> {
    let (owner, repo, token) = resolve_repo(&app, &db, &project_id).await?;
    let http = client(&token)?;
    let mut out: Vec<PullRequestFile> = Vec::new();
    let mut page = 1u32;
    loop {
        let resp = http
            .get(format!("{API}/repos/{owner}/{repo}/pulls/{number}/files"))
            .query(&[("per_page", PER_PAGE.to_string()), ("page", page.to_string())])
            .send()
            .await
            .map_err(|e| format!("GitHub PR files failed: {e}"))?;
        if !resp.status().is_success() {
            return Err(gh_error(resp, "files").await);
        }
        let rows: Vec<Value> = resp.json().await.map_err(|e| e.to_string())?;
        let count = rows.len();
        for r in rows {
            out.push(PullRequestFile {
                path: r["filename"].as_str().unwrap_or("").to_string(),
                previous_path: r["previous_filename"].as_str().map(|s| s.to_string()),
                status: r["status"].as_str().unwrap_or("modified").to_string(),
                additions: r["additions"].as_i64().unwrap_or(0),
                deletions: r["deletions"].as_i64().unwrap_or(0),
                // Binary/deleted files carry no patch.
                patch: r["patch"].as_str().map(|s| s.to_string()),
            });
        }
        if count < PER_PAGE || out.len() >= MAX_PR_FILES {
            break;
        }
        page += 1;
    }
    out.truncate(MAX_PR_FILES);
    Ok(out)
}

/// Submit an overall review: event ∈ APPROVE | COMMENT | REQUEST_CHANGES.
#[tauri::command]
pub async fn github_submit_review(
    project_id: String,
    number: i64,
    event: String,
    body: String,
    db: State<'_, DbState>,
    app: AppHandle,
) -> CmdResult<()> {
    let event = match event.as_str() {
        "APPROVE" | "COMMENT" | "REQUEST_CHANGES" => event,
        other => return Err(format!("unknown review event: {other}")),
    };
    if event != "APPROVE" && body.trim().is_empty() {
        return Err("a body is required for comment/request-changes reviews".to_string());
    }
    let (owner, repo, token) = resolve_repo(&app, &db, &project_id).await?;
    let resp = client(&token)?
        .post(format!("{API}/repos/{owner}/{repo}/pulls/{number}/reviews"))
        .json(&json!({ "event": event, "body": body }))
        .send()
        .await
        .map_err(|e| format!("GitHub submit review failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(gh_error(resp, "review").await);
    }
    Ok(())
}

/// Check-run rollup for a PR's head commit → a single status badge.
/// Best-effort: check-runs first, legacy commit status as fallback; "none"
/// when the repo has no CI configured.
#[tauri::command]
pub async fn github_pr_checks(
    project_id: String,
    number: i64,
    db: State<'_, DbState>,
    app: AppHandle,
) -> CmdResult<PullRequestChecks> {
    let (owner, repo, token) = resolve_repo(&app, &db, &project_id).await?;
    let http = client(&token)?;

    // Head SHA for the PR.
    let resp = http
        .get(format!("{API}/repos/{owner}/{repo}/pulls/{number}"))
        .send()
        .await
        .map_err(|e| format!("GitHub get PR failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(gh_error(resp, "get").await);
    }
    let pr: Value = resp.json().await.map_err(|e| e.to_string())?;
    let sha = pr["head"]["sha"].as_str().unwrap_or("").to_string();
    if sha.is_empty() {
        return Ok(PullRequestChecks { state: "none".into(), total: 0, failing: 0, pending: 0 });
    }

    // Check runs (Checks API). Any run present → rollup from conclusions.
    let resp = http
        .get(format!("{API}/repos/{owner}/{repo}/commits/{sha}/check-runs"))
        .query(&[("per_page", "100")])
        .send()
        .await
        .map_err(|e| format!("GitHub check-runs failed: {e}"))?;
    if resp.status().is_success() {
        let v: Value = resp.json().await.map_err(|e| e.to_string())?;
        let runs = v["check_runs"].as_array().cloned().unwrap_or_default();
        if !runs.is_empty() {
            let mut failing = 0i64;
            let mut pending = 0i64;
            for r in &runs {
                match (r["status"].as_str(), r["conclusion"].as_str()) {
                    (Some("completed"), Some(c))
                        if matches!(c, "failure" | "cancelled" | "timed_out" | "action_required") =>
                    {
                        failing += 1
                    }
                    (Some("completed"), _) => {}
                    _ => pending += 1, // queued / in_progress / waiting
                }
            }
            let state = if failing > 0 {
                "failure"
            } else if pending > 0 {
                "pending"
            } else {
                "success"
            };
            return Ok(PullRequestChecks {
                state: state.into(),
                total: runs.len() as i64,
                failing,
                pending,
            });
        }
    }

    // Legacy commit Status API fallback (older CI integrations).
    let resp = http
        .get(format!("{API}/repos/{owner}/{repo}/commits/{sha}/status"))
        .send()
        .await
        .map_err(|e| format!("GitHub status failed: {e}"))?;
    if !resp.status().is_success() {
        return Ok(PullRequestChecks { state: "none".into(), total: 0, failing: 0, pending: 0 });
    }
    let v: Value = resp.json().await.map_err(|e| e.to_string())?;
    let state = v["state"].as_str().unwrap_or("none");
    let total = v["total_count"].as_i64().unwrap_or(0);
    Ok(PullRequestChecks {
        state: if total == 0 { "none".into() } else { state.to_string() },
        total,
        failing: if state == "failure" || state == "error" { 1 } else { 0 },
        pending: if state == "pending" { 1 } else { 0 },
    })
}

/// Draft a PR title + body from the branch diff using the user's fast-model
/// pair (commitMessage.provider/model, falling back to the given chat
/// session's provider/model — identical resolution to generate_commit_message).
/// Returns None when no usable model is configured or the branch has no diff.
#[tauri::command]
pub async fn github_draft_pr_text(
    project_id: String,
    base: String,
    chat_session_id: String,
    db: State<'_, DbState>,
) -> CmdResult<Option<PullRequestDraft>> {

    let project_path = {
        let conn = db.0.lock();
        db::get_project(&conn, &project_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "project not found".to_string())?
            .path
    };
    let path = Path::new(&project_path).to_path_buf();

    // Branch diff vs base: stat summary + bounded patch body. Three-dot
    // (merge-base) diff: what the PR will actually contain. Both are blocking
    // git subprocesses — run them off the async runtime worker.
    // Argv guard (same standard as create_branch/checkout_branch): a `base`
    // starting with `-` is parsed by git as an OPTION, not a ref — e.g.
    // `--output=<path>` would write the diff to an arbitrary filesystem path
    // (audit M-14).
    let base = base.trim().to_string();
    if base.starts_with('-') || base.is_empty() {
        return Err("invalid base ref".into());
    }
    let range = format!("{base}...HEAD");
    let (stat, patch) = tauri::async_runtime::spawn_blocking(move || {
        let stat = crate::git::run_git_env(&path, &["diff", "--stat", &range], &[])
            .unwrap_or_default();
        let patch = crate::git::run_git_env(&path, &["diff", &range], &[])
            .unwrap_or_default();
        (stat, patch)
    })
    .await
    .map_err(|e| format!("git diff failed: {e}"))?;
    if patch.trim().is_empty() {
        return Ok(None);
    }
    let patch: String = patch.chars().take(12_000).collect();

    // Provider/model resolution mirrors generate_commit_message.
    let (provider_str, model_str) = {
        let conn = db.0.lock();
        let cm_provider = db::get_setting(&conn, "commitMessage.provider")
            .ok().flatten().filter(|p| !p.trim().is_empty());
        let cm_model = db::get_setting(&conn, "commitMessage.model")
            .ok().flatten().filter(|m| !m.trim().is_empty());
        match (cm_provider, cm_model) {
            (Some(p), Some(m)) => (p, m),
            _ => {
                let cs = db::get_chat_session(&conn, &chat_session_id)
                    .map_err(|e| e.to_string())?
                    .ok_or_else(|| "chat session not found".to_string())?;
                (cs.provider, cs.model)
            }
        }
    };
    let api_key = {
        let conn = db.0.lock();
        crate::secrets::get_chat_api_key(&conn, &provider_str)
    };
    if api_key.is_none() && provider_str != "local_gguf" {
        return Ok(None);
    }
    let api_key = api_key.unwrap_or_default();
    let base_url = {
        let conn = db.0.lock();
        db::get_setting(&conn, &format!("chat.{provider_str}.base_url"))
            .ok().flatten().filter(|b| !b.trim().is_empty())
    };

    let system = "You draft a GitHub pull request title and body from a branch diff.         Reply in EXACTLY this format:

TITLE: <one line, imperative, ≤80 chars>
\
        BODY:
<markdown body: 1-paragraph summary, then a short bullet list of the         notable changes, then a '## Test plan' section with 1-3 bullets>
\
        No other text, no quotes around the title.";
    let user = format!("Diff stat:
{stat}

Diff (truncated):
{patch}");

    // B-10: one-shot JSON call — a total timeout bounds a wedged endpoint
    // instead of hanging the PR-draft command forever (matches the other
    // one-shot generators; this one previously used Client::new()).
    let client = crate::chat::llm_client::oneshot_client()?;
    let Some(raw) = crate::chat::llm_client::oneshot(
        &provider_str,
        &client,
        &api_key,
        base_url.as_deref(),
        &model_str,
        system,
        &user,
        768,
    )
    .await?
    else {
        return Ok(None);
    };
    Ok(Some(parse_pr_draft(&raw)))
}

/// Parse the TITLE:/BODY: marker contract. Tolerant: a missing BODY marker
/// puts everything after the title line into the body.
pub(crate) fn parse_pr_draft(raw: &str) -> PullRequestDraft {
    let mut title = String::new();
    let mut body = String::new();
    let mut in_body = false;
    for line in raw.lines() {
        let t = line.trim();
        if !in_body {
            if let Some(rest) = t.strip_prefix("TITLE:") {
                title = rest.trim().trim_matches('"').to_string();
                continue;
            }
            if t == "BODY:" || t.starts_with("BODY:") {
                in_body = true;
                if let Some(rest) = t.strip_prefix("BODY:") {
                    let rest = rest.trim();
                    if !rest.is_empty() {
                        body.push_str(rest);
                        body.push('\n');
                    }
                }
                continue;
            }
            if title.is_empty() && !t.is_empty() {
                // Model skipped the TITLE: marker — first non-empty line wins.
                title = t.trim_matches('"').to_string();
            } else if !title.is_empty() && !t.is_empty() {
                in_body = true;
                body.push_str(line);
                body.push('\n');
            }
        } else {
            body.push_str(line);
            body.push('\n');
        }
    }
    PullRequestDraft { title: title.trim().to_string(), body: body.trim().to_string() }
}

// ---- Issues (§4.4.6): the GitHub surface is no longer PR-only ----

fn map_issue_summary(v: &Value) -> GitHubIssueSummary {
    GitHubIssueSummary {
        number: v["number"].as_i64().unwrap_or(0),
        title: v["title"].as_str().unwrap_or("").to_string(),
        state: v["state"].as_str().unwrap_or("open").to_string(),
        author: v["user"]["login"].as_str().unwrap_or("").to_string(),
        labels: v["labels"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|l| l["name"].as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default(),
        comments: v["comments"].as_i64().unwrap_or(0),
        html_url: v["html_url"].as_str().unwrap_or("").to_string(),
        created_at: v["created_at"].as_str().unwrap_or("").to_string(),
        updated_at: v["updated_at"].as_str().unwrap_or("").to_string(),
    }
}

/// List issues for the project's repo. `state`: "open" | "closed" | "all".
/// PRs are filtered out (`pull_request` key present ⇒ PR) so this command is
/// purely the issues half of the surface.
#[tauri::command]
pub async fn github_list_issues(
    project_id: String,
    state: Option<String>,
    db: State<'_, DbState>,
    app: AppHandle,
) -> CmdResult<Vec<GitHubIssueSummary>> {
    let (owner, repo, token) = resolve_repo(&app, &db, &project_id).await?;
    let state = state.as_deref().unwrap_or("open");
    let resp = client(&token)?
        .get(format!("{API}/repos/{owner}/{repo}/issues"))
        .query(&[
            ("state", state),
            ("per_page", "50"),
            ("sort", "updated"),
            ("direction", "desc"),
        ])
        .send()
        .await
        .map_err(|e| format!("GitHub list issues failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(gh_error(resp, "list").await);
    }
    let rows: Vec<Value> = resp.json().await.map_err(|e| e.to_string())?;
    Ok(rows
        .iter()
        .filter(|v| v.get("pull_request").is_none())
        .map(map_issue_summary)
        .collect())
}

/// Issue detail: summary + markdown body.
#[tauri::command]
pub async fn github_get_issue(
    project_id: String,
    number: i64,
    db: State<'_, DbState>,
    app: AppHandle,
) -> CmdResult<GitHubIssueDetail> {
    let (owner, repo, token) = resolve_repo(&app, &db, &project_id).await?;
    let resp = client(&token)?
        .get(format!("{API}/repos/{owner}/{repo}/issues/{number}"))
        .send()
        .await
        .map_err(|e| format!("GitHub get issue failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(gh_error(resp, "get").await);
    }
    let v: Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(GitHubIssueDetail {
        summary: map_issue_summary(&v),
        body: v["body"].as_str().unwrap_or("").to_string(),
    })
}

/// Create an issue. `labels` are optional (applying them needs a token with
/// push scope; an OAuth `repo`-scoped token or a repo PAT has it).
#[tauri::command]
pub async fn github_create_issue(
    project_id: String,
    title: String,
    body: String,
    labels: Option<Vec<String>>,
    db: State<'_, DbState>,
    app: AppHandle,
) -> CmdResult<GitHubIssueSummary> {
    if title.trim().is_empty() {
        return Err("title is required".to_string());
    }
    let (owner, repo, token) = resolve_repo(&app, &db, &project_id).await?;
    let mut payload = json!({ "title": title, "body": body });
    if let Some(labels) = labels.filter(|l| !l.is_empty()) {
        payload["labels"] = json!(labels);
    }
    let resp = client(&token)?
        .post(format!("{API}/repos/{owner}/{repo}/issues"))
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("GitHub create issue failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(gh_error(resp, "create").await);
    }
    let v: Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(map_issue_summary(&v))
}

/// Comment on an issue (or PR — same endpoint).
#[tauri::command]
pub async fn github_add_issue_comment(
    project_id: String,
    number: i64,
    body: String,
    db: State<'_, DbState>,
    app: AppHandle,
) -> CmdResult<GitHubIssueComment> {
    if body.trim().is_empty() {
        return Err("comment body is required".to_string());
    }
    let (owner, repo, token) = resolve_repo(&app, &db, &project_id).await?;
    let resp = client(&token)?
        .post(format!("{API}/repos/{owner}/{repo}/issues/{number}/comments"))
        .json(&json!({ "body": body }))
        .send()
        .await
        .map_err(|e| format!("GitHub add comment failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(gh_error(resp, "comment").await);
    }
    let v: Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(GitHubIssueComment {
        id: v["id"].as_i64().unwrap_or(0),
        author: v["user"]["login"].as_str().unwrap_or("").to_string(),
        body: v["body"].as_str().unwrap_or("").to_string(),
        created_at: v["created_at"].as_str().unwrap_or("").to_string(),
    })
}

/// Close or reopen an issue. `state`: "open" | "closed".
#[tauri::command]
pub async fn github_set_issue_state(
    project_id: String,
    number: i64,
    state: String,
    db: State<'_, DbState>,
    app: AppHandle,
) -> CmdResult<GitHubIssueSummary> {
    let state = match state.as_str() {
        "open" | "closed" => state,
        other => return Err(format!("unknown issue state: {other}")),
    };
    let (owner, repo, token) = resolve_repo(&app, &db, &project_id).await?;
    let resp = client(&token)?
        .patch(format!("{API}/repos/{owner}/{repo}/issues/{number}"))
        .json(&json!({ "state": state }))
        .send()
        .await
        .map_err(|e| format!("GitHub set issue state failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(gh_error(resp, "update").await);
    }
    let v: Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(map_issue_summary(&v))
}

/// List an issue's comments (newest 50, oldest first).
#[tauri::command]
pub async fn github_list_issue_comments(
    project_id: String,
    number: i64,
    db: State<'_, DbState>,
    app: AppHandle,
) -> CmdResult<Vec<GitHubIssueComment>> {
    let (owner, repo, token) = resolve_repo(&app, &db, &project_id).await?;
    let resp = client(&token)?
        .get(format!("{API}/repos/{owner}/{repo}/issues/{number}/comments"))
        .query(&[("per_page", "50")])
        .send()
        .await
        .map_err(|e| format!("GitHub list comments failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(gh_error(resp, "comments").await);
    }
    let rows: Vec<Value> = resp.json().await.map_err(|e| e.to_string())?;
    Ok(rows
        .iter()
        .map(|v| GitHubIssueComment {
            id: v["id"].as_i64().unwrap_or(0),
            author: v["user"]["login"].as_str().unwrap_or("").to_string(),
            body: v["body"].as_str().unwrap_or("").to_string(),
            created_at: v["created_at"].as_str().unwrap_or("").to_string(),
        })
        .collect())
}

/// Live smoke: list the public Rust repo's issues anonymously (read-only).
/// Run explicitly: cargo test -p relay github_issues_live -- --ignored
#[tokio::test]
#[ignore = "hits the live network (api.github.com, anonymous rate limit)"]
async fn github_issues_live() {
    let http = reqwest::Client::builder()
        .user_agent("relay-desktop")
        .timeout(Duration::from_secs(20))
        .build()
        .unwrap();
    let resp = http
        .get(format!("{API}/repos/rust-lang/rust/issues"))
        .query(&[("state", "open"), ("per_page", "100")])
        .send()
        .await
        .unwrap();
    assert!(resp.status().is_success(), "status {}", resp.status());
    let rows: Vec<Value> = resp.json().await.unwrap();
    let issues: Vec<&Value> =
        rows.iter().filter(|v| v.get("pull_request").is_none()).collect();
    assert!(!issues.is_empty(), "expected at least one real issue");
    let mapped = map_issue_summary(issues[0]);
    assert!(mapped.number > 0);
    assert!(!mapped.title.is_empty());
    println!("live issue #{}: {}", mapped.number, mapped.title);
}

#[cfg(test)]
mod tests {
    use super::{map_issue_summary, parse_github_remote};
    use serde_json::json;

    #[test]
    fn issue_mapper_extracts_labels_and_skips_prs() {
        let v = json!({
            "number": 42,
            "title": "Crash on save",
            "state": "open",
            "user": { "login": "octocat" },
            "labels": [ { "name": "bug" }, { "name": "P1" } ],
            "comments": 3,
            "html_url": "https://github.com/o/r/issues/42",
            "created_at": "2026-09-01T00:00:00Z",
            "updated_at": "2026-09-02T00:00:00Z"
        });
        let issue = map_issue_summary(&v);
        assert_eq!(issue.number, 42);
        assert_eq!(issue.labels, vec!["bug".to_string(), "P1".to_string()]);
        assert_eq!(issue.comments, 3);
        assert_eq!(issue.author, "octocat");

        // The PR filter: a payload carrying `pull_request` is excluded by
        // github_list_issues's iterator (shape asserted here).
        let pr_shaped = json!({ "number": 1, "pull_request": { "url": "x" } });
        assert!(pr_shaped.get("pull_request").is_some());

        // Missing/empty labels degrade to an empty vec, never a panic.
        let bare = json!({ "number": 7 });
        assert!(map_issue_summary(&bare).labels.is_empty());
    }

    #[test]
    fn parses_ssh_and_https_remotes() {
        let cases = [
            ("git@github.com:owner/repo.git", ("owner", "repo")),
            ("git@github.com:owner/repo", ("owner", "repo")),
            ("https://github.com/owner/repo", ("owner", "repo")),
            ("https://github.com/owner/repo.git", ("owner", "repo")),
            ("ssh://git@github.com/owner/repo", ("owner", "repo")),
            ("https://github.com/owner-name/repo.name", ("owner-name", "repo.name")),
        ];
        for (url, (owner, repo)) in cases {
            let (o, r) = parse_github_remote(url).unwrap_or_else(|| panic!("failed: {url}"));
            assert_eq!((o.as_str(), r.as_str()), (owner, repo), "{url}");
        }
    }

    #[test]
    fn pr_draft_parser_handles_marker_and_bare_forms() {
        let d = super::parse_pr_draft("TITLE: feat: add pulls tab
BODY:
Summary text.

- a
- b

## Test plan
- [ ] ran tests");
        assert_eq!(d.title, "feat: add pulls tab");
        assert!(d.body.contains("Summary text."));
        assert!(d.body.contains("## Test plan"));

        // Bare first line = title, rest = body.
        let d2 = super::parse_pr_draft("fix: repair the thing
Some body line");
        assert_eq!(d2.title, "fix: repair the thing");
        assert_eq!(d2.body, "Some body line");
    }

    #[test]
    fn rejects_non_github_hosts() {
        assert!(parse_github_remote("git@gitlab.com:owner/repo.git").is_none());
        assert!(parse_github_remote("https://bitbucket.org/owner/repo").is_none());
        assert!(parse_github_remote("https://git.example.com/owner/repo").is_none());
        assert!(parse_github_remote("not-a-url").is_none());
        assert!(parse_github_remote("https://github.com/onlyowner").is_none());
        assert!(parse_github_remote("git@github.com:").is_none());
    }
}

/// Local branches for the create-form pickers (name, current flag). Not
/// GitHub-API — the candidate head branch is whichever local branch the user
/// is about to push.
///
/// `async` + `spawn_blocking`: `git branch` is a subprocess wait. The lock was
/// already scoped correctly here; what remained was running the git call on
/// the IPC (UI) thread.
#[tauri::command]
pub async fn github_local_branches(
    project_id: String,
    db: State<'_, DbState>,
) -> CmdResult<Vec<BranchOption>> {
    let project_path = {
        let conn = db.0.lock();
        db::get_project(&conn, &project_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "project not found".to_string())?
            .path
    };
    let branches = tokio::task::spawn_blocking(move || crate::git::list_branches(Path::new(&project_path)))
        .await
        .map_err(|e| e.to_string())??;
    Ok(branches
        .into_iter()
        .map(|b| BranchOption { name: b.name, is_current: b.is_current, is_remote: b.is_remote })
        .collect())
}
