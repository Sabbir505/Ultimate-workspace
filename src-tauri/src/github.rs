//! GitHub REST client for the Pulls surface (list / create / review PRs;
//! issues since §4.4.6).
//!
//! Auth resolves in two steps: the GitHub connector's stored OAuth token
//! (`connectors::oauth::ensure_valid_access_token`) first — the connector
//! requests `repo` scope at authorize time, which covers pulls + reviews +
//! check reads + issues — then a Personal Access Token from the OS keychain
//! (`Settings → Pull Requests` field) for users who don't want the OAuth
//! dance. A stored PAT also backs up a connector token GitHub has stopped
//! honoring (revoked app access): a rejected credential is retried once
//! against it before the panel reports failure. The hosted GitHub MCP server
//! is intentionally NOT used here: the panel needs typed, paginated REST
//! shapes (files with patches, review submission), not MCP tool-call
//! round-trips.
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

/// Resolve (owner, repo, auth) for a project, or a friendly error naming
/// which prerequisite is missing (drives the panel's empty states).
async fn resolve_repo(
    app: &AppHandle,
    db: &DbState,
    project_id: &str,
) -> Result<(String, String, GitHubAuth), String> {
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
    let auth = resolve_github_auth(app, db).await?;
    Ok((owner, repo, auth))
}

/// Resolved GitHub credentials. `token` is what requests authenticate with —
/// the connector's OAuth token when one resolves, else the PAT. `pat` carries
/// the stored Personal Access Token when it is DIFFERENT from `token`, i.e.
/// when it exists as a genuine fallback for `send_authed` to retry with.
struct GitHubAuth {
    token: String,
    pat: Option<String>,
    /// True when `token` came from the connector — only those can be
    /// re-minted on a 401 (`reauth_after_rejection`).
    from_connector: bool,
    app: AppHandle,
}

/// GitHub auth resolution (§4.4.6 PAT fallback): OAuth connector first, then
/// a Personal Access Token stored in the OS keychain (Settings → Pull
/// Requests field). Covers EVERY panel command — issues, reviews, checks,
/// PR CRUD — because it sits in the shared `resolve_repo` choke point.
///
/// The PAT is still read when the connector token wins, and kept as a
/// fallback: GitHub returning 401 for a connector token (the user revoked
/// the OAuth app on github.com, or the grant was invalidated server-side)
/// is indistinguishable from "expired" until a request fails, and the panel
/// used to be wedged on "reconnect the connector" forever even with a
/// working PAT sitting in Settings → Pull Requests.
async fn resolve_github_auth(app: &AppHandle, db: &DbState) -> Result<GitHubAuth, String> {
    let connector_token = crate::connectors::oauth::ensure_valid_access_token(app, "github")
        .await
        .ok()
        .filter(|t| !t.is_empty());
    let pat = load_pat(db).await;
    if let Some(token) = connector_token {
        // A PAT equal to the connector token is not a fallback.
        let pat = pat.filter(|p| *p != token);
        return Ok(GitHubAuth { token, pat, from_connector: true, app: app.clone() });
    }
    // OAuth missing/expired/unusable → PAT from the keychain.
    if let Some(pat) = pat {
        return Ok(GitHubAuth { token: pat, pat: None, from_connector: false, app: app.clone() });
    }
    Err("GitHub is not connected — connect the connector in Settings → Connectors,          or paste a Personal Access Token in Settings → Pull Requests"
        .to_string())
}

/// Read the PAT from the OS keychain (spawn_blocking: keyring calls can
/// block on IPC).
async fn load_pat(db: &DbState) -> Option<String> {
    let db2 = std::sync::Arc::clone(&db.0);
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db2.lock();
        crate::secrets::platform_load(&conn, PAT_NAMESPACE, PAT_KEY)
    })
    .await
    .ok()
    .flatten()
    .filter(|t| !t.trim().is_empty())
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

/// Send one GitHub API request authenticated as the resolved credentials.
///
/// A 401 — the one status that unambiguously means "this credential is dead"
/// (a 403 may be a rate limit or a SAML gate, both retryable without
/// touching auth) — is handled in two steps: a connector token is re-minted
/// first (the stored refresh token can produce a fresh one, and GitHub's
/// token responses carry no `expires_in`, so a revoked-but-never-expired
/// access token would otherwise be served forever), then the stored PAT is
/// tried as a last resort. The retry is safe for writes too — GitHub
/// rejects a 401 before executing anything.
async fn send_authed(
    auth: &GitHubAuth,
    action: &str,
    build: impl Fn(&str) -> Result<reqwest::RequestBuilder, String>,
) -> Result<reqwest::Response, String> {
    let resp = build(&auth.token)?
        .send()
        .await
        .map_err(|e| format!("GitHub {action} failed: {e}"))?;
    if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
        if auth.from_connector {
            if let Ok(fresh) = crate::connectors::oauth::reauth_after_rejection(
                &auth.app,
                "github",
                &auth.token,
            )
            .await
            {
                let retried = build(&fresh)?
                    .send()
                    .await
                    .map_err(|e| format!("GitHub {action} failed: {e}"))?;
                // A fresh token failing again means something other than a
                // stale grant — fall through to the PAT before giving up.
                if retried.status() != reqwest::StatusCode::UNAUTHORIZED {
                    return Ok(retried);
                }
            }
        }
        if let Some(pat) = auth.pat.as_deref() {
            let retried = build(pat)?
                .send()
                .await
                .map_err(|e| format!("GitHub {action} failed: {e}"))?;
            return Ok(retried);
        }
    }
    Ok(resp)
}

/// Header value as a trimmed string, when present and ASCII.
fn header_str(resp: &reqwest::Response, name: &str) -> Option<String> {
    resp.headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Map a GitHub error response to a friendly string. 422s on create carry
/// structured `errors[]` we translate (existing PR, missing head ref).
///
/// 401/403 are NOT one failure, and telling every one of them "reconnect the
/// GitHub connector" sends users to fix the wrong thing: GitHub answers 403
/// for an exhausted rate limit (the token is fine — wait), for org SAML
/// enforcement (the token needs an SSO authorization click), and for a
/// fine-grained PAT that can't see the repo (the grant is too narrow). Only
/// the leftover cases are actually a credential problem, so the rate-limit
/// headers and the response body pick the advice.
async fn gh_error(resp: reqwest::Response, action: &str) -> String {
    let status = resp.status().as_u16();
    let remaining = header_str(&resp, "x-ratelimit-remaining");
    // Ceil to minutes until the quota resets; None when the header is absent
    // or already in the past.
    let reset_minutes = header_str(&resp, "x-ratelimit-reset")
        .and_then(|s| s.parse::<i64>().ok())
        .map(|reset| (reset - db::now_ts() + 59) / 60)
        .filter(|m| *m > 0);
    let scopes = header_str(&resp, "x-oauth-scopes");
    let body = resp.text().await.unwrap_or_default();
    gh_error_message(
        status,
        remaining.as_deref(),
        reset_minutes,
        scopes.as_deref(),
        &body,
        action,
    )
}

/// The status/headers/body → advice translation, pure so every branch is
/// unit-testable without a network.
fn gh_error_message(
    status: u16,
    ratelimit_remaining: Option<&str>,
    ratelimit_reset_minutes: Option<i64>,
    oauth_scopes: Option<&str>,
    body: &str,
    action: &str,
) -> String {
    let parsed: Option<Value> = serde_json::from_str(body).ok();
    let message = parsed
        .as_ref()
        .and_then(|v| v.get("message"))
        .and_then(|m| m.as_str())
        .unwrap_or("");
    let lower = message.to_lowercase();

    if status == 422 {
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
    if status == 404 {
        return format!("Not found — is the branch pushed to GitHub? ({action})");
    }
    if status == 401 || status == 403 {
        // Rate limit: `x-ratelimit-remaining: 0`, or a body that says so
        // (secondary limits don't always carry the header).
        if ratelimit_remaining == Some("0") || lower.contains("rate limit") {
            return match ratelimit_reset_minutes {
                Some(m) => format!(
                    "GitHub API rate limit reached — the {action} works again in about {m} minutes. This is GitHub's quota, not the token: nothing to reconnect."
                ),
                None => format!(
                    "GitHub API rate limit reached — the {action} will work once the quota resets (usually within the hour). This is GitHub's quota, not the token: nothing to reconnect."
                ),
            };
        }
        // Org SAML enforcement: the token is valid, the org just hasn't
        // authorized this OAuth app for SSO.
        if lower.contains("saml") {
            return format!(
                "GitHub requires SSO authorization for this token ({action}) — open the repository on github.com, click Authorize next to the OAuth app (GitHub → Settings → Applications → Authorized OAuth Apps), then retry."
            );
        }
        // A fine-grained PAT whose grant doesn't reach this repo.
        if lower.contains("personal access token") || lower.contains("resource not accessible") {
            return format!(
                "This Personal Access Token cannot access the repository ({action}) — a fine-grained PAT needs Pull requests: Read and write plus Contents: Read granted for it, or replace it in Settings → Pull Requests."
            );
        }
        // What's left on 401/403 is a credential problem. Name both remedies
        // — the connector token and the PAT are independent.
        let said = if message.is_empty() {
            String::new()
        } else {
            format!(" GitHub said: {message}")
        };
        return format!(
            "GitHub rejected the token ({status}) — reconnect the GitHub connector in Settings → Connectors, or update the Personal Access Token in Settings → Pull Requests.{said}"
        );
    }
    let scopes_hint = match oauth_scopes {
        Some(s) => format!(" (token scopes: {s})"),
        None => String::new(),
    };
    format!("GitHub {action} failed ({status}): {message}{scopes_hint}")
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
        merged: v["merged_at"].as_str().is_some(),
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
    let (owner, repo, auth) = resolve_repo(&app, &db, &project_id).await?;
    let state = state.as_deref().unwrap_or("open");
    let resp = send_authed(&auth, "list PRs", |t| {
        Ok(client(t)?
            .get(format!("{API}/repos/{owner}/{repo}/pulls"))
            .query(&[("state", state), ("per_page", "50"), ("sort", "updated"), ("direction", "desc")]))
    })
    .await?;
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
    let (owner, repo, auth) = resolve_repo(&app, &db, &project_id).await?;
    let resp = send_authed(&auth, "create PR", |t| {
        Ok(client(t)?
            .post(format!("{API}/repos/{owner}/{repo}/pulls"))
            .json(&json!({
                "title": title,
                "body": body,
                "head": head,
                "base": base,
                "draft": draft,
            })))
    })
    .await?;
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
    let (owner, repo, auth) = resolve_repo(&app, &db, &project_id).await?;
    let resp = send_authed(&auth, "get PR", |t| {
        Ok(client(t)?.get(format!("{API}/repos/{owner}/{repo}/pulls/{number}")))
    })
    .await?;
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
    let (owner, repo, auth) = resolve_repo(&app, &db, &project_id).await?;
    let mut out: Vec<PullRequestFile> = Vec::new();
    let mut page = 1u32;
    loop {
        let resp = send_authed(&auth, "PR files", |t| {
            Ok(client(t)?
                .get(format!("{API}/repos/{owner}/{repo}/pulls/{number}/files"))
                .query(&[("per_page", PER_PAGE.to_string()), ("page", page.to_string())]))
        })
        .await?;
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
    let (owner, repo, auth) = resolve_repo(&app, &db, &project_id).await?;
    let resp = send_authed(&auth, "submit review", |t| {
        Ok(client(t)?
            .post(format!("{API}/repos/{owner}/{repo}/pulls/{number}/reviews"))
            .json(&json!({ "event": event, "body": body })))
    })
    .await?;
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
    let (owner, repo, auth) = resolve_repo(&app, &db, &project_id).await?;

    // Head SHA for the PR.
    let resp = send_authed(&auth, "get PR", |t| {
        Ok(client(t)?.get(format!("{API}/repos/{owner}/{repo}/pulls/{number}")))
    })
    .await?;
    if !resp.status().is_success() {
        return Err(gh_error(resp, "get").await);
    }
    let pr: Value = resp.json().await.map_err(|e| e.to_string())?;
    let sha = pr["head"]["sha"].as_str().unwrap_or("").to_string();
    if sha.is_empty() {
        return Ok(PullRequestChecks { state: "none".into(), total: 0, failing: 0, pending: 0 });
    }

    // Check runs (Checks API). Any run present → rollup from conclusions.
    let resp = send_authed(&auth, "check-runs", |t| {
        Ok(client(t)?
            .get(format!("{API}/repos/{owner}/{repo}/commits/{sha}/check-runs"))
            .query(&[("per_page", "100")]))
    })
    .await?;
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
    let resp = send_authed(&auth, "status", |t| {
        Ok(client(t)?.get(format!("{API}/repos/{owner}/{repo}/commits/{sha}/status")))
    })
    .await?;
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
        None,
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
    let (owner, repo, auth) = resolve_repo(&app, &db, &project_id).await?;
    let state = state.as_deref().unwrap_or("open");
    let resp = send_authed(&auth, "list issues", |t| {
        Ok(client(t)?
            .get(format!("{API}/repos/{owner}/{repo}/issues"))
            .query(&[
                ("state", state),
                ("per_page", "50"),
                ("sort", "updated"),
                ("direction", "desc"),
            ]))
    })
    .await?;
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
    let (owner, repo, auth) = resolve_repo(&app, &db, &project_id).await?;
    let resp = send_authed(&auth, "get issue", |t| {
        Ok(client(t)?.get(format!("{API}/repos/{owner}/{repo}/issues/{number}")))
    })
    .await?;
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
    let (owner, repo, auth) = resolve_repo(&app, &db, &project_id).await?;
    let mut payload = json!({ "title": title, "body": body });
    if let Some(labels) = labels.filter(|l| !l.is_empty()) {
        payload["labels"] = json!(labels);
    }
    let resp = send_authed(&auth, "create issue", |t| {
        Ok(client(t)?.post(format!("{API}/repos/{owner}/{repo}/issues")).json(&payload))
    })
    .await?;
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
    let (owner, repo, auth) = resolve_repo(&app, &db, &project_id).await?;
    let resp = send_authed(&auth, "add comment", |t| {
        Ok(client(t)?
            .post(format!("{API}/repos/{owner}/{repo}/issues/{number}/comments"))
            .json(&json!({ "body": body })))
    })
    .await?;
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
    let (owner, repo, auth) = resolve_repo(&app, &db, &project_id).await?;
    let resp = send_authed(&auth, "set issue state", |t| {
        Ok(client(t)?
            .patch(format!("{API}/repos/{owner}/{repo}/issues/{number}"))
            .json(&json!({ "state": state })))
    })
    .await?;
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
    let (owner, repo, auth) = resolve_repo(&app, &db, &project_id).await?;
    // NEWEST first (audit M: issue-comments ordering): GitHub's default for
    // this endpoint is ascending, so page 1 was the OLDEST 50 — issues with
    // more than 50 comments never showed their recent ones. Reversed after
    // the fetch so callers keep rendering oldest-first.
    let resp = send_authed(&auth, "list comments", |t| {
        Ok(client(t)?
            .get(format!("{API}/repos/{owner}/{repo}/issues/{number}/comments"))
            .query(&[
                ("per_page", "50"),
                ("sort", "created"),
                ("direction", "desc"),
            ]))
    })
    .await?;
    if !resp.status().is_success() {
        return Err(gh_error(resp, "comments").await);
    }
    let mut rows: Vec<Value> = resp.json().await.map_err(|e| e.to_string())?;
    rows.reverse();
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
    use super::{gh_error_message, map_issue_summary, parse_github_remote};
    use serde_json::json;

    #[test]
    fn http_403_rate_limit_is_not_a_token_problem() {
        // x-ratelimit-remaining: 0 with a body that says nothing about auth.
        let msg = gh_error_message(
            403,
            Some("0"),
            Some(12),
            None,
            r#"{"message":"API rate limit exceeded for user ID 1."}"#,
            "list",
        );
        assert!(msg.contains("rate limit"), "got: {msg}");
        assert!(msg.contains("12 minutes"), "got: {msg}");
        assert!(
            !msg.contains("GitHub rejected the token"),
            "must not blame the credential: {msg}"
        );
    }

    #[test]
    fn http_403_secondary_rate_limit_without_header() {
        let msg = gh_error_message(
            403,
            None,
            None,
            None,
            r#"{"message":"You have exceeded a secondary rate limit."}"#,
            "list",
        );
        assert!(msg.contains("rate limit"), "got: {msg}");
        assert!(
            !msg.contains("GitHub rejected the token"),
            "must not blame the credential: {msg}"
        );
    }

    #[test]
    fn http_403_saml_enforcement_names_the_sso_fix() {
        let msg = gh_error_message(
            403,
            None,
            None,
            None,
            r#"{"message":"Resource protected by organization SAML enforcement."}"#,
            "list",
        );
        assert!(msg.contains("SSO"), "got: {msg}");
        assert!(!msg.contains("Personal Access Token"), "got: {msg}");
    }

    #[test]
    fn http_403_fine_grained_pat_without_repo_access() {
        let msg = gh_error_message(
            403,
            None,
            None,
            None,
            r#"{"message":"Resource not accessible by personal access token"}"#,
            "create",
        );
        assert!(msg.contains("Personal Access Token"), "got: {msg}");
        assert!(msg.contains("create"), "got: {msg}");
        assert!(!msg.contains("reconnect"), "the PAT is the problem, not the connector: {msg}");
    }

    #[test]
    fn http_401_names_both_remedies_and_the_api_message() {
        let msg = gh_error_message(
            401,
            None,
            None,
            None,
            r#"{"message":"Bad credentials"}"#,
            "list",
        );
        assert!(msg.contains("Bad credentials"), "got: {msg}");
        assert!(msg.contains("Connectors"), "got: {msg}");
        assert!(msg.contains("Pull Requests"), "got: {msg}");
    }

    #[test]
    fn http_401_without_a_body_still_advises() {
        let msg = gh_error_message(401, None, None, None, "not json", "list");
        assert!(!msg.contains("GitHub said:"), "no phantom body quote: {msg}");
        assert!(msg.contains("Connectors"), "got: {msg}");
    }

    #[test]
    fn other_statuses_report_the_message_and_scopes() {
        let msg = gh_error_message(500, None, None, Some("repo,read:org"), r#"{"message":"boom"}"#, "list");
        assert_eq!(msg, "GitHub list failed (500): boom (token scopes: repo,read:org)");
        let no_scopes = gh_error_message(500, None, None, None, r#"{"message":"boom"}"#, "list");
        assert_eq!(no_scopes, "GitHub list failed (500): boom");
    }

    #[test]
    fn not_found_and_422_mappings_unchanged() {
        let nf = gh_error_message(404, None, None, None, "", "list");
        assert_eq!(nf, "Not found — is the branch pushed to GitHub? (list)");
        let dup = gh_error_message(
            422,
            None,
            None,
            None,
            r#"{"message":"Validation Failed","errors":[{"message":"A pull request already exists for owner:branch."}]}"#,
            "create",
        );
        assert_eq!(dup, "A pull request for this branch already exists");
    }

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
