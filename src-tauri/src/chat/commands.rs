//! Chat mode IPC command handlers (CONTRACT.md "Chat" section).

use std::sync::Arc;

use tauri::{AppHandle, State};

use crate::chat::providers::*;
use crate::db;
use crate::secrets;
use crate::types::*;
use crate::DbState;

type CmdResult<T> = Result<T, String>;

// ---- Chat session CRUD ----

/// Removes `<think>…</think>` reasoning blocks (display-only) from a message
/// before it is sent back to the API as conversation history.
fn strip_think_blocks(content: &str) -> String {
    let mut out = String::with_capacity(content.len());
    let mut rest = content;
    while let Some(start) = rest.find("<think>") {
        out.push_str(&rest[..start]);
        match rest[start..].find("</think>") {
            Some(end) => rest = &rest[start + end + "</think>".len()..],
            None => {
                rest = "";
                break;
            }
        }
    }
    out.push_str(rest);
    out.trim().to_string()
}

#[tauri::command]
pub fn list_chat_sessions(db: State<DbState>) -> CmdResult<Vec<ChatSession>> {
    let conn = db.0.lock();
    db::list_chat_sessions(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_chat_session(
    provider: String,
    model: String,
    db: State<DbState>,
) -> CmdResult<ChatSession> {
    let conn = db.0.lock();
    db::create_chat_session(&conn, &provider, &model).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_chat_session(
    chat_session_id: String,
    db: State<DbState>,
) -> CmdResult<()> {
    let conn = db.0.lock();
    db::delete_chat_session(&conn, &chat_session_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_chat_session_model(
    chat_session_id: String,
    model: String,
    db: State<DbState>,
) -> CmdResult<()> {
    let conn = db.0.lock();
    db::update_chat_session_model(&conn, &chat_session_id, &model).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_chat_session_title(
    chat_session_id: String,
    title: String,
    db: State<DbState>,
) -> CmdResult<()> {
    let conn = db.0.lock();
    db::update_chat_session_title(&conn, &chat_session_id, &title).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_chat_messages(
    chat_session_id: String,
    db: State<DbState>,
) -> CmdResult<Vec<ChatMessageRecord>> {
    let conn = db.0.lock();
    db::list_chat_messages(&conn, &chat_session_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn touch_chat_session(
    chat_session_id: String,
    db: State<DbState>,
) -> CmdResult<()> {
    let conn = db.0.lock();
    db::touch_chat_session(&conn, &chat_session_id).map_err(|e| e.to_string())
}

// ---- Send / cancel ----

/// Persists the user message, looks up provider/model/api_key/base_url for the
/// session, assembles messages from history, and kicks off streaming.
#[tauri::command]
pub async fn send_chat_message(
    chat_session_id: String,
    content: String,
    effort: Option<String>,
    tools_enabled: Option<bool>,
    code_exec_enabled: Option<bool>,
    chat_state: State<'_, crate::ChatState>,
    db: State<'_, DbState>,
    app: AppHandle,
) -> CmdResult<()> {
    let chat_mgr = &chat_state.0;
    // 1. Look up the session.
    let (provider_str, model_str) = {
        let conn = db.0.lock();
        let cs = db::get_chat_session(&conn, &chat_session_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "chat session not found".to_string())?;
        (cs.provider, cs.model)
    };

    // 2. Persist the user message.
    {
        let conn = db.0.lock();
        db::add_chat_message(&conn, &chat_session_id, "user", &content, None, None, None)
            .map_err(|e| e.to_string())?;
        db::touch_chat_session(&conn, &chat_session_id).map_err(|e| e.to_string())?;
    }

    // 3. Resolve provider id.
    let provider_id: ChatProviderId = match provider_str.as_str() {
        "anthropic" => ChatProviderId::Anthropic,
        "openai" => ChatProviderId::OpenAI,
        "anthropic_compatible" => ChatProviderId::AnthropicCompatible,
        "openai_compatible" => ChatProviderId::OpenAICompatible,
        other => return Err(format!("unknown provider: {other}")),
    };

    // 4. Load API key from keychain.
    let api_key = {
        let conn = db.0.lock();
        secrets::get_chat_api_key(&conn, &provider_str)
    }
    .ok_or_else(|| format!("no API key configured for provider: {provider_str}"))?;

    // 5. Load optional base_url and model override from app_settings.
    let (base_url, model_override) = {
        let conn = db.0.lock();
        let base = db::get_setting(&conn, &format!("chat.{provider_str}.base_url"))
            .map_err(|e| e.to_string())?;
        let mo = db::get_setting(&conn, &format!("chat.{provider_str}.model"))
            .map_err(|e| e.to_string())?;
        (base, mo)
    };
    // Per-session model wins; the Settings model is only a default for
    // sessions created without one.
    let model = if model_str.trim().is_empty() {
        model_override.ok_or_else(|| "no model configured for this chat".to_string())?
    } else {
        model_str
    };
    let effort = effort.filter(|e| !e.trim().is_empty());

    // 6. Build message history from DB.
    let messages = {
        let conn = db.0.lock();
        let records = db::list_chat_messages(&conn, &chat_session_id)
            .map_err(|e| e.to_string())?;
        records
            .into_iter()
            .map(|r| ChatMessage {
                role: r.role,
                // Thinking blocks are for display only — never re-sent.
                content: strip_think_blocks(&r.content),
            })
            .collect::<Vec<_>>()
    };

    let shared_db = Arc::clone(&db.0);
    chat_state.0.send(
        chat_session_id,
        provider_id,
        model,
        api_key,
        base_url,
        effort,
        tools_enabled.unwrap_or(false),
        code_exec_enabled.unwrap_or(false),
        messages,
        shared_db,
        app,
    );

    Ok(())
}

#[tauri::command]
pub fn cancel_chat_message(
    chat_session_id: String,
    chat_state: State<'_, crate::ChatState>,
) -> CmdResult<()> {
    chat_state.0.cancel(&chat_session_id);
    Ok(())
}

// ---- Artifact preview ----

/// Standard base64 encode (no external crate).
fn base64_encode(data: &[u8]) -> String {
    const ALPHABET: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(ALPHABET[(n >> 18 & 63) as usize] as char);
        out.push(ALPHABET[(n >> 12 & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[(n >> 6 & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}

/// Minimal XML entity unescape (order matters: `&amp;` last).
fn xml_unescape(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

/// Escape text for safe embedding in the HTML we build for doc/ppt previews.
fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// Concatenate the inner text of every `<tag …>…</close>` occurrence in `chunk`
/// (used to pull `<w:t>`/`<a:t>` run text out of Office XML).
fn collect_tag_text(chunk: &str, open: &str, close: &str) -> String {
    let mut out = String::new();
    let mut rest = chunk;
    while let Some(i) = rest.find(open) {
        let after = &rest[i + open.len()..];
        // Only match a real element start: `<w:t>` or `<w:t …>` (not `<w:tbl>`).
        if !(after.starts_with('>') || after.starts_with(' ') || after.starts_with('/')) {
            rest = after;
            continue;
        }
        if let Some(gt) = after.find('>') {
            let content = &after[gt + 1..];
            if let Some(ce) = content.find(close) {
                out.push_str(&content[..ce]);
                rest = &content[ce + close.len()..];
                continue;
            }
        }
        break;
    }
    xml_unescape(&out)
}

/// Split an Office XML string into element slices that start with `<p>` where
/// `p` is the paragraph tag (`w:p` for docx, `a:p` for pptx). Matches only real
/// paragraph starts (`<w:p>` / `<w:p …>`), never `<w:pPr>`/`<w:pStyle>`.
fn split_paragraphs<'a>(xml: &'a str, tag: &str) -> Vec<&'a str> {
    let exact = format!("<{tag}>");
    let with_attrs = format!("<{tag} ");
    let mut starts = Vec::new();
    let mut idx = 0;
    let needle = format!("<{tag}");
    while let Some(rel) = xml[idx..].find(&needle) {
        let abs = idx + rel;
        let rest = &xml[abs..];
        if rest.starts_with(&exact) || rest.starts_with(&with_attrs) {
            starts.push(abs);
        }
        idx = abs + needle.len();
    }
    let mut out = Vec::new();
    for (k, &s) in starts.iter().enumerate() {
        let end = starts.get(k + 1).copied().unwrap_or(xml.len());
        out.push(&xml[s..end]);
    }
    out
}

/// Render a docx `word/document.xml` as simple HTML (headings + paragraphs).
fn docx_to_html(bytes: &[u8]) -> Option<String> {
    use std::io::Read;
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).ok()?;
    let mut xml = String::new();
    zip.by_name("word/document.xml")
        .ok()?
        .read_to_string(&mut xml)
        .ok()?;

    let mut html = String::new();
    for para in split_paragraphs(&xml, "w:p") {
        let text = collect_tag_text(para, "<w:t", "</w:t>");
        let trimmed = text.trim();
        if trimmed.is_empty() {
            continue;
        }
        // Heading detection via <w:pStyle w:val="…">.
        let style = para
            .find("<w:pStyle")
            .and_then(|i| para[i..].find("w:val=\"").map(|j| i + j + 7))
            .and_then(|s| para[s..].find('"').map(|e| &para[s..s + e]))
            .unwrap_or("");
        let tag = match style {
            "Title" => "h1",
            "Heading1" => "h2",
            "Heading2" => "h3",
            "Heading3" => "h4",
            s if s.starts_with("Heading") => "h5",
            _ => "p",
        };
        html.push_str(&format!("<{tag}>{}</{tag}>", html_escape(trimmed)));
    }
    Some(html)
}

/// Render a pptx as HTML: one titled section per slide.
fn pptx_to_html(bytes: &[u8]) -> Option<String> {
    use std::io::Read;
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).ok()?;

    // Collect + sort slide files numerically (slide1, slide2, … slide10).
    let mut names: Vec<String> = zip
        .file_names()
        .filter(|n| {
            n.starts_with("ppt/slides/slide") && n.ends_with(".xml") && !n.contains("_rels")
        })
        .map(|s| s.to_string())
        .collect();
    names.sort_by_key(|n| {
        n.trim_start_matches("ppt/slides/slide")
            .trim_end_matches(".xml")
            .parse::<u32>()
            .unwrap_or(u32::MAX)
    });

    let mut html = String::new();
    for (i, name) in names.iter().enumerate() {
        let mut xml = String::new();
        if zip
            .by_name(name)
            .ok()
            .and_then(|mut f| f.read_to_string(&mut xml).ok())
            .is_none()
        {
            continue;
        }
        html.push_str(&format!(
            "<section class=\"slide\"><div class=\"slide-num\">Slide {}</div>",
            i + 1
        ));
        for para in split_paragraphs(&xml, "a:p") {
            let text = collect_tag_text(para, "<a:t", "</a:t>");
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                html.push_str(&format!("<p>{}</p>", html_escape(trimmed)));
            }
        }
        html.push_str("</section>");
    }
    if html.is_empty() {
        None
    } else {
        Some(html)
    }
}

/// Render the first worksheet of an xlsx as an HTML table (shared strings resolved).
fn xlsx_to_html(bytes: &[u8]) -> Option<String> {
    use std::io::Read;
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).ok()?;

    // Shared strings table (cells of type "s" index into this).
    let mut shared: Vec<String> = Vec::new();
    if let Ok(mut f) = zip.by_name("xl/sharedStrings.xml") {
        let mut xml = String::new();
        if f.read_to_string(&mut xml).is_ok() {
            for si in xml.split("<si>").skip(1) {
                shared.push(collect_tag_text(si, "<t", "</t>"));
            }
        }
    }

    let mut xml = String::new();
    zip.by_name("xl/worksheets/sheet1.xml")
        .ok()?
        .read_to_string(&mut xml)
        .ok()?;

    let mut rows_html = String::new();
    let mut row_count = 0usize;
    for row in xml.split("<row").skip(1) {
        if row_count >= 500 {
            break;
        }
        let mut cells_html = String::new();
        for cell in split_cells(row) {
            let open_tag_end = cell.find('>').unwrap_or(cell.len());
            let is_shared = cell[..open_tag_end].contains("t=\"s\"");
            let raw = collect_tag_text(cell, "<v", "</v>");
            let value = if is_shared {
                raw.trim()
                    .parse::<usize>()
                    .ok()
                    .and_then(|i| shared.get(i).cloned())
                    .unwrap_or_default()
            } else if raw.is_empty() {
                collect_tag_text(cell, "<t", "</t>")
            } else {
                raw
            };
            cells_html.push_str(&format!("<td>{}</td>", html_escape(value.trim())));
        }
        rows_html.push_str(&format!("<tr>{cells_html}</tr>"));
        row_count += 1;
    }
    if rows_html.is_empty() {
        None
    } else {
        Some(format!("<table>{rows_html}</table>"))
    }
}

/// Split a worksheet row slice into `<c …>…</c>` cell slices.
fn split_cells(row: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut idx = 0;
    while let Some(rel) = row[idx..].find("<c") {
        let abs = idx + rel;
        let rest = &row[abs..];
        if rest.starts_with("<c>") || rest.starts_with("<c ") {
            let end = row[abs + 2..]
                .find("<c")
                .map(|e| abs + 2 + e)
                .unwrap_or(row.len());
            out.push(&row[abs..end]);
            idx = end;
        } else {
            idx = abs + 2;
        }
    }
    out
}

/// Read a generated artifact for in-app preview. Text-like files return their
/// decoded (and length-capped) text; images and PDFs return a `data:` URI;
/// Office documents (docx/pptx/xlsx) are extracted to HTML (kind = `office`);
/// anything else returns metadata only (rendered as a file card).
#[tauri::command]
pub fn read_artifact_preview(path: String) -> CmdResult<ArtifactPreview> {
    use std::path::Path;

    let p = Path::new(&path);
    let filename = p
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| path.clone());
    let ext = p
        .extension()
        .map(|s| s.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();

    let meta = std::fs::metadata(p).map_err(|e| format!("cannot stat file: {e}"))?;
    let size = meta.len();

    // Classify by extension.
    let text_kind = match ext.as_str() {
        "md" | "markdown" => Some("markdown"),
        "csv" => Some("csv"),
        "json" => Some("json"),
        "html" | "htm" => Some("html"),
        "txt" | "log" | "text" => Some("text"),
        "js" | "ts" | "tsx" | "jsx" | "py" | "rs" | "go" | "java" | "c" | "cpp" | "h" | "hpp"
        | "sh" | "bash" | "yaml" | "yml" | "toml" | "xml" | "sql" | "rb" | "php" | "css" => {
            Some("code")
        }
        _ => None,
    };
    let is_image = matches!(
        ext.as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "bmp"
    );
    let is_pdf = ext == "pdf";

    const MAX_TEXT: usize = 400_000; // ~400 KB of text
    const MAX_MEDIA: u64 = 25 * 1024 * 1024; // 25 MB

    if let Some(kind) = text_kind {
        let bytes = std::fs::read(p).map_err(|e| format!("cannot read file: {e}"))?;
        let mut text = String::from_utf8_lossy(&bytes).into_owned();
        let truncated = text.len() > MAX_TEXT;
        if truncated {
            let mut cut = MAX_TEXT;
            while !text.is_char_boundary(cut) {
                cut -= 1;
            }
            text.truncate(cut);
        }
        return Ok(ArtifactPreview {
            path,
            filename,
            ext,
            kind: kind.to_string(),
            text: Some(text),
            data_uri: None,
            size,
            truncated,
        });
    }

    if (is_image || is_pdf) && size <= MAX_MEDIA {
        let bytes = std::fs::read(p).map_err(|e| format!("cannot read file: {e}"))?;
        let mime = match ext.as_str() {
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "gif" => "image/gif",
            "webp" => "image/webp",
            "svg" => "image/svg+xml",
            "bmp" => "image/bmp",
            "pdf" => "application/pdf",
            _ => "application/octet-stream",
        };
        let data_uri = format!("data:{mime};base64,{}", base64_encode(&bytes));
        return Ok(ArtifactPreview {
            path,
            filename,
            ext,
            kind: if is_pdf { "pdf" } else { "image" }.to_string(),
            text: None,
            data_uri: Some(data_uri),
            size,
            truncated: false,
        });
    }

    // Office documents: extract to HTML so they render inline (kind = office).
    if matches!(ext.as_str(), "docx" | "pptx" | "xlsx") && size <= MAX_MEDIA {
        if let Ok(bytes) = std::fs::read(p) {
            let html = match ext.as_str() {
                "docx" => docx_to_html(&bytes),
                "pptx" => pptx_to_html(&bytes),
                "xlsx" => xlsx_to_html(&bytes),
                _ => None,
            };
            if let Some(html) = html {
                return Ok(ArtifactPreview {
                    path,
                    filename,
                    ext,
                    kind: "office".to_string(),
                    text: Some(html),
                    data_uri: None,
                    size,
                    truncated: false,
                });
            }
        }
    }

    // Anything else (unsupported/oversized/unparseable): metadata only.
    Ok(ArtifactPreview {
        path,
        filename,
        ext,
        kind: "binary".to_string(),
        text: None,
        data_uri: None,
        size,
        truncated: false,
    })
}

// ---- Artifact download ----

/// Copy a generated artifact to a user-chosen destination path (the frontend
/// gets `dest` from a save dialog).
#[tauri::command]
pub fn download_artifact(src: String, dest: String) -> CmdResult<()> {
    std::fs::copy(&src, &dest).map_err(|e| format!("could not save file: {e}"))?;
    Ok(())
}

/// Zip several artifacts into a user-chosen destination `.zip` path. Duplicate
/// filenames are disambiguated with a numeric suffix.
#[tauri::command]
pub fn download_artifacts_zip(paths: Vec<String>, dest: String) -> CmdResult<()> {
    use std::io::Write;
    use std::path::Path;
    use zip::write::SimpleFileOptions;

    let file = std::fs::File::create(&dest).map_err(|e| format!("could not create zip: {e}"))?;
    let mut zip = zip::ZipWriter::new(file);
    let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    let mut used: std::collections::HashSet<String> = std::collections::HashSet::new();
    for src in &paths {
        let data = match std::fs::read(src) {
            Ok(d) => d,
            Err(_) => continue, // skip missing files rather than aborting the whole zip
        };
        let base = Path::new(src)
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "file".to_string());
        let mut name = base.clone();
        let mut n = 1;
        while used.contains(&name) {
            let (stem, ext) = match base.rsplit_once('.') {
                Some((s, e)) => (s.to_string(), format!(".{e}")),
                None => (base.clone(), String::new()),
            };
            name = format!("{stem} ({n}){ext}");
            n += 1;
        }
        used.insert(name.clone());
        zip.start_file(name, opts)
            .map_err(|e| format!("zip error: {e}"))?;
        zip.write_all(&data).map_err(|e| format!("zip error: {e}"))?;
    }
    zip.finish().map_err(|e| format!("zip error: {e}"))?;
    Ok(())
}

// ---- API key management ----

/// Store the chat API key in the OS keychain, and provider config in app_settings.
/// The key value is NEVER returnable via any IPC command.
///
/// When `key` is empty but the provider already has a stored key, the keychain
/// entry is left untouched — only settings (base_url, model) are updated. This
/// allows model-only / baseUrl-only changes without re-entering the key. When
/// `key` is non-empty, it replaces the stored keychain entry. When both `key`
/// is empty AND no key exists for this provider, we reject (nothing to save).
#[tauri::command]
pub fn set_chat_api_key(
    provider: String,
    key: String,
    base_url: Option<String>,
    model: Option<String>,
    db: State<DbState>,
) -> CmdResult<()> {
    if provider.trim().is_empty() {
        return Err("provider must not be empty".to_string());
    }

    let conn = db.0.lock();
    if !key.trim().is_empty() {
        // User provided a new key — store it in the OS keychain.
        secrets::set_chat_api_key(&conn, &provider, &key)?;
    }
    // If key is empty and no existing key, we still allow saving base_url/model
    // so the user can set up the config before entering the key.
    // The key can be added later.

    if let Some(url) = base_url {
        db::set_setting(&conn, &format!("chat.{provider}.base_url"), &url)
            .map_err(|e| e.to_string())?;
    }
    if let Some(m) = model {
        db::set_setting(&conn, &format!("chat.{provider}.model"), &m)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn delete_chat_api_key(provider: String, db: State<DbState>) -> CmdResult<()> {
    let conn = db.0.lock();
    secrets::delete_chat_api_key(&conn, &provider)?;
    // Clearing a provider removes its whole configuration, not just the key.
    conn.execute(
        "DELETE FROM app_settings WHERE key IN (?1, ?2)",
        rusqlite::params![
            format!("chat.{provider}.base_url"),
            format!("chat.{provider}.model"),
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Returns non-secret config only — the API key value is NEVER returned.
///
/// When `provider` is None, scans all providers in priority order and returns
/// config for the FIRST one that has a stored key (so the UI can pre-fill the
/// correct provider/model/baseUrl). The `has_key` field tells the API Keys
/// panel whether Save is allowed without re-entering the key.
#[tauri::command]
pub fn get_chat_config(provider: Option<String>, db: State<DbState>) -> CmdResult<ChatConfigPayload> {
    let conn = db.0.lock();
    match provider {
        Some(p) => {
            let base_url = db::get_setting(&conn, &format!("chat.{p}.base_url"))
                .map_err(|e| e.to_string())?;
            let model = db::get_setting(&conn, &format!("chat.{p}.model"))
                .map_err(|e| e.to_string())?;
            let has_key = secrets::has_chat_api_key(&conn, &p);
            Ok(ChatConfigPayload {
                provider: Some(p),
                base_url,
                model,
                has_key,
            })
        }
        None => {
            for p in ["anthropic", "openai", "anthropic_compatible", "openai_compatible"] {
                if secrets::has_chat_api_key(&conn, p) {
                    let base_url = db::get_setting(&conn, &format!("chat.{p}.base_url"))
                        .map_err(|e| e.to_string())?;
                    let model = db::get_setting(&conn, &format!("chat.{p}.model"))
                        .map_err(|e| e.to_string())?;
                    return Ok(ChatConfigPayload {
                        provider: Some(p.to_string()),
                        base_url,
                        model,
                        has_key: true,
                    });
                }
            }
            // No provider has a stored key yet.
            Ok(ChatConfigPayload {
                provider: None,
                base_url: None,
                model: None,
                has_key: false,
            })
        }
    }
}

/// List available models from a compatible provider by querying its `/v1/models` endpoint.
/// Supports both Anthropic-compatible (`x-api-key` header) and OpenAI-compatible
/// (`Authorization: Bearer` header) providers.
#[tauri::command]
pub async fn list_chat_models(
    provider: String,
    base_url: Option<String>,
    api_key: Option<String>,
    db: State<'_, DbState>,
) -> CmdResult<Vec<crate::types::ChatModel>> {
    use reqwest;

    // Resolve base_url: prefer the passed argument, then the stored setting.
    let base = match base_url {
        Some(url) if !url.trim().is_empty() => url,
        _ => {
            let conn = db.0.lock();
            db::get_setting(&conn, &format!("chat.{provider}.base_url"))
                .map_err(|e| e.to_string())?
                .ok_or_else(|| "base_url is required for compatible providers".to_string())?
        }
    };

    // Resolve API key: prefer the passed argument, then the keychain.
    let key = match api_key {
        Some(k) if !k.trim().is_empty() => k,
        _ => {
            let conn = db.0.lock();
            secrets::get_chat_api_key(&conn, &provider)
                .ok_or_else(|| format!("no API key configured for provider: {provider}"))?
        }
    };

    let url = format!("{base}/v1/models");

    let client = reqwest::Client::new();
    let req = client.get(&url);

    let req = match provider.as_str() {
        "anthropic_compatible" => req.header("x-api-key", key),
        "openai_compatible" => req.header("Authorization", format!("Bearer {key}")),
        _ => return Err("list_chat_models only supports compatible providers".to_string()),
    };

    let resp = req.send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    let body_text = resp.text().await.map_err(|e| e.to_string())?;

    if status == 404 {
        return Ok(vec![]);
    }

    if !status.is_success() {
        return Err(format!("HTTP {status}: {body_text}"));
    }

    // Try to parse as JSON
    let json: serde_json::Value = match serde_json::from_str(&body_text) {
        Ok(v) => v,
        Err(e) => {
            // Log the raw response for debugging
            eprintln!("[list_chat_models] Failed to parse JSON: {e}");
            eprintln!("[list_chat_models] Raw response (first 500 chars): {}", &body_text.chars().take(500).collect::<String>());
            return Err(format!("error decoding response body: {e}"));
        }
    };

    // Try standard OpenAI shape first ({ data: [...] }). Only `id` is
    // required — many compatible providers omit object/created/owned_by.
    let models: Vec<crate::types::ChatModel> = if let Some(data) = json.get("data").and_then(|v| v.as_array()) {
        data.iter()
            .filter_map(|v| {
                let id = v.get("id")?.as_str()?.to_string();
                let object = v
                    .get("object")
                    .and_then(|o| o.as_str())
                    .unwrap_or("model")
                    .to_string();
                let created = v.get("created").and_then(|c| c.as_i64()).unwrap_or(0);
                let owned_by = v
                    .get("owned_by")
                    .and_then(|o| o.as_str())
                    .unwrap_or("")
                    .to_string();
                Some(crate::types::ChatModel { id, object, created, owned_by })
            })
            .collect()
    } else if let Some(arr) = json.as_array() {
        // Fallback: plain array of model IDs.
        arr.iter()
            .filter_map(|v| {
                let id = v.as_str()?.to_string();
                Some(crate::types::ChatModel {
                    id,
                    object: "model".to_string(),
                    created: 0,
                    owned_by: "".to_string(),
                })
            })
            .collect()
    } else {
        return Err("unexpected /v1/models response shape".to_string());
    };

    Ok(models)
}

#[cfg(test)]
mod office_preview_tests {
    use super::*;

    #[test]
    fn collect_tag_text_joins_runs_and_unescapes() {
        let xml = r#"<w:r><w:t>Hello</w:t></w:r><w:r><w:t xml:space="preserve"> A &amp; B</w:t></w:r>"#;
        assert_eq!(collect_tag_text(xml, "<w:t", "</w:t>"), "Hello A & B");
    }

    #[test]
    fn collect_tag_text_ignores_similar_tags() {
        // `<w:tbl>` must not be picked up when collecting `<w:t>` runs.
        let xml = r#"<w:tbl><w:t>keep</w:t></w:tbl>"#;
        assert_eq!(collect_tag_text(xml, "<w:t", "</w:t>"), "keep");
    }

    #[test]
    fn split_paragraphs_skips_ppr() {
        let xml = r#"<w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Title</w:t></w:r></w:p><w:p><w:r><w:t>Body</w:t></w:r></w:p></w:body>"#;
        let paras = split_paragraphs(xml, "w:p");
        assert_eq!(paras.len(), 2);
        assert!(collect_tag_text(paras[0], "<w:t", "</w:t>").contains("Title"));
        assert!(collect_tag_text(paras[1], "<w:t", "</w:t>").contains("Body"));
    }

    #[test]
    fn docx_and_pptx_extract_from_generated_files() {
        let dir = std::env::temp_dir().join(format!("conduit-office-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();

        let docx = crate::chat::artifacts::generate(
            &dir,
            "docx",
            "t.docx",
            None,
            "Solar System\nEight planets orbit the Sun.",
        )
        .unwrap();
        let html = docx_to_html(&std::fs::read(&docx.path).unwrap()).unwrap();
        assert!(html.contains("Solar System"), "docx html: {html}");
        assert!(html.contains("Eight planets"), "docx html: {html}");

        let pptx = crate::chat::artifacts::generate(
            &dir,
            "pptx",
            "t.pptx",
            None,
            "Slide One\nAlpha\n---\nSlide Two\nBeta",
        )
        .unwrap();
        let phtml = pptx_to_html(&std::fs::read(&pptx.path).unwrap()).unwrap();
        assert!(phtml.contains("Slide 1"), "pptx html: {phtml}");
        assert!(phtml.contains("Alpha") && phtml.contains("Beta"), "pptx html: {phtml}");

        let _ = std::fs::remove_dir_all(&dir);
    }
}