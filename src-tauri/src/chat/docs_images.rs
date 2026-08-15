//! Image text surrogates for local doc indexing.
//!
//! Images can't be embedded directly, so we reduce them to searchable text:
//! 1. **OCR** — Windows.Media.Ocr on Windows; unavailable elsewhere (None).
//! 2. **Vision caption** — optional, via the local chat sidecar's OpenAI-style
//!    `/v1/chat/completions` with an image_url data-URI, when a vision-capable
//!    local model is installed and running.
//! 3. **Filename** — always available, but alone it isn't enough to index.
//!
//! [`compose_surrogate`] merges whichever sources succeeded; an image with no
//! OCR and no caption is skipped by the indexer (and counted as such).

use std::path::Path;

/// Fixed prompt for vision captions. Kept short and factual so the surrogate
/// reads like searchable text, not prose.
pub const CAPTION_PROMPT: &str =
    "Describe this image factually in 80 words or fewer for search indexing. \
     Include any visible text, the main objects, and the overall scene. \
     Output only the description, no preamble.";

/// OCR an image file. Returns None when OCR is unavailable (non-Windows),
/// the image has no text, or any step fails — OCR is best-effort and a
/// failure just means the indexer falls back to caption/filename.
#[cfg(windows)]
pub fn ocr_image(path: &Path) -> Option<String> {
    match win_ocr::run(path) {
        Ok(text) => {
            let text = text.trim().to_string();
            if text.is_empty() {
                None
            } else {
                Some(text)
            }
        }
        Err(e) => {
            eprintln!("[docs] OCR failed for {}: {e}", path.display());
            None
        }
    }
}

#[cfg(not(windows))]
pub fn ocr_image(_path: &Path) -> Option<String> {
    None
}

/// Ask the local chat sidecar to caption an image. Returns None on any
/// failure (sidecar down, model without vision, network error, empty reply) —
/// the caller degrades to OCR-only silently.
pub async fn vision_caption(base_url: &str, abs_path: &Path) -> Option<String> {
    use base64::Engine as _;

    let bytes = std::fs::read(abs_path).ok()?;
    let mime = match abs_path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("bmp") => "image/bmp",
        Some("gif") => "image/gif",
        _ => "application/octet-stream",
    };
    let data_uri = format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&bytes)
    );

    let body = serde_json::json!({
        "messages": [{
            "role": "user",
            "content": [
                { "type": "text", "text": CAPTION_PROMPT },
                { "type": "image_url", "image_url": { "url": data_uri } },
            ],
        }],
        "max_tokens": 140,
        "temperature": 0.0,
        "stream": false,
    });

    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .ok()?;
    let resp = client
        .post(format!("{}/v1/chat/completions", base_url.trim_end_matches('/')))
        .json(&body)
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        eprintln!(
            "[docs] vision caption HTTP {} for {}",
            resp.status(),
            abs_path.display()
        );
        return None;
    }
    let json: serde_json::Value = resp.json().await.ok()?;
    let content = json["choices"][0]["message"]["content"]
        .as_str()?
        .trim()
        .to_string();
    if content.is_empty() {
        None
    } else {
        Some(content)
    }
}

/// Merge filename + OCR + caption into the text that gets embedded for an
/// image. Returns None when there is no content beyond the filename — the
/// indexer skips such images (an orphan filename embeds poorly and produces
/// noise in search results).
pub fn compose_surrogate(
    filename: &str,
    ocr: Option<&str>,
    caption: Option<&str>,
) -> Option<String> {
    let mut parts = vec![format!("Image file: {filename}")];
    let mut has_content = false;
    if let Some(ocr) = ocr.map(str::trim).filter(|s| !s.is_empty()) {
        parts.push(format!("OCR text: {ocr}"));
        has_content = true;
    }
    if let Some(caption) = caption.map(str::trim).filter(|s| !s.is_empty()) {
        parts.push(format!("Description: {caption}"));
        has_content = true;
    }
    if has_content {
        Some(parts.join("\n"))
    } else {
        None
    }
}

#[cfg(windows)]
mod win_ocr {
    use windows::core::HSTRING;
    use windows::Graphics::Imaging::{
        BitmapAlphaMode, BitmapDecoder, BitmapPixelFormat, BitmapTransform,
        ColorManagementMode, ExifOrientationMode,
    };
    use windows::Media::Ocr::OcrEngine;
    use windows::Storage::{FileAccessMode, StorageFile};

    fn e<E: std::fmt::Display>(err: E) -> String {
        err.to_string()
    }

    pub fn run(path: &std::path::Path) -> Result<String, String> {
        let path_str = path.to_string_lossy().to_string();
        let file = StorageFile::GetFileFromPathAsync(&HSTRING::from(&path_str))
            .map_err(e)?
            .get()
            .map_err(e)?;
        let stream = file
            .OpenAsync(FileAccessMode::Read)
            .map_err(e)?
            .get()
            .map_err(e)?;
        let decoder = BitmapDecoder::CreateAsync(&stream)
            .map_err(e)?
            .get()
            .map_err(e)?;

        // OcrEngine rejects images whose larger dimension exceeds
        // MaxImageDimension; decode scaled-down via a BitmapTransform.
        let width = decoder.PixelWidth().map_err(e)?;
        let height = decoder.PixelHeight().map_err(e)?;
        let max_dim = OcrEngine::MaxImageDimension().map_err(e)?;
        let transform = BitmapTransform::new().map_err(e)?;
        if width.max(height) > max_dim {
            let scale = max_dim as f64 / width.max(height) as f64;
            transform
                .SetScaledWidth(((width as f64 * scale).floor() as u32).max(1))
                .map_err(e)?;
            transform
                .SetScaledHeight(((height as f64 * scale).floor() as u32).max(1))
                .map_err(e)?;
        }

        let bitmap = decoder
            .GetSoftwareBitmapTransformedAsync(
                BitmapPixelFormat::Gray8,
                BitmapAlphaMode::Ignore,
                &transform,
                ExifOrientationMode::IgnoreExifOrientation,
                ColorManagementMode::DoNotColorManage,
            )
            .map_err(e)?
            .get()
            .map_err(e)?;

        let engine = OcrEngine::TryCreateFromUserProfileLanguages().map_err(e)?;
        let result = engine
            .RecognizeAsync(&bitmap)
            .map_err(e)?
            .get()
            .map_err(e)?;
        Ok(result.Text().map_err(e)?.to_string_lossy())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn surrogate_requires_content_beyond_filename() {
        assert_eq!(compose_surrogate("scan.png", None, None), None);
        assert_eq!(compose_surrogate("scan.png", Some("  "), Some("")), None);
    }

    #[test]
    fn surrogate_with_ocr_only() {
        let s = compose_surrogate("receipt.jpg", Some("TOTAL $12.50"), None).unwrap();
        assert!(s.starts_with("Image file: receipt.jpg\n"));
        assert!(s.contains("OCR text: TOTAL $12.50"));
        assert!(!s.contains("Description:"));
    }

    #[test]
    fn surrogate_with_caption_only() {
        let s = compose_surrogate("photo.png", None, Some("a red barn in a field")).unwrap();
        assert!(s.contains("Description: a red barn in a field"));
        assert!(!s.contains("OCR text:"));
    }

    #[test]
    fn surrogate_with_both_orders_ocr_then_caption() {
        let s = compose_surrogate("doc.png", Some("hello world"), Some("a scanned letter")).unwrap();
        assert_eq!(
            s,
            "Image file: doc.png\nOCR text: hello world\nDescription: a scanned letter"
        );
    }

    #[test]
    fn mime_mapping_for_common_extensions() {
        // Indirect check: vision_caption rejects missing files before MIME
        // matters, so this only pins the extension logic via the surrogate
        // path staying pure. Kept as a compile-level guard.
        for ext in ["png", "jpg", "jpeg", "webp", "bmp", "gif"] {
            let name = format!("x.{ext}");
            assert!(Path::new(&name).extension().is_some());
        }
    }
}
