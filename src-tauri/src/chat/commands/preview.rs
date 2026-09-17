//! `commands::preview` — carved verbatim from the former commands.rs
//! monolith (mechanical split; see REFACTOR_PROGRESS.md).

use super::*;

// ---- Artifact preview ----

/// Standard base64 encode (no external crate). `pub` so
/// `browser_mcp.rs:391` can call it for the screenshot-encoding path —
/// kept module-private in the past, but `browser_mcp` is the legitimate
/// external consumer (it builds the data URI for the
/// `browser_screenshot` tool's return payload).
pub(crate) fn base64_encode(data: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
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

// ---- Artifact preview ----
// (the former preview-scope containment was lifted on product decision —
// these endpoints exist to open the user's files, wherever they live)

/// Silent cap for read-aloud text. `doc_to_text` caps at 250K chars for the
/// MODEL context, with a visible truncation note; speech wants neither the
/// size nor the note (the note itself would be read aloud). A document this
/// long is already hours of audio, and the player's background prefetch would
/// keep the synthesis engine busy voicing every sentence of it.
fn cap_speech_text(mut text: String) -> String {
    const MAX_SPEECH_CHARS: usize = 60_000;
    if text.chars().count() <= MAX_SPEECH_CHARS {
        return text;
    }
    let mut cut = MAX_SPEECH_CHARS;
    while !text.is_char_boundary(cut) {
        cut -= 1;
    }
    text.truncate(cut);
    text
}

/// Speech-ready plain text for the read-aloud button: what
/// [`crate::chat::office::doc_to_text`] extracts for the office/PDF formats,
/// line-normalized for the sentence splitter, then capped.
///
/// The line pass matters for office documents, whose extractor emits one
/// paragraph per line: a deck bullet with no period would run straight into
/// the next line as one unbroken sentence. Each line gets a terminal stop
/// unless it already ends in punctuation (or a dash — the `--- Slide N ---`
/// markers must survive verbatim; the speech side turns them into labels).
/// PDFs are exempt: their extractor emits visually wrapped lines, and a
/// period there would cut sentences mid-thought.
fn speech_text_for(ext: &str, bytes: &[u8]) -> Option<String> {
    let mut text = crate::chat::office::doc_to_text(ext, bytes)?;
    if matches!(ext, "docx" | "pptx" | "xlsx" | "xls") {
        let mut spoken = String::with_capacity(text.len() + 16);
        for line in text.lines() {
            let line = line.trim_end();
            if line.is_empty() {
                // Blank lines ARE structure — the paragraph pause between
                // slides comes from them.
                spoken.push('\n');
                continue;
            }
            spoken.push_str(line);
            let ends_sentence = line.ends_with(|c: char| matches!(c, '.' | '!' | '?'));
            if !ends_sentence && !line.ends_with('-') {
                spoken.push('.');
            }
            spoken.push('\n');
        }
        text = spoken;
    }
    Some(cap_speech_text(text))
}

/// Read a generated artifact for in-app preview. Text-like files return their
/// decoded (and length-capped) text; images and PDFs return a `data:` URI;
/// Office documents are rendered as: docx → raw bytes for client-side
/// docx-preview rendering (kind = `office`, original_bytes = true); pptx →
/// converted to PDF via headless LibreOffice when available (kind = `pdf`),
/// else the hand-rolled HTML converter (kind = `office`); xlsx → HTML
/// (kind = `office`). Anything else returns metadata only (rendered as a
/// file card).
///
/// Office and PDF previews also carry `speech_text` — the extractors' plain
/// text, for the read-aloud button (see [`speech_text_for`]). The office
/// `text` is the preview HTML and a PDF has no `text` at all, so without it
/// there would be nothing speakable to hand the TTS player.
///
/// Any readable path may be previewed — the artifact IPC endpoints lost their
/// preview-scope containment on product decision (2026-09): the pane exists
/// to open the user's files, wherever they live.
///
/// `async` because pptx→pdf shells out to LibreOffice for several seconds —
/// that work runs on `spawn_blocking` so the IPC handler isn't stalled.
#[tauri::command]
pub async fn read_artifact_preview(path: String) -> CmdResult<ArtifactPreview> {
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
    let text_kind = classify_text_ext(&ext);
    let is_image = matches!(
        ext.as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "bmp"
    );
    let is_pdf = ext == "pdf";

    const MAX_TEXT: usize = 400_000; // ~400 KB of text
    const MAX_MEDIA: u64 = 25 * 1024 * 1024; // 25 MB

    if let Some(kind) = text_kind {
        // spawn_blocking (B2): a 400 KB read on the async IPC context stalls
        // every other in-flight command on this runtime thread.
        let path_for_read = path.clone();
        let bytes = tokio::task::spawn_blocking(move || std::fs::read(Path::new(&path_for_read)))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| format!("cannot read file: {e}"))?;
        let mut text = String::from_utf8_lossy(&bytes).into_owned();
        let truncated = text.len() > MAX_TEXT;
        if truncated {
            let mut cut = MAX_TEXT;
            while !text.is_char_boundary(cut) {
                cut -= 1;
            }
            text.truncate(cut);
        }
        // A .html file produced by the `generate_diagram` tool carries the
        // diagram sentinel marker at the top. Route it as `kind: "diagram"`
        // (same srcDoc-iframe rendering as html, but diagram-specific export
        // chrome — PNG export enabled, SVG greyed out).
        let final_kind = if kind == "html"
            && (text.starts_with(crate::chat::tools::DIAGRAM_MARKER)
                || text.starts_with(crate::chat::tools::LEGACY_DIAGRAM_MARKER))
        {
            "diagram"
        } else {
            kind
        };
        return Ok(ArtifactPreview {
            path,
            filename,
            ext,
            kind: final_kind.to_string(),
            text: Some(text),
            speech_text: None,
            data_uri: None,
            original_bytes: None,
            size,
            truncated,
        });
    }

    if (is_image || is_pdf) && size <= MAX_MEDIA {
        // spawn_blocking (B2): up to 25 MB read + base64 on the hot path.
        // The speech text rides along in the same closure — for a PDF it is
        // what read-aloud speaks, and pdf_extract can be slow, so it must
        // stay off the IPC thread too.
        let path_for_read = path.clone();
        let read = tokio::task::spawn_blocking(move || {
            let bytes = std::fs::read(Path::new(&path_for_read))
                .map_err(|e| format!("cannot read file: {e}"))?;
            let speech = if is_pdf {
                speech_text_for("pdf", &bytes)
            } else {
                None
            };
            Ok::<_, String>((bytes, speech))
        })
        .await
        .map_err(|e| e.to_string())?;
        let (bytes, speech_text) = read?;
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
            speech_text,
            data_uri: Some(data_uri),
            original_bytes: None,
            size,
            truncated: false,
        });
    }

    // PPTX: convert the original deck to PDF with headless LibreOffice so the
    // preview is the *original* file (fonts/images/layout intact), rendered by
    // the native PDF viewer. On any conversion failure (LibreOffice missing,
    // timeout, corrupt file) fall through to the office→HTML preview below.
    if ext == "pptx" && size <= MAX_MEDIA {
        let path_for_convert = path.clone();
        let pdf_bytes = tokio::task::spawn_blocking(move || -> Option<Vec<u8>> {
            crate::chat::office::office_to_pdf(Path::new(&path_for_convert))
        })
        .await
        .ok()
        .flatten();
        if let Some(pdf_bytes) = pdf_bytes {
            // Read-aloud speaks the ORIGINAL slides (with the `--- Slide N ---`
            // markers the speech side turns into labels), not the converted
            // PDF — slide structure is worth a pause between slides.
            let path_for_speech = path.clone();
            let speech_text = tokio::task::spawn_blocking(move || {
                std::fs::read(Path::new(&path_for_speech))
                    .ok()
                    .and_then(|bytes| speech_text_for("pptx", &bytes))
            })
            .await
            .ok()
            .flatten();
            let data_uri = format!("data:application/pdf;base64,{}", base64_encode(&pdf_bytes));
            return Ok(ArtifactPreview {
                path,
                filename,
                ext,
                kind: "pdf".to_string(),
                text: None,
                speech_text,
                data_uri: Some(data_uri),
                original_bytes: Some(true),
                size,
                truncated: false,
            });
        }
    }

    // Legacy binary .xls: LibreOffice (when installed) converts the ORIGINAL
    // workbook to a true-fidelity PDF — same treatment as .pptx above, real
    // columns/styles instead of "can't preview". Without LibreOffice, fall
    // back to the legacy text extractor so the content is at least readable.
    if ext == "xls" && size <= MAX_MEDIA {
        let path_for_convert = path.clone();
        let pdf_bytes = tokio::task::spawn_blocking(move || -> Option<Vec<u8>> {
            crate::chat::office::office_to_pdf(Path::new(&path_for_convert))
        })
        .await
        .ok()
        .flatten();
        if let Some(pdf_bytes) = pdf_bytes {
            let path_for_speech = path.clone();
            let speech_text = tokio::task::spawn_blocking(move || {
                std::fs::read(Path::new(&path_for_speech))
                    .ok()
                    .and_then(|bytes| speech_text_for("xls", &bytes))
            })
            .await
            .ok()
            .flatten();
            let data_uri = format!("data:application/pdf;base64,{}", base64_encode(&pdf_bytes));
            return Ok(ArtifactPreview {
                path,
                filename,
                ext,
                kind: "pdf".to_string(),
                text: None,
                speech_text,
                data_uri: Some(data_uri),
                original_bytes: Some(true),
                size,
                truncated: false,
            });
        }
        let path_for_read = path.clone();
        let text = tokio::task::spawn_blocking(move || {
            std::fs::read(Path::new(&path_for_read))
                .ok()
                .and_then(|bytes| crate::chat::office::doc_to_text("xls", &bytes))
        })
        .await
        .ok()
        .flatten();
        if let Some(text) = text {
            return Ok(ArtifactPreview {
                path,
                filename,
                ext,
                kind: "text".to_string(),
                text: Some(text),
                speech_text: None,
                data_uri: None,
                original_bytes: None,
                size,
                truncated: false,
            });
        }
    }

    // Office documents: render to faithful, self-contained HTML (colours,
    // fonts, tables, slide layouts) shown in a sandboxed iframe (kind = office).
    // For docx/pptx, also return the raw bytes as data_uri for client-side
    // rendering (docx-preview for docx; pptx raw bytes back the fallback when
    // LibreOffice conversion failed).
    if matches!(ext.as_str(), "docx" | "pptx" | "xlsx") && size <= MAX_MEDIA {
        // spawn_blocking (B2 + B13): the read AND the Office→HTML renderers
        // (multi-pass string scans, worst-case quadratic on pathological
        // documents) both run off the async IPC context now.
        let path_for_read = path.clone();
        let ext_for_render = ext.clone();
        let rendered = tokio::task::spawn_blocking(move || {
            let bytes = std::fs::read(Path::new(&path_for_read)).ok()?;
            let speech = speech_text_for(&ext_for_render, &bytes);
            let html = match ext_for_render.as_str() {
                "docx" => crate::chat::office::docx_to_html(&bytes),
                "pptx" => crate::chat::office::pptx_to_html(&bytes),
                "xlsx" => crate::chat::office::xlsx_to_html(&bytes),
                _ => None,
            };
            html.map(|h| (bytes, h, speech))
        })
        .await
        .ok()
        .flatten();
        if let Some((bytes, html, speech_text)) = rendered {
            // Encode raw file bytes for client-side rendering.
            let mime = match ext.as_str() {
                "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                "pptx" => {
                    "application/vnd.openxmlformats-officedocument.presentationml.presentation"
                }
                "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                _ => "application/octet-stream",
            };
            let data_uri = format!("data:{mime};base64,{}", base64_encode(&bytes));
            return Ok(ArtifactPreview {
                path,
                filename,
                ext,
                kind: "office".to_string(),
                text: Some(html),
                speech_text,
                data_uri: Some(data_uri),
                original_bytes: Some(true),
                size,
                truncated: false,
            });
        }
    }

    // Anything else (unsupported/oversized/unparseable): metadata only.
    Ok(ArtifactPreview {
        path,
        filename,
        ext,
        kind: "binary".to_string(),
        text: None,
        speech_text: None,
        data_uri: None,
        original_bytes: None,
        size,
        truncated: false,
    })
}

/// Extension → preview `kind` for text-like artifacts. Extracted from
/// `read_artifact_preview` so the routing table is unit-testable.
pub(crate) fn classify_text_ext(ext: &str) -> Option<&'static str> {
    match ext {
        "md" | "markdown" => Some("markdown"),
        "csv" => Some("csv"),
        "json" => Some("json"),
        "html" | "htm" => Some("html"),
        // Mermaid sources render as diagrams (MermaidDiagram), not code text.
        "mmd" | "mermaid" => Some("mermaid"),
        "txt" | "log" | "text" => Some("text"),
        "tsx" | "jsx" => Some("jsx"),
        "js" | "ts" | "py" | "rs" | "go" | "java" | "c" | "cpp" | "h" | "hpp" | "sh" | "bash"
        | "yaml" | "yml" | "toml" | "xml" | "sql" | "rb" | "php" | "css" => Some("code"),
        _ => None,
    }
}

#[cfg(test)]
mod preview_tests {
    use super::{cap_speech_text, classify_text_ext, file_mtime_secs, find_by_basename_walk, speech_text_for};

    #[test]
    fn mermaid_sources_classify_as_mermaid_kind() {
        assert_eq!(classify_text_ext("mmd"), Some("mermaid"));
        assert_eq!(classify_text_ext("mermaid"), Some("mermaid"));
        // Case-insensitivity is handled upstream (ext is lowercased), but the
        // table itself must only hold lowercase entries.
        assert_eq!(classify_text_ext("MMD"), None, "caller lowercases the ext");
    }

    #[test]
    fn existing_kinds_unchanged() {
        assert_eq!(classify_text_ext("md"), Some("markdown"));
        assert_eq!(classify_text_ext("html"), Some("html"));
        assert_eq!(classify_text_ext("tsx"), Some("jsx"));
        assert_eq!(classify_text_ext("py"), Some("code"));
        assert_eq!(classify_text_ext("exe"), None);
    }

    #[test]
    fn speech_text_gives_office_lines_terminal_stops_but_not_pdfs() {
        let dir = std::env::temp_dir().join(format!("relay-speech-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();

        // Deck bullets have no periods; read-aloud must still break between
        // them, and the slide markers must survive verbatim (the speech side
        // turns them into spoken labels).
        let pptx = crate::chat::artifacts::generate(
            &dir,
            "pptx",
            "t.pptx",
            None,
            "Slide One\nAlpha\n---\nSlide Two\nBeta",
        )
        .unwrap();
        let speech = speech_text_for("pptx", &std::fs::read(&pptx.path).unwrap()).unwrap();
        assert!(speech.contains("Alpha."), "missing line stop: {speech}");
        assert!(speech.contains("Beta."), "missing line stop: {speech}");
        assert!(
            speech.contains("--- Slide 1 ---"),
            "slide marker must survive verbatim: {speech}"
        );

        // A PDF's wrapped lines must NOT gain periods — they are visual, not
        // sentence boundaries.
        let pdf = crate::chat::artifacts::generate(
            &dir,
            "pdf",
            "t.pdf",
            Some("Quarterly Report"),
            "Revenue grew twelve percent.\nCosts stayed flat.",
        )
        .unwrap();
        let pdf_speech =
            speech_text_for("pdf", &std::fs::read(&pdf.path).unwrap()).unwrap();
        assert!(
            pdf_speech.contains("Revenue grew twelve percent."),
            "{pdf_speech}"
        );

        assert!(speech_text_for("bogus", b"not a real file").is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn speech_cap_cuts_silently_at_a_char_boundary() {
        // 100_000 chars is past the 60K speech cap (doc_to_text's own 250K
        // model-context cap is far larger by design).
        let long = "word ".repeat(20_000);
        let capped = cap_speech_text(long.clone());
        assert!(capped.chars().count() <= 60_000);
        assert!(capped.is_char_boundary(capped.len()));
        assert_ne!(capped, long);
        // Under the cap: returned untouched, no truncation note appended.
        assert_eq!(cap_speech_text("short.".to_string()), "short.");
    }

    #[test]
    fn get_file_mtime_reports_secs_and_missing_files() {
        let dir = tempfile::tempdir().expect("tempdir");
        let file = dir.path().join("artifact.html");
        std::fs::write(&file, "<html></html>").expect("write");

        let mtime = file_mtime_secs(&file.to_string_lossy())
            .expect("existing file has an mtime");
        assert!(mtime > 0, "mtime is secs-since-epoch, got {mtime}");

        // A file written later has a >= mtime (same-second writes allowed).
        std::fs::write(&file, "<html>v2</html>").expect("rewrite");
        let mtime2 = file_mtime_secs(&file.to_string_lossy()).expect("still exists");
        assert!(mtime2 >= mtime);

        assert_eq!(
            file_mtime_secs(&dir.path().join("gone.html").to_string_lossy()),
            None,
            "missing file → None, not an error (preview keeps last render)"
        );
    }

    #[test]
    fn basename_walk_prefers_newest_match_and_skips_vendor_dirs() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        std::fs::create_dir_all(root.join("a/b")).expect("dirs");
        // Two copies: the deeper one is written LAST (newer mtime) — it must
        // win over the shallower older copy. The sleep keeps the two mtimes
        // out of the same filesystem timestamp bucket (NTFS granularity made
        // a plain back-to-back write pair flaky).
        std::fs::write(root.join("traffic.mmd"), "older-shallow").expect("write shallow");
        std::thread::sleep(std::time::Duration::from_millis(50));
        std::fs::write(root.join("a/b/traffic.mmd"), "newer-deep").expect("write deep");
        let hit = find_by_basename_walk(root, "traffic.mmd").expect("found");
        assert_eq!(std::fs::read_to_string(&hit).unwrap(), "newer-deep");

        // Case-insensitive.
        assert!(find_by_basename_walk(root, "TRAFFIC.MMD").is_some());

        // Missing basename → None.
        assert_eq!(find_by_basename_walk(root, "absent.txt"), None);

        // Vendor dirs are skipped — the only copy lives under node_modules.
        let dir2 = tempfile::tempdir().expect("tempdir");
        std::fs::create_dir_all(dir2.path().join("node_modules/pkg")).expect("dirs");
        std::fs::write(dir2.path().join("node_modules/pkg/only.txt"), "x").expect("write");
        assert_eq!(find_by_basename_walk(dir2.path(), "only.txt"), None);
    }
}

/// True when a LibreOffice `soffice` binary is reachable, which is what the
/// pptx→pdf preview path needs. The frontend uses this to show a one-line
/// install hint above pptx previews that fell back to the HTML converter.
///
/// `async` so the probe's filesystem/PATH lookups never run on the UI thread —
/// the office preview mounts and calls this on every open.
#[tauri::command]
pub async fn is_libreoffice_available() -> bool {
    crate::chat::office::libreoffice_available()
}

/// "Accurate view" for Office artifact previews: convert the original
/// docx/pptx/xlsx (and legacy .doc/.ppt) to PDF with headless LibreOffice and
/// return a `data:application/pdf;base64,…` URI for the in-app PDF viewer.
/// Results come from the same (path,len,mtime)-keyed cache as the pptx
/// preview path, so toggling is cheap after the first conversion. `None`
/// means LibreOffice isn't available or the conversion failed — the caller
/// keeps showing the fast preview.
#[tauri::command]
pub async fn office_accurate_pdf(path: String) -> CmdResult<Option<String>> {
    const MAX_MEDIA: u64 = 25 * 1024 * 1024;
    let p = Path::new(&path);
    let ext_ok = p
        .extension()
        .map(|e| {
            matches!(
                e.to_string_lossy().to_ascii_lowercase().as_str(),
                "docx" | "pptx" | "xlsx" | "doc" | "ppt"
            )
        })
        .unwrap_or(false);
    let size_ok = std::fs::metadata(p)
        .map(|m| m.len() <= MAX_MEDIA)
        .unwrap_or(false);
    if !ext_ok || !size_ok {
        return Ok(None);
    }
    let path_for_convert = path.clone();
    let pdf_bytes = tokio::task::spawn_blocking(move || {
        crate::chat::office::office_to_pdf(Path::new(&path_for_convert))
    })
    .await
    .ok()
    .flatten();
    Ok(pdf_bytes.map(|b| format!("data:application/pdf;base64,{}", base64_encode(&b))))
}

/// Completion callback for the JavaScript document engine (`jsdocgen`). The
/// frontend `DocCodeRunner` executes the model's program in a sandboxed
/// iframe and posts the produced file back as base64 (or an error message).
/// Resolves the async waiter parked in `chat::jsdocgen::generate`.
#[tauri::command(async)]
pub fn docgen_complete(
    request_id: String,
    data_b64: Option<String>,
    error: Option<String>,
) -> CmdResult<()> {
    let result = match (data_b64, error) {
        (Some(b64), _) => crate::chat::jsdocgen::decode_base64(&b64),
        (None, Some(e)) => Err(e),
        (None, None) => {
            Err("the document runner returned neither file data nor an error".to_string())
        }
    };
    crate::chat::jsdocgen::complete(&request_id, result);
    Ok(())
}

/// Completion callback for the plan-compiled document engine (`docdesign`).
/// The frontend `DocDesignRunner` validates the plan (L1), compiles it against
/// the design system (L2 invariants), runs the generated program in a
/// sandboxed frame, and posts the produced file back as base64 (or an error)
/// plus the JSON-encoded QA issue list. Resolves the waiter parked in
/// `chat::docdesign::plan`.
#[tauri::command(async)]
pub fn docdesign_complete(
    request_id: String,
    data_b64: Option<String>,
    error: Option<String>,
    issues_json: Option<String>,
    payload_kind: Option<String>,
) -> CmdResult<()> {
    let result = match (data_b64, error) {
        (Some(b64), _) => crate::chat::jsdocgen::decode_base64(&b64),
        (None, Some(e)) => Err(e),
        (None, None) => {
            Err("the document compiler returned neither file data nor an error".to_string())
        }
    };
    crate::chat::docdesign::plan::complete(&request_id, result, issues_json, payload_kind);
    Ok(())
}

/// Completion callback for the docdesign render probes (`docdesign://qa`).
/// The frontend converts the artifact to PDF (LibreOffice bridge for office
/// files) and inspects it with pdf.js; this resolves the waiter parked in
/// `chat::docdesign::qa::run_render_probes`.
#[tauri::command(async)]
pub fn docdesign_qa_complete(
    request_id: String,
    issues_json: Option<String>,
    page_count: Option<u32>,
) -> CmdResult<()> {
    crate::chat::docdesign::qa::complete(&request_id, issues_json, page_count.unwrap_or(0));
    Ok(())
}

/// Last-modified time of a file, in seconds since the Unix epoch. The
/// artifact preview panes poll this (cheap stat) to hot-reload when the model
/// edits an open artifact file. `None` when the file is gone (deleted while
/// previewed) — the caller keeps showing the last good preview.
///
/// `async` is load-bearing, not cosmetic: this is the only command the UI
/// polls on a timer (every 2 s per open artifact tab), and a non-async command
/// runs INLINE on the IPC thread — the UI thread. A stat can still block
/// briefly on a slow disk, so it runs on the blocking pool.
#[tauri::command]
pub async fn get_file_mtime(path: String) -> CmdResult<Option<u64>> {
    tokio::task::spawn_blocking(move || Ok(file_mtime_secs(&path)))
        .await
        .map_err(|e| e.to_string())?
}

/// Core of [`get_file_mtime`] — split out so it's unit-testable without a
/// Tauri app/state.
pub(super) fn file_mtime_secs(path: &str) -> Option<u64> {
    let meta = std::fs::metadata(path).ok()?;
    let secs = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs());
    secs
}

/// Find a file by basename under `dir` (breadth-first, bounded depth and
/// scan budget; vendor/heavy/hidden dirs are skipped). Returns the most
/// recently modified match, or `None`.
///
/// Recovers preview targets for chat file-change rows whose recorded path no
/// longer exists — models sometimes state a destination they didn't actually
/// write to, and files can move between the turn and the click. The walk is
/// bounded (depth/budget/skip-list), so even a whole-drive `dir` stays cheap.
#[tauri::command]
pub async fn find_file_by_basename(dir: String, basename: String) -> CmdResult<Option<String>> {
    if basename.trim().is_empty() {
        return Ok(None);
    }
    tokio::task::spawn_blocking(move || {
        let root = std::path::PathBuf::from(&dir);
        Ok(find_by_basename_walk(&root, &basename))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Sync core of `find_file_by_basename` — separated so it's unit-testable
/// without a tokio runtime. `basename` is matched case-insensitively.
pub(super) fn find_by_basename_walk(root: &std::path::Path, basename: &str) -> Option<String> {
    let needle = basename.to_lowercase();
    const SKIP_DIRS: [&str; 8] = [
        "node_modules",
        ".git",
        "target",
        "dist",
        "build",
        ".next",
        ".venv",
        "__pycache__",
    ];
    const MAX_DEPTH: u8 = 6;
    const MAX_SCANNED: usize = 20_000;
    let mut queue = std::collections::VecDeque::from([(root.to_path_buf(), 0u8)]);
    let mut scanned = 0usize;
    // Several files can share the name (an old copy in a sibling folder, a
    // rebuilt copy in the current one) — the MOST RECENTLY MODIFIED match
    // wins, since the user almost always means the freshest file.
    let mut best: Option<(std::time::SystemTime, std::path::PathBuf)> = None;
    while let Some((cur, depth)) = queue.pop_front() {
        let Ok(entries) = std::fs::read_dir(&cur) else {
            continue;
        };
        for entry in entries.flatten() {
            scanned += 1;
            if scanned > MAX_SCANNED {
                break;
            }
            let path = entry.path();
            let name = entry.file_name();
            let lower = name.to_string_lossy().to_lowercase();
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            if !is_dir && lower == needle {
                let mtime = entry
                    .metadata()
                    .and_then(|m| m.modified())
                    .unwrap_or(std::time::UNIX_EPOCH);
                let replace = match &best {
                    None => true,
                    Some((best_time, _)) => mtime > *best_time,
                };
                if replace {
                    best = Some((mtime, path.clone()));
                }
            }
            if is_dir && depth < MAX_DEPTH && !SKIP_DIRS.contains(&lower.as_str()) {
                queue.push_back((path, depth + 1));
            }
        }
    }
    best.map(|(_, p)| p.to_string_lossy().into_owned())
}

// ---- Open in default app ----

/// Open a generated artifact with the OS default application.
///
/// Runs through a Rust command (not the JS opener plugin's `openPath`) so a
/// failure RETURNS as an error the pane can surface — the JS path used to
/// reject inside a `catch (err) console.warn(...)` and the button silently
/// did nothing. A path that has vanished since the turn is re-discovered by
/// basename in its directory before giving up.
#[tauri::command]
pub async fn open_artifact_external(path: String) -> CmdResult<String> {
    let resolved = tokio::task::spawn_blocking(move || -> Option<String> {
        let p = std::path::Path::new(&path);
        if p.is_file() {
            return Some(p.to_string_lossy().into_owned());
        }
        // Recover a moved file: same directory (or the artifacts dir root via
        // the recorded parent), same basename.
        let dir = p.parent()?;
        let basename = p.file_name()?.to_string_lossy().into_owned();
        find_by_basename_walk(dir, &basename)
    })
    .await
    .map_err(|e| e.to_string())?
    .ok_or_else(|| "File not found on disk — it may have been moved or deleted.".to_string())?;
    tauri_plugin_opener::open_path(&resolved, None::<&str>)
        .map(|_| resolved)
        .map_err(|e| format!("Could not open the file: {e}"))
}
