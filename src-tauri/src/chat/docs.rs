//! Local document corpora: folder walking + text chunking for the local RAG
//! pipeline. Storage lives in db/docs.rs; the embedding sidecar in
//! chat/local_models.rs; the index runner in chat/docs_index.rs; image
//! surrogates in chat/docs_images.rs.
//!
//! Everything here is pure/side-effect-light so the indexer can run the walk
//! and chunking inside `spawn_blocking` without stalling tokio workers.

use std::path::{Path, PathBuf};

/// Extensions indexed as plain text (chunked + embedded directly).
pub const TEXT_EXTENSIONS: &[&str] = &[
    "md", "markdown", "txt", "rst", "json", "jsonl", "csv", "tsv", "html", "htm", "xml", "yaml",
    "yml", "toml", "ts", "tsx", "js", "jsx", "mjs", "py", "rs", "css", "scss", "sql", "sh", "bash",
    "ps1", "c", "h", "cpp", "hpp", "cc", "java", "go", "kt", "swift", "rb", "php", "cs", "ini",
    "cfg", "conf", "log", "tex", "vue", "svelte",
];

/// Extensions indexed as images — embedded via their text surrogate
/// (OCR + optional vision caption, see docs_images.rs).
pub const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "webp", "bmp", "gif"];

/// Directories never descended into. `pub(crate)` so the project-wiki repo
/// walk (wiki/mod.rs) shares one ignore list with the RAG corpus walk.
pub(crate) const SKIP_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    "out",
    "__pycache__",
    ".venv",
    "venv",
    "vendor",
    ".idea",
    ".vscode",
];

pub const MAX_TEXT_FILE_BYTES: u64 = 1_000_000;
pub const MAX_IMAGE_FILE_BYTES: u64 = 20_000_000;
/// Safety valve against pathological folders; search cost is linear in chunks.
pub const MAX_CHUNKS_PER_CORPUS: usize = 50_000;

pub const CHUNK_TARGET: usize = 1800;
pub const CHUNK_OVERLAP: usize = 200;

/// What the walker found for one file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WalkKind {
    Text,
    Image,
}

#[derive(Debug, Clone)]
pub struct WalkEntry {
    /// Corpus-root-relative path, '/'-separated (stable across platforms).
    pub rel_path: String,
    pub abs_path: PathBuf,
    pub kind: WalkKind,
    /// Unix seconds; 0 when the metadata read fails.
    pub mtime: i64,
    pub size: i64,
}

/// Classify a file by extension. None = not indexed.
pub fn classify_path(path: &Path) -> Option<WalkKind> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    if TEXT_EXTENSIONS.contains(&ext.as_str()) {
        Some(WalkKind::Text)
    } else if IMAGE_EXTENSIONS.contains(&ext.as_str()) {
        Some(WalkKind::Image)
    } else {
        None
    }
}

/// Recursively collect indexable files under `root`. Skips hidden dirs,
/// SKIP_DIRS at any depth, over-size files, and anything unreadable.
pub fn walk_corpus(root: &Path) -> Vec<WalkEntry> {
    let mut out = Vec::new();
    let mut stack: Vec<PathBuf> = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(read) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in read.flatten() {
            let path = entry.path();
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            if name.starts_with('.') {
                continue; // hidden files/dirs are never indexed
            }
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_dir() {
                if !SKIP_DIRS.contains(&name) {
                    stack.push(path);
                }
                continue;
            }
            if !meta.is_file() {
                continue;
            }
            let Some(kind) = classify_path(&path) else {
                continue;
            };
            let size = meta.len();
            let cap = match kind {
                WalkKind::Text => MAX_TEXT_FILE_BYTES,
                WalkKind::Image => MAX_IMAGE_FILE_BYTES,
            };
            if size == 0 || size > cap {
                continue;
            }
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            let rel = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            out.push(WalkEntry {
                rel_path: rel,
                abs_path: path,
                kind,
                mtime,
                size: size as i64,
            });
        }
    }
    // Deterministic order: progress logs and tests stay stable.
    out.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    out
}

fn floor_boundary(text: &str, mut i: usize) -> usize {
    while i > 0 && !text.is_char_boundary(i) {
        i -= 1;
    }
    i
}

/// The byte offset to end the current chunk at: prefer a paragraph break in
/// the latter 60% of the window, then a line break, then a space; otherwise
/// hard-cut at the target.
fn best_break(text: &str, start: usize, hard_end: usize) -> usize {
    let end = floor_boundary(text, hard_end);
    let window = &text[start..end];
    let min = window.len() * 2 / 5;
    if let Some(pos) = window.rfind("\n\n") {
        if pos >= min {
            return start + pos + 2;
        }
    }
    if let Some(pos) = window.rfind('\n') {
        if pos >= min {
            return start + pos + 1;
        }
    }
    if let Some(pos) = window.rfind(' ') {
        if pos >= min {
            return start + pos + 1;
        }
    }
    end
}

/// Split document text into overlapping chunks (~1800 chars, 200 overlap).
/// Chunk offsets are byte offsets aligned to char boundaries; content is
/// trimmed. Empty/whitespace-only input yields no chunks.
///
/// Thin wrapper over [`chunk_text_with_meta`] — content bytes are identical.
pub fn chunk_text(text: &str) -> Vec<String> {
    chunk_text_with_meta(text, "")
        .into_iter()
        .map(|m| m.content)
        .collect()
}

/// One chunk plus its contextual metadata.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChunkMeta {
    pub content: String,
    /// Markdown heading trail in effect where the chunk starts
    /// ("Guide > Setup", '' before any heading). Since chunk-schema v2 the
    /// trail (plus the relative path) is prepended to the text that gets
    /// EMBEDDED (contextual chunk enrichment, `enriched_embed_text`) — the
    /// stored chunk content stays raw for the FTS leg and display.
    pub heading: String,
}

/// Cap for the contextual prefix (rel path + heading trail) that precedes a
/// chunk in the embed/rerank input — a pathological path or deeply nested
/// trail must not eat the chunk's own token budget.
const CONTEXT_PREFIX_CAP: usize = 300;

/// The `path · heading` context line situating a chunk ('' when the chunk has
/// no context at all — empty path, or empty path AND heading).
fn context_prefix(path: &str, heading: &str) -> String {
    let path = path.trim();
    let heading = heading.trim();
    let line = match (path.is_empty(), heading.is_empty()) {
        (true, _) => String::new(),
        (false, true) => path.to_string(),
        (false, false) => format!("{path} · {heading}"),
    };
    if line.chars().count() > CONTEXT_PREFIX_CAP {
        format!("{}…", crate::util::truncate_chars(&line, CONTEXT_PREFIX_CAP))
    } else {
        line
    }
}

/// The text that gets EMBEDDED (and fed to the reranker) for one chunk:
/// a `path · heading` context line, a blank line, then the raw chunk
/// content. This is the "contextual chunk enrichment" pass (chunk-schema
/// v2): keyword search (FTS over the raw content) and display are unchanged
/// — only the vector leg's input gains the context, so chunks inside long
/// documents remain retrievable by the section they live in, not just by
/// their own tokens.
pub fn enriched_embed_text(path: &str, heading: &str, content: &str) -> String {
    match context_prefix(path, heading) {
        prefix if prefix.is_empty() => content.to_string(),
        prefix => format!("{prefix}\n\n{content}"),
    }
}

/// [`chunk_text`] with enrichment: `path` decides whether heading trails are
/// tracked (markdown files only — `.md`/`.markdown`; anything else gets ''
/// headings). The slicing itself is byte-identical to `chunk_text`.
pub fn chunk_text_with_meta(text: &str, path: &str) -> Vec<ChunkMeta> {
    let normalized = text.replace("\r\n", "\n");
    let trimmed = normalized.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    let is_markdown = matches!(
        Path::new(path)
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .as_deref(),
        Some("md") | Some("markdown")
    );
    let trails = if is_markdown { heading_trails(trimmed) } else { Vec::new() };
    // Trail in effect at a chunk's start: the last heading at or before that
    // offset (a heading starting exactly at the chunk start IS part of the
    // chunk). Trails is sorted by offset.
    let heading_at = |start: usize| -> String {
        let upto = trails.partition_point(|(off, _)| *off <= start);
        if upto == 0 {
            String::new()
        } else {
            trails[upto - 1].1.clone()
        }
    };

    if trimmed.len() <= CHUNK_TARGET + CHUNK_OVERLAP {
        return vec![ChunkMeta {
            content: trimmed.to_string(),
            heading: heading_at(0),
        }];
    }
    let mut chunks = Vec::new();
    let mut start = 0usize;
    let len = trimmed.len();
    while start < len {
        let hard_end = (start + CHUNK_TARGET).min(len);
        let end = if hard_end < len {
            best_break(trimmed, start, hard_end)
        } else {
            len
        };
        let piece = trimmed[start..end].trim();
        if !piece.is_empty() {
            chunks.push(ChunkMeta {
                content: piece.to_string(),
                heading: heading_at(start),
            });
        }
        if end >= len {
            break;
        }
        // Overlap the next chunk with the tail of this one, but guarantee
        // forward progress (target >> overlap, so this can't stall).
        start = end.saturating_sub(CHUNK_OVERLAP).max(start + 1);
        start = floor_boundary(trimmed, start);
    }
    chunks
}

/// Byte-offset → heading-trail snapshots for a markdown document, one entry
/// per heading line. Line-based heuristic: a heading is a line of 1-6 `#`
/// followed by a space and non-empty title (leading whitespace tolerated);
/// deeper headings nest on the trail ("H1 > H2"). Offsets are byte offsets
/// into `text` (normalized to '\n' line endings by the caller).
fn heading_trails(text: &str) -> Vec<(usize, String)> {
    let mut snapshots: Vec<(usize, String)> = Vec::new();
    let mut stack: Vec<(usize, String)> = Vec::new(); // (level, title)
    let mut offset = 0usize;
    for line in text.split('\n') {
        let t = line.trim();
        let hashes = t.bytes().take_while(|b| *b == b'#').count();
        if (1..=6).contains(&hashes) && t.as_bytes().get(hashes) == Some(&b' ') {
            let title = t[hashes + 1..].trim();
            if !title.is_empty() {
                stack.truncate(hashes - 1);
                stack.push((hashes, title.to_string()));
                let joined = stack
                    .iter()
                    .map(|(_, s)| s.as_str())
                    .collect::<Vec<_>>()
                    .join(" > ");
                snapshots.push((offset, joined));
            }
        }
        offset += line.len() + 1;
    }
    snapshots
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_extensions() {
        assert_eq!(
            classify_path(Path::new("a/README.md")),
            Some(WalkKind::Text)
        );
        assert_eq!(classify_path(Path::new("a/main.RS")), Some(WalkKind::Text));
        assert_eq!(classify_path(Path::new("a/pic.PNG")), Some(WalkKind::Image));
        assert_eq!(classify_path(Path::new("a/blob.bin")), None);
        assert_eq!(classify_path(Path::new("a/noext")), None);
    }

    #[test]
    fn small_text_is_one_chunk() {
        assert_eq!(chunk_text("").len(), 0);
        assert_eq!(chunk_text("   \n  ").len(), 0);
        let chunks = chunk_text("hello world");
        assert_eq!(chunks, vec!["hello world".to_string()]);
        let medium = "x".repeat(CHUNK_TARGET + CHUNK_OVERLAP);
        assert_eq!(chunk_text(&medium).len(), 1);
    }

    #[test]
    fn long_text_chunks_with_overlap_and_progress() {
        // 10 paragraphs of ~500 chars each.
        let para = "lorem ipsum dolor sit amet ".repeat(18); // ~495 chars
        let text = vec![para; 10].join("\n\n");
        let chunks = chunk_text(&text);
        assert!(
            chunks.len() >= 4,
            "expected several chunks, got {}",
            chunks.len()
        );
        // Every chunk respects the target ceiling (plus boundary slack).
        for c in &chunks {
            assert!(c.len() <= CHUNK_TARGET + 64, "chunk too big: {}", c.len());
            assert!(!c.is_empty());
        }
        // Overlap: chunk 2 starts inside chunk 1's tail (byte-level proof).
        let first_len = chunks[0].len();
        let tail_probe = &chunks[0][first_len - 60..];
        assert!(
            chunks[1].contains(tail_probe.trim_end()),
            "chunk 2 should contain chunk 1's 60-char tail"
        );
        // Coverage: total chunked text at least covers the source.
        let total: usize = chunks.iter().map(|c| c.len()).sum();
        assert!(total >= text.trim().len());
    }

    #[test]
    fn chunking_never_splits_multibyte_chars() {
        // Multibyte-heavy text: hard cuts must land on char boundaries.
        let text = "日本語のテキスト。".repeat(500); // ~8.5k bytes, no spaces/newlines
        let chunks = chunk_text(&text);
        assert!(chunks.len() >= 2);
        for c in &chunks {
            assert!(c.chars().all(|ch| ch == '日'
                || ch == '本'
                || ch == '語'
                || ch == 'の'
                || ch == 'テ'
                || ch == 'キ'
                || ch == 'ス'
                || ch == 'ト'
                || ch == '。'));
        }
    }

    #[test]
    fn meta_non_markdown_gets_empty_headings() {
        let metas = chunk_text_with_meta("plain text file", "notes/readme.txt");
        assert_eq!(metas.len(), 1);
        assert_eq!(metas[0].content, "plain text file");
        assert_eq!(metas[0].heading, "");
        // Even markdown heading lines in a non-.md file are inert.
        let metas = chunk_text_with_meta("# Title\nbody", "code/main.rs");
        assert_eq!(metas[0].heading, "");
    }

    #[test]
    fn meta_tracks_markdown_heading_trail() {
        // Short doc (single-chunk fast path): the trail in effect at the
        // chunk's start — the leading heading counts, an early one doesn't.
        let lead = chunk_text_with_meta("## Setup\n\nsetup body.", "x.md");
        assert_eq!(lead.len(), 1);
        assert_eq!(lead[0].heading, "Setup");
        let late = chunk_text_with_meta("intro.\n\n# Guide\n\nguide body.", "x.md");
        assert_eq!(late.len(), 1);
        assert_eq!(late[0].heading, "", "chunk starts before any heading");

        // Trail building itself: nesting, the '>' join, and popping back up.
        let text = "intro\n\n# A\ntext\n\n## B\ntext\n\n### C\ntext\n\n# D\nend";
        let trails = heading_trails(text);
        let heads: Vec<&str> = trails.iter().map(|(_, h)| h.as_str()).collect();
        assert_eq!(heads, ["A", "A > B", "A > B > C", "D"]);
        assert!(trails.windows(2).all(|w| w[0].0 < w[1].0), "offsets ascend");

        // `#` without a space or with an empty title is not a heading.
        let tricky = "#not a heading\n\n# \n\nreal body";
        let metas3 = chunk_text_with_meta(tricky, "x.md");
        assert_eq!(metas3[0].heading, "");
        assert_eq!(
            chunk_text_with_meta(tricky, "x.md")
                .into_iter()
                .map(|m| m.content)
                .collect::<Vec<_>>(),
            chunk_text(tricky)
        );
    }

    #[test]
    fn meta_long_markdown_chunks_carry_their_section() {
        // Section bodies are single ~1000-char lines (no interior paragraph
        // breaks), so chunk boundaries land on section edges only — best_break
        // prefers the "\n\n" between sections.
        let body = |word: &str| format!("{word} {}", "lorem ipsum dolor sit amet ".repeat(36));
        let text = format!(
            "intro paragraph before any heading.\n\n# Guide\n\n{}\n\n## Setup\n\n{}\n\n### Advanced\n\n{}",
            body("guide"),
            body("setup"),
            body("advanced"),
        );
        let metas = chunk_text_with_meta(&text, "big.md");
        assert!(metas.len() >= 3, "expected several chunks");
        // First chunk starts before any heading.
        assert_eq!(metas[0].heading, "");
        // Every chunk's trail is one of the document's heading trails (or ''
        // before the first) — and at least the mid-document trails appear.
        let valid = ["", "Guide", "Guide > Setup", "Guide > Setup > Advanced"];
        for m in &metas {
            assert!(
                valid.contains(&m.heading.as_str()),
                "unexpected trail {:?}",
                m.heading
            );
        }
        assert!(metas.iter().any(|m| m.heading == "Guide > Setup"));
        // Content bytes unchanged vs the heading-free chunker.
        let plain = chunk_text(&text);
        let with_meta: Vec<String> = metas.into_iter().map(|m| m.content).collect();
        assert_eq!(plain, with_meta);
    }

    #[test]
    fn enriched_embed_text_carries_path_and_heading() {
        // Markdown chunk mid-document: path + trail line, blank line, raw body.
        let enriched = enriched_embed_text("guides/setup.md", "Guide > Setup", "body text");
        assert_eq!(enriched, "guides/setup.md · Guide > Setup\n\nbody text");
        // Before any heading: path-only prefix.
        assert_eq!(
            enriched_embed_text("a.md", "", "body"),
            "a.md\n\nbody",
            "path-only context"
        );
        // Non-markdown files (code, image surrogates) still get the path.
        assert_eq!(
            enriched_embed_text("src/main.rs", "", "fn main() {}"),
            "src/main.rs\n\nfn main() {}"
        );
        // No path at all (defensive): content unchanged — the embedding input
        // must never be WORSE than the pre-enrichment bare content.
        assert_eq!(enriched_embed_text("", "", "body"), "body");
        assert_eq!(enriched_embed_text("   ", "  ", "body"), "body");
        // A pathological path+trail is capped, never allowed to eat the body.
        let long = format!("{} — {}", "deep/".repeat(80), "Very > ".repeat(40));
        let got = enriched_embed_text(&long, "", "tail");
        assert!(got.chars().count() < CONTEXT_PREFIX_CAP + 8 + 4);
        assert!(got.ends_with("\n\ntail"));
        assert!(got.contains('…'), "capped prefix is ellipsized");
    }

    #[test]
    fn walker_filters_dirs_caps_and_classifies() {
        let root = std::env::temp_dir().join(format!("relay-docs-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::write(root.join("readme.md"), "hello").unwrap();
        std::fs::write(root.join("sub/photo.png"), [0x89, 0x50, 0x4e, 0x47]).unwrap();
        std::fs::write(root.join("sub/blob.bin"), "nope").unwrap();
        std::fs::write(root.join("node_modules/pkg/index.js"), "skipped").unwrap();
        std::fs::write(root.join(".git/config"), "skipped").unwrap();
        std::fs::write(root.join(".hidden.md"), "skipped").unwrap();

        let entries = walk_corpus(&root);
        let rels: Vec<&str> = entries.iter().map(|e| e.rel_path.as_str()).collect();
        assert_eq!(rels, ["readme.md", "sub/photo.png"]);
        assert_eq!(entries[0].kind, WalkKind::Text);
        assert_eq!(entries[1].kind, WalkKind::Image);
        assert!(entries
            .iter()
            .all(|e| e.size > 0 && !e.rel_path.contains('\\')));

        let _ = std::fs::remove_dir_all(&root);
    }
}
