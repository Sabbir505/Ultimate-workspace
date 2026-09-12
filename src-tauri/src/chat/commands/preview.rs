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

// ---- Artifact preview containment ----

/// The filesystem roots the artifact preview/open/download IPC endpoints may
/// touch. These commands take paths straight from the webview — which renders
/// model-controlled content — so without containment, any script execution in
/// the pane becomes an arbitrary-file read primitive (secrets, SSH keys,
/// other apps' data). The universe mirrors what `dispatch::run_tool` grants
/// the model: the artifacts dir, every registered project, its chat
/// worktrees, roots the user granted from approval cards, and the remembered
/// working folder.
pub(super) fn preview_scope_roots<R: tauri::Runtime>(
    conn: &rusqlite::Connection,
    app: &tauri::AppHandle<R>,
) -> Vec<String> {
    let mut roots: Vec<String> = db::list_projects(conn)
        .map(|ps| ps.into_iter().map(|p| p.path).collect())
        .unwrap_or_default();
    roots.extend(db::chat_worktree_paths(conn, None).unwrap_or_default());
    // `artifacts_dir_locked`, NOT `artifacts_dir`: every caller of this function
    // holds the `DbState` guard for `conn`, and `artifacts_dir(app)` locks that
    // same (non-reentrant) mutex internally — calling it here self-deadlocked
    // the global DB mutex on every artifact preview and every 2 s
    // `get_file_mtime` poll, parking runtime workers until no IPC response
    // could be delivered at all.
    roots.push(
        crate::chat::dispatch::artifacts_dir_locked(conn, app)
            .to_string_lossy()
            .into_owned(),
    );
    if let Some(granted) = db::get_setting(conn, "permissions.grantedRoots")
        .ok()
        .flatten()
        .and_then(|j| serde_json::from_str::<Vec<String>>(&j).ok())
    {
        roots.extend(granted);
    }
    if let Some(dir) = db::get_setting(conn, "chat.local_gguf.last_working_dir")
        .ok()
        .flatten()
        .filter(|d| !d.trim().is_empty())
    {
        roots.push(dir);
    }
    roots
}

/// Gate for the artifact IPC endpoints: the same hard scope check the
/// mutating FS tools answer to (`permission::path_within_scope` — resolves
/// symlinks/junctions, segment-boundary prefix). `Ok(None)` lets callers
/// degrade to "file not found" semantics instead of an error toast where the
/// frontend has no error UI.
pub(super) fn path_in_preview_scope(path: &str, roots: &[String]) -> Option<()> {
    crate::chat::permission::path_within_scope(path, roots).then_some(())
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
/// The path must sit inside the artifacts dir, a registered project/worktree,
/// a user-granted root, or the remembered working folder — see
/// [`preview_scope_roots`].
///
/// `async` because pptx→pdf shells out to LibreOffice for several seconds —
/// that work runs on `spawn_blocking` so the IPC handler isn't stalled.
#[tauri::command]
pub async fn read_artifact_preview(
    app: AppHandle,
    db: State<'_, DbState>,
    path: String,
) -> CmdResult<ArtifactPreview> {
    use std::path::Path;

    let roots = preview_scope_roots_blocking(&db, &app).await?;
    if path_in_preview_scope(&path, &roots).is_none() {
        return Err(format!(
            "Refusing to preview \"{path}\": it is outside the folders Relay can \
             access (your projects, chat worktrees, the artifacts folder, and \
             user-granted roots)."
        ));
    }

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
            data_uri: None,
            original_bytes: None,
            size,
            truncated,
        });
    }

    if (is_image || is_pdf) && size <= MAX_MEDIA {
        // spawn_blocking (B2): up to 25 MB read + base64 on the hot path.
        let path_for_read = path.clone();
        let bytes = tokio::task::spawn_blocking(move || std::fs::read(Path::new(&path_for_read)))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| format!("cannot read file: {e}"))?;
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
            let data_uri = format!("data:application/pdf;base64,{}", base64_encode(&pdf_bytes));
            return Ok(ArtifactPreview {
                path,
                filename,
                ext,
                kind: "pdf".to_string(),
                text: None,
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
            let data_uri = format!("data:application/pdf;base64,{}", base64_encode(&pdf_bytes));
            return Ok(ArtifactPreview {
                path,
                filename,
                ext,
                kind: "pdf".to_string(),
                text: None,
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
            let html = match ext_for_render.as_str() {
                "docx" => crate::chat::office::docx_to_html(&bytes),
                "pptx" => crate::chat::office::pptx_to_html(&bytes),
                "xlsx" => crate::chat::office::xlsx_to_html(&bytes),
                _ => None,
            };
            html.map(|h| (bytes, h))
        })
        .await
        .ok()
        .flatten();
        if let Some((bytes, html)) = rendered {
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
    use super::{classify_text_ext, find_by_basename_walk, get_file_mtime_gated};

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
    fn get_file_mtime_reports_secs_and_missing_files() {
        let dir = tempfile::tempdir().expect("tempdir");
        let file = dir.path().join("artifact.html");
        std::fs::write(&file, "<html></html>").expect("write");
        let roots = vec![dir.path().to_string_lossy().into_owned()];

        let mtime = get_file_mtime_gated(&file.to_string_lossy(), &roots)
            .expect("existing file has an mtime");
        assert!(mtime > 0, "mtime is secs-since-epoch, got {mtime}");

        // A file written later has a >= mtime (same-second writes allowed).
        std::fs::write(&file, "<html>v2</html>").expect("rewrite");
        let mtime2 = get_file_mtime_gated(&file.to_string_lossy(), &roots).expect("still exists");
        assert!(mtime2 >= mtime);

        assert_eq!(
            get_file_mtime_gated(&dir.path().join("gone.html").to_string_lossy(), &roots),
            None,
            "missing file → None, not an error (preview keeps last render)"
        );
    }

    #[test]
    fn artifact_scope_gate_blocks_outside_paths() {
        // The preview-scope gate must allow legitimate in-root files and
        // refuse everything else — siblings with similar names, `..`
        // traversal, and arbitrary absolute paths.
        let dir = tempfile::tempdir().expect("tempdir");
        let roots = vec![dir.path().to_string_lossy().into_owned()];

        std::fs::write(dir.path().join("in_scope.html"), b"x").expect("write");
        let inside = dir.path().join("in_scope.html");
        assert!(
            get_file_mtime_gated(&inside.to_string_lossy(), &roots).is_some(),
            "in-scope file is readable"
        );

        // Sibling dir whose name merely extends the root (`root` vs `root2`):
        // a raw starts_with would allow it — the segment boundary must not.
        let sibling = dir.path().parent().unwrap().join(format!(
            "{}2",
            dir.path().file_name().unwrap().to_string_lossy()
        ));
        assert!(
            get_file_mtime_gated(&sibling.join("secret.txt").to_string_lossy(), &roots).is_none(),
            "sibling-root path must be refused"
        );

        // `..` traversal escaping the root.
        let traversal = dir.path().join("..").join("..").join("etc_passwd.txt");
        assert!(
            get_file_mtime_gated(&traversal.to_string_lossy(), &roots).is_none(),
            "traversal escape must be refused"
        );

        // Arbitrary absolute path (e.g. C:\\Windows\\system32\\config).
        assert!(
            get_file_mtime_gated("C:\\Windows\\win.ini", &roots).is_none(),
            "arbitrary system path must be refused"
        );

        // Empty roots → nothing is in scope.
        assert!(
            get_file_mtime_gated(&inside.to_string_lossy(), &[]).is_none(),
            "no granted roots → nothing readable"
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
/// previewed) — the caller keeps showing the last good preview. Out-of-scope
/// paths also report `None` (same observable behavior as a vanished file).
///
/// `async` is load-bearing, not cosmetic: this is the only command the UI
/// polls on a timer (every 2 s per open artifact tab), it takes the shared
/// `DbState` mutex to compute the preview scope, and a non-async command runs
/// INLINE on the IPC thread — the UI thread. Opening an artifact therefore used
/// to arm a repeating main-thread mutex acquisition: any concurrent long
/// holder (a streaming turn's writes, an automation run, a checkpoint) stopped
/// the window pumping messages for the whole hold, which Windows reports as
/// "not responding". Run it off the main thread and the same contention
/// degrades to a late promise the pane already ignores.
#[tauri::command]
pub async fn get_file_mtime(
    app: AppHandle,
    db: State<'_, DbState>,
    path: String,
) -> CmdResult<Option<u64>> {
    let roots = preview_scope_roots_blocking(&db, &app).await?;
    Ok(get_file_mtime_gated(&path, &roots))
}

/// [`preview_scope_roots`] evaluated on the BLOCKING pool instead of the async
/// runtime's worker threads.
///
/// Every artifact IPC needs the preview scope, and computing it runs database
/// queries under the shared `DbState` guard. On a runtime worker that wait
/// consumes part of the async scheduler itself (only ~CPU-count workers exist),
/// which is how one wedged lock in this path stopped *every* command in the app
/// from ever answering. The blocking pool is separate and much larger, so a
/// stuck wait here costs latency on this one call and nothing anywhere else.
pub(super) async fn preview_scope_roots_blocking(
    db: &State<'_, DbState>,
    app: &AppHandle,
) -> Result<Vec<String>, String> {
    let db = Arc::clone(&db.0);
    let app = app.clone();
    tokio::task::spawn_blocking(move || {
        let conn = db.lock();
        preview_scope_roots(&conn, &app)
    })
    .await
    .map_err(|e| e.to_string())
}

/// Scope-gated core of [`get_file_mtime`] — split out so the containment
/// behavior is unit-testable without a Tauri app/state.
pub(super) fn get_file_mtime_gated(path: &str, roots: &[String]) -> Option<u64> {
    if path_in_preview_scope(path, roots).is_none() {
        return None;
    }
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
/// write to, and files can move between the turn and the click. `dir` must
/// sit inside the preview scope (see [`preview_scope_roots`]); an
/// out-of-scope dir reports `None` rather than scanning arbitrary folders.
#[tauri::command]
pub async fn find_file_by_basename(
    app: AppHandle,
    db: State<'_, DbState>,
    dir: String,
    basename: String,
) -> CmdResult<Option<String>> {
    if basename.trim().is_empty() {
        return Ok(None);
    }
    let roots = preview_scope_roots_blocking(&db, &app).await?;
    if path_in_preview_scope(&dir, &roots).is_none() {
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
/// basename in its directory before giving up. The path (and whatever the
/// basename recovery finds) must sit inside the preview scope — see
/// [`preview_scope_roots`].
#[tauri::command]
pub async fn open_artifact_external(
    app: AppHandle,
    db: State<'_, DbState>,
    path: String,
) -> CmdResult<String> {
    let roots = preview_scope_roots_blocking(&db, &app).await?;
    if path_in_preview_scope(&path, &roots).is_none() {
        return Err(format!(
            "Refusing to open \"{path}\": it is outside the folders Relay can \
             access (your projects, chat worktrees, the artifacts folder, and \
             user-granted roots)."
        ));
    }
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
    // The basename walk stays under the (already gated) recorded parent, but
    // gate the resolved target anyway — defense in depth before the OS opens it.
    if path_in_preview_scope(&resolved, &roots).is_none() {
        return Err("Resolved file is outside the folders Relay can access.".to_string());
    }
    tauri_plugin_opener::open_path(&resolved, None::<&str>)
        .map(|_| resolved)
        .map_err(|e| format!("Could not open the file: {e}"))
}

#[cfg(test)]
mod preview_scope_tests {
    use super::*;
    use tauri::Manager;

    /// Regression (commit 3cd241c9): `preview_scope_roots` is always called with
    /// the `DbState` guard held — every artifact IPC does `{ let conn =
    /// db.0.lock(); preview_scope_roots(&conn, &app) }`. It used to resolve the
    /// artifacts dir with `dispatch::artifacts_dir(app)`, which locks that same
    /// mutex internally; `parking_lot::Mutex` is not reentrant, so the call
    /// blocked on a guard its own thread held — forever. The global DB mutex
    /// stayed owned by a thread that could never release it, every other DB
    /// command queued behind it, and once each runtime worker was parked no IPC
    /// response was ever delivered (empty chats, dead artifact previews, and a
    /// window that looks frozen while the main thread kept pumping).
    ///
    /// Runs the call on a worker thread and fails on a timeout instead of
    /// hanging the suite on the old behavior.
    #[test]
    fn preview_scope_roots_does_not_relock_the_db_mutex() {
        let app = tauri::test::mock_app();
        let handle = app.handle().clone();
        app.manage(crate::DbState(std::sync::Arc::new(parking_lot::Mutex::new(
            crate::db::mem(),
        ))));
        let db = app.state::<crate::DbState>().0.clone();

        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            // Exactly the shape every caller uses: guard held across the call.
            let conn = db.lock();
            let roots = preview_scope_roots(&conn, &handle);
            let _ = tx.send(roots.len());
        });
        match rx.recv_timeout(std::time::Duration::from_secs(5)) {
            Ok(n) => println!("preview_scope_roots returned {n} roots without deadlocking"),
            Err(_) => panic!("preview_scope_roots deadlocked on the DbState mutex"),
        }
    }
}
