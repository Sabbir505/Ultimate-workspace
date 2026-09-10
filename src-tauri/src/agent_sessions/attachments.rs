//! agent attachment preparation: decode, sanitize, and write to the artifacts dir — extracted carve of agent_sessions (see
//! mod.rs). `use super::*` inherits the parent's imports and private
//! helpers; items are pub(super) and glob-reimported by the parent.
use super::*;
// ---------------------------------------------------------------- attachments
/// Turn composer attachments into a prompt appendix for harness turns.
///
/// Unlike the built-in chat (which sends images as vision content parts over
/// HTTP), CLI harnesses receive plain text on stdin — so binary attachments
/// are materialized to disk under `<artifacts>/chat-attachments/<session>/`
/// and referenced by absolute path: the harness's own file-reading tools open
/// them natively, images included (claude/kimi/opencode Read all handle png/
/// jpg/pdf). The caller folds the extracted document text into the persisted
/// message itself (via `chat::commands::process_attachments`), so this
/// appendix stays tiny — just the paths — and never duplicates it.
///
/// Returns the appendix to append to the turn's prompt — empty when there is
/// nothing usable. Plain-text attachments need no disk round-trip (their
/// contents ride along in the message body like any other provider).

pub(crate) fn prepare_agent_attachments(
    app: &AppHandle,
    chat_session_id: &str,
    attachments: &[crate::types::ChatAttachmentInput],
) -> String {
    let mut lines: Vec<String> = Vec::new();
    let millis = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    for (idx, a) in attachments.iter().enumerate() {
        // Only binary kinds hit the disk; "text" is already inline upstream.
        if !matches!(a.kind.as_str(), "image" | "doc") {
            continue;
        }
        let Some(bytes) = a.data.as_deref().and_then(decode_attachment_b64) else {
            continue;
        };
        match write_agent_attachment_file(app, chat_session_id, &a.name, idx, millis, &bytes) {
            Some(path) => {
                let desc = match a.kind.as_str() {
                    "image" => format!(
                        "image ({}); view it with your file/image reading tool",
                        a.media_type.clone().unwrap_or_else(|| "image".into())
                    ),
                    _ => format!(
                        "original {} file — the message above carries its extracted text; \
                         read this copy directly for figures/layout or anything the \
                         extraction missed",
                        a.format.clone().unwrap_or_else(|| "document".into())
                    ),
                };
                lines.push(format!("- `{}` — {desc}", path.display()));
            }
            // Disk write failed — say so instead of silently dropping.
            None => lines.push(format!(
                "- {} — could not be saved to disk for this turn.",
                a.name
            )),
        }
    }
    if lines.is_empty() {
        return String::new();
    }
    let _count = lines.len();
    format!(
        "\n\n---\n\n## Attached files\nThe user attached file(s) with this message:\n{}\nRead every attached file above before answering.",
        lines.join("\n")
    )
}

/// Base64-decode an attachment payload (no `data:` prefix), tolerating junk.
pub(super) fn decode_attachment_b64(data: &str) -> Option<Vec<u8>> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.decode(data).ok()
}

/// Sanitize an attachment filename for safe use inside the attachments dir:
/// separators and control/odd characters become `_`, hidden-dot stems are
/// flattened, length is capped with the extension preserved. A name made of
/// nothing safe collapses to `file`.
pub(super) fn sanitize_attachment_name(name: &str) -> String {
    const MAX_STEM: usize = 60;
    let stem_ext = name.rsplit_once('.');
    let sanitize_part = |s: &str| -> String {
        let mapped: String = s
            .chars()
            .map(|c| {
                if c.is_alphanumeric() || matches!(c, '-' | '_') {
                    c
                } else {
                    '_'
                }
            })
            .collect();
        // Collapse runs of separators so "my report (final)" reads
        // my_report_final instead of my_report__final_.
        let mut collapsed = String::with_capacity(mapped.len());
        for c in mapped.chars() {
            if c == '_' && collapsed.ends_with('_') {
                continue;
            }
            collapsed.push(c);
        }
        collapsed.trim_matches('_').to_string()
    };
    let (stem, ext) = match stem_ext {
        Some((stem, ext)) => (sanitize_part(stem), Some(sanitize_part(ext))),
        None => (sanitize_part(name), None),
    };
    let mut stem = stem.trim_matches('.').to_string();
    if stem.is_empty() {
        stem = "file".into();
    }
    if stem.chars().count() > MAX_STEM {
        stem = stem.chars().take(MAX_STEM).collect();
    }
    match ext.filter(|e| !e.is_empty()) {
        Some(ext) => format!("{stem}.{ext}"),
        None => stem,
    }
}

/// Write one attachment's bytes under
/// `<artifacts>/chat-attachments/<session>/<millis>_<idx>_<name>` — unique
/// per file within a turn (idx) and across turns (millis), so re-sending the
/// same filename never clobbers an earlier copy the CLI may still reference.
/// Returns the absolute path on success.
pub(super) fn write_agent_attachment_file(
    app: &AppHandle,
    chat_session_id: &str,
    name: &str,
    idx: usize,
    millis: u128,
    bytes: &[u8],
) -> Option<std::path::PathBuf> {
    let dir = crate::chat::dispatch::artifacts_dir(app)
        .join("chat-attachments")
        .join(sanitize_attachment_name(chat_session_id));
    std::fs::create_dir_all(&dir).ok()?;
    let path = dir.join(format!(
        "{millis}_{idx:02}_{}",
        sanitize_attachment_name(name)
    ));
    std::fs::write(&path, bytes).ok()?;
    Some(path)
}
