//! `generate_image` — local text-to-image through the stable-diffusion.cpp
//! sd-server sidecar (`commands/image_gen.rs`). Writes the decoded PNG into
//! the session's artifacts dir and surfaces it as BOTH an artifact (chat card,
//! downloads) and a preview (the tool pane renders image kinds natively), so
//! the user sees the picture without leaving the conversation.

use std::path::Path;

use serde_json::Value;

use super::{ArtifactRef, ToolOutcome};
use crate::chat::artifacts;

pub(super) async fn generate_image_tool(
    app: &tauri::AppHandle,
    artifacts_dir: &Path,
    args: &Value,
    owner: Option<&str>,
) -> ToolOutcome {
    let prompt = args
        .get("prompt")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if prompt.is_empty() {
        return ToolOutcome::text("Error: generate_image requires a non-empty \"prompt\".");
    }
    // Size: the agent MAY pass width/height; omitted = 0 sentinel → the
    // engine renders at the active model's native size (and the small-VRAM
    // clamp still applies downstream). Hardware never decides UP, only down.
    let width = args.get("width").and_then(|v| v.as_u64()).map(|v| v as u32).unwrap_or(0);
    let height = args.get("height").and_then(|v| v.as_u64()).map(|v| v as u32).unwrap_or(0);
    let requested_name = args
        .get("filename")
        .and_then(|v| v.as_str())
        .unwrap_or("image");

    match crate::commands::image_gen::generate_via_app(
        app,
        &prompt,
        width,
        height,
        Some(artifacts_dir),
        None,
        owner,
    )
    .await
    {
        Ok(img) => {
            let Some(saved) = img.path else {
                return ToolOutcome::text(
                    "Error: generate_image produced no file — the image engine returned an \
                     unexpected response.",
                );
            };
            let base = artifacts::sanitize_filename(requested_name);
            let filename = if base.to_lowercase().ends_with(".png") {
                base
            } else {
                format!("{base}.png")
            };
            ToolOutcome {
                text: format!(
                    "Generated a {}×{} image from the prompt and saved it to \"{}\". It is \
                     displayed to the user. If it misses the intent, say what to change and \
                     call generate_image again — a fresh seed is drawn every time.",
                    img.width, img.height, saved
                ),
                artifact: Some(ArtifactRef {
                    path: saved.clone(),
                    filename,
                }),
                browse_url: None,
                preview: Some(ArtifactRef {
                    path: saved,
                    filename: "image.png".into(),
                }),
            }
        }
        Err(e) => {
            // First-run setup lives in Settings; point the model at it so its
            // reply to the user is actionable instead of a dead end.
            let hint = if e.contains("not installed")
                || e.contains("No image model")
                || e.contains("text encoder is missing")
                || e.contains("VAE is missing")
            {
                " Set it up in Settings → Local Models → Images (engine build + model files), \
                 then retry."
            } else {
                ""
            };
            ToolOutcome::text(format!("generate_image failed: {e}.{hint}"))
        }
    }
}
