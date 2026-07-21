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

use serde::Serialize;
use std::fs;
use std::path::PathBuf;

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

/// Root dirs per harness for a given kind ("skills" | "loops").
fn roots(kind: &str) -> Vec<(&'static str, PathBuf)> {
    let Some(home) = crate::util::home_dir() else { return vec![] };
    let mut v = vec![
        ("claude", home.join(".claude").join(kind)),
        ("kimi", home.join(".agents").join(kind)),
    ];
    // Defensive: kimi's own-named dir if a version starts using it.
    v.push(("kimi", home.join(".kimi-code").join(kind)));
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

/// Pull `name:` / `description:` out of the YAML frontmatter block. Simple
/// line parsing — no yaml dependency for two keys.
fn parse_frontmatter(content: &str) -> (Option<String>, Option<String>) {
    let mut name = None;
    let mut desc = None;
    let mut in_fm = false;
    for (i, line) in content.lines().enumerate() {
        let t = line.trim();
        if i == 0 && t == "---" {
            in_fm = true;
            continue;
        }
        if in_fm && t == "---" {
            break;
        }
        if !in_fm {
            break;
        }
        let unquote = |v: &str| v.trim().trim_matches('"').trim_matches('\'').to_string();
        if let Some(v) = t.strip_prefix("name:") {
            name = Some(unquote(v));
        } else if let Some(v) = t.strip_prefix("description:") {
            desc = Some(unquote(v));
        }
    }
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
    Ok(())
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
        let tmp = std::env::temp_dir().join(format!("conduit-skills-{}", uuid::Uuid::new_v4()));
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
