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
    /// "claude" | "kimi" | "both"
    pub source: String,
    pub claude_path: Option<String>,
    pub kimi_path: Option<String>,
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
                    // cache/<marketplace>/<plugin>/<version>/skills/<slug>/...
                    // We push the `cache` root and let the scan walk into it
                    // via `read_dir`; deeper enumeration is unnecessary
                    // because the scan already recurses through directories
                    // looking for SKILL.md / LOOP.md.
                    v.push(("claude", child.join(kind)));
                }
                _ => {}
            }
        }
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
                // Body starts after this line. `lines()` strips the trailing
                // newline, so advance past the second `---` + its newline.
                body_start = content
                    .lines()
                    .take(i + 1)
                    .map(|l| l.len() + 1)
                    .sum::<usize>()
                    .min(content.len());
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
    let mut by_slug: std::collections::BTreeMap<String, InstalledSkill> = Default::default();
    for (harness, root) in roots(kind) {
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
                kind: kind.trim_end_matches('s').to_string(),
            });
            if harness == "claude" {
                e.claude_path = Some(path_str);
            } else {
                // Keep the first kimi path found (.agents preferred by order).
                e.kimi_path.get_or_insert(path_str);
            }
        }
    }
    for e in by_slug.values_mut() {
        e.source = match (&e.claude_path, &e.kimi_path) {
            (Some(_), Some(_)) => "both",
            (Some(_), None) => "claude",
            _ => "kimi",
        }
        .to_string();
    }
    by_slug.into_values().collect()
}

pub fn list_installed(kind: &str) -> Vec<InstalledSkill> {
    scan(kind)
}

/// Content of a skill doc: prefer the Claude copy, else the Kimi one.
pub fn read_installed(slug: &str, kind: &str) -> Option<String> {
    let s = scan(kind).into_iter().find(|s| s.slug == slug)?;
    let path = s.claude_path.or(s.kimi_path)?;
    fs::read_to_string(path).ok()
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
    let s = scan(kind)
        .into_iter()
        .find(|s| s.slug == slug)
        .ok_or_else(|| format!("no installed {kind} named {slug}"))?;
    let mut wrote = false;
    for path in [s.claude_path, s.kimi_path].into_iter().flatten() {
        fs::write(&path, content).map_err(|e| format!("write {path}: {e}"))?;
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
        kind: kind.trim_end_matches('s').to_string(),
    })
}

pub fn delete_installed(slug: &str, kind: &str) -> Result<(), String> {
    let s = scan(kind)
        .into_iter()
        .find(|s| s.slug == slug)
        .ok_or_else(|| format!("no installed {kind} named {slug}"))?;
    for path in [s.claude_path, s.kimi_path].into_iter().flatten() {
        if let Some(dir) = PathBuf::from(&path).parent().map(|p| p.to_path_buf()) {
            // Only remove the directory we just identified as a skill dir.
            if dir.join("SKILL.md").exists() || dir.join("LOOP.md").exists() || path.ends_with(".md") {
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

    #[test]
    fn create_writes_both_roots() {
        // Point HOME/USERPROFILE at a temp dir for hermetic roots.
        let tmp = std::env::temp_dir().join(format!("relay-skills-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        std::env::set_var("USERPROFILE", &tmp);
        std::env::set_var("HOME", &tmp);
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
        std::fs::remove_dir_all(&tmp).ok();
    }
}
