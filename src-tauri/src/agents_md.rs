//! `AGENTS.md` — the de-facto repository instruction-file standard (the
//! format donated to the AAIF, read natively by OpenCode, Codex, Gemini CLI,
//! Cursor and friends).
//!
//! Relay's support has three parts:
//! 1. **Layering** — the project's AGENTS.md is read and appended to both
//!    prompt surfaces: the harness context section (`agent_sessions::bundle`,
//!    so CLI agents that don't discover it natively still get it) and the
//!    built-in chat's system prompt (`chat::commands::send`).
//! 2. **Tools** — `read_agents_md` / `write_agents_md` in the built-in
//!    registry so a model can author or update the file on request.
//! 3. **Discovery** — root file first, then ancestor walk (the standard's
//!    lookup), so a session rooted in a subdirectory still finds it.
//!
//! Layered sections are capped ([`MAX_CONTEXT_CHARS`]): AGENTS.md files are
//! unbounded in the wild and the section rides the system prompt, which is
//! the region every provider prompt-caches — an uncapped file would tax
//! every turn forever.

/// The standard file name, at the project root.
pub const FILE_NAME: &str = "AGENTS.md";

/// Cap for the layered prompt section (chars). The full file stays available
/// to the model via `read_agents_md`; only the automatic layering is capped.
pub const MAX_CONTEXT_CHARS: usize = 8_000;

/// How many ancestor levels above the project root discovery may walk before
/// giving up (the standard walks to the filesystem root; three levels keeps
/// the lookup cheap and predictable).
const MAX_ANCESTORS: u32 = 3;

/// Find the AGENTS.md governing `root`: the root's own file, else the
/// nearest ancestor's. Returns the file's full path.
pub fn find(root: &str) -> Option<std::path::PathBuf> {
    let mut dir = std::path::Path::new(root).to_path_buf();
    for _ in 0..=MAX_ANCESTORS {
        let candidate = dir.join(FILE_NAME);
        if candidate.is_file() {
            return Some(candidate);
        }
        if !dir.pop() {
            return None;
        }
    }
    None
}

/// Read the AGENTS.md governing `root` (discovery per [`find`]). Returns the
/// path and the file's full text.
pub fn read(root: &str) -> Option<(std::path::PathBuf, String)> {
    let path = find(root)?;
    let content = std::fs::read_to_string(&path).ok()?;
    Some((path, content))
}

/// Build the layered prompt section for a project root: `None` when the
/// project has no AGENTS.md (or it is empty after trim) — the section must
/// be ABSENT, not empty, so the prompt prefix stays stable.
pub fn prompt_section(root: &str) -> Option<String> {
    let (path, content) = read(root)?;
    let content = content.trim();
    if content.is_empty() {
        return None;
    }
    let (content, truncated) = if content.chars().count() > MAX_CONTEXT_CHARS {
        (
            format!("{}…", crate::util::truncate_chars(content, MAX_CONTEXT_CHARS)),
            true,
        )
    } else {
        (content.to_string(), false)
    };
    let mut section = format!(
        "## Project instructions (AGENTS.md)\n\nSource: {}\n\n{content}",
        path.display()
    );
    if truncated {
        section.push_str(
            "\n\n[Truncated — the full file is readable via the read_agents_md tool.]",
        );
    }
    Some(section)
}

/// Append an AGENTS.md section to an already-built system prompt (the
/// built-in chat's assembly point). Both sides Option because prompts and
/// sections are independently optional; the result is Some only when there
/// is something to send — same contract as `build_system_prompt`.
pub fn append_to_system(system: Option<String>, section: Option<String>) -> Option<String> {
    match (system, section) {
        (Some(mut system), Some(section)) => {
            system.push_str("\n\n");
            system.push_str(&section);
            Some(system)
        }
        (Some(system), None) => Some(system),
        (None, Some(section)) => Some(section),
        (None, None) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn write_agents_md(dir: &std::path::Path, content: &str) {
        std::fs::write(dir.join(FILE_NAME), content).unwrap();
    }

    #[test]
    fn finds_root_file_and_reads_it() {
        let tmp = TempDir::new().unwrap();
        write_agents_md(tmp.path(), "# Rules\nBe terse.");
        let (path, content) = read(tmp.path().to_str().unwrap()).unwrap();
        assert_eq!(path, tmp.path().join(FILE_NAME));
        assert!(content.contains("Be terse."));
    }

    #[test]
    fn discovery_walks_ancestors_when_root_has_none() {
        let tmp = TempDir::new().unwrap();
        write_agents_md(tmp.path(), "# Parent rules");
        let sub = tmp.path().join("crates").join("app");
        std::fs::create_dir_all(&sub).unwrap();
        let (path, _) = read(sub.to_str().unwrap()).unwrap();
        assert_eq!(path, tmp.path().join(FILE_NAME));
    }

    #[test]
    fn root_file_wins_over_ancestor() {
        let tmp = TempDir::new().unwrap();
        write_agents_md(tmp.path(), "# Parent rules");
        let sub = tmp.path().join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        write_agents_md(&sub, "# Sub rules");
        let (path, content) = read(sub.to_str().unwrap()).unwrap();
        assert_eq!(path, sub.join(FILE_NAME));
        assert!(content.contains("Sub rules"));
    }

    #[test]
    fn none_when_no_file_anywhere_near() {
        let tmp = TempDir::new().unwrap();
        let sub = tmp.path().join("a").join("b");
        std::fs::create_dir_all(&sub).unwrap();
        assert!(read(sub.to_str().unwrap()).is_none());
        assert!(prompt_section(sub.to_str().unwrap()).is_none());
    }

    #[test]
    fn empty_file_yields_no_section() {
        let tmp = TempDir::new().unwrap();
        write_agents_md(tmp.path(), "   \n");
        assert!(prompt_section(tmp.path().to_str().unwrap()).is_none());
    }

    #[test]
    fn prompt_section_carries_source_path_and_body() {
        let tmp = TempDir::new().unwrap();
        write_agents_md(tmp.path(), "# Rules\nUse pnpm. Never touch main.");
        let section = prompt_section(tmp.path().to_str().unwrap()).unwrap();
        assert!(section.starts_with("## Project instructions (AGENTS.md)"));
        assert!(section.contains(tmp.path().join(FILE_NAME).to_str().unwrap()));
        assert!(section.contains("Use pnpm."));
    }

    #[test]
    fn oversized_file_is_truncated_with_a_pointer_to_the_tool() {
        let tmp = TempDir::new().unwrap();
        let long = "x".repeat(MAX_CONTEXT_CHARS + 500);
        write_agents_md(tmp.path(), &long);
        let section = prompt_section(tmp.path().to_str().unwrap()).unwrap();
        assert!(section.chars().count() < MAX_CONTEXT_CHARS + 400);
        assert!(section.contains("read_agents_md"));
        assert!(section.ends_with('…') || section.contains("[Truncated"));
    }

    #[test]
    fn append_to_system_combines_and_preserves_optionality() {
        assert_eq!(append_to_system(Some("sys".into()), Some("sec".into())).unwrap(), "sys\n\nsec");
        assert_eq!(append_to_system(Some("sys".into()), None).unwrap(), "sys");
        assert_eq!(append_to_system(None, Some("sec".into())).unwrap(), "sec");
        assert!(append_to_system(None, None).is_none());
    }
}
