//! Tests for the wiki engine: pure parsing/validation, DB joins, the
//! scripted end-to-end build+update flow (real git, no model), and the
//! live `#[ignore]` checks (real repo analysis; real-model build).

use super::*;
use std::collections::VecDeque;
use std::path::PathBuf;
use tempfile::TempDir;

// ── helpers ───────────────────────────────────────────────────────────────

fn mock_wiki_app() -> tauri::AppHandle<tauri::test::MockRuntime> {
    let app = tauri::test::mock_app();
    let conn = crate::db::mem();
    app.manage(crate::DbState(std::sync::Arc::new(parking_lot::Mutex::new(
        conn,
    ))));
    app.manage(Arc::new(WikiJobRegistry::default()));
    app.handle().clone()
}

fn write_repo_file(dir: &Path, rel: &str, content: &str) {
    let path = dir.join(rel);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, content).unwrap();
}

fn git(dir: &Path, args: &[&str]) {
    crate::git::run_git_env(dir, args, &[]).unwrap_or_else(|e| {
        panic!("git {args:?} failed: {e} (is git on PATH?)")
    });
}

fn commit_all(dir: &Path, msg: &str) {
    git(dir, &["add", "-A"]);
    git(
        dir,
        &[
            "-c",
            "user.email=relay@example.test",
            "-c",
            "user.name=relay",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-m",
            msg,
        ],
    );
}

fn scripted(pages: &[&str]) -> Caller {
    Caller::Scripted(std::sync::Mutex::new(
        pages.iter().map(|s| s.to_string()).collect::<VecDeque<_>>(),
    ))
}

/// A BUILD queue: prepends the non-JSON stub the single-call fast path
/// consumes (and rejects) before the outline + page pipeline runs. Update
/// queues must use `scripted()` — they have no single-call pass, and the
/// stub would be stored as a page body.
fn scripted_build(pages: &[&str]) -> Caller {
    let mut queue: VecDeque<String> = VecDeque::new();
    queue.push_back("this is not json at all".to_string());
    for s in pages {
        queue.push_back(s.to_string());
    }
    Caller::Scripted(std::sync::Mutex::new(queue))
}

/// One-page outline for tests that don't want to script both pages.
const SCRIPTED_OUTLINE_SINGLE: &str = "```json
{\"pages\":[{\"slug\":\"Overview\",\"title\":\"Overview\",\"kind\":\"overview\",\"summary\":\"The big picture\",\"brief\":\"Cover the project from the README and main\",\"files\":[\"README.md\",\"src/main.rs\"]}] }
```";

fn sample_repo() -> (TempDir, PathBuf) {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path().to_path_buf();
    write_repo_file(
        &root,
        "README.md",
        "# Sample\nA sample project used by the wiki tests.\n",
    );
    write_repo_file(
        &root,
        "src/main.rs",
        "//! Entry point.\npub fn main() {\n    println!(\"sample\");\n}\n",
    );
    write_repo_file(
        &root,
        "src/mesh.rs",
        "//! Mesh module: peer-to-peer session messaging.\npub struct Mailbox;\n",
    );
    write_repo_file(&root, "docs/notes.md", "internal notes\n");
    git(&root, &["init"]);
    commit_all(&root, "init");
    (tmp, root)
}

// ── pure parsing / validation ─────────────────────────────────────────────

#[test]
fn sanitize_slug_folds_to_kebab_and_caps_length() {
    assert_eq!(sanitize_slug("Session Mesh!", "x"), "session-mesh");
    assert_eq!(sanitize_slug("  ", "Overview Page"), "overview-page");
    assert_eq!(sanitize_slug("///", "Fallback"), "fallback");
    let long = sanitize_slug(&"a".repeat(80), "x");
    assert_eq!(long.chars().count(), 48);
}

#[test]
fn extract_json_tolerates_fences_and_prose() {
    assert_eq!(extract_json("{\"a\":1}"), Some("{\"a\":1}"));
    assert_eq!(
        extract_json("```json\n{\"a\":1}\n```"),
        Some("{\"a\":1}"),
        "span between braces survives the fence"
    );
    assert_eq!(
        extract_json("Here you go:\n{\"pages\":[]} — hope it helps"),
        Some("{\"pages\":[]}")
    );
    assert_eq!(extract_json("no json at all"), None);
}

#[test]
fn normalize_outline_parses_fenced_and_bare_shapes() {
    let fenced = "```json\n{\"pages\":[{\"slug\":\"Overview\",\"title\":\"Overview\",\
\"kind\":\"overview\",\"summary\":\"big picture\",\"brief\":\"cover it\",\
\"files\":[\"./README.md\", \"/abs/path\", \"a/../b\"]}]}\n```";
    let briefs = normalize_outline(fenced, 10).unwrap();
    assert_eq!(briefs.len(), 1);
    assert_eq!(briefs[0].slug, "overview");
    // ./ stripped; absolute and .. paths dropped, not passed through.
    assert_eq!(briefs[0].files, vec!["README.md".to_string()]);

    let bare = "[{\"slug\":\"Mesh\",\"title\":\"Mesh\",\"kind\":\"weird-kind\",\
\"summary\":\"s\",\"brief\":\"b\",\"files\":[]}]";
    let briefs = normalize_outline(bare, 10).unwrap();
    assert_eq!(briefs[0].kind, "module", "unknown kinds fold to module");

    assert!(normalize_outline("not json at all", 10).is_err());
    assert!(normalize_outline("{\"pages\":[{\"slug\":\"x\",\"brief\":\"\"}]}", 10).is_err());
}

#[test]
fn normalize_outline_caps_pages_and_suffixes_slug_collisions() {
    let items: Vec<String> = (0..6)
        .map(|i| {
            format!(
                "{{\"slug\":\"dup\",\"title\":\"Dup {i}\",\"kind\":\"module\",\
\"summary\":\"s\",\"brief\":\"brief {i}\",\"files\":[]}}"
            )
        })
        .collect();
    let json = format!("{{\"pages\":[{}]}}", items.join(","));
    let briefs = normalize_outline(&json, 3).unwrap();
    assert_eq!(briefs.len(), 3, "page cap enforced");
    let slugs: std::collections::HashSet<&str> = briefs.iter().map(|b| b.slug.as_str()).collect();
    assert_eq!(slugs.len(), 3, "slug collisions suffixed, never merged");
    assert_eq!(briefs[0].kind, "module");
}

#[test]
fn parse_page_splits_body_from_ledger_and_degrades_gracefully() {
    let page = "# Overview\nThe mesh routes messages.\n\n<!-- relay:claims -->\n\
```relay-claims\n{\"claims\":[{\"claim\":\"The mesh routes messages.\",\
\"path\":\"src/mesh.rs\",\"lines\":[1,2]}]}\n```";
    let (body, claims) = parse_page(page);
    assert!(body.starts_with("# Overview"));
    assert!(!body.contains("relay:claims"), "marker stripped from the body");
    assert_eq!(claims.len(), 1);
    assert_eq!(claims[0].path, "src/mesh.rs");

    let (body, claims) = parse_page("# Just a page, no ledger");
    assert_eq!(body, "# Just a page, no ledger");
    assert!(claims.is_empty(), "missing ledger degrades to zero claims");

    let (body, claims) = parse_page(
        "# Page\n<!-- relay:claims -->\n```relay-claims\n{not json}\n```",
    );
    assert_eq!(body, "# Page");
    assert!(claims.is_empty(), "invalid ledger JSON degrades to zero claims");
}

#[test]
fn parse_page_strips_a_repeated_marker_from_the_body() {
    // A model that emits the ledger marker more than once: rfind alone would
    // keep the first one, and it renders as raw text in the reader.
    let page = "# Overview

<!-- relay:claims -->
```relay-claims
{\"claims\":[{\"claim\":\"early\",\"path\":\"a.rs\",\"lines\":[1,2]}]}
```

More prose.

<!-- relay:claims -->
```relay-claims
{\"claims\":[{\"claim\":\"late\",\"path\":\"b.rs\",\"lines\":[3,4]}]}
```";
    let (body, claims) = parse_page(page);
    assert!(!body.contains("relay:claims"), "every marker stripped, not just the last");
    assert!(!body.contains("relay-claims"), "the fenced ledger block is gone too");
    assert!(body.contains("More prose."), "prose after the stray ledger survives");
    // The LAST ledger is the authoritative one.
    assert_eq!(claims.len(), 1);
    assert_eq!(claims[0].path, "b.rs");
}

#[test]
fn strip_claims_ledger_is_a_no_op_on_a_clean_body() {
    let clean = "# Overview

The mesh routes messages.
";
    assert_eq!(strip_claims_ledger(clean), clean.trim());
    let dirty = "# Overview

<!-- relay:claims -->
```relay-claims
{\"claims\":[]}
```";
    let stripped = strip_claims_ledger(dirty);
    assert!(!stripped.contains("relay"), "residue removed: {stripped:?}");
    // Idempotent.
    assert_eq!(strip_claims_ledger(&stripped), stripped);
}

#[test]
fn parse_single_wiki_never_stores_the_marker_in_a_page_body() {
    // The single-call envelope carries claims as a sibling array, so a body
    // that still contains ledger residue must have it stripped before storage.
    let dirty_body = concat!(
        "# Overview

The mesh routes messages between peers over the wire.

",
        "It is the core of the subsystem and everything else builds on it.

",
        "<!-- relay:claims -->
```relay-claims
",
        "{\"claims\":[{\"claim\":\"x\",\"path\":\"src/mesh.rs\",\"lines\":[1,2]}]}
```"
    );
    let raw = serde_json::json!({
        "pages": [
            {
                "slug": "overview",
                "title": "Overview",
                "kind": "overview",
                "summary": "Big picture",
                "body": dirty_body,
                "claims": [{"claim": "The mesh routes messages.", "path": "src/mesh.rs", "lines": [1, 2]}],
            },
            {
                "slug": "mesh",
                "title": "Mesh",
                "kind": "module",
                "summary": "Peer messaging",
                "body": "# Mesh

It routes messages between peers over the wire, with retries and backpressure.",
                "claims": [{"claim": "Peer messaging.", "path": "src/mesh.rs", "lines": [1, 2]}],
            },
        ]
    })
    .to_string();
    let pages = parse_single_wiki(&raw, 8).expect("single-call parses");
    assert_eq!(pages.len(), 2);
    for p in &pages {
        assert!(
            !p.body.contains("relay:claims"),
            "ledger marker must never reach the stored body: {:?}",
            p.body
        );
    }
    assert!(pages[0].body.contains("The mesh routes messages between peers over the wire."));
    assert!(pages[0].body.contains("core of the subsystem"), "prose around the stray ledger survives");
}

#[test]
fn validate_claims_drops_escapes_and_missing_files() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path();
    write_repo_file(root, "src/real.rs", "fn a() {}\n");
    let raw = vec![
        RawClaim {
            claim: "real".into(),
            path: "src/real.rs".into(),
            lines: vec![1, 2],
        },
        RawClaim {
            claim: "escape".into(),
            path: "../outside.rs".into(),
            lines: vec![1, 1],
        },
        RawClaim {
            claim: "absolute".into(),
            path: "C:/windows/system32".into(),
            lines: vec![1, 1],
        },
        RawClaim {
            claim: "ghost".into(),
            path: "src/ghost.rs".into(),
            lines: vec![1, 1],
        },
        RawClaim {
            claim: "empty".into(),
            path: "src/real.rs".into(),
            lines: vec![],
        },
    ];
    let claims = validate_claims(root, &raw);
    let paths: Vec<&str> = claims.iter().map(|c| c.evidence_path.as_str()).collect();
    assert_eq!(paths, vec!["src/real.rs", "src/real.rs"], "escape/abs/ghost dropped");
    // Blob SHAs are best-effort (git hash-object): present or None, but the
    // e2e test pins the in-repo case. Inverted ranges fold to unlined
    // evidence rather than being dropped.
    assert_eq!(claims[1].line_start, None);
}

#[test]
fn stale_reason_truncates_long_file_lists() {
    let files: Vec<String> = (0..8).map(|i| format!("src/f{i}.rs")).collect();
    let reason = stale_reason_for(&files);
    assert!(reason.contains("+3 more"), "reason: {reason}");
    assert_eq!(reason.matches(',').count(), 4, "five files max then the +N");
}

// ── audit regressions ─────────────────────────────────────────────────────

#[test]
fn validate_claims_keeps_going_past_an_empty_claim() {
    // An empty `claim` (the field is `#[serde(default)]`, so `""` is the
    // parse result for `{"path":"a.rs"}`) used to `break` the whole loop,
    // discarding every LATER claim and its evidence path. Claims are also the
    // page's freshness join key, so one malformed entry silently truncated a
    // page's grounding and froze it out of the update pass forever.
    let tmp = TempDir::new().unwrap();
    let root = tmp.path();
    write_repo_file(root, "a.rs", "fn a() {}\n");
    write_repo_file(root, "b.rs", "fn b() {}\n");
    write_repo_file(root, "c.rs", "fn c() {}\n");
    let raw = vec![
        RawClaim { claim: "first".into(), path: "a.rs".into(), lines: vec![1, 1] },
        RawClaim { claim: "   ".into(), path: "b.rs".into(), lines: vec![1, 1] },
        RawClaim { claim: String::new(), path: "b.rs".into(), lines: vec![1, 1] },
        RawClaim { claim: "third".into(), path: "c.rs".into(), lines: vec![1, 1] },
    ];
    let claims = validate_claims(root, &raw);
    let paths: Vec<&str> = claims.iter().map(|c| c.evidence_path.as_str()).collect();
    assert_eq!(
        paths,
        vec!["a.rs", "c.rs"],
        "an empty claim drops only itself, not the rest of the ledger"
    );
}

#[test]
fn validate_claims_still_stops_at_the_cap() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path();
    write_repo_file(root, "a.rs", "fn a() {}\n");
    let raw: Vec<RawClaim> = (0..(MAX_CLAIMS_PER_PAGE + 25))
        .map(|i| RawClaim {
            claim: format!("claim {i}"),
            path: "a.rs".into(),
            lines: vec![1, 1],
        })
        .collect();
    let claims = validate_claims(root, &raw);
    assert_eq!(claims.len(), MAX_CLAIMS_PER_PAGE, "the cap is a hard stop, not a filter");
}

#[test]
fn validate_claims_rejects_windows_absolute_and_symlink_escapes() {
    // `starts_with('/')` only caught Unix absolutes. On Windows `Path::join`
    // DISCARDS the base for `C:/…`, so a claim could hash, persist and render
    // a file from anywhere on disk. Claim paths are untrusted model output.
    let tmp = TempDir::new().unwrap();
    let outside = TempDir::new().unwrap();
    let root = tmp.path();
    let secret = outside.path().join("secret.txt");
    std::fs::write(&secret, "TOP SECRET").unwrap();
    write_repo_file(root, "real.rs", "fn a() {}\n");

    // A symlink inside the repo pointing out of it must be rejected too:
    // `is_file()` alone follows it.
    let link = root.join("escape");
    #[cfg(unix)]
    std::os::unix::fs::symlink(&secret, &link).unwrap();

    let abs_form = secret.to_string_lossy().replace('\\', "/");
    let mut raw = vec![
        RawClaim { claim: "real".into(), path: "real.rs".into(), lines: vec![1, 1] },
        RawClaim { claim: "abs".into(), path: abs_form.clone(), lines: vec![1, 1] },
        RawClaim { claim: "drive".into(), path: "C:/windows/system32/drivers/etc/hosts".into(), lines: vec![1, 1] },
        RawClaim { claim: "unc".into(), path: "//server/share/x.txt".into(), lines: vec![1, 1] },
    ];
    #[cfg(unix)]
    raw.push(RawClaim { claim: "symlink".into(), path: "escape".into(), lines: vec![1, 1] });

    let claims = validate_claims(root, &raw);
    let paths: Vec<&str> = claims.iter().map(|c| c.evidence_path.as_str()).collect();
    assert_eq!(paths, vec!["real.rs"], "only the genuine in-repo file survives: {paths:?}");
}

#[test]
fn blob_shas_are_resolved_in_one_batched_call() {
    // The per-claim `git hash-object` was the single largest blocking cost in
    // a build: every git spawn pays a ~50ms reaping floor, so 64 claims on a
    // page meant 3+ seconds of a pinned tokio worker. The batch must produce
    // the SAME per-path SHAs as the single-file path.
    let tmp = TempDir::new().unwrap();
    let root = tmp.path();
    write_repo_file(root, "a.rs", "fn a() {}\n");
    write_repo_file(root, "b.rs", "fn b() {}\n");
    write_repo_file(root, "c.rs", "fn c() {}\n");

    let one = git_blob_shas(root, &["a.rs".to_string()]);
    assert_eq!(
        one.get("a.rs").cloned(),
        git_blob_sha(root, "a.rs"),
        "single-path batch must match the one-file call"
    );

    let rels: Vec<String> = ["a.rs", "b.rs", "c.rs"].iter().map(|s| s.to_string()).collect();
    let batched = git_blob_shas(root, &rels);
    for rel in &rels {
        assert_eq!(
            batched.get(rel).cloned(),
            git_blob_sha(root, rel),
            "batched SHA for {rel} must match the per-file SHA"
        );
    }
    assert_eq!(batched.len(), 3, "every path gets a SHA, aligned not shifted");

    // A path git cannot hash degrades to "unverifiable" rather than
    // mis-aligning every later SHA onto the wrong file.
    let with_missing = git_blob_shas(root, &["a.rs".into(), "gone.rs".into(), "c.rs".into()]);
    assert_eq!(
        with_missing.get("c.rs").cloned(),
        git_blob_sha(root, "c.rs"),
        "a missing path must not shift the SHAs after it"
    );
    assert!(git_blob_shas(root, &[]).is_empty());
}

#[test]
fn single_call_duplicate_slugs_are_deduplicated() {
    // Pages upsert on UNIQUE(project_id, slug), so two pages sharing a slug
    // meant the second SILENTLY OVERWROTE the first while the build still
    // reported N pages stored and progress said "(7/7)".
    let body = |t: &str| {
        format!("# {t}\n\nSome body text comfortably over the eighty character minimum the parser enforces.\n")
    };
    let raw = serde_json::json!({
        "pages": [
            {"slug":"overview","title":"Overview","kind":"overview","summary":"s","body":body("A"),"claims":[]},
            {"slug":"overview","title":"Overview Again","kind":"overview","summary":"s","body":body("B"),"claims":[]},
            {"slug":"mesh","title":"Mesh","kind":"module","summary":"s","body":body("C"),"claims":[]},
        ]
    })
    .to_string();
    let pages = parse_single_wiki(&raw, 20).unwrap();
    let slugs: Vec<&str> = pages.iter().map(|p| p.brief.slug.as_str()).collect();
    assert_eq!(pages.len(), 3, "no page may be silently dropped");
    let mut uniq = slugs.clone();
    uniq.sort();
    uniq.dedup();
    assert_eq!(uniq.len(), 3, "slugs must be unique or a page is overwritten: {slugs:?}");
}

#[test]
fn strip_claims_ledger_never_deletes_real_prose() {
    // The fence search was unbounded, so a page with a marker followed by
    // real prose and a LATER relay-claims fence lost that prose entirely —
    // silently, with nothing in the stored body to show for it.
    let body = "# Page\n\nReal prose A.\n\n<!-- relay:claims -->\n\nMore real prose B that must survive.\n\n```relay-claims\n{\"claims\":[]}\n```\n";
    let out = strip_claims_ledger(body);
    assert!(out.contains("Real prose A."), "kept: {out}");
    assert!(
        out.contains("More real prose B that must survive."),
        "prose between the marker and a later fence must survive: {out}"
    );
    assert!(!out.contains("relay-claims"), "the ledger itself is stripped: {out}");

    // The normal shape (marker immediately followed by the fence) still strips.
    let clean = "# Page\n\nBody.\n\n<!-- relay:claims -->\n```relay-claims\n{\"claims\":[]}\n```\n";
    let stripped = strip_claims_ledger(clean);
    assert!(!stripped.contains("relay-claims"), "{stripped}");
    assert!(stripped.contains("Body."), "{stripped}");
}

#[test]
fn pages_with_no_evidence_are_still_refreshed() {
    // A page whose claims were ALL dropped by validation has no wiki_claims
    // rows, so joining on claims alone made it unreachable by the freshness
    // engine: the update passed it as unaffected and advanced the HEAD stamp
    // past every commit that could have repaired it.
    let conn = crate::db::mem();
    let project = crate::db::wiki_ensure_project(&conn, "/repo").unwrap();
    crate::db::wiki_replace_page(
        &conn, &project.id, "ghost", "Ghost", "module", "", "body", "brief",
        &[], "fresh", None, &[],
    )
    .unwrap();
    crate::db::wiki_replace_page(
        &conn, &project.id, "filed", "Filed", "module", "", "body", "brief",
        &["src/a.rs".to_string()], "fresh", None, &[],
    )
    .unwrap();

    let unevidenced = crate::db::wiki_pages_without_evidence(&conn, &project.id).unwrap();
    assert_eq!(unevidenced, vec!["ghost".to_string()]);

    // A changed file reaches the page through its stored file set even with
    // no claims at all. The un-evidenced page rides along: we cannot check
    // it, so any commit is grounds to refresh it.
    let affected = affected_pages(&conn, &project.id, &["src/a.rs".to_string()]).unwrap();
    assert_eq!(affected, vec!["filed".to_string(), "ghost".to_string()]);

    // The unevidenced page is refreshed whenever ANY commit lands — "we
    // cannot check this page" is not "this page is still current".
    let affected = affected_pages(&conn, &project.id, &["unrelated.rs".to_string()]).unwrap();
    assert_eq!(affected, vec!["ghost".to_string()]);
}

#[test]
fn affected_pages_are_marked_stale_before_any_model_call() {
    // `wiki_set_page_status` had ZERO callers, so nothing was ever marked
    // stale. When the model call failed part-way through the refresh loop
    // (`?`), the untouched remainder stayed labelled "fresh" while its cited
    // evidence had demonstrably changed — and both the LLM (via
    // `index_prompt_section`) and the reader (via the status badge) were
    // told stale content was current.
    let conn = crate::db::mem();
    let project = crate::db::wiki_ensure_project(&conn, "/repo").unwrap();
    for (slug, files) in [
        ("mesh", vec!["src/mesh.rs".to_string()]),
        ("vault", vec!["src/vault.rs".to_string()]),
    ] {
        crate::db::wiki_replace_page(
            &conn,
            &project.id,
            slug,
            slug,
            "module",
            "",
            "body",
            "brief",
            &files,
            "fresh",
            None,
            &[db::WikiClaim {
                claim: "c".into(),
                evidence_path: files[0].clone(),
                line_start: None,
                line_end: None,
                blob_sha: None,
            }],
        )
        .unwrap();
    }

    let changed = vec!["src/mesh.rs".to_string()];
    let affected = affected_pages(&conn, &project.id, &changed).unwrap();
    assert_eq!(affected, vec!["mesh".to_string()]);

    mark_affected_stale(&conn, &project.id, &affected, &changed).unwrap();

    let pages = crate::db::wiki_list_pages(&conn, &project.id).unwrap();
    let mesh = pages.iter().find(|p| p.slug == "mesh").unwrap();
    let vault = pages.iter().find(|p| p.slug == "vault").unwrap();
    assert_eq!(mesh.status, "stale", "an affected page must be flagged");
    assert_eq!(
        mesh.stale_reason.as_deref(),
        Some("src/mesh.rs"),
        "and say which source moved"
    );
    assert_eq!(
        vault.status, "fresh",
        "an unaffected page must NOT be flagged — this is what keeps the no-op update honest"
    );

    // Regenerating resets it: replace_page clears the reason on success.
    crate::db::wiki_replace_page(
        &conn, &project.id, "mesh", "Mesh", "module", "", "new body", "brief",
        &["src/mesh.rs".to_string()], "fresh", None, &[],
    )
    .unwrap();
    let pages = crate::db::wiki_list_pages(&conn, &project.id).unwrap();
    let mesh = pages.iter().find(|p| p.slug == "mesh").unwrap();
    assert_eq!(mesh.status, "fresh");
    assert_eq!(mesh.stale_reason, None);
}

// ── DB-backed units ───────────────────────────────────────────────────────

#[test]
fn affected_pages_joins_changed_paths_against_claim_evidence() {
    let conn = crate::db::mem();
    let project = crate::db::wiki_ensure_project(&conn, "/repo").unwrap();
    crate::db::wiki_replace_page(
        &conn,
        &project.id,
        "mesh",
        "Mesh",
        "module",
        "",
        "body",
        "brief",
        &[],
        "fresh",
        None,
        &[db::WikiClaim {
            claim: "x".into(),
            evidence_path: "src/mesh.rs".into(),
            line_start: None,
            line_end: None,
            blob_sha: None,
        }],
    )
    .unwrap();
    crate::db::wiki_replace_page(
        &conn,
        &project.id,
        "overview",
        "Overview",
        "overview",
        "",
        "body",
        "brief",
        &[],
        "fresh",
        None,
        &[db::WikiClaim {
            claim: "y".into(),
            evidence_path: "README.md".into(),
            line_start: None,
            line_end: None,
            blob_sha: None,
        }],
    )
    .unwrap();
    let affected = affected_pages(
        &conn,
        &project.id,
        &["src/mesh.rs".to_string(), "unrelated.txt".to_string()],
    )
    .unwrap();
    assert_eq!(affected, vec!["mesh".to_string()]);
}

#[test]
fn index_prompt_section_absent_without_pages_present_with_them() {
    let conn = crate::db::mem();
    assert!(index_prompt_section(&conn, "/no/wiki").is_none());
    let project = crate::db::wiki_ensure_project(&conn, "/repo").unwrap();
    assert!(index_prompt_section(&conn, "/repo").is_none(), "no pages → no section");
    crate::db::wiki_replace_page(
        &conn,
        &project.id,
        "overview",
        "Overview",
        "overview",
        "The big picture",
        "# Overview",
        "brief",
        &[],
        "stale",
        None,
        &[],
    )
    .unwrap();
    let section = index_prompt_section(&conn, "/repo").unwrap();
    assert!(section.starts_with("## Project knowledge (Relay wiki)"));
    assert!(section.contains("`overview` Overview — The big picture"));
    assert!(section.contains("[stale]"), "status rides the index");
    assert!(section.contains("search_wiki"));
}

#[test]
fn index_prompt_section_truncates_over_budget() {
    let conn = crate::db::mem();
    let project = crate::db::wiki_ensure_project(&conn, "/repo").unwrap();
    for i in 0..200 {
        crate::db::wiki_replace_page(
            &conn,
            &project.id,
            &format!("page-{i}"),
            &format!("Page {i}"),
            "module",
            &"summary ".repeat(10),
            "body",
            "brief",
            &[],
            "fresh",
            None,
            &[],
        )
        .unwrap();
    }
    let section = index_prompt_section(&conn, "/repo").unwrap();
    assert!(section.chars().count() <= MAX_INDEX_CHARS + 200);
    assert!(section.contains("[index truncated]"));
}

#[test]
fn has_pages_reflects_the_wiki_state() {
    let conn = crate::db::mem();
    assert!(!has_pages(&conn, "/repo"));
    let project = crate::db::wiki_ensure_project(&conn, "/repo").unwrap();
    assert!(!has_pages(&conn, "/repo"), "project row alone isn't enough");
    crate::db::wiki_replace_page(
        &conn,
        &project.id,
        "overview",
        "Overview",
        "overview",
        "",
        "b",
        "br",
        &[],
        "fresh",
        None,
        &[],
    )
    .unwrap();
    assert!(has_pages(&conn, "/repo"));
}

#[test]
fn harness_engine_of_maps_prefixes_and_refuses_acp() {
    assert_eq!(
        harness_engine_of("commandcode").as_deref(),
        Some("commandcode")
    );
    assert_eq!(harness_engine_of("harness:opencode").as_deref(), Some("opencode"));
    assert_eq!(harness_engine_of("acp:zed"), None, "ACP has no unattended path");
    assert_eq!(harness_engine_of("openrouter"), None, "cloud ids stay cloud");
    assert_eq!(harness_engine_of("nonsense"), None);
}

#[test]
fn harness_build_model_resolves_without_any_api_key() {
    // The decisive property of the harness arm: it resolves on a machine
    // with NO Relay-held keys, because the CLI owns its auth.
    let conn = crate::db::mem();
    crate::db::set_setting(&conn, SETTING_BUILD_PROVIDER, "harness:commandcode").unwrap();
    crate::db::set_setting(&conn, SETTING_BUILD_MODEL, "inclusionai/ling-3.1-flash:free")
        .unwrap();
    match resolve_build_model(&conn) {
        Ok(Caller::Harness { harness_id, model }) => {
            assert_eq!(harness_id, "commandcode");
            assert_eq!(model, "inclusionai/ling-3.1-flash:free");
        }
        _ => panic!("expected a harness caller"),
    }
    // Empty model = the CLI's own configured default.
    crate::db::set_setting(&conn, SETTING_BUILD_MODEL, "").unwrap();
    match resolve_build_model(&conn) {
        Ok(Caller::Harness { model, .. }) => assert_eq!(model, ""),
        _ => panic!("expected a harness caller"),
    }
}

#[test]
fn resolve_build_model_requires_a_complete_config() {
    let conn = crate::db::mem();
    // Nothing configured and no keychain key → the chain must say so, not panic.
    if crate::chat::commands::resolve_cloud_summarizer(&conn).is_none() {
        assert!(resolve_build_model(&conn).is_err());
    }
    // Provider without a model → explicit error, no keychain round-trip.
    crate::db::set_setting(&conn, SETTING_BUILD_PROVIDER, "anthropic").unwrap();
    let err = match resolve_build_model(&conn) {
        Err(e) => e,
        Ok(_) => panic!("must not resolve without a model"),
    };
    assert!(err.contains(SETTING_BUILD_MODEL), "err: {err}");
    // Model without a key → explicit error before any network thought.
    crate::db::set_setting(&conn, SETTING_BUILD_MODEL, "claude-x").unwrap();
    match resolve_build_model(&conn) {
        Err(err) => assert!(err.contains("API key"), "err: {err}"),
        Ok(_) => {
            // Only reachable on a dev machine that really has an Anthropic
            // key in the OS keychain — acceptable, still a valid resolution.
        }
    }
}

// ── scripted end-to-end flow (real git, no model) ─────────────────────────

const SCRIPTED_OUTLINE: &str = "```json\n{\"pages\":[\
{\"slug\":\"Overview\",\"title\":\"Overview\",\"kind\":\"overview\",\"summary\":\
\"The big picture\",\"brief\":\"Cover the project from the README and main\",\
\"files\":[\"README.md\",\"src/main.rs\"]},\
{\"slug\":\"Mesh Module\",\"title\":\"Mesh\",\"kind\":\"module\",\"summary\":\
\"Peer messaging\",\"brief\":\"Cover the mesh module\",\"files\":[\"src/mesh.rs\"]}\
]}\n```";

fn scripted_page(slug: &str, mesh_line: &str) -> String {
    format!(
        "# {slug}\n\nThe sample project has a `{slug}` area. {mesh_line}\n\n\
```mermaid\nflowchart TD\n  A[README] --> B[main]\n```\n\n\
<!-- relay:claims -->\n```relay-claims\n{{\"claims\":[\
{{\"claim\":\"{mesh_line}\",\"path\":\"src/mesh.rs\",\"lines\":[1,2]}},\
{{\"claim\":\"The sample project is described in README.md.\",\"path\":\"README.md\",\"lines\":[1,1]}}\
]}}\n```"
    )
}

#[tokio::test]
async fn malformed_one_pass_response_is_self_repaired_by_the_same_model() {
    // A one-pass response whose JSON is corrupted mid-document (mirrors the
    // live free-model failure: valid-looking wiki, unbalanced quote at char
    // ~34k) must be handed back to the model for ONE repair round instead of
    // paying the N+1-call two-phase fallback immediately.
    let (_tmp, root) = sample_repo();
    let app = mock_wiki_app();

    let valid = serde_json::json!({
        "pages": [
            {"slug":"overview","title":"Overview","kind":"overview","summary":"s",
             "body":"# Overview\n\nSome body text comfortably over the eighty character minimum the parser enforces.\n","claims":[]},
            {"slug":"mesh","title":"Mesh","kind":"module","summary":"s",
             "body":"# Mesh\n\nSome body text comfortably over the eighty character minimum the parser enforces.\n","claims":[]},
        ]
    })
    .to_string();
    let malformed = valid.replacen("\"summary\":\"s\"", "\"summary\":\"s", 1);
    assert_ne!(malformed, valid, "corruption must change the payload");
    assert!(
        parse_single_wiki(&malformed, 20).is_err(),
        "the corrupted response must fail the strict parse"
    );

    // Queue: [malformed one-pass, repaired response]. The build must end on
    // the repair — no outline/page calls follow.
    let out = run_build_with(&app, &root, scripted(&[&malformed, &valid]))
        .await
        .unwrap();
    assert_eq!(out.pages, 2, "the repaired response must be used");

    let canonical = canonical_root(&root).unwrap();
    let pages = {
        let db = app.state::<crate::DbState>();
        let conn = db.0.lock();
        let project = db::wiki_get_project_by_path(&conn, &canonical)
            .unwrap()
            .unwrap();
        db::wiki_list_pages(&conn, &project.id).unwrap()
    };
    assert_eq!(pages.len(), 2);
}

#[tokio::test]
async fn scripted_build_end_to_end_then_update_pass() {
    let (_tmp, root) = sample_repo();
    let app = mock_wiki_app();

    let out = run_build_with(
        &app,
        &root,
        scripted_build(&[
            SCRIPTED_OUTLINE,
            &scripted_page("Overview", "The mesh module defines Mailbox."),
            &scripted_page("Mesh", "The mesh module defines Mailbox."),
        ]),
    )
    .await
    .unwrap();
    assert_eq!(out.pages, 2);

    let canonical = canonical_root(&root).unwrap();
    let (project, pages) = {
        let db = app.state::<crate::DbState>();
        let conn = db.0.lock();
        let project = db::wiki_get_project_by_path(&conn, &canonical)
            .unwrap()
            .unwrap();
        let pages = db::wiki_list_pages(&conn, &project.id).unwrap();
        (project, pages)
    };
    assert_eq!(pages.len(), 2);
    let head = git_head(&root).unwrap();
    assert_eq!(project.head_sha.as_deref(), Some(head.as_str()));
    assert_eq!(project.schema_version, db::WIKI_SCHEMA_VERSION);
    assert!(project.build_model.as_deref() == Some("scripted"));

    // Claims survived validation against the real repo (blob SHAs resolved).
    let full = {
        let db = app.state::<crate::DbState>();
        let conn = db.0.lock();
        db::wiki_get_page_full(&conn, &project.id, "mesh-module")
            .unwrap()
            .unwrap()
    };
    assert_eq!(full.claims.len(), 2, "both claims validated");
    assert!(
        full.claims.iter().all(|c| c.blob_sha.is_some()),
        "git hash-object must resolve SHAs inside a real repo"
    );
    assert_eq!(full.page.status, "fresh");

    // ── update: a commit touching cited evidence regenerates that page ──
    write_repo_file(&root, "src/mesh.rs", "//! Mesh module v2: routing added.\npub struct Router;\n");
    commit_all(&root, "add routing to mesh");
    let report = run_update_with(
        &app,
        &root,
        scripted(&[
            &scripted_page("Mesh", "The mesh module now routes."),
            &scripted_page("Overview", "The mesh module now routes."),
        ]),
    )
    .await
    .unwrap();
    assert_eq!(report.status, "updated");
    // Both scripted pages cite src/mesh.rs in their claim ledgers, so both
    // are affected by this commit — the join is doing its job.
    assert_eq!(report.pages_refreshed, 2);
    assert_eq!(report.changed_paths, 1, "only src/mesh.rs changed");

    let (head2, full2) = {
        let db = app.state::<crate::DbState>();
        let conn = db.0.lock();
        let full = db::wiki_get_page_full(&conn, &project.id, "mesh-module")
            .unwrap()
            .unwrap();
        let project = db::wiki_get_project_by_path(&conn, &canonical)
            .unwrap()
            .unwrap();
        (project.head_sha.unwrap(), full)
    };
    assert_eq!(head2, git_head(&root).unwrap(), "update stamps the new HEAD");
    assert_eq!(full2.page.status, "fresh");
    assert!(full2.body.contains("now routes"), "the page was regenerated");
    // Both pages came back fresh off the same update pass.
    let overview = {
        let db = app.state::<crate::DbState>();
        let conn = db.0.lock();
        db::wiki_get_page_full(&conn, &project.id, "overview")
            .unwrap()
            .unwrap()
    };
    assert_eq!(overview.page.status, "fresh");
    assert!(overview.body.contains("now routes"), "overview regenerated too");

    // ── update again: same HEAD → up_to_date, ZERO model calls ──
    let report = run_update_with(&app, &root, scripted(&[])).await.unwrap();
    assert_eq!(report.status, "up_to_date");

    // ── update with an irrelevant commit → up_to_date, ZERO model calls ──
    write_repo_file(&root, "docs/notes.md", "more notes\n");
    commit_all(&root, "unrelated notes");
    let report = run_update_with(&app, &root, scripted(&[])).await.unwrap();
    assert_eq!(report.status, "up_to_date");
    assert_eq!(report.changed_paths, 1);
    // Reaching here at all proves the empty scripted queue was never popped.
}

#[tokio::test]
async fn scripted_rebuild_when_schema_version_lags() {
    let (_tmp, root) = sample_repo();
    let app = mock_wiki_app();
    run_build_with(&app, &root, scripted_build(&[SCRIPTED_OUTLINE, &scripted_page("Overview", "mesh."), &scripted_page("Mesh", "mesh.")]))
        .await
        .unwrap();
    // Simulate an old-format wiki: roll the stamp back.
    let canonical = canonical_root(&root).unwrap();
    {
        let db = app.state::<crate::DbState>();
        let conn = db.0.lock();
        conn.execute(
            "UPDATE wiki_projects SET schema_version = 0",
            [],
        )
        .unwrap();
    }
    let report = run_update_with(
        &app,
        &root,
        // This update REBUILDS (schema lag) — the rebuild runs the single-
        // call pass first, so the queue needs the build-shaped stub.
        scripted_build(&[
            SCRIPTED_OUTLINE,
            &scripted_page("Overview", "mesh."),
            &scripted_page("Mesh", "mesh."),
        ]),
    )
    .await
    .unwrap();
    assert_eq!(report.status, "rebuilt", "schema lag forces a rebuild");
    let count = {
        let db = app.state::<crate::DbState>();
        let conn = db.0.lock();
        let project = db::wiki_get_project_by_path(&conn, &canonical).unwrap().unwrap();
        db::wiki_page_count(&conn, &project.id).unwrap()
    };
    assert_eq!(count, 2);
}

#[tokio::test]
async fn build_without_a_model_leaves_the_existing_wiki_intact() {
    let (_tmp, root) = sample_repo();
    let app = mock_wiki_app();
    run_build_with(&app, &root, scripted_build(&[SCRIPTED_OUTLINE, &scripted_page("Overview", "mesh."), &scripted_page("Mesh", "mesh.")]))
        .await
        .unwrap();
    // A provider configured without a usable key → the run_build wrapper
    // must fail BEFORE clearing (deterministic regardless of what the dev
    // machine's keychain holds, because the explicit setting wins).
    {
        let db = app.state::<crate::DbState>();
        let conn = db.0.lock();
        crate::db::set_setting(&conn, SETTING_BUILD_PROVIDER, "ghost-provider").unwrap();
        crate::db::set_setting(&conn, SETTING_BUILD_MODEL, "ghost-model").unwrap();
    }
    let err = run_build(&app, &root).await.unwrap_err();
    assert!(err.contains("API key"), "err: {err}");
    let canonical = canonical_root(&root).unwrap();
    let count = {
        let db = app.state::<crate::DbState>();
        let conn = db.0.lock();
        let project = db::wiki_get_project_by_path(&conn, &canonical).unwrap().unwrap();
        db::wiki_page_count(&conn, &project.id).unwrap()
    };
    assert_eq!(count, 2, "the failed build must not have cleared pages");
}

#[tokio::test]
async fn concurrent_jobs_are_refused_and_cancel_does_not_free_the_slot() {
    let (_tmp, root) = sample_repo();
    let app = mock_wiki_app();
    let canonical = canonical_root(&root).unwrap();
    let registry = Arc::clone(app.state::<Arc<WikiJobRegistry>>().inner());
    // Simulate an in-flight job occupying the slot.
    let flag = Arc::new(std::sync::atomic::AtomicBool::new(false));
    registry.active.lock().insert(
        canonical.clone(),
        WikiJobSlot {
            cancel: Arc::clone(&flag),
        },
    );
    let err = run_build_with(&app, &root, scripted_build(&[SCRIPTED_OUTLINE])).await.unwrap_err();
    assert!(err.contains("already running"), "err: {err}");

    // Cancelling signals the running job but must NOT release the slot: the
    // job only polls the flag between model calls, so it keeps running until
    // its current (up to 10-minute) call returns. Releasing here used to let
    // a second build start and interleave its page writes with the dying
    // build's, mixing pages from two generations with no error anywhere.
    let fired = {
        let active = registry.active.lock();
        let slot = active.get(&canonical).expect("slot must survive cancel");
        slot.cancel.store(true, std::sync::atomic::Ordering::SeqCst);
        true
    };
    assert!(fired);
    let still_occupied = registry.active.lock().contains_key(&canonical);
    assert!(
        still_occupied,
        "cancel must not free the slot while the job is still winding down"
    );
    // The signal actually reached the job.
    assert!(cancelled(&flag));

    // Only the job's own guard frees it — a rebuild proceeds after that.
    registry.active.lock().remove(&canonical);
    let out = run_build_with(
        &app,
        &root,
        scripted_build(&[
            SCRIPTED_OUTLINE_SINGLE,
            &scripted_page("Overview", "mesh."),
        ]),
    )
    .await
    .unwrap();
    assert_eq!(out.pages, 1);
}

#[test]
fn cancel_flag_is_level_triggered_and_idempotent() {
    // The build/update loops poll `cancelled(flag)` between pages. The flag is
    // LEVEL-triggered, not a consuming one-shot: polling must not clear it
    // (a build checks between every page), and firing twice is harmless.
    let flag = std::sync::atomic::AtomicBool::new(false);
    assert!(!cancelled(&flag), "a fresh job is not cancelled");
    flag.store(true, std::sync::atomic::Ordering::SeqCst);
    assert!(cancelled(&flag), "first poll after firing sees the cancel");
    assert!(cancelled(&flag), "polling must not consume the signal");
    flag.store(true, std::sync::atomic::Ordering::SeqCst);
    assert!(cancelled(&flag), "a second cancel is idempotent, not an error");
}

#[tokio::test]
async fn job_guard_frees_the_slot_even_when_the_job_returns_early() {
    // The guard must release on every exit path (error, `?`, panic) — a stuck
    // slot would wedge the project until an app restart.
    let registry = Arc::new(WikiJobRegistry::default());
    {
        let (_guard, _flag) = try_acquire(&registry, "/repo/x").unwrap();
        assert!(registry.active.lock().contains_key("/repo/x"));
        assert!(
            try_acquire(&registry, "/repo/x").is_err(),
            "the slot is held for the guard's lifetime"
        );
    }
    assert!(
        !registry.active.lock().contains_key("/repo/x"),
        "dropping the guard frees the slot"
    );
    // A DIFFERENT project is never blocked by it.
    let (_g, _f) = try_acquire(&registry, "/repo/y").unwrap();
}

fn single_wiki_json() -> String {
    // Built with serde (not string gymnastics) — the ledger marker inside
    // each body is what the page parser splits on.
    let page = |slug: &str, title: &str, kind: &str, path: &str| {
        serde_json::json!({
            "slug": slug,
            "title": title,
            "kind": kind,
            "summary": "one sentence",
            "body": format!(
                "# {title}

The mesh module defines Mailbox.

<!-- relay:claims -->
```relay-claims
{{\"claims\":[{{\"claim\":\"The mesh module defines Mailbox.\",\"path\":\"{path}\",\"lines\":[1,2]}}]}}
```"
            ),
            "claims": [{ "claim": "The mesh module defines Mailbox.", "path": path, "lines": [1, 2] }],
        })
    };
    serde_json::json!({
        "pages": [
            page("overview", "Overview", "overview", "README.md"),
            page("mesh", "Mesh", "module", "src/mesh.rs"),
        ]
    })
    .to_string()
}

fn direct_scripted(responses: &[String]) -> Caller {
    // NO stub prepended: the first response goes to the single-call pass.
    Caller::Scripted(std::sync::Mutex::new(
        responses.iter().cloned().collect::<VecDeque<_>>(),
    ))
}

#[tokio::test]
async fn single_call_build_writes_every_page_in_one_pass() {
    let (_tmp, root) = sample_repo();
    let app = mock_wiki_app();
    let out = run_build_with(&app, &root, direct_scripted(&[single_wiki_json()]))
        .await
        .unwrap();
    assert_eq!(out.pages, 2, "both pages stored from the ONE call");
    let canonical = canonical_root(&root).unwrap();
    let (count, head) = {
        let db = app.state::<crate::DbState>();
        let conn = db.0.lock();
        let project = db::wiki_get_project_by_path(&conn, &canonical)
            .unwrap()
            .unwrap();
        (
            db::wiki_page_count(&conn, &project.id).unwrap(),
            project.head_sha,
        )
    };
    assert_eq!(count, 2);
    assert_eq!(head.as_deref(), Some(git_head(&root).unwrap().as_str()));
    // Claims were validated against the real repo (blob SHAs resolved).
    let full = {
        let db = app.state::<crate::DbState>();
        let conn = db.0.lock();
        db::wiki_get_page_full(&conn, &project_id_of(&conn, &canonical), "mesh")
            .unwrap()
            .unwrap()
    };
    assert!(full.claims.iter().all(|c| c.blob_sha.is_some()));
    assert_eq!(
        full.page.title, "Mesh",
        "single-call pages keep their titles"
    );
}

fn project_id_of(conn: &rusqlite::Connection, canonical: &str) -> String {
    crate::db::wiki_get_project_by_path(conn, canonical)
        .unwrap()
        .unwrap()
        .id
}

#[tokio::test]
async fn single_call_page_update_rederives_from_claim_files() {
    // A single-call page stores its CLAIM PATHS as the brief's file set, so
    // the freshness pass can still re-derive it after a commit.
    let (_tmp, root) = sample_repo();
    let app = mock_wiki_app();
    run_build_with(&app, &root, direct_scripted(&[single_wiki_json()]))
        .await
        .unwrap();
    write_repo_file(&root, "src/mesh.rs", "//! v2 routing
");
    commit_all(&root, "mesh v2");
    let report = run_update_with(
        &app,
        &root,
        scripted(&[&scripted_page("Mesh", "The mesh module now routes.")]),
    )
    .await
    .unwrap();
    assert_eq!(report.status, "updated", "report: {report:?}");
    assert_eq!(report.pages_refreshed, 1, "only the mesh page cites mesh.rs");
}

// ── live tests (#[ignore]; real endpoints/machine state) ─────────────────

/// Live: analyze THIS repository (deterministic pipeline, no model).
/// Run: `cargo test --lib wiki::tests::live_analyze_this_workspace -- --ignored --nocapture`
#[test]
#[ignore]
fn live_analyze_this_workspace() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf();
    let analysis = analyze_repo(&root);
    println!(
        "analysis: {} files, {} loc, top langs: {:?}",
        analysis.total_files,
        analysis.total_loc,
        analysis
            .languages
            .iter()
            .map(|l| (l.ext.as_str(), l.loc))
            .collect::<Vec<_>>()
    );
    assert!(analysis.total_files > 300, "a real workspace walk finds the tree");
    assert!(analysis.total_loc > 10_000);
    assert!(analysis.is_git_repo);
    assert!(!analysis.recent_activity.is_empty());
    assert!(
        analysis.key_files.iter().any(|f| f == "package.json"),
        "key files found: {:?}",
        analysis.key_files
    );
    assert!(!analysis.languages.is_empty());
    // This workspace holds >100k files (multi-project junk included); the
    // cap MUST engage and say so rather than pretending to be complete.
    if analysis.truncated {
        assert_eq!(analysis.total_files, MAX_ANALYSIS_FILES);
        println!("(walk hit the {:?}-file cap — truncated, as designed)", MAX_ANALYSIS_FILES);
    }
}

/// Live: the freshness pipeline against THIS repo's real git — stamp the
/// current HEAD and confirm the update pass no-ops (diff + join run for
/// real; the scripted queue proves zero model calls).
#[tokio::test]
#[ignore]
async fn live_update_pass_up_to_date_on_this_repo() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf();
    let app = mock_wiki_app();
    let canonical = canonical_root(&root).unwrap();
    let head = git_head(&root).expect("this workspace is a git repo");
    {
        let db = app.state::<crate::DbState>();
        let conn = db.0.lock();
        let project = db::wiki_ensure_project(&conn, &canonical).unwrap();
        db::wiki_stamp_build(&conn, &project.id, Some(&head), Some("live-test")).unwrap();
    }
    let report = run_update_with(&app, &root, scripted(&[])).await.unwrap();
    println!("live update report: {report:?}");
    assert_eq!(report.status, "up_to_date");
}

/// Live: a FULL build with the machine's real configured provider (keychain
/// lookup via the summarizer chain, or explicit wiki.build_* settings),
/// against a small real git repo — then a real update pass after a commit.
/// Costs real tokens; run explicitly:
/// `cargo test --lib wiki::tests::live_real_model_build -- --ignored --nocapture`
#[tokio::test]
#[ignore]
async fn live_real_model_build() {
    let app = mock_wiki_app();
    // Model resolution for the LIVE run, in order:
    // 1. $RELAY_WIKI_LIVE_MODEL ("provider:model") — explicit override;
    // 2. the REAL app DB's configured chat.openrouter.model (the summarizer
    //    chain otherwise falls to a provider DEFAULT model, and on this
    //    machine that default was geo-blocked — a real finding of this test);
    // 3. the plain summarizer chain.
    {
        let db = app.state::<crate::DbState>();
        let conn = db.0.lock();
        let mut configured: Option<(String, String)> = None;
        if let Ok(spec) = std::env::var("RELAY_WIKI_LIVE_MODEL") {
            if let Some((provider, model)) = spec.split_once(':') {
                configured = Some((provider.to_string(), model.to_string()));
            }
        }
        if configured.is_none() {
            if let Some(appdata) = std::env::var_os("APPDATA") {
                let real_db = std::path::PathBuf::from(appdata)
                    .join("dev.relay.app")
                    .join("relay.db");
                if let Ok(real) = rusqlite::Connection::open_with_flags(
                    &real_db,
                    rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
                ) {
                    if let Ok(Some(model)) =
                        crate::db::get_setting(&real, "chat.openrouter.model")
                    {
                        configured = Some(("openrouter".to_string(), model));
                    }
                }
            }
        }
        if let Some((provider, model)) = configured {
            crate::db::set_setting(&conn, SETTING_BUILD_PROVIDER, &provider).unwrap();
            crate::db::set_setting(&conn, SETTING_BUILD_MODEL, &model).unwrap();
        }
        match resolve_build_model(&conn) {
            Ok(_) => {}
            Err(e) => {
                println!("SKIP: no live build model available ({e})");
                return;
            }
        }
    }
    let caller = {
        let db = app.state::<crate::DbState>();
        let conn = db.0.lock();
        resolve_build_model(&conn).expect("resolved above")
    };
    println!("live build model: {}", caller.label());
    let (_tmp, root) = sample_repo();
    write_repo_file(
        &root,
        "src/mesh.rs",
        "//! Mesh module: peer-to-peer session messaging with mailboxes,\n\
//! depth-limited spawning and hard rate caps.\npub struct Mailbox;\npub struct Router;\n",
    );
    commit_all(&root, "grow mesh module");

    let out = run_build_with(&app, &root, caller).await.expect("live build");
    println!("live build: {} pages via {}", out.pages, out.model);
    assert!(out.pages >= 1);

    let canonical = canonical_root(&root).unwrap();
    let (project, any_claims) = {
        let db = app.state::<crate::DbState>();
        let conn = db.0.lock();
        let project = db::wiki_get_project_by_path(&conn, &canonical)
            .unwrap()
            .expect("wiki row");
        let pages = db::wiki_list_pages(&conn, &project.id).unwrap();
        let claims = db::wiki_evidence_paths(&conn, &project.id).unwrap();
        (project, (pages, claims))
    };
    let (pages, claims) = any_claims;
    println!("pages: {:?}", pages.iter().map(|p| p.slug.clone()).collect::<Vec<_>>());
    assert!(!pages.is_empty());
    assert!(!claims.is_empty(), "a real build should ground claims in real files");
    // Every stored claim path must exist in the repo (validation held).
    for (_, path) in &claims {
        assert!(root.join(path).is_file(), "claim path {path} must exist");
    }
    assert_eq!(project.head_sha.as_deref(), Some(git_head(&root).unwrap().as_str()));

    // Update: touch a cited file, commit, update for real.
    let cited = claims[0].1.clone();
    write_repo_file(&root, &cited, "// live-test edit: content changed\n");
    commit_all(&root, "live update probe");
    let report = run_update(&app, &root).await.unwrap();
    println!("live update report: {report:?}");
    assert!(
        report.status == "updated" || report.status == "up_to_date",
        "live update landed in an unexpected state: {report:?}"
    );
}

#[test]
fn clearing_pages_resets_the_build_stamp_so_a_rebuild_can_recover() {
    // Clearing the pages while leaving head_sha intact produced a wiki that
    // no update pass could repair: zero pages, but the freshness tick saw
    // "HEAD unchanged" and `run_update` returned up_to_date. A failed REBUILD
    // (unlike a first build) was wedged until the user clicked Build again.
    let conn = crate::db::mem();
    let project = crate::db::wiki_ensure_project(&conn, "/repo").unwrap();
    crate::db::wiki_stamp_build(&conn, &project.id, Some("abc123"), Some("m")).unwrap();
    let stamped = crate::db::wiki_get_project_by_path(&conn, "/repo").unwrap().unwrap();
    assert!(stamped.head_sha.is_some());

    crate::db::wiki_clear_pages(&conn, &project.id).unwrap();
    crate::db::wiki_clear_build_stamp(&conn, &project.id).unwrap();

    let after = crate::db::wiki_get_project_by_path(&conn, "/repo").unwrap().unwrap();
    assert_eq!(
        after.head_sha, None,
        "a cleared wiki must present as 'never built' so the next tick rebuilds"
    );
    assert_eq!(after.schema_version, 0);
    assert_eq!(after.built_at, None);
    assert_eq!(crate::db::wiki_page_count(&conn, &project.id).unwrap(), 0);
}

#[test]
fn wiki_claims_and_pages_are_cleared_atomically() {
    // `wiki_claims.page_id` has no foreign key, so a partial clear strands
    // rows that nothing ever collects.
    let conn = crate::db::mem();
    let project = crate::db::wiki_ensure_project(&conn, "/repo").unwrap();
    for slug in ["a", "b"] {
        crate::db::wiki_replace_page(
            &conn,
            &project.id,
            slug,
            slug,
            "module",
            "",
            "body",
            "brief",
            &[],
            "fresh",
            None,
            &[db::WikiClaim {
                claim: "c".into(),
                evidence_path: "src/a.rs".into(),
                line_start: None,
                line_end: None,
                blob_sha: None,
            }],
        )
        .unwrap();
    }
    crate::db::wiki_remove_wiki(&conn, &project.id).unwrap();
    let claims: i64 = conn
        .query_row("SELECT COUNT(*) FROM wiki_claims", [], |r| r.get(0))
        .unwrap();
    let pages: i64 = conn
        .query_row("SELECT COUNT(*) FROM wiki_pages", [], |r| r.get(0))
        .unwrap();
    assert_eq!((claims, pages), (0, 0));
}

#[test]
fn removing_a_project_cascades_to_its_wikis() {
    // wiki_projects keys on the FOLDER PATH, not projects.id, so it has no FK
    // to cascade from. Without this the freshness sweep kept running
    // `git rev-parse` against a deleted project.
    let conn = crate::db::mem();
    let dir = TempDir::new().unwrap();
    let root = dir.path().to_string_lossy().to_string();
    let nested = format!("{root}/packages/app");
    let p1 = crate::db::wiki_ensure_project(&conn, &root).unwrap();
    let p2 = crate::db::wiki_ensure_project(&conn, &nested).unwrap();
    for p in [&p1, &p2] {
        crate::db::wiki_replace_page(
            &conn,
            &p.id,
            "overview",
            "Overview",
            "overview",
            "",
            "b",
            "br",
            &[],
            "fresh",
            None,
            &[db::WikiClaim {
                claim: "c".into(),
                evidence_path: "src/a.rs".into(),
                line_start: None,
                line_end: None,
                blob_sha: None,
            }],
        )
        .unwrap();
    }
    let n = crate::db::wiki_remove_wiki_by_path_prefix(&conn, &root).unwrap();
    assert_eq!(n, 2, "the project wiki AND any wiki rooted below it go");
    assert!(crate::db::wiki_list_projects(&conn).unwrap().is_empty());
    let claims: i64 = conn
        .query_row("SELECT COUNT(*) FROM wiki_claims", [], |r| r.get(0))
        .unwrap();
    assert_eq!(claims, 0, "no stranded claims");
}

#[test]
fn empty_index_with_content_is_repaired_on_boot() {
    // The crash window the old three-batch migration left open: the FTS table
    // exists with the CURRENT DDL but its index was never populated, so the
    // DDL guard saw "already migrated" and never rebuilt — every pre-existing
    // page permanently unfindable. Verified against SQLite: `count(*)` on an
    // external-content FTS table reads the CONTENT table (and reports healthy
    // here), and FTS5's own `integrity-check` also passes; only the vocab
    // view reflects the real index.
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    crate::db::init_schema(&conn).unwrap();
    conn.execute(
        "INSERT INTO wiki_pages (id, project_id, slug, title, kind, summary, body, status, generated_at)
         VALUES ('u1', 'p1', 'mesh', 'Mesh', 'module', 's', 'the mesh routes', 'fresh', 0)",
        [],
    )
    .unwrap();
    assert_eq!(
        crate::db::wiki_search_pages(&conn, "p1", "mesh", 5).unwrap().len(),
        1
    );

    // Wipe ONLY the index, leaving the table and the DDL intact.
    conn.execute_batch("INSERT INTO wiki_pages_fts(wiki_pages_fts) VALUES('delete-all');")
        .unwrap();
    assert_eq!(
        crate::db::wiki_search_pages(&conn, "p1", "mesh", 5).unwrap().len(),
        0,
        "precondition: the index really is empty"
    );

    crate::db::init_schema(&conn).unwrap();
    assert_eq!(
        crate::db::wiki_search_pages(&conn, "p1", "mesh", 5).unwrap().len(),
        1,
        "a re-boot must detect the empty index and repair it"
    );
}

#[test]
fn empty_index_repair_leaves_no_residue() {
    // The drift probe creates a vocab table; it must not leave schema behind.
    let conn = crate::db::mem();
    let n: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE name LIKE '%drift%'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n, 0, "no probe vocab table may persist");
}
