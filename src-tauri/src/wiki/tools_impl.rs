//! The `search_wiki` / `read_wiki_page` agent tools — read-only, DB-only
//! (FTS over generated pages; no model calls, no filesystem access). The
//! wiki is project-scoped but the TOOLS are global: they search every built
//! wiki, labeling hits with their project, because a harness CLI bridged
//! session has no ambient project binding. Same spirit as `search_docs`
//! spanning all corpora.

use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::db;

pub(crate) async fn run_wiki_tool(app: &AppHandle, name: &str, args: &Value) -> String {
    if name == crate::chat::tools::SEARCH_WIKI {
        run_search(app, args).await
    } else if name == crate::chat::tools::READ_WIKI_PAGE {
        run_read(app, args)
    } else {
        format!("Error: unknown wiki tool '{name}'.")
    }
}

fn arg_str(args: &Value, key: &str) -> String {
    args.get(key)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string()
}

fn project_label(path: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string())
}

async fn run_search(app: &AppHandle, args: &Value) -> String {
    let query = arg_str(args, "query");
    if query.is_empty() {
        return "Error: search_wiki requires a non-empty \"query\".".to_string();
    }
    let top_k = args
        .get("top_k")
        .and_then(|v| v.as_u64())
        .map(|v| v.min(20).max(1) as usize)
        .unwrap_or(5);

    let projects: Vec<db::WikiProject> = {
        let db = app.state::<crate::DbState>();
        let conn = db.0.lock();
        db::wiki_list_projects(&conn).unwrap_or_default()
    };
    if projects.is_empty() {
        return "No project wiki is built yet (the search_wiki tool appears once a wiki \
                exists)."
            .to_string();
    }

    let mut hits: Vec<(String, db::WikiSearchHit)> = Vec::new();
    {
        let db = app.state::<crate::DbState>();
        let conn = db.0.lock();
        for project in &projects {
            let page_hits = match db::wiki_search_pages(&conn, &project.id, &query, top_k) {
                Ok(h) => h,
                Err(e) => return format!("Error searching the wiki: {e}"),
            };
            hits.extend(
                page_hits
                    .into_iter()
                    .map(|h| (project_label(&project.path), h)),
            );
        }
    }
    if hits.is_empty() {
        return format!(
            "No wiki page matched \"{query}\". Try broader keywords, or read the \
             project's overview page directly."
        );
    }
    hits.sort_by(|a, b| a.1.rank.partial_cmp(&b.1.rank).unwrap_or(std::cmp::Ordering::Equal));
    hits.truncate(top_k);

    let mut out = format!("Wiki hits for \"{query}\" (most relevant first):\n");
    for (label, hit) in &hits {
        let status = if hit.status == "fresh" {
            String::new()
        } else {
            format!(", {}", hit.status)
        };
        out.push_str(&format!(
            "- [{label}] `{}` — {} ({}{}) — {}. «{}»\n",
            hit.slug, hit.title, hit.kind, status, hit.summary, hit.snippet
        ));
    }
    out.push_str("\nUse read_wiki_page with the slug for the full page.");
    out
}

fn run_read(app: &AppHandle, args: &Value) -> String {
    let slug = arg_str(args, "slug");
    if slug.is_empty() {
        return "Error: read_wiki_page requires the page \"slug\" (from search_wiki).".to_string();
    }
    let db = app.state::<crate::DbState>();
    let conn = db.0.lock();
    let projects = db::wiki_list_projects(&conn).unwrap_or_default();
    for project in &projects {
        let Some(full) = db::wiki_get_page_full(&conn, &project.id, &slug).ok().flatten()
        else {
            continue;
        };
        let status = if full.page.status == "fresh" {
            String::new()
        } else {
            format!(
                "\n\n> ⚠ This page is **{}**: {}",
                full.page.status,
                full.page.stale_reason.as_deref().unwrap_or("its sources changed")
            )
        };
        let mut out = format!(
            "# {} (`{}`, project {})\n\n{}{status}",
            full.page.title,
            full.page.slug,
            project_label(&project.path),
            full.body
        );
        if !full.claims.is_empty() {
            out.push_str(&format!("\n\n---\nEvidence ({} claims):\n", full.claims.len()));
            for claim in &full.claims {
                let lines = match (claim.line_start, claim.line_end) {
                    (Some(a), Some(b)) if b > a => format!(":{a}-{b}"),
                    (Some(a), _) => format!(":{a}"),
                    _ => String::new(),
                };
                let sha = claim
                    .blob_sha
                    .as_deref()
                    .map(|s| format!(" @{}", &s[..s.len().min(8)]))
                    .unwrap_or_default();
                out.push_str(&format!(
                    "- {} — `{}`{lines}{sha}\n",
                    claim.claim, claim.evidence_path
                ));
            }
        }
        return out;
    }
    format!("Error: no wiki page with slug \"{slug}\". Use search_wiki to find slugs.")
}
