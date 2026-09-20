//! Obsidian-flavored markdown metadata extraction for the vault index.
//!
//! The vault's source of truth is the plain `.md` files on disk; this parser
//! extracts only the METADATA the index needs (headings, wikilinks, tags,
//! block ids, frontmatter, word count) — rendering fidelity lives in the
//! webview (react-markdown) and the editor (CodeMirror), which see the full
//! syntax. Deliberately NOT comrak: the metadata surface is narrow, and a
//! focused scanner is honest about what it does and doesn't understand
//! (code-fence awareness is the one correctness trap that matters — links,
//! tags, headings and block ids inside fenced code are not metadata).
//!
//! Link spec (help.obsidian.md — Internal links / Embed files):
//!   `[[Note]]` `[[Note|Alias]]` `[[Note#Heading]]` `[[Note#^blockid]]`
//!   `[[#Heading]]` (same-note), embeds `![[...]]`, markdown links
//!   `[text](Note.md#heading)`, image resize `![[img.png|640]]`.
//! Characters `# | ^ : %%` cannot appear in a link path (they are syntax).

/// One parsed `[[...]]` / `![[]]` / markdown link reference.
#[derive(Debug, Clone, PartialEq)]
pub struct LinkRef {
    /// Raw target as written (inside `[[ ]]`, before the first `|`),
    /// e.g. `Folder/Note#Heading`. Empty for same-note heading links.
    pub target: String,
    /// Pipe display text, when present.
    pub display: Option<String>,
    /// `#heading` / `#^blockid` subpath (with the `#`).
    pub subpath: Option<String>,
    /// `![[...]]` / `![alt](x)` transclusion.
    pub is_embed: bool,
    /// Markdown-style `[text](path)` (false for wikilinks).
    pub is_md: bool,
    /// 0-based line the link appears on.
    pub line: usize,
}

impl LinkRef {
    /// The linkpath portion Obsidian resolves (target without subpath).
    /// Empty string = same-note subpath link (`[[#Heading]]`).
    pub fn linkpath(&self) -> &str {
        self.target.split('#').next().unwrap_or("")
    }
}

/// One `#tag` occurrence (inline; frontmatter tags are handled separately).
#[derive(Debug, Clone, PartialEq)]
pub struct TagRef {
    pub tag: String,
    pub line: usize,
}

/// One heading, with its outline level (1–6).
#[derive(Debug, Clone, PartialEq)]
pub struct Heading {
    pub level: u8,
    pub text: String,
    pub line: usize,
}

/// One `^block-id` definition.
#[derive(Debug, Clone, PartialEq)]
pub struct BlockId {
    pub id: String,
    pub line: usize,
}

/// Minimal frontmatter model — the Obsidian Properties subset: top-level
/// scalars plus lists (inline `[a, b]` or `- item` lines). Nested YAML is
/// stored as its raw string (source-mode only, same as Obsidian's UI).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Frontmatter {
    /// Insertion-ordered (key, value) pairs; list values join into `value`
    /// with `, ` — `lists` carries the split items for list-typed keys.
    pub entries: Vec<(String, String)>,
    pub list_keys: Vec<String>,
}

impl Frontmatter {
    pub fn get(&self, key: &str) -> Option<&str> {
        self.entries
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(key))
            .map(|(_, v)| v.as_str())
    }
    pub fn get_list(&self, key: &str) -> Vec<String> {
        let Some(v) = self.get(key) else {
            return Vec::new();
        };
        if self.list_keys.iter().any(|k| k.eq_ignore_ascii_case(key)) {
            split_list(v)
        } else {
            vec![v.to_string()]
        }
    }
}

/// Everything the index needs about one note.
#[derive(Debug, Clone, Default)]
pub struct ParsedNote {
    pub frontmatter: Option<Frontmatter>,
    pub frontmatter_raw: Option<String>,
    pub title: Option<String>,
    pub headings: Vec<Heading>,
    pub links: Vec<LinkRef>,
    pub tags: Vec<TagRef>,
    pub blocks: Vec<BlockId>,
    pub word_count: u32,
}

/// Parse one note's full text into index metadata.
pub fn parse_note(content: &str) -> ParsedNote {
    let mut out = ParsedNote::default();
    let (body, fm) = split_frontmatter(content);
    if let Some((raw, fm)) = fm {
        out.frontmatter_raw = Some(raw);
        out.frontmatter = Some(fm);
    }

    let mut in_fence: Option<String> = None;
    for (idx, line) in body.lines().enumerate() {
        let line_no = idx; // body-relative 0-based
        // Fenced code toggles (``` / ~~~ with optional info string). The
        // fence marker may be indented up to 3 spaces (CommonMark).
        let trimmed = line.trim_start();
        if trimmed.len() >= 3 {
            for fence in ["```", "~~~"] {
                if trimmed.starts_with(fence) {
                    match &in_fence {
                        None => in_fence = Some(fence.to_string()),
                        Some(open) if open == fence => in_fence = None,
                        _ => {}
                    }
                    break;
                }
            }
        }
        if in_fence.is_some() {
            // Content inside a fence is code, not metadata. Word count still
            // counts it (it's file body text).
            out.word_count += line.split_whitespace().count() as u32;
            continue;
        }

        // Headings: ATX `#{1,6} text` (require the space; `#tag` is a tag).
        let heading = parse_heading(line, line_no);
        if let Some(h) = &heading {
            if out.title.is_none() && h.level == 1 {
                out.title = Some(h.text.clone());
            }
        }

        // Block ids: `^id` at end of a paragraph/list/quote line, or a bare
        // `^id` line below a list/quote/table (Obsidian's own convention).
        if let Some(id) = parse_block_id(line) {
            out.blocks.push(BlockId { id, line: line_no });
        }

        // Blank out spans that are NOT content for link/tag purposes:
        // inline code spans and the link spans themselves (a URL fragment
        // `page#sec` must not become a tag; `[[#x]]` must not double-count).
        // Both masks are byte-length preserving, so the spans scan_links
        // reports map 1:1 onto the ORIGINAL line (rewrite needs that).
        let code_masked = mask_inline_code(line);
        let links = scan_links(&code_masked, line_no);
        let mut tagscan = code_masked.clone().into_bytes();
        for l in &links {
            for b in &mut tagscan[l.span_start..l.span_end] {
                *b = b' ';
            }
        }
        out.links.extend(links.into_iter().map(|l| LinkRef {
            target: l.target,
            display: l.display,
            subpath: l.subpath,
            is_embed: l.is_embed,
            is_md: l.is_md,
            line: l.line,
        }));

        for t in scan_tags(&String::from_utf8_lossy(&tagscan), line_no) {
            out.tags.push(t);
        }
        // Heading markers (`#`) are markup, not words.
        match &heading {
            Some(h) => {
                out.headings.push(h.clone());
                out.word_count += h.text.split_whitespace().count() as u32;
            }
            None => out.word_count += line.split_whitespace().count() as u32,
        }
    }
    out
}

/// Split leading `---` frontmatter. Returns (body, Some((raw_yaml, parsed)))
/// when a well-formed fence is present. Walks the content with a byte cursor
/// instead of `lines()` arithmetic: `lines()` strips `\r`, so counting
/// `line.len() + 1` per line drifts one byte short per CRLF line — the body
/// offset lands inside the closing fence, shifting every indexed line number
/// (and, if the drift cuts a multibyte char, silently emptying the body).
pub fn split_frontmatter(content: &str) -> (&str, Option<(String, Frontmatter)>) {
    let bytes = content.as_bytes();
    let mut pos = 0usize;
    let mut yaml = String::new();
    let mut first = true;
    while pos < content.len() {
        let nl = content[pos..].find('\n').map(|i| pos + i);
        let line_end = nl.unwrap_or(content.len());
        let mut text_end = line_end;
        if text_end > pos && bytes[text_end - 1] == b'\r' {
            text_end -= 1; // CRLF: the \r belongs to the ending, not the line
        }
        let line = &content[pos..text_end];
        if first {
            first = false;
            if line.trim_end() != "---" {
                return (content, None);
            }
        } else if line.trim_end() == "---" {
            let body_offset = nl.map_or(content.len(), |i| i + 1);
            let fm = parse_frontmatter(&yaml);
            return (
                &content[body_offset..],
                Some((yaml.trim_end().to_string(), fm)),
            );
        } else {
            yaml.push_str(line);
            yaml.push('\n');
        }
        pos = nl.map_or(content.len(), |i| i + 1);
    }
    // Unterminated fence: not frontmatter.
    (content, None)
}

/// Parse the Obsidian-Properties YAML subset: `key: scalar`, `key:` followed
/// by `- item` lines, and inline lists `key: [a, b]`. Unknown nesting is
/// kept as raw indented text under its key.
pub fn parse_frontmatter(yaml: &str) -> Frontmatter {
    let mut fm = Frontmatter::default();
    let mut current: Option<(String, String, bool)> = None; // key, value, is_list
    let mut flush = |cur: &mut Option<(String, String, bool)>, fm: &mut Frontmatter| {
        if let Some((k, v, is_list)) = cur.take() {
            let v = v.trim().to_string();
            if !v.is_empty() || is_list {
                if is_list {
                    fm.list_keys.push(k.clone());
                }
                fm.entries.push((k, v));
            }
        }
    };
    for raw_line in yaml.lines() {
        let line = raw_line.trim_end();
        if line.trim().is_empty() {
            continue;
        }
        let item = line.trim_start();
        if item.starts_with("- ") || item == "-" {
            if let Some((_, v, is_list)) = current.as_mut() {
                *is_list = true;
                let entry = item.trim_start_matches('-').trim();
                if !entry.is_empty() {
                    if v.is_empty() {
                        v.push_str(entry);
                    } else {
                        v.push_str(", ");
                        v.push_str(entry);
                    }
                }
                continue;
            }
            // List item with no owning key (malformed) — ignore.
            continue;
        }
        if let Some(colon) = split_key_value(line) {
            flush(&mut current, &mut fm);
            let (k, v) = colon;
            let v = v.trim();
            if v.starts_with('[') && v.ends_with(']') {
                let items = split_list(&v[1..v.len().saturating_sub(1)]);
                fm.list_keys.push(k.clone());
                fm.entries.push((k, items.join(", ")));
            } else {
                current = Some((k, v.trim_matches('"').trim_matches('\'').to_string(), false));
            }
        }
        // Lines that are neither keys nor list items (nested maps) are
        // intentionally dropped from the property list — source mode still
        // shows the raw YAML via frontmatter_raw.
    }
    flush(&mut current, &mut fm);
    fm
}

/// Split `key: value` at the first `: ` / trailing `:` (the YAML top-level
/// rule; `http://x` values therefore don't split — the colon isn't followed
/// by a space or EOL... actually `url: http://x` splits at the FIRST colon
/// only when it is followed by space-or-EOL, which `http://x` is not).
fn split_key_value(line: &str) -> Option<(String, String)> {
    let bytes = line.as_bytes();
    for i in 0..bytes.len() {
        if bytes[i] == b':' {
            let eol = i + 1 >= bytes.len();
            if eol || bytes[i + 1] == b' ' {
                let key = line[..i].trim().to_string();
                if key.is_empty() || key.contains(' ') || key.starts_with('#') {
                    return None;
                }
                return Some((key, line[i + 1..].to_string()));
            }
        }
    }
    None
}

fn split_list(s: &str) -> Vec<String> {
    s.split(',')
        .map(|p| p.trim().trim_matches('"').trim_matches('\'').to_string())
        .filter(|p| !p.is_empty())
        .collect()
}

fn parse_heading(line: &str, line_no: usize) -> Option<Heading> {
    let hashes = line.len() - line.trim_start_matches('#').len();
    if hashes == 0 || hashes > 6 {
        return None;
    }
    let rest = &line[hashes..];
    if !rest.starts_with(' ') {
        return None; // `#tag`, not a heading
    }
    let text = rest.trim().trim_end_matches('#').trim();
    if text.is_empty() {
        return None; // bare `#` line
    }
    Some(Heading {
        level: hashes as u8,
        text: text.to_string(),
        line: line_no,
    })
}

fn parse_block_id(line: &str) -> Option<String> {
    let t = line.trim();
    // Obsidian block ids: alphanumeric + `-`.
    let valid = |s: &str| {
        !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    };
    // Standalone `^id` line (below lists/quotes/tables).
    if let Some(id) = t.strip_prefix('^') {
        if !id.contains(char::is_whitespace) && valid(id) {
            return Some(id.to_string());
        }
        return None;
    }
    // Trailing form: the last whitespace-separated token is `^id`.
    let (before, last) = t.rsplit_once(char::is_whitespace)?;
    let id = last.strip_prefix('^')?;
    if valid(id) && !before.trim().is_empty() {
        return Some(id.to_string());
    }
    None
}

/// A scanned span on a line (internal — spans let us mask links out of the
/// tag scan without losing their structured data).
#[derive(Debug)]
struct SpanLink {
    target: String,
    display: Option<String>,
    subpath: Option<String>,
    is_embed: bool,
    is_md: bool,
    /// Markdown links spell their targets with `.md`; the index stores the
    /// stem (wikilink-compatible), and the rewrite restores the extension.
    md_had_ext: bool,
    line: usize,
    span_start: usize,
    span_end: usize,
}

/// Blank inline code spans (`…``…``…`) — BYTE-LENGTH preserving (each char
/// becomes as many spaces as its UTF-8 width) so downstream byte offsets
/// (link spans) map onto the original line unchanged.
fn mask_inline_code(line: &str) -> String {
    let chars: Vec<char> = line.chars().collect();
    let mut out = String::with_capacity(line.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '`' {
            let mut j = i + 1;
            while j < chars.len() && chars[j] != '`' {
                j += 1;
            }
            if j < chars.len() {
                for c in &chars[i..=j] {
                    for _ in 0..c.len_utf8() {
                        out.push(' ');
                    }
                }
                i = j + 1;
                continue;
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

fn scan_links(line: &str, line_no: usize) -> Vec<SpanLink> {
    let mut out = Vec::new();
    let chars: Vec<char> = line.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        // Embed/image: `![[` or `![`.
        let is_embed = chars[i] == '!'
            && i + 1 < chars.len()
            && (chars[i + 1] == '[');
        let bracket = if is_embed { i + 1 } else { i };
        if bracket + 1 < chars.len() && chars[bracket] == '[' {
            // Wikilink `[[target|display]]` vs markdown `[text](url)`.
            if bracket + 1 < chars.len() && chars[bracket + 1] == '[' {
                if let Some(close) = find_seq(&chars, bracket + 2, "]]") {
                    let inner: String = chars[bracket + 2..close].iter().collect();
                    out.push(wikilink(&inner, is_embed, line_no, char_off(&chars, i), char_off(&chars, close + 2)));
                    i = close + 2;
                    continue;
                }
            }
            // Markdown link: find `](` then the closing `)`.
            if let Some(paren) = find_md_paren(&chars, bracket + 1) {
                let text: String = chars[bracket + 1..paren.0].iter().collect();
                let url: String = chars[paren.1 + 1..paren.2].iter().collect();
                out.push(md_link(&text, &url, is_embed, line_no, char_off(&chars, i), char_off(&chars, paren.2 + 1)));
                i = paren.2 + 1;
                continue;
            }
        }
        i += 1;
    }
    out
}

fn find_seq(chars: &[char], from: usize, pat: &str) -> Option<usize> {
    let p: Vec<char> = pat.chars().collect();
    (from..chars.len().saturating_sub(p.len() - 1))
        .find(|&i| (0..p.len()).all(|k| chars[i + k] == p[k]))
}

/// Find `](`…`)` starting the scan after a `[`. Returns (bracket_close_idx,
/// paren_open_idx, paren_close_idx).
fn find_md_paren(chars: &[char], from: usize) -> Option<(usize, usize, usize)> {
    let mut i = from;
    while i < chars.len() {
        if chars[i] == ']' && i + 1 < chars.len() && chars[i + 1] == '(' {
            let open = i + 1;
            let mut j = open + 1;
            while j < chars.len() && chars[j] != ')' && !chars[j].is_whitespace() {
                j += 1;
            }
            if j < chars.len() && chars[j] == ')' {
                return Some((i, open, j));
            }
        }
        i += 1;
    }
    None
}

fn char_off(chars: &[char], idx: usize) -> usize {
    chars[..idx.min(chars.len())].iter().map(|c| c.len_utf8()).sum()
}

fn wikilink(inner: &str, is_embed: bool, line: usize, start: usize, end: usize) -> SpanLink {
    // Inner = `target|display`; target = `path#subpath`.
    let (target_raw, display) = match inner.split_once('|') {
        Some((t, d)) => (t.trim().to_string(), Some(d.trim().to_string())),
        None => (inner.trim().to_string(), None),
    };
    let (target, subpath) = match target_raw.split_once('#') {
        Some((t, s)) => (t.trim().to_string(), Some(format!("#{s}"))),
        None => (target_raw.clone(), None),
    };
    // Image-size display `![[img.png|640]]` keeps `display` — the frontend
    // uses it for sizing; resolution only ever looks at `target`.
    SpanLink {
        target,
        display,
        subpath,
        is_embed,
        is_md: false,
        md_had_ext: false,
        line,
        span_start: start,
        span_end: end,
    }
}

fn md_link(text: &str, url: &str, is_embed: bool, line: usize, start: usize, end: usize) -> SpanLink {
    let url = url.trim();
    // Only INTERNAL links join the link graph: relative md paths to vault
    // files. http(s)/mailto/absolute-OS links are external (rendered as <a>).
    let internal = !url.is_empty()
        && !url.contains("://")
        && !url.starts_with('#')
        && !url.starts_with('/')
        && !url.starts_with("mailto:");
    let decoded = internal
        .then(|| url.replace("%20", " "))
        .unwrap_or_default();
    let (raw_target, subpath) = match decoded.split_once('#') {
        Some((t, s)) => (t.trim().to_string(), Some(format!("#{s}"))),
        None => (decoded.clone(), None),
    };
    let md_had_ext = raw_target.to_ascii_lowercase().ends_with(".md");
    // Wikilink-compatible stem for the index (resolve_link strips `.md`
    // anyway; storing the stem keeps `raw` uniform for unresolved lookups).
    let target = if md_had_ext {
        raw_target[..raw_target.len() - 3].to_string()
    } else {
        raw_target
    };
    SpanLink {
        target: if internal { target } else { String::new() },
        display: (!text.is_empty()).then(|| text.to_string()),
        subpath: internal.then_some(subpath).flatten(),
        is_embed,
        is_md: true,
        md_had_ext,
        line,
        span_start: start,
        span_end: end,
    }
}

fn scan_tags(line: &str, line_no: usize) -> Vec<TagRef> {
    let mut out = Vec::new();
    let bytes = line.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'#' {
            i += 1;
            continue;
        }
        // Not a tag when preceded by a word char, another '#', or '-'
        // (headings `## x` handled by the '#' check; `#` in `##` pairs).
        if i > 0 {
            let prev = bytes[i - 1];
            if prev.is_ascii_alphanumeric() || prev == b'-' || prev == b'_' || prev == b'#' {
                i += 1;
                continue;
            }
        }
        let mut j = i + 1;
        // First char must be a letter (Obsidian: no leading digit).
        if j < bytes.len() && bytes[j].is_ascii_alphabetic() {
            while j < bytes.len()
                && (bytes[j].is_ascii_alphanumeric() || bytes[j] == b'_' || bytes[j] == b'-' || bytes[j] == b'/')
            {
                j += 1;
            }
            // Trailing separators are punctuation, not part of the tag.
            let mut end = j;
            while end > i + 1 && (bytes[end - 1] == b'-' || bytes[end - 1] == b'/') {
                end -= 1;
            }
            let tag = line[i + 1..end].to_string();
            if !tag.is_empty() {
                out.push(TagRef { tag, line: line_no });
            }
            i = j;
            continue;
        }
        i += 1;
    }
    out
}

// ---------------------------------------------------------------------------
// Link resolution (Files & links rules)
// ---------------------------------------------------------------------------

/// A file record the resolver needs. `aliases` is the parsed frontmatter list.
#[derive(Debug, Clone)]
pub struct FileMeta {
    /// Vault-relative path with extension, forward slashes.
    pub path: String,
    pub basename: String,
    pub folder: String,
    pub aliases: Vec<String>,
    pub is_note: bool,
}

/// Normalize a raw linkpath for matching: trim, strip a trailing `.md`,
/// forward slashes, no leading `./`.
pub fn normalize_linkpath(raw: &str) -> String {
    let mut s = raw.trim().replace('\\', "/");
    while let Some(stripped) = s.strip_prefix("./") {
        s = stripped.to_string();
    }
    if s.to_ascii_lowercase().ends_with(".md") {
        s.truncate(s.len() - 3);
    }
    s
}

/// Resolve a linkpath against the vault file map (Obsidian Files & links
/// rules): case-insensitive; full-path match first; else basename (or alias)
/// match, shortest path wins, lexicographic tiebreak. Returns the winning
/// file's vault path.
pub fn resolve_link(linkpath: &str, files: &[FileMeta]) -> Option<String> {
    let norm = normalize_linkpath(linkpath);
    if norm.is_empty() {
        return None;
    }
    let norm_lc = norm.to_ascii_lowercase();
    // 1. Full path match (with or without the .md extension).
    if let Some(f) = files.iter().find(|f| f.path.to_ascii_lowercase() == norm_lc) {
        return Some(f.path.clone());
    }
    if let Some(f) = files
        .iter()
        .find(|f| f.path.to_ascii_lowercase() == format!("{norm_lc}.md"))
    {
        return Some(f.path.clone());
    }
    // 2. Basename match (shortest path wins, then lexicographic).
    let base_lc = norm.rsplit('/').next().unwrap_or(&norm).to_ascii_lowercase();
    let mut candidates: Vec<&FileMeta> = files
        .iter()
        .filter(|f| f.basename.to_ascii_lowercase() == base_lc)
        .collect();
    // 3. Alias match joins the same candidate pool (alias → whole file).
    candidates.extend(
        files
            .iter()
            .filter(|f| f.aliases.iter().any(|a| a.to_ascii_lowercase() == base_lc)),
    );
    candidates
        .into_iter()
        .min_by_key(|f| (f.path.len(), f.path.clone()))
        .map(|f| f.path.clone())
}

/// The "shortest path when possible" linktext for a destination, computed
/// against the post-change file list: bare basename when unique among
/// basenames, else the minimal folder prefix that disambiguates (growing
/// from the basename leftward), else the full normalized path (e.g. a
/// root-level file can only be disambiguated by its full name).
pub fn shortest_linktext(dest: &str, files: &[FileMeta]) -> String {
    let with_ext = dest.trim().replace('\\', "/");
    let norm = normalize_linkpath(&with_ext);
    let base = norm.rsplit('/').next().unwrap_or(&norm);
    let base_matches = files
        .iter()
        .filter(|f| normalize_linkpath(&f.path).rsplit('/').next() == Some(base))
        .count();
    if base_matches <= 1 {
        return base.to_string();
    }
    let segs: Vec<&str> = norm.split('/').collect();
    let n = segs.len();
    for depth in 1..n {
        let prefix = segs[n - 1 - depth..].join("/");
        let count = files
            .iter()
            .filter(|f| {
                let p = normalize_linkpath(&f.path);
                p.eq_ignore_ascii_case(&prefix) || p.to_ascii_lowercase().ends_with(&format!("/{prefix}").to_ascii_lowercase())
            })
            .count();
        if count <= 1 {
            return prefix;
        }
    }
    // Even the full sans-extension path is ambiguous (e.g. `Folder/Note`
    // matching `Deep/Folder/Note`): Obsidian falls back to the spelled-out
    // filename WITH extension, which is filesystem-unique.
    with_ext
}

/// Rewrite every link in `content` that resolves (against `files`) to
/// `old_path`, replacing only the target text with `new_linktext` — display
/// text and subpaths survive, and each line keeps its original line ending
/// (LF stays LF, CRLF stays CRLF — renaming a note must not flip the line
/// endings of every file that links to it). Returns (new_content, rewrite_count).
pub fn rewrite_inbound_links(
    content: &str,
    old_path: &str,
    new_linktext: &str,
    files: &[FileMeta],
) -> (String, usize) {
    let old_norm = normalize_linkpath(old_path);
    let mut out = String::with_capacity(content.len() + 16);
    let mut rewrites = 0usize;
    let bytes = content.as_bytes();
    let mut pos = 0usize;
    while pos < content.len() {
        let nl = content[pos..].find('\n').map(|i| pos + i);
        let line_end = nl.unwrap_or(content.len());
        // Split a CRLF's \r off so parsing sees the same text `lines()` did;
        // the ending itself is re-emitted verbatim below.
        let had_cr = line_end > pos && bytes[line_end - 1] == b'\r';
        let text_end = if had_cr { line_end - 1 } else { line_end };
        let line = &content[pos..text_end];
        // Spans are byte offsets into the masked line, which is
        // byte-length-identical to `line` (both masks preserve width).
        let code_masked = mask_inline_code(line);
        let links = scan_links(&code_masked, 0);
        let hits: Vec<&SpanLink> = links
            .iter()
            .filter(|l| {
                let dest = normalize_linkpath(&l.target);
                if dest.is_empty() {
                    return false;
                }
                // A link counts as inbound when it RESOLVES to the renamed
                // file, or spells its path exactly (an ambiguous-same-basename
                // spelling that resolves elsewhere must not be rewritten).
                resolve_link(&dest, files)
                    .as_deref()
                    .map(|p| normalize_linkpath(p).eq_ignore_ascii_case(&old_norm))
                    .unwrap_or(false)
                    || dest.eq_ignore_ascii_case(&old_norm)
            })
            .collect();
        if hits.is_empty() {
            out.push_str(line);
        } else {
            // Ordered single pass over the original line.
            let mut last = 0usize;
            for l in &hits {
                out.push_str(&line[last..l.span_start]);
                let subpath = l.subpath.clone().unwrap_or_default();
                if l.is_md {
                    let display = l.display.clone().unwrap_or_default();
                    let encoded = new_linktext.replace(' ', "%20");
                    // Markdown links spell notes with their extension; keep
                    // that convention when the original had it.
                    let ext = if l.md_had_ext && !new_linktext.to_ascii_lowercase().ends_with(".md") {
                        ".md"
                    } else {
                        ""
                    };
                    out.push_str(&format!("[{display}]({encoded}{ext}{subpath})"));
                } else {
                    let bang = if l.is_embed { "!" } else { "" };
                    // Obsidian order: target, then #subpath, then |alias —
                    // the subpath targets the destination, so it must stay
                    // BEFORE the pipe (an alias with the subpath appended is
                    // display text, and the heading target is lost).
                    match &l.display {
                        Some(d) => out.push_str(&format!("{bang}[[{new_linktext}{subpath}|{d}]]")),
                        None => out.push_str(&format!("{bang}[[{new_linktext}{subpath}]]")),
                    }
                }
                last = l.span_end;
                rewrites += 1;
            }
            out.push_str(&line[last..]);
        }
        match nl {
            Some(i) => {
                if had_cr {
                    out.push_str("\r\n");
                } else {
                    out.push('\n');
                }
                pos = i + 1;
            }
            None => pos = content.len(),
        }
    }
    (out, rewrites)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_headings_title_and_word_count() {
        let n = parse_note("# My Title\n\nSome words here.\n\n## Sub\nmore words");
        assert_eq!(n.title.as_deref(), Some("My Title"));
        assert_eq!(n.headings.len(), 2);
        assert_eq!(n.headings[0].level, 1);
        assert_eq!(n.headings[1].text, "Sub");
        assert_eq!(n.word_count, 8); // includes the heading words
    }

    #[test]
    fn hash_prefix_without_space_is_not_a_heading() {
        let n = parse_note("#tag not heading\n# Real");
        assert_eq!(n.headings.len(), 1);
        assert!(n.tags.iter().any(|t| t.tag == "tag"));
    }

    #[test]
    fn wikilink_variants() {
        let n = parse_note(
            "a [[Note]] b [[Folder/Note|alias]] c [[Note#Head]] d [[#Same]] e ![[Img.png|640]]",
        );
        let links = &n.links;
        assert_eq!(links.len(), 5);
        assert_eq!(links[0].target, "Note");
        assert!(links[0].display.is_none());
        assert_eq!(links[1].target, "Folder/Note");
        assert_eq!(links[1].display.as_deref(), Some("alias"));
        assert_eq!(links[2].subpath.as_deref(), Some("#Head"));
        assert_eq!(links[3].target, "");
        assert_eq!(links[3].subpath.as_deref(), Some("#Same"));
        assert!(links[4].is_embed);
        assert_eq!(links[4].display.as_deref(), Some("640"));
    }

    #[test]
    fn code_fences_hide_metadata() {
        let n = parse_note(
            "real [[Link]]\n```rust\nlet s = \"[[Fake]]\";\n# not heading\n#faketag\n```\nafter [[Real2]]",
        );
        let targets: Vec<&str> = n.links.iter().map(|l| l.target.as_str()).collect();
        assert_eq!(targets, vec!["Link", "Real2"]);
        assert!(n.tags.is_empty());
        assert!(n.headings.is_empty());
    }

    #[test]
    fn inline_code_hides_links_and_tags() {
        let n = parse_note("use `[[NotALink]]` and `#nottag` then [[Yes]] #yes");
        assert_eq!(n.links.len(), 1);
        assert_eq!(n.links[0].target, "Yes");
        assert_eq!(n.tags.len(), 1);
        assert_eq!(n.tags[0].tag, "yes");
    }

    #[test]
    fn tags_rules() {
        let n = parse_note("#ok #with/sub #under_score #digit1 no#space #\n- item");
        let tags: Vec<&str> = n.tags.iter().map(|t| t.tag.as_str()).collect();
        assert!(tags.contains(&"ok"));
        assert!(tags.contains(&"with/sub"));
        assert!(tags.contains(&"under_score"));
        assert!(tags.contains(&"digit1"));
        assert!(!tags.contains(&"space"), "no#space must not produce 'space'");
    }

    #[test]
    fn url_fragments_are_not_tags() {
        let n = parse_note("see https://example.com/page#section");
        assert!(n.tags.is_empty());
    }

    #[test]
    fn md_internal_links_indexed_externals_not() {
        let n = parse_note(
            "[local](Folder/Note.md) [frag](#head) [web](https://x.y) [img](a.png)",
        );
        let internal: Vec<&LinkRef> = n.links.iter().filter(|l| !l.target.is_empty()).collect();
        assert_eq!(internal.len(), 2, "local + image file are internal");
        assert_eq!(internal[0].target, "Folder/Note");
        assert!(internal[0].subpath.is_none());
        assert_eq!(internal[1].target, "a.png");
    }

    #[test]
    fn md_link_spaces_encoded() {
        let n = parse_note("[t](My%20Note.md)");
        assert_eq!(n.links[0].target, "My Note");
    }

    #[test]
    fn block_ids() {
        let n = parse_note("paragraph text ^abc123\n- list item\n^list-id\nplain");
        assert_eq!(n.blocks.len(), 2);
        assert_eq!(n.blocks[0].id, "abc123");
        assert_eq!(n.blocks[1].id, "list-id");
    }

    #[test]
    fn frontmatter_subset() {
        let content = "---\ntitle: Hello\ntags: [a, b]\naliases:\n  - First\n  - Second\nstatus: done\nurl: https://x.y\n---\n# Body";
        let n = parse_note(content);
        let fm = n.frontmatter.unwrap();
        assert_eq!(fm.get("title"), Some("Hello"));
        assert_eq!(fm.get("status"), Some("done"));
        assert_eq!(fm.get("url"), Some("https://x.y"));
        assert_eq!(fm.get_list("tags"), vec!["a", "b"]);
        assert_eq!(fm.get_list("aliases"), vec!["First", "Second"]);
        assert_eq!(n.title.as_deref(), Some("Body"), "H1 beats frontmatter title for outline title");
    }

    #[test]
    fn unterminated_frontmatter_is_body() {
        let n = parse_note("---\nnot: closed");
        assert!(n.frontmatter.is_none());
        assert!(n.links.is_empty());
    }

    #[test]
    fn crlf_frontmatter_splits_at_the_exact_body_offset() {
        // Byte-cursor accounting: one \r per line must not shift the body.
        let content = "---\r\naliases: [X]\r\n---\r\n# Title\r\nbody [[Link]]";
        let (body, fm) = split_frontmatter(content);
        assert_eq!(body, "# Title\r\nbody [[Link]]");
        assert!(fm.is_some());
        let n = parse_note(content);
        assert_eq!(n.title.as_deref(), Some("Title"));
        assert_eq!(n.links.len(), 1);
        assert_eq!(n.links[0].line, 1, "body-relative line, not shifted by CRLF");
        assert_eq!(n.headings.len(), 1);
        assert_eq!(n.headings[0].line, 0);
    }

    #[test]
    fn crlf_frontmatter_with_multibyte_yaml_keeps_body() {
        // The old offset math could land mid-UTF-8 char and silently
        // produce an empty body; the byte cursor cannot.
        let content = "---\r\n别名: 值一\r\n别名二: 值二\r\n别名三: 值三\r\n---\r\n# 好";
        let n = parse_note(content);
        assert_eq!(n.headings.len(), 1);
        assert_eq!(n.headings[0].text, "好");
    }

    #[test]
    fn frontmatter_empty_body_and_no_trailing_newline() {
        let (body, fm) = split_frontmatter("---\nk: v\n---");
        assert_eq!(body, "");
        assert!(fm.is_some());
        let (body2, fm2) = split_frontmatter("---\r\nk: v\r\n---\r\n");
        assert_eq!(body2, "");
        assert!(fm2.is_some());
    }

    fn files() -> Vec<FileMeta> {
        vec![
            FileMeta { path: "Note.md".into(), basename: "Note".into(), folder: "".into(), aliases: vec!["The Alias".into()], is_note: true },
            FileMeta { path: "Folder/Note.md".into(), basename: "Note".into(), folder: "Folder".into(), aliases: vec![], is_note: true },
            FileMeta { path: "Deep/Folder/Note.md".into(), basename: "Note".into(), folder: "Deep/Folder".into(), aliases: vec![], is_note: true },
            FileMeta { path: "Daily/2026-09-19.md".into(), basename: "2026-09-19".into(), folder: "Daily".into(), aliases: vec![], is_note: true },
        ]
    }

    #[test]
    fn resolve_prefers_exact_path_then_shortest_basename() {
        let f = files();
        assert_eq!(resolve_link("Folder/Note", &f).as_deref(), Some("Folder/Note.md"));
        assert_eq!(resolve_link("folder/note.md", &f).as_deref(), Some("Folder/Note.md"));
        assert_eq!(resolve_link("note", &f).as_deref(), Some("Note.md"), "shortest path wins");
        assert_eq!(resolve_link("The Alias", &f).as_deref(), Some("Note.md"), "aliases resolve");
        assert_eq!(resolve_link("Missing", &f), None);
    }

    #[test]
    fn resolve_case_insensitive_on_all_platforms() {
        let f = files();
        assert_eq!(resolve_link("daily/2026-09-19", &f).as_deref(), Some("Daily/2026-09-19.md"));
    }

    #[test]
    fn shortest_linktext_disambiguates() {
        // Ambiguous bare basename at the ROOT: only the full name
        // distinguishes it (dest has no folder segments to grow).
        let mut f = files();
        f.remove(1); // remove Folder/Note.md → Note.md vs Deep/Folder/Note.md
        assert_eq!(shortest_linktext("Note.md", &f), "Note.md");
        // Three same-basename files: minimal folder prefix wins.
        let f = files();
        // `Folder/Note` is ambiguous (Deep/Folder/Note ends with it) so the
        // extension form is the only unique spelling.
        assert_eq!(shortest_linktext("Folder/Note.md", &f), "Folder/Note.md");
        assert_eq!(shortest_linktext("Deep/Folder/Note.md", &f), "Deep/Folder/Note");
        // Unique basename → bare.
        let single = vec![files().remove(0)];
        assert_eq!(single.first().unwrap().path, "Note.md");
        assert_eq!(shortest_linktext("Note.md", &single), "Note");
    }

    #[test]
    fn rewrite_keeps_display_and_subpath() {
        let content = "see [[Old Name|the old]] and [[Old Name#Head]] ![[Old Name]] [md](Old%20Name.md#x)";
        let files = vec![FileMeta {
            path: "Old Name.md".into(),
            basename: "Old Name".into(),
            folder: "".into(),
            aliases: vec![],
            is_note: true,
        }];
        let (out, n) = rewrite_inbound_links(content, "Old Name.md", "New Name", &files);
        assert_eq!(n, 4);
        assert!(out.contains("[[New Name|the old]]"), "out: {out}");
        assert!(out.contains("[[New Name#Head]]"));
        assert!(out.contains("![[New Name]]"));
        assert!(out.contains("[md](New%20Name.md#x)"));
    }

    #[test]
    fn rewrite_keeps_subpath_before_alias_in_wikilinks() {
        // `[[Old#Head|alias]]`: the subpath targets the destination and must
        // stay before the pipe — `[[New|alias#Head]]` demotes it to display
        // text and the heading link is lost.
        let content = "[[Old#Head|see here]] and [[Old#^abc|ref]]";
        let files = vec![FileMeta {
            path: "Old.md".into(),
            basename: "Old".into(),
            folder: "".into(),
            aliases: vec![],
            is_note: true,
        }];
        let (out, n) = rewrite_inbound_links(content, "Old.md", "New", &files);
        assert_eq!(n, 2);
        assert!(out.contains("[[New#Head|see here]]"), "out: {out}");
        assert!(out.contains("[[New#^abc|ref]]"), "out: {out}");
    }

    #[test]
    fn rewrite_preserves_crlf_line_endings() {
        let content = "top\r\nlink [[Old]] here\r\nlast no newline";
        let files = vec![FileMeta {
            path: "Old.md".into(),
            basename: "Old".into(),
            folder: "".into(),
            aliases: vec![],
            is_note: true,
        }];
        let (out, n) = rewrite_inbound_links(content, "Old.md", "New", &files);
        assert_eq!(n, 1);
        assert_eq!(out, "top\r\nlink [[New]] here\r\nlast no newline");
        // And an LF file stays LF.
        let (out2, _) = rewrite_inbound_links("a\n[[Old]]\n", "Old.md", "New", &files);
        assert_eq!(out2, "a\n[[New]]\n");
    }

    #[test]
    fn rewrite_leaves_unrelated_links() {
        let content = "[[Other]] [[Old Name 2]]";
        let files = vec![FileMeta {
            path: "Old Name.md".into(),
            basename: "Old Name".into(),
            folder: "".into(),
            aliases: vec![],
            is_note: true,
        }];
        let (out, n) = rewrite_inbound_links(content, "Old Name.md", "New", &files);
        assert_eq!(n, 0);
        assert_eq!(out, content);
    }

    #[test]
    fn mask_inline_code_handles_utf8() {
        let s = "héllo `code` wörld";
        assert_eq!(mask_inline_code(s), "héllo        wörld");
    }
}
