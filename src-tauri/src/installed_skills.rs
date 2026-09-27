//! Installed skill/loop discovery across harness skill directories.
//!
//! Claude Code keeps user skills in `~/.claude/skills/<slug>/SKILL.md`; Kimi
//! Code's user skill dir is `~/.agents/skills/` (this machine, kimi 0.27.0 —
//! `~/.kimi-code/skills` does not exist). "Loops" follow the same directory
//! convention under `loops/` — none exist yet on any harness, so the loops
//! scan returns empty until a harness or the user creates one (see
//! BUILD_LOG.md; if a future harness version introduces a different loop
//! format, this scanner needs updating).
//!
//! Creating a skill/loop writes to BOTH primary roots so either harness can
//! discover it by its slash-command name — that is the whole point of the
//! feature.

use once_cell::sync::Lazy;
use serde::Serialize;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InstalledSkill {
    pub slug: String,
    pub name: String,
    pub description: String,
    /// "claude" | "kimi" | "both" | "project"
    pub source: String,
    pub claude_path: Option<String>,
    pub kimi_path: Option<String>,
    /// A repo-local copy (`<project>/.claude|agents/<kind>/<slug>`), tracked
    /// SEPARATELY from the user-level slots. It used to share `claude_path`
    /// with the user copy, so a single row could hold a project path AND a
    /// user path at once — and save/delete, which write every populated slot,
    /// then overwrote the user's GLOBAL skill with an edit made against the
    /// repo copy, and `remove_dir_all`'d the repo directory along with the
    /// agent-authored `scripts/` beside the doc. A skill the agent wrote into
    /// a repo must never be able to reach into `~/.claude` or `~/.agents`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_path: Option<String>,
    /// "skill" | "loop"
    pub kind: String,
}

/// A skill surfaced to the chat `/` menu — either an on-disk harness skill or
/// a built-in (embedded via `include_str!`). On a slug collision the on-disk
/// copy wins so a user can override a built-in by creating
/// `~/.claude/skills/<slug>/SKILL.md`.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AvailableSkill {
    pub slug: String,
    pub name: String,
    pub description: String,
    /// "installed" (on-disk) | "builtin"
    pub origin: String,
}

/// In-memory snapshot used by the backend injection path (no filesystem reads
/// per turn). Body is frontmatter-stripped.
#[derive(Debug, Clone)]
pub struct SkillSnapshot {
    pub slug: String,
    pub name: String,
    pub body: String,
}

/// Built-in skill embedded at compile time. Slugs match the old
/// `assistant.skills` `command` fields so existing `/docx`, `/pptx`, `/pdf`,
/// `/diagram`, `/goal`, `/loop` invocations keep working. (`/loop` is an alias
/// of `/goal` that shares the same `goal-loop-skill.md` body.)
#[derive(Debug, Clone)]
struct BuiltinSkill {
    slug: &'static str,
    name: &'static str,
    body: &'static str,
}

/// Root dirs per harness for a given kind ("skills" | "loops").
///
/// Claude Code's skill layout has shifted across versions. Relay scans
/// every convention we know about so the Skills Library shows what's actually
/// on disk regardless of which one the user (or a marketplace) wrote into:
///
///   - `~/.claude/skills/<slug>/SKILL.md` — the original Claude Code convention.
///   - `~/.claude/plugins/marketplaces/<marketplace>/skills/<slug>/SKILL.md` —
///     the layout Claude Code 1.0+ uses for installed plugins. The user has
///     an `anthropic-agent-skills` marketplace here with 16 skills; without
///     this scan root the Skills Library shows nothing on this machine.
///   - `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/skills/<slug>/SKILL.md`
///     — the cache dir Claude Code stages plugin content into; some
///     workflows only land skills here without a `marketplaces/` mirror.
///   - `~/.agents/skills/` — Kimi Code's user skill dir (kimi 0.27.0+).
///   - `~/.kimi-code/skills/` — defensive: a kimi version that adopts a
///     self-named dir.
fn roots(kind: &str) -> Vec<(&'static str, PathBuf)> {
    let Some(home) = crate::util::home_dir() else { return vec![] };
    let mut v = vec![
        ("claude", home.join(".claude").join(kind)),
        ("agents", home.join(".agents").join(kind)),
        ("kimi", home.join(".kimi-code").join(kind)),
    ];
    // Claude Code plugin marketplaces — `~/.claude/plugins/` has two
    // skill-bearing siblings we walk:
    //   marketplaces/<name>/skills/<slug>/SKILL.md
    //   cache/<marketplace>/<plugin>/<version>/skills/<slug>/SKILL.md
    // The earlier (buggy) attempt built plugins/<entry>/{marketplaces,cache}/<kind>
    // for every entry under plugins/, which neither pattern matches. Walk
    // the two top-level dirs explicitly.
    let plugins_dir = home.join(".claude").join("plugins");
    if let Ok(entries) = fs::read_dir(&plugins_dir) {
        for entry in entries.flatten() {
            let child = entry.path();
            if !child.is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            match name.as_str() {
                "marketplaces" => {
                    // Each subdir under marketplaces/ is one marketplace.
                    if let Ok(mps) = fs::read_dir(&child) {
                        for mp in mps.flatten() {
                            let mp_dir = mp.path();
                            if !mp_dir.is_dir() {
                                continue;
                            }
                            v.push(("claude", mp_dir.join(kind)));
                        }
                    }
                }
                "cache" => {
                    // DELIBERATELY not scanned. `cache/<marketplace>/<plugin>/
                    // <version>/<kind>/<slug>/` is the staging copy Claude Code
                    // writes while installing a plugin, and the SAME skills are
                    // already read from `marketplaces/<name>/<kind>/` above —
                    // so walking it surfaced nothing new, while the injection
                    // cache (which appends every skill body to every turn)
                    // charged the user ~7.4k extra prompt chars per request
                    // for the duplicates. A single `read_dir` can't reach
                    // three levels down anyway, which is why the old code
                    // pushed a `cache/skills` path that never existed.
                }
                _ => {}
            }
        }
    }
    v
}

/// Scan roots contributed by the OPEN PROJECTS: `<project>/.claude/<kind>` and
/// `<project>/.agents/<kind>`.
///
/// Relay launches each CLI with the project's directory as its cwd, so an
/// agent told to "create a skill" writes it THERE — and a home-only scan never
/// sees those skills, not even after a restart. Entries found only here are
/// reported with `source: "project"`.
fn project_roots(kind: &str, projects: &[PathBuf]) -> Vec<(&'static str, PathBuf)> {
    let mut v = vec![];
    for p in projects {
        v.push(("project", p.join(".claude").join(kind)));
        v.push(("project", p.join(".agents").join(kind)));
    }
    v
}

/// The markdown file inside a skill dir: SKILL.md, LOOP.md, or the first .md.
fn doc_file(dir: &PathBuf) -> Option<PathBuf> {
    for name in ["SKILL.md", "LOOP.md"] {
        let f = dir.join(name);
        if f.is_file() {
            return Some(f);
        }
    }
    let mut mds: Vec<PathBuf> = fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("md"))
        .collect();
    mds.sort();
    mds.into_iter().next()
}

/// Pull `name:` / `description:` out of the YAML frontmatter block and return
/// the frontmatter-stripped body. Simple line parsing — no yaml dependency
/// for two keys. If there is no leading `---` block, returns the whole
/// content as the body with `None` name/desc.
fn strip_frontmatter(content: &str) -> (String, Option<String>, Option<String>) {
    let mut name = None;
    let mut desc = None;
    let mut in_fm = false;
    let mut body_start = 0usize;
    for (i, line) in content.lines().enumerate() {
        let t = line.trim();
        if i == 0 && t == "---" {
            in_fm = true;
            continue;
        }
        if in_fm {
            if t == "---" {
                // Body starts after this line's terminating newline. Compute
                // it from the ACTUAL newline positions: `lines()` strips
                // `\r\n`, so the old `len + 1`-per-line budget undercounted
                // CRLF files by one byte per line — the offset landed inside
                // the `---\r\n` delimiter (frontmatter leaked into skill
                // bodies) and, with enough frontmatter lines, backed into
                // multibyte values and panicked on every chat send. The i-th
                // `\n` is exactly the one terminating line i.
                body_start = content
                    .match_indices('\n')
                    .nth(i)
                    .map(|(pos, _)| pos + 1)
                    .unwrap_or(content.len());
                break;
            }
            let unquote = |v: &str| v.trim().trim_matches('"').trim_matches('\'').to_string();
            if let Some(v) = t.strip_prefix("name:") {
                name = Some(unquote(v));
            } else if let Some(v) = t.strip_prefix("description:") {
                desc = Some(unquote(v));
            }
        } else {
            // No frontmatter; whole content is the body.
            return (content.to_string(), None, None);
        }
    }
    let body = if in_fm {
        content[body_start..].trim().to_string()
    } else {
        // Had `---` on line 0 but no closing `---` — treat whole content as body.
        content.trim().to_string()
    };
    (body, name, desc)
}

/// Back-compat thin wrapper for callers that only want name/description.
fn parse_frontmatter(content: &str) -> (Option<String>, Option<String>) {
    let (_, name, desc) = strip_frontmatter(content);
    (name, desc)
}

fn scan(kind: &str) -> Vec<InstalledSkill> {
    scan_with_projects(kind, &[])
}

/// `scan` plus the open projects' own skill dirs. A skill that exists ONLY in a
/// project gets `source: "project"`; one that also exists in a user-level
/// harness dir keeps that source, and a user-level copy is the one the editor
/// writes back to.
fn scan_with_projects(kind: &str, projects: &[PathBuf]) -> Vec<InstalledSkill> {
    let mut by_slug: std::collections::BTreeMap<String, InstalledSkill> = Default::default();
    let all_roots = roots(kind)
        .into_iter()
        .chain(project_roots(kind, projects));
    for (harness, root) in all_roots {
        let Ok(entries) = fs::read_dir(&root) else { continue };
        for entry in entries.flatten() {
            let dir = entry.path();
            if !dir.is_dir() {
                continue;
            }
            let Some(doc) = doc_file(&dir) else { continue };
            let slug = entry.file_name().to_string_lossy().into_owned();
            let (name, desc) = fs::read_to_string(&doc)
                .map(|c| parse_frontmatter(&c))
                .unwrap_or((None, None));
            let path_str = doc.to_string_lossy().into_owned();
            let e = by_slug.entry(slug.clone()).or_insert_with(|| InstalledSkill {
                slug: slug.clone(),
                name: name.clone().unwrap_or_else(|| slug.clone()),
                description: desc.clone().unwrap_or_default(),
                source: String::new(),
                claude_path: None,
                kimi_path: None,
                project_path: None,
                kind: kind.trim_end_matches('s').to_string(),
            });
            match harness {
                // `get_or_insert`, not `= Some(..)`: `name`/`description` come
                // from the FIRST root scanned (the user's own `~/.claude`),
                // so a plain overwrite here let a MARKETPLACE copy of the same
                // slug take over the path — the row then showed the user's name
                // and description while opening/saving edited a plugin's file,
                // which the next plugin reinstall silently reverts. First root
                // wins for every slot, so the row and its paths agree.
                "claude" => {
                    e.claude_path.get_or_insert(path_str);
                }
                // Repo-local copies get their own slot (see `project_path`),
                // not the claude slot: sharing it is what let a project skill
                // overwrite the user's global one on save.
                "project" => {
                    e.project_path.get_or_insert(path_str);
                }
                // Keep the first kimi path found (.agents preferred by order).
                _ => {
                    e.kimi_path.get_or_insert(path_str);
                }
            }
        }
    }
    for e in by_slug.values_mut() {
        // A row with no user-level home at all is repo-local, and is labelled
        // as such. When a user-level copy ALSO exists, the row is that user's
        // skill (the library edits the user copy; see `writable_paths`) and
        // the project copy is left alone.
        e.source = match (&e.claude_path, &e.kimi_path) {
            (Some(_), Some(_)) => "both",
            (Some(_), None) => "claude",
            (None, Some(_)) => "kimi",
            (None, None) => "project",
        }
        .to_string();
    }
    by_slug.into_values().collect()
}

pub fn list_installed(kind: &str) -> Vec<InstalledSkill> {
    scan(kind)
}

/// `list_installed` including the open projects' own skill dirs — the surface
/// the Skills Library shows, so a skill an agent wrote inside a repo appears.
pub fn list_installed_with_projects(kind: &str, projects: &[PathBuf]) -> Vec<InstalledSkill> {
    scan_with_projects(kind, projects)
}

/// Content of a skill doc: prefer the Claude copy, else the Kimi one.
pub fn read_installed(slug: &str, kind: &str) -> Option<String> {
    read_installed_with(slug, kind, &[])
}

/// `read_installed` that can also resolve a project-scoped skill (the library
/// lists those, so opening one for edit must find its file).
pub fn read_installed_with(slug: &str, kind: &str, projects: &[PathBuf]) -> Option<String> {
    let s = scan_with_projects(kind, projects)
        .into_iter()
        .find(|s| s.slug == slug)?;
    fs::read_to_string(primary_path(&s)?).ok()
}

/// The file the library opens for this entry: the user's own copy when there
/// is one, else the repo-local copy. A row is a user-level skill as soon as
/// the user has a copy — the library shows that skill's name and description,
/// so it must read and write the same file the row was built from.
fn primary_path(s: &InstalledSkill) -> Option<&str> {
    s.claude_path
        .as_deref()
        .or(s.kimi_path.as_deref())
        .or(s.project_path.as_deref())
}

/// The files a save may write, and a delete may remove. Deliberately NOT
/// "every populated slot": when a project copy and a user copy share a slug,
/// only the USER copies are touched. The library row is the user's skill (its
/// name/description come from the user file), so saving must not push repo
/// content into `~/.claude`/`~/.agents` — that silently rewrote the global
/// skill for every other project — and deleting must not reach into a repo
/// directory. A project-only skill (no user copy) still round-trips through
/// its own path.
fn writable_paths(s: &InstalledSkill) -> Vec<&str> {
    let user: Vec<&str> = s.claude_path.iter().chain(s.kimi_path.iter()).map(String::as_str).collect();
    if user.is_empty() {
        s.project_path.iter().map(String::as_str).collect()
    } else {
        user
    }
}

/// The built-in skills, embedded at compile time. Bodies are the raw
/// markdown (frontmatter stripped at read time by `strip_frontmatter`).
/// Six today: docx / pptx / pdf / diagram (document generation skills) plus
/// goal and loop (the autonomous goal-driven loop; `/loop` is an alias of
/// `/goal` and shares the same `goal-loop-skill.md` body).
fn builtins() -> Vec<BuiltinSkill> {
    vec![
        BuiltinSkill {
            slug: "docx",
            name: "Word documents (.docx)",
            body: include_str!("../../skills/docx-skill.md"),
        },
        BuiltinSkill {
            slug: "pptx",
            name: "Slide decks (.pptx)",
            body: include_str!("../../skills/pptx-skill.md"),
        },
        BuiltinSkill {
            slug: "pdf",
            name: "PDF documents",
            body: include_str!("../../skills/pdf-skill.md"),
        },
        BuiltinSkill {
            slug: "diagram",
            name: "Diagrams (vector SVG)",
            body: include_str!("../../skills/diagram-html-svg-skill.md"),
        },
        BuiltinSkill {
            slug: "goal",
            name: "Run a goal-driven loop",
            body: include_str!("../../skills/goal-loop-skill.md"),
        },
        BuiltinSkill {
            slug: "loop",
            name: "Run an autonomous work loop (alias for /goal)",
            body: include_str!("../../skills/goal-loop-skill.md"),
        },
    ]
}

/// Every skill the chat `/` menu can offer: on-disk harness skills merged with
/// the built-ins. On a slug collision the on-disk copy wins, so a user can
/// override a built-in by creating `~/.claude/skills/<slug>/SKILL.md`.
pub fn list_all_skills() -> Vec<AvailableSkill> {
    let mut out: Vec<AvailableSkill> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    // On-disk first so they shadow built-ins on slug collision.
    for s in scan("skills") {
        seen.insert(s.slug.clone());
        out.push(AvailableSkill {
            slug: s.slug,
            name: s.name,
            description: s.description,
            origin: "installed".into(),
        });
    }
    for b in builtins() {
        if seen.contains(b.slug) {
            continue;
        }
        let (_, name, desc) = strip_frontmatter(b.body);
        out.push(AvailableSkill {
            slug: b.slug.into(),
            name: name.unwrap_or_else(|| b.name.into()),
            description: desc.unwrap_or_else(|| b.name.into()),
            origin: "builtin".into(),
        });
    }
    out
}

/// Frontmatter-stripped body of a skill by slug: on-disk first, then built-in.
/// Used by the backend injection path.
#[allow(dead_code)]
pub fn read_skill_body(slug: &str) -> Option<String> {
    if let Some(raw) = read_installed(slug, "skills") {
        let (body, _, _) = strip_frontmatter(&raw);
        return Some(body);
    }
    builtins()
        .into_iter()
        .find(|b| b.slug == slug)
        .map(|b| strip_frontmatter(b.body).0)
}

/// Per-process cache of skill snapshots for the injection hot path. Refreshes
/// after `SKILL_CACHE_TTL` so edits made in Skills Library are picked up
/// promptly; `invalidate_skill_cache()` clears it immediately on write ops.
const SKILL_CACHE_TTL: Duration = Duration::from_secs(5);
static SKILL_CACHE: Lazy<Mutex<Option<(Instant, Vec<SkillSnapshot>)>>> =
    Lazy::new(|| Mutex::new(None));

/// Clear the cached skill snapshots. Called after any create/save/delete so
/// the next chat send and `/` menu query see fresh disk state.
pub fn invalidate_skill_cache() {
    if let Ok(mut g) = SKILL_CACHE.lock() {
        *g = None;
    }
}

/// Cached, frontmatter-stripped skill snapshots (slug/name/body) for the
/// backend injection path. Re-scans the filesystem only if the cache is empty
/// or older than `SKILL_CACHE_TTL`.
pub fn cached_skills() -> Vec<SkillSnapshot> {
    if let Ok(mut g) = SKILL_CACHE.lock() {
        if let Some((at, snap)) = g.as_ref() {
            if at.elapsed() < SKILL_CACHE_TTL {
                return snap.clone();
            }
        }
        let mut snaps: Vec<SkillSnapshot> = scan("skills")
            .into_iter()
            .filter_map(|s| {
                // Read straight from the path the scan already resolved, rather
                // than re-scanning per skill (avoids an N+1 of `read_installed`).
                let path = s.claude_path.as_ref().or(s.kimi_path.as_ref())?;
                let raw = fs::read_to_string(path).ok()?;
                let (body, name, _) = strip_frontmatter(&raw);
                Some(SkillSnapshot {
                    slug: s.slug,
                    name: name.unwrap_or_else(|| s.name),
                    body,
                })
            })
            .collect();
        // Built-ins only when not shadowed by an on-disk skill of the same slug.
        let on_disk_slugs: std::collections::HashSet<String> =
            snaps.iter().map(|s| s.slug.clone()).collect();
        for b in builtins() {
            if on_disk_slugs.contains(b.slug) {
                continue;
            }
            let (body, name, _) = strip_frontmatter(b.body);
            snaps.push(SkillSnapshot {
                slug: b.slug.into(),
                name: name.unwrap_or_else(|| b.name.into()),
                body,
            });
        }
        *g = Some((Instant::now(), snaps.clone()));
        return snaps;
    }
    Vec::new()
}

/// Write content back to every copy that exists (keeps mirrored skills in sync).
pub fn save_installed(slug: &str, kind: &str, content: &str) -> Result<(), String> {
    save_installed_with(slug, kind, content, &[])
}

/// `save_installed` that can also write a project-scoped skill in place.
pub fn save_installed_with(
    slug: &str,
    kind: &str,
    content: &str,
    projects: &[PathBuf],
) -> Result<(), String> {
    let s = scan_with_projects(kind, projects)
        .into_iter()
        .find(|s| s.slug == slug)
        .ok_or_else(|| format!("no installed {kind} named {slug}"))?;
    let mut wrote = false;
    for path in writable_paths(&s) {
        fs::write(path, content).map_err(|e| format!("write {path}: {e}"))?;
        wrote = true;
    }
    if wrote {
        invalidate_skill_cache();
        Ok(())
    } else {
        Err("no file on disk for this entry".into())
    }
}

/// Create a new skill/loop in BOTH harness roots so either CLI discovers it
/// by slash command. Returns the created entry.
pub fn create_installed(name: &str, kind: &str, content: &str) -> Result<InstalledSkill, String> {
    let slug = slugify(name);
    if slug.is_empty() {
        return Err("name produces an empty slug".into());
    }
    let body = if content.trim_start().starts_with("---") {
        content.to_string()
    } else {
        format!("---\nname: {slug}\ndescription: \n---\n\n{content}")
    };
    let mut claude_path = None;
    let mut kimi_path = None;
    for (harness, root) in roots(kind).into_iter().take(2) {
        let dir = root.join(&slug);
        fs::create_dir_all(&dir).map_err(|e| format!("mkdir {}: {e}", dir.display()))?;
        let doc = dir.join(if kind == "loops" { "LOOP.md" } else { "SKILL.md" });
        fs::write(&doc, &body).map_err(|e| format!("write {}: {e}", doc.display()))?;
        if harness == "claude" {
            claude_path = Some(doc.to_string_lossy().into_owned());
        } else {
            kimi_path = Some(doc.to_string_lossy().into_owned());
        }
    }
    invalidate_skill_cache();
    Ok(InstalledSkill {
        slug: slug.clone(),
        name: slug,
        description: String::new(),
        source: "both".into(),
        claude_path,
        kimi_path,
        // Always created in the two USER harness roots; the next scan fills
        // this in if the slug also exists inside a project.
        project_path: None,
        kind: kind.trim_end_matches('s').to_string(),
    })
}

pub fn delete_installed(slug: &str, kind: &str) -> Result<(), String> {
    delete_installed_with(slug, kind, &[])
}

/// `delete_installed` that can also remove a project-scoped skill.
pub fn delete_installed_with(
    slug: &str,
    kind: &str,
    projects: &[PathBuf],
) -> Result<(), String> {
    let s = scan_with_projects(kind, projects)
        .into_iter()
        .find(|s| s.slug == slug)
        .ok_or_else(|| format!("no installed {kind} named {slug}"))?;
    for path in writable_paths(&s) {
        if let Some(dir) = PathBuf::from(path).parent().map(|p| p.to_path_buf()) {
            // Only remove a directory this scan positively identified as a
            // skill dir — i.e. one whose own canonical doc is SKILL.md/LOOP.md.
            // The old guard also accepted `path.ends_with(".md")`, which is
            // vacuous: `doc_file` only ever returns a `.md`, so it always
            // passed. That let `doc_file`'s "first .md" fallback turn a Delete
            // into a recursive wipe of a directory whose real contents were
            // `scripts/` and `references/`. Before project roots were scanned
            // the blast radius was one harness dir; now it reached into the
            // user's repos.
            let canonical = dir.join("SKILL.md").is_file() || dir.join("LOOP.md").is_file();
            if canonical {
                let _ = fs::remove_dir_all(&dir);
            }
        }
    }
    invalidate_skill_cache();
    Ok(())
}

/// Make every installed skill/loop global — i.e. readable by *any* harness.
///
/// "Global" here means the skill exists in BOTH harness user dirs (Claude's
/// `~/.claude/<kind>/<slug>/` and Kimi/agents' `~/.agents/<kind>/<slug>/`),
/// so its `source` becomes "both". A skill currently living in only one
/// harness's dir is copied into the other, mirroring `create_installed`'s
/// layout. Returns how many entries were mirrored to the missing harness.
/// Entries already present in both (source "both") are left untouched.
pub fn make_installed_global(kind: &str) -> Result<usize, String> {
    let mut copied = 0usize;
    for s in scan(kind) {
        if s.source == "both" {
            continue;
        }
        // A project skill is already reachable by every agent working in that
        // repo — this action mirrors between the two USER harness dirs, so
        // copying one out would quietly promote it to the user's machine.
        if s.source == "project" {
            continue;
        }
        // Choose the file to mirror: prefer whichever copy already exists
        // (claude first, matching `read_installed`'s preference).
        let (source_doc, missing_harness) = match (&s.claude_path, &s.kimi_path) {
            (Some(src), Some(_)) => (src.clone(), None), // defensive: already both
            (Some(src), None) => (src.clone(), Some("kimi")),
            (None, Some(src)) => (src.clone(), Some("claude")),
            (None, None) => continue,
        };
        let Some(missing_harness) = missing_harness else { continue };
        let Some(home) = crate::util::home_dir() else { continue };
        // Resolve the missing harness's user root for this kind.
        let missing_root = match missing_harness {
            "kimi" => home.join(".agents").join(kind),
            _ => home.join(".claude").join(kind),
        };
        let dest_dir = missing_root.join(&s.slug);
        let doc_name = if kind == "loops" { "LOOP.md" } else { "SKILL.md" };
        let dest_doc = dest_dir.join(doc_name);
        if dest_doc.exists() {
            continue;
        }
        let body = fs::read_to_string(&source_doc).map_err(|e| {
            format!("read {}: {e}", source_doc)
        })?;
        fs::create_dir_all(&dest_dir).map_err(|e| {
            format!("mkdir {}: {e}", dest_dir.display())
        })?;
        fs::write(&dest_doc, &body).map_err(|e| {
            format!("write {}: {e}", dest_doc.display())
        })?;
        copied += 1;
    }
    if copied > 0 {
        invalidate_skill_cache();
    }
    Ok(copied)
}

/// kebab-case slug from a display name; this becomes the slash-command name.
pub fn slugify(name: &str) -> String {
    let mut out = String::new();
    let mut last_dash = false;
    for c in name.trim().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
            last_dash = false;
        } else if !last_dash && !out.is_empty() {
            out.push('-');
            last_dash = true;
        }
    }
    out.trim_end_matches('-').to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The scan roots are derived from `HOME`/`USERPROFILE` at call time, and
    /// `cargo test` runs these in parallel threads of ONE process — so a test
    /// that repoints HOME at its fixture silently breaks every other test
    /// reading the same variable. Every test that touches those env vars holds
    /// this for its whole body.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    /// Point HOME/USERPROFILE at `dir` and hand back a restore closure.
    fn use_home(dir: &std::path::Path) -> impl Fn() {
        let prev_home = std::env::var("HOME").ok();
        let prev_profile = std::env::var("USERPROFILE").ok();
        std::env::set_var("USERPROFILE", dir);
        std::env::set_var("HOME", dir);
        invalidate_skill_cache();
        move || {
            if let Some(v) = prev_home.clone() {
                std::env::set_var("HOME", v);
            }
            if let Some(v) = prev_profile.clone() {
                std::env::set_var("USERPROFILE", v);
            }
            invalidate_skill_cache();
        }
    }

    #[test]
    fn slugify_basics() {
        assert_eq!(slugify("Audit AI Slop"), "audit-ai-slop");
        assert_eq!(slugify("  pdf tools! "), "pdf-tools");
        assert_eq!(slugify("already-kebab"), "already-kebab");
        assert_eq!(slugify("!!!"), "");
    }

    #[test]
    fn frontmatter_parse() {
        let (n, d) = parse_frontmatter("---\nname: pdf\ndescription: \"PDF tools\"\n---\n\n# Body");
        assert_eq!(n.as_deref(), Some("pdf"));
        assert_eq!(d.as_deref(), Some("PDF tools"));
        let (n2, d2) = parse_frontmatter("# no frontmatter");
        assert!(n2.is_none() && d2.is_none());
    }

    /// F5 regression: `lines()` strips `\r\n` but the old body offset budgeted
    /// only `+1` byte per line, so CRLF files landed the offset inside the
    /// `---\r\n` closing delimiter and the frontmatter leaked into the body.
    #[test]
    fn strip_frontmatter_crlf_body_starts_after_delimiter() {
        let content =
            "---\r\nname: Test Skill\r\ndescription: Does things\r\n---\r\n\r\n# Body\r\nline two\r\n";
        let (body, name, desc) = strip_frontmatter(content);
        assert_eq!(name.as_deref(), Some("Test Skill"));
        assert_eq!(desc.as_deref(), Some("Does things"));
        assert_eq!(body, "# Body\r\nline two");
        assert!(!body.contains("---"), "delimiter leaked into body: {body:?}");
        assert!(!body.contains("name:"), "frontmatter leaked into body: {body:?}");
    }

    /// F5 panic case: with 6+ frontmatter lines the old undercount (one byte
    /// per line) backed the body offset into a multibyte frontmatter value —
    /// `content[offset..]` panicked on every chat send. Must parse cleanly.
    #[test]
    fn strip_frontmatter_crlf_multibyte_frontmatter_does_not_panic() {
        let content = "---\r\nname: X\r\ndescription: ✓ünïcödé ✓\r\na: 1\r\nb: 2\r\nc: 3\r\nd: 4\r\ne: ✓✓\r\n---\r\n# Body here\r\n";
        let (body, name, desc) = strip_frontmatter(content);
        assert_eq!(name.as_deref(), Some("X"));
        assert_eq!(desc.as_deref(), Some("✓ünïcödé ✓"));
        assert_eq!(body, "# Body here");
        assert!(!body.contains("---"), "delimiter leaked into body: {body:?}");
    }

    /// LF files keep working: body is everything after the closing delimiter.
    #[test]
    fn strip_frontmatter_lf_body_is_unchanged() {
        let content = "---\nname: pdf\n---\n\n# Body";
        let (body, name, _) = strip_frontmatter(content);
        assert_eq!(name.as_deref(), Some("pdf"));
        assert_eq!(body, "# Body");
    }

    /// Closing delimiter as the last line with no trailing newline → empty body.
    #[test]
    fn strip_frontmatter_closing_delimiter_without_trailing_newline() {
        let content = "---\r\nname: X\r\n---";
        let (body, name, _) = strip_frontmatter(content);
        assert_eq!(name.as_deref(), Some("X"));
        assert_eq!(body, "");
    }

    #[test]
    fn create_writes_both_roots() {
        let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // Point HOME/USERPROFILE at a temp dir for hermetic roots.
        let tmp = std::env::temp_dir().join(format!("relay-skills-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        let restore = use_home(&tmp);
        let created = create_installed("Test Thing", "skills", "do the thing").unwrap();
        assert_eq!(created.slug, "test-thing");
        assert_eq!(created.source, "both");
        let cp = created.claude_path.unwrap();
        let kp = created.kimi_path.unwrap();
        assert!(cp.contains(".claude"));
        assert!(kp.contains(".agents"));
        let content = std::fs::read_to_string(&cp).unwrap();
        assert!(content.contains("name: test-thing"));
        // And the scanner finds it from both roots.
        let found = list_installed("skills");
        let s = found.iter().find(|s| s.slug == "test-thing").unwrap();
        assert_eq!(s.source, "both");
        // save + read round-trip
        save_installed("test-thing", "skills", "new body").unwrap();
        assert_eq!(read_installed("test-thing", "skills").unwrap(), "new body");
        delete_installed("test-thing", "skills").unwrap();
        assert!(list_installed("skills").iter().all(|s| s.slug != "test-thing"));
        drop(restore);
        std::fs::remove_dir_all(&tmp).ok();
    }

    /// The regression this guards: Relay launches each CLI with the project as
    /// its cwd, so an agent told to "create a skill" writes it into the
    /// REPO — and a home-only scan never showed it, not even after a restart.
    #[test]
    fn project_skills_are_discovered() {
        let slug = format!("proj-skill-{}", uuid::Uuid::new_v4());
        let root = std::env::temp_dir().join(format!("relay-proj-{}", uuid::Uuid::new_v4()));
        let dir = root.join(".claude").join("skills").join(&slug);
        std::fs::create_dir_all(&dir).unwrap();
        let body = format!("---\nname: {slug}\ndescription: written by an agent\n---\n\nbody");
        std::fs::write(dir.join("SKILL.md"), &body).unwrap();

        let found = list_installed_with_projects("skills", &[root.clone()]);
        let entry = found
            .iter()
            .find(|s| s.slug == slug)
            .expect("project skill must be listed");
        assert_eq!(entry.source, "project");
        assert_eq!(entry.description, "written by an agent");
        // Resolvable by slug for the editor, and written back in place.
        assert_eq!(
            read_installed_with(&slug, "skills", &[root.clone()]).as_deref(),
            Some(body.as_str())
        );
        save_installed_with(&slug, "skills", "edited", &[root.clone()]).unwrap();
        let edited = std::fs::read_to_string(dir.join("SKILL.md")).unwrap();
        assert_eq!(edited, "edited");

        // Invisible to the home-only scan the chat `/` menu uses — and no
        // stray copy lands in the user's harness dirs.
        assert!(list_installed("skills").iter().all(|s| s.slug != slug));
        std::fs::remove_dir_all(&root).ok();
    }

    /// A slug that exists BOTH in the user's harness dir and inside a project
    /// must not let a repo-local edit reach into the user's global skill.
    ///
    /// The project copy used to share the `claude_path` slot, so one row held a
    /// project path AND a user path, and save/delete — which write every
    /// populated slot — rewrote `~/.claude/skills/<slug>/SKILL.md` from an edit
    /// made against the repo copy (silently changing the skill for every other
    /// project), and `remove_dir_all`'d the repo directory on Delete.
    #[test]
    fn project_copy_never_overwrites_the_users_global_skill() {
        let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let slug = format!("collide-{}", uuid::Uuid::new_v4());
        let home = std::env::temp_dir().join(format!("relay-home-{}", uuid::Uuid::new_v4()));
        let root = std::env::temp_dir().join(format!("relay-proj-{}", uuid::Uuid::new_v4()));
        let user_dir = home.join(".claude").join("skills").join(&slug);
        let proj_dir = root.join(".agents").join("skills").join(&slug);
        std::fs::create_dir_all(&user_dir).unwrap();
        std::fs::create_dir_all(&proj_dir).unwrap();
        let user_body = format!("---\nname: {slug}\ndescription: the user's copy\n---\n\nUSER");
        let proj_body = format!("---\nname: {slug}\ndescription: the repo copy\n---\n\nREPO");
        std::fs::write(user_dir.join("SKILL.md"), &user_body).unwrap();
        std::fs::write(proj_dir.join("SKILL.md"), &proj_body).unwrap();

        let restore = use_home(&home);

        let found = list_installed_with_projects("skills", &[root.clone()]);
        let entry = found
            .iter()
            .find(|s| s.slug == slug)
            .expect("colliding skill must be listed");
        // The row is the USER's skill — that is where its name/description
        // come from — and the two copies are tracked in separate slots.
        assert_eq!(entry.source, "claude");
        assert_eq!(entry.claude_path.as_deref(), Some(user_dir.join("SKILL.md").to_str().unwrap()));
        assert_eq!(entry.project_path.as_deref(), Some(proj_dir.join("SKILL.md").to_str().unwrap()));

        // Reading returns the user's copy, matching the row's metadata.
        assert_eq!(
            read_installed_with(&slug, "skills", &[root.clone()]).as_deref(),
            Some(user_body.as_str())
        );

        // Saving rewrites ONLY the user's copy.
        save_installed_with(&slug, "skills", "EDITED", &[root.clone()]).unwrap();
        assert_eq!(std::fs::read_to_string(user_dir.join("SKILL.md")).unwrap(), "EDITED");
        assert_eq!(
            std::fs::read_to_string(proj_dir.join("SKILL.md")).unwrap(),
            proj_body,
            "a repo-local skill must not be rewritten by an edit aimed at the user's copy"
        );

        drop(restore);
        std::fs::remove_dir_all(&home).ok();
        std::fs::remove_dir_all(&root).ok();
    }

    /// A project skill dir with no canonical `SKILL.md` (only supporting
    /// files) must not be `remove_dir_all`'d: `doc_file`'s "first .md" fallback
    /// used to satisfy a guard that was therefore vacuous, so one Delete click
    /// wiped the directory including the agent-authored `scripts/` beside it.
    #[test]
    fn delete_leaves_a_directory_without_a_canonical_skill_doc() {
        let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let slug = format!("noskillmd-{}", uuid::Uuid::new_v4());
        let root = std::env::temp_dir().join(format!("relay-proj-{}", uuid::Uuid::new_v4()));
        let dir = root.join(".claude").join("skills").join(&slug);
        std::fs::create_dir_all(dir.join("scripts")).unwrap();
        std::fs::write(dir.join("README.md"), "notes").unwrap();
        std::fs::write(dir.join("scripts").join("deploy.sh"), "echo hi").unwrap();

        let home = std::env::temp_dir().join(format!("relay-home-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&home).unwrap();
        let restore = use_home(&home);

        delete_installed_with(&slug, "skills", &[root.clone()]).unwrap();
        assert!(
            dir.join("scripts").join("deploy.sh").is_file(),
            "a directory with no SKILL.md/LOOP.md must be left alone, not wiped"
        );

        drop(restore);
        std::fs::remove_dir_all(&home).ok();
        std::fs::remove_dir_all(&root).ok();
    }
}
