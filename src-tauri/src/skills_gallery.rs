//! Skills gallery (§4.3.4 second half): a curated, bundled catalog of
//! well-known Agent Skills entries the Skills Library can browse and
//! one-click install.
//!
//! The gallery is CATALOG-ONLY by design — it prefills discovery, it does
//! not create a second install path. "Install" in the UI calls the same
//! validated `install_skill_from_url` (raw/blob/tree/zip guards, zip-slip
//! caps, dual-root write) as pasting a URL; the catalog just removes the
//! "find a URL first" step. Entries are curated (`&'static str`, display
//! order = vec order, same shape as `mcp_gallery::catalog` and
//! `automation_templates::templates`), and each carries a GitHub tree URL
//! that [`verify_gallery_entry`] can re-resolve live so a stale catalog
//! entry says so instead of failing at install time with a raw 404.
//!
//! Live verification hits the GitHub contents API unauthenticated (60 req/h
//! is plenty for a browse-verify); the test suite pins the URL shapes and
//! live-checks the whole catalog behind `-- --ignored`.

use serde::Serialize;
use tauri::command;

/// One curated gallery entry. `url` is a GitHub TREE URL understood by
/// `installed_skills::install_from_url` (owner/repo/tree/ref/path).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillGalleryEntry {
    pub id: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    pub author: &'static str,
    pub category: &'static str,
    pub url: &'static str,
}

/// The bundled catalog. Order is display order. Every entry below was
/// live-verified against the GitHub contents API on 2026-10-01
/// (`skills/<name>` directories of anthropics/skills); the `--ignored` test
/// re-verifies the whole list so catalog rot is caught by a test run.
pub fn gallery() -> Vec<SkillGalleryEntry> {
    vec![
        SkillGalleryEntry {
            id: "docx",
            name: "Word documents (.docx)",
            description: "Create, edit, and analyze Word documents with tracked changes, comments, and formatting preservation.",
            author: "anthropics",
            category: "Documents",
            url: "https://github.com/anthropics/skills/tree/main/skills/docx",
        },
        SkillGalleryEntry {
            id: "pptx",
            name: "Slide decks (.pptx)",
            description: "Create, edit, and analyze PowerPoint presentations with layouts, templates, and speaker notes.",
            author: "anthropics",
            category: "Documents",
            url: "https://github.com/anthropics/skills/tree/main/skills/pptx",
        },
        SkillGalleryEntry {
            id: "xlsx",
            name: "Spreadsheets (.xlsx)",
            description: "Create, edit, and analyze Excel spreadsheets with formulas, charts, and formatting.",
            author: "anthropics",
            category: "Documents",
            url: "https://github.com/anthropics/skills/tree/main/skills/xlsx",
        },
        SkillGalleryEntry {
            id: "pdf",
            name: "PDF processing",
            description: "Extract text and tables, merge, split, rotate, fill forms, and create PDFs.",
            author: "anthropics",
            category: "Documents",
            url: "https://github.com/anthropics/skills/tree/main/skills/pdf",
        },
        SkillGalleryEntry {
            id: "canvas-design",
            name: "Canvas design",
            description: "Create original visual art, posters, and static designs with deliberate design philosophy.",
            author: "anthropics",
            category: "Creative",
            url: "https://github.com/anthropics/skills/tree/main/skills/canvas-design",
        },
        SkillGalleryEntry {
            id: "algorithmic-art",
            name: "Algorithmic art",
            description: "Generative art with p5.js — seeded randomness, flow fields, particle systems.",
            author: "anthropics",
            category: "Creative",
            url: "https://github.com/anthropics/skills/tree/main/skills/algorithmic-art",
        },
        SkillGalleryEntry {
            id: "theme-factory",
            name: "Theme factory",
            description: "Style artifacts with cohesive color and font themes; presets plus custom themes.",
            author: "anthropics",
            category: "Creative",
            url: "https://github.com/anthropics/skills/tree/main/skills/theme-factory",
        },
        SkillGalleryEntry {
            id: "frontend-design",
            name: "Frontend design",
            description: "Distinctive, intentional visual direction for new UI — typography, layout, and taste.",
            author: "anthropics",
            category: "Engineering",
            url: "https://github.com/anthropics/skills/tree/main/skills/frontend-design",
        },
        SkillGalleryEntry {
            id: "webapp-testing",
            name: "Webapp testing",
            description: "Drive and verify local web apps with Playwright — interactions, screenshots, console logs.",
            author: "anthropics",
            category: "Engineering",
            url: "https://github.com/anthropics/skills/tree/main/skills/webapp-testing",
        },
        SkillGalleryEntry {
            id: "mcp-builder",
            name: "MCP server builder",
            description: "Build high-quality Model Context Protocol servers that integrate external APIs as tools.",
            author: "anthropics",
            category: "Engineering",
            url: "https://github.com/anthropics/skills/tree/main/skills/mcp-builder",
        },
        SkillGalleryEntry {
            id: "skill-creator",
            name: "Skill creator",
            description: "Author, edit, and evaluate SKILL.md skills with trigger-reliable descriptions.",
            author: "anthropics",
            category: "Engineering",
            url: "https://github.com/anthropics/skills/tree/main/skills/skill-creator",
        },
        SkillGalleryEntry {
            id: "web-artifacts-builder",
            name: "Web artifacts builder",
            description: "Build elaborate multi-component web artifacts with React, Tailwind, and shadcn/ui.",
            author: "anthropics",
            category: "Engineering",
            url: "https://github.com/anthropics/skills/tree/main/skills/web-artifacts-builder",
        },
    ]
}

/// Every entry is a GitHub tree URL the installer accepts, with a unique id
/// and no empty fields (catalog-shape contract, mirrors the template tests
/// in automation_templates.rs).
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_catalog_entry_is_a_unique_wellformed_github_tree_url() {
        let mut ids = std::collections::HashSet::new();
        for e in gallery() {
            assert!(!e.id.is_empty() && !e.name.is_empty(), "entry id/name");
            assert!(!e.description.is_empty(), "{}: description", e.id);
            assert!(ids.insert(e.id), "duplicate catalog id: {}", e.id);
            let r = crate::installed_skills::parse_github_url(e.url)
                .unwrap_or_else(|| panic!("{}: URL must parse: {}", e.id, e.url));
            assert_eq!(r.owner, "anthropics");
            assert_eq!(r.repo, "skills");
            assert!(!r.path.is_empty(), "{}: tree path", e.id);
        }
    }

    /// Live check of the whole catalog against the real contents API — the
    /// guard against catalog rot. Run explicitly:
    /// cargo test -p relay skills_gallery -- --ignored
    #[tokio::test]
    #[ignore = "hits the live network (api.github.com, anonymous rate limit)"]
    async fn catalog_entries_resolve_live() {
        let client = crate::installed_skills::install_http_client().unwrap();
        let mut checked = 0usize;
        for e in gallery() {
            let r = crate::installed_skills::parse_github_url(e.url)
                .unwrap_or_else(|| panic!("{}: bad URL", e.id));
            verify_gallery_entry_inner(&client, &r)
                .await
                .unwrap_or_else(|err| panic!("{}: {}", e.id, err));
            checked += 1;
        }
        assert!(checked >= 10, "catalog should be non-trivially large");
    }
}

use tauri::AppHandle;

/// Re-resolve one catalog entry's path via the GitHub contents API. Shared
/// by the `#[ignore]` live test and the command below (which the UI calls
/// lazily so a stale entry shows a "no longer available" badge instead of a
/// raw install failure).
pub async fn verify_gallery_entry_inner(
    client: &reqwest::Client,
    git_ref: &crate::installed_skills::GitHubRef,
) -> Result<(), String> {
    let entries = crate::installed_skills::github_list_dir(client, git_ref).await?;
    // A skill directory must hold at least one markdown file — a tree URL
    // pointing at an empty dir (renamed/moved skill) is not installable.
    if entries.iter().any(|(_, _, is_dir)| !*is_dir) {
        Ok(())
    } else {
        Err("directory contains no files (skill moved or removed?)".to_string())
    }
}

/// Live-verify one gallery entry. Cheap + read-only; the UI calls it per
/// entry when the gallery renders (or on demand) and renders the verdict.
#[command(async)]
pub async fn verify_skill_gallery_entry(
    _app: AppHandle,
    url: String,
) -> Result<(), String> {
    let r = crate::installed_skills::parse_github_url(&url)
        .ok_or_else(|| "not a GitHub tree URL".to_string())?;
    let client = crate::installed_skills::install_http_client()?;
    verify_gallery_entry_inner(&client, &r).await
}

/// The bundled catalog for the Skills Library's Gallery tab.
#[command]
pub fn list_skill_gallery() -> Vec<SkillGalleryEntry> {
    gallery()
}
