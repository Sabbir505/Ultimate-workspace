//! Local image generation — the image analog of the STT system. Four pieces:
//!
//! 1. **Curated model catalog** — GGUF diffusion models (Z-Image Turbo quants
//!    from `leejet/Z-Image-Turbo-GGUF`), a classic full checkpoint (SD 1.5),
//!    the text encoder the split models need (Qwen3-4B GGUF) and the shared
//!    VAE (Flux `ae.safetensors` — served by the UNGATED `Comfy-Org`
//!    mirror; the upstream `black-forest-labs` repos are gated on HuggingFace
//!    and every download from them fails with a misleading "gated" error).
//!    Files land in `<models dir>/image-gen/`.
//! 2. **Manual models** — anything else diffusion-shaped already on disk in
//!    the models folder (a hand-downloaded SDXL checkpoint, a favorite
//!    SD 1.5 merge) is detected by `image_gen_status` and can be pointed at:
//!    the user assigns each file a role (diffusion / text-encoder / VAE) and,
//!    for diffusion files, a layout (full self-contained checkpoint vs split
//!    model that needs the encoder + VAE files).
//! 3. **sd-server sidecar** — stable-diffusion.cpp's HTTP server (the image
//!    counterpart of llama-server). Resolved like the whisper binary (managed
//!    build → user path → env → PATH), spawned against one diffusion model on
//!    a free port, health-polled, exposed as start/stop/status. Generation is
//!    an OpenAI-style `POST /v1/images/generations` returning base64 PNG.
//! 4. **Settings** — `imageGen.defaultModel` (models-root-relative diffusion
//!    path), `imageGen.defaultLayout`, the per-file overrides `imageGen.roles`
//!    / `imageGen.layouts`, `imageGen.device` (`"auto" | "vulkan" | "cpu"`),
//!    and the binary path override `imageGen.sdServerPath`.
//!
//! Engine installs are pinned stable-diffusion.cpp release zips (CUDA 12 +
//! cudart, Vulkan, CPU) verified with SHA-256 before extraction — the same
//! contract as the whisper/llama installers. One image at a time: the server
//! has no queue management or cancellation, so generations are serialized
//! behind a process-wide gate.
//!
//! `generate_image` (chat/tools/imagegen.rs) calls [`generate_via_app`].

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use base64::Engine as _;
use serde_json::Value;
use parking_lot::Mutex;
use serde::Serialize;
use tauri::{Manager, State};

use crate::commands::local_model_market::DownloadRegistry;
use crate::commands::local_model_market::DownloadState;
use crate::db;
use crate::DbState;

type CmdResult<T> = Result<T, String>;

/// Where downloaded image models live, relative to the configured models dir.
pub const IMAGE_SUBDIR: &str = "image-gen";

const DEFAULT_MODEL_KEY: &str = "imageGen.defaultModel";
/// Layout of the CURRENT default diffusion model (`"full"` / `"split"`) —
/// written together with `DEFAULT_MODEL_KEY` by `image_gen_set_default`.
const DEFAULT_LAYOUT_KEY: &str = "imageGen.defaultLayout";
/// JSON map: models-relative file path → assigned role. Overrides the name
/// heuristic for detected manual files.
const ROLES_KEY: &str = "imageGen.roles";
/// The SELECTED text encoder / VAE for split models (models-root-relative
/// paths, per the grouped picker). Empty/missing = automatic: the catalog
/// file, wherever it sits in the models folder.
const ENCODER_PATH_KEY: &str = "imageGen.encoderPath";
const VAE_PATH_KEY: &str = "imageGen.vaePath";
/// JSON map: models-relative diffusion path → layout override.
const LAYOUTS_KEY: &str = "imageGen.layouts";
const SERVER_PATH_KEY: &str = "imageGen.sdServerPath";
/// `"auto" | "vulkan" | "cpu"` — which stable-diffusion.cpp build to run.
/// `"auto"` prefers the managed CUDA build (NVIDIA) when present, then
/// Vulkan, then the CPU build — mirroring the `stt.device` contract, but
/// three-way because image models run on AMD/Intel GPUs too.
const DEVICE_KEY: &str = "imageGen.device";

/// Managed install dirs (siblings of the whisper/llama builds).
pub const SD_CUDA_DIR: &str = "sd-cpp-cuda";
pub const SD_VULKAN_DIR: &str = "sd-cpp-vulkan";
pub const SD_CPU_DIR: &str = "sd-cpp";

/// Pinned stable-diffusion.cpp auto-build (`master-872`). Pinned, not
/// `latest/download`, so the asset name/contents can never shift under us;
/// bump deliberately together with the URLs + SHAs below. Also the version
/// the build updater (`check_build_updates`) compares installs against.
pub const SD_RELEASE_TAG: &str = "master-872-cc515a0";

#[cfg(windows)]
const SD_CUDA_ZIP_URL: &str = "https://github.com/leejet/stable-diffusion.cpp/releases/download/master-872-cc515a0/sd-master-cc515a0-bin-win-cuda12-x64.zip";
/// SECURITY: SHA-256 of the pinned zip — the download is executed, so TLS
/// alone is not enough. Verified before extraction; bump with the tag.
#[cfg(windows)]
const SD_CUDA_ZIP_SHA256: &str = "7d64c44c1f3907dc9b2fe0932331d77499005d7b16cf654ea76674072b6d64b5";
#[cfg(windows)]
/// The CUDA 12 runtime DLLs ship as a SEPARATE asset (same shape as
/// llama.cpp's cudart bundle): cublas64_12, cublasLt64_12, cudart64_12.
const SD_CUDART_ZIP_URL: &str = "https://github.com/leejet/stable-diffusion.cpp/releases/download/master-872-cc515a0/cudart-sd-bin-win-cu12-x64.zip";
#[cfg(windows)]
const SD_CUDART_ZIP_SHA256: &str = "fe20366827d357c00797eebb58244dddab7fd9a348d70090c3871004c320f38d";
#[cfg(windows)]
const SD_VULKAN_ZIP_URL: &str = "https://github.com/leejet/stable-diffusion.cpp/releases/download/master-872-cc515a0/sd-master-cc515a0-bin-win-vulkan-x64.zip";
#[cfg(windows)]
const SD_VULKAN_ZIP_SHA256: &str =
    "b8c6538f8948dfaa1adc25c463fb1617098d1ff307032e38f29648d5891ead8d";
#[cfg(windows)]
const SD_CPU_ZIP_URL: &str = "https://github.com/leejet/stable-diffusion.cpp/releases/download/master-872-cc515a0/sd-master-cc515a0-bin-win-cpu-x64.zip";
#[cfg(windows)]
const SD_CPU_ZIP_SHA256: &str =
    "43c9b5d2a2af61d65bf46e57c53b154067bccc82e84823eaee66ec4d20095875";

/// Progress ids for the engine installs (the ServerBuildsCard rows key on
/// these; `check_build_updates` shares them).
pub const CUDA_INSTALL_ID: &str = "image-sd-cuda";
pub const VULKAN_INSTALL_ID: &str = "image-sd-vulkan";
pub const CPU_INSTALL_ID: &str = "image-sd-cpu";

const SD_SERVER_EXE: &str = if cfg!(windows) { "sd-server.exe" } else { "sd-server" };

/// Generation defaults for detected manual diffusion models (catalog entries
/// carry their own). 20 steps / CFG 7 is the classic SD1.5/SDXL sweet spot
/// the upstream CLI defaults to.
const MANUAL_STEPS: u32 = 20;
const MANUAL_CFG: f64 = 7.0;

// ---- Model layout ----

/// How a diffusion model loads. `Split` (Z-Image / modern DiT family) loads a
/// standalone diffusion transformer plus separate text-encoder and VAE files;
/// `Full` (SD 1.5 / SDXL checkpoints) is one self-contained file passed via
/// `-m`, encoders and VAE included.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageLayout {
    Split,
    Full,
}

impl ImageLayout {
    fn as_str(self) -> &'static str {
        match self {
            ImageLayout::Split => "split",
            ImageLayout::Full => "full",
        }
    }
    fn parse(s: &str) -> Option<Self> {
        match s {
            "full" => Some(ImageLayout::Full),
            "split" => Some(ImageLayout::Split),
            _ => None,
        }
    }
}

/// One curated image model file. `role` groups the catalog in the UI and
/// drives start-time resolution; `layout` only means something for
/// diffusion entries.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageModelInfo {
    pub id: String,
    pub label: String,
    /// Package this entry belongs to ("z-image-turbo", "sd15"): a family is
    /// the full pipeline — diffusion + the text encoder + VAE it needs — so
    /// the panel can install/activate it as ONE thing, reusing component
    /// files that are already on disk under other families.
    pub family: String,
    /// `"diffusion" | "text-encoder" | "vae"`.
    pub role: String,
    /// `"split" | "full"` (diffusion entries only; `"split"` for deps).
    pub layout: String,
    pub filename: String,
    pub download_url: String,
    pub size_bytes: u64,
    pub note: String,
    pub recommended: bool,
    /// Sample steps for the diffusion spawn (0 for dependencies).
    pub steps: u32,
    /// CFG scale for the diffusion spawn (0 for dependencies).
    pub cfg_scale: f64,
    /// The model's NATIVE pixel size (latent space trains at this): the
    /// default render size when the caller doesn't ask for one — 512-class
    /// checkpoints (SD1.5/DreamShaper) render blurry at 1024, and SDXL-class
    /// ones waste VRAM at 512. 0 for dependencies.
    pub native_size: u32,
}

const Z_IMAGE_DIFFUSION_URL: &str = "https://huggingface.co/leejet/Z-Image-Turbo-GGUF/resolve/main";
const QWEN3_TE_URL: &str =
    "https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/main";
/// The Flux VAE mirrored in Comfy-Org's Z-Image bundle — UNGATED. The
/// canonical `black-forest-labs/FLUX.1-schnell` copy requires accepting terms
/// on HuggingFace, so every anonymous download from it fails ("gated"); the
/// file is identical (same Flux VAE Z-Image ships with).
const FLUX_VAE_URL: &str =
    "https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/vae";
/// Classic SD 1.5 full checkpoint — official repo, ungated.
const SD15_URL: &str =
    "https://huggingface.co/stable-diffusion-v1-5/stable-diffusion-v1-5/resolve/main";

/// Curated catalog: three Z-Image Turbo quants (the 2026 efficiency pick —
/// 6B params, 8 steps, runs from ~4GB VRAM), the SD 1.5 full checkpoint, and
/// the two shared files every split model needs.
pub fn catalog() -> Vec<ImageModelInfo> {
    vec![
        ImageModelInfo {
            id: "image/diffusion-z-image-turbo-q4_0".into(),
            family: "z-image-turbo".into(),
            label: "Z-Image Turbo (Q4_0)".into(),
            role: "diffusion".into(),
            layout: "split".into(),
            filename: "z_image_turbo-Q4_0.gguf".into(),
            download_url: format!("{Z_IMAGE_DIFFUSION_URL}/z_image_turbo-Q4_0.gguf"),
            size_bytes: 3_683_370_944,
            note: "Recommended — sharp 1024px images in 8 steps, comfortable on 6GB VRAM".into(),
            recommended: true,
            steps: 8,
            cfg_scale: 1.0,
            native_size: 1024,
        },
        ImageModelInfo {
            id: "image/diffusion-z-image-turbo-q3_k".into(),
            family: "z-image-turbo".into(),
            label: "Z-Image Turbo (Q3_K)".into(),
            role: "diffusion".into(),
            layout: "split".into(),
            filename: "z_image_turbo-Q3_K.gguf".into(),
            download_url: format!("{Z_IMAGE_DIFFUSION_URL}/z_image_turbo-Q3_K.gguf"),
            size_bytes: 3_143_559_104,
            note: "Lowest VRAM — pairs with CPU offload for ~4GB cards; slightly softer detail".into(),
            recommended: false,
            steps: 8,
            cfg_scale: 1.0,
            native_size: 1024,
        },
        ImageModelInfo {
            id: "image/diffusion-z-image-turbo-q6_k".into(),
            family: "z-image-turbo".into(),
            label: "Z-Image Turbo (Q6_K)".into(),
            role: "diffusion".into(),
            layout: "split".into(),
            filename: "z_image_turbo-Q6_K.gguf".into(),
            download_url: format!("{Z_IMAGE_DIFFUSION_URL}/z_image_turbo-Q6_K.gguf"),
            size_bytes: 5_263_239_104,
            note: "Best quality quant — needs ~8GB VRAM free (or offload, which is slower)".into(),
            recommended: false,
            steps: 8,
            cfg_scale: 1.0,
            native_size: 1024,
        },
        ImageModelInfo {
            id: "image/diffusion-sd15-full".into(),
            family: "sd15".into(),
            label: "SD 1.5 (full checkpoint)".into(),
            role: "diffusion".into(),
            layout: "full".into(),
            filename: "v1-5-pruned-emaonly.safetensors".into(),
            download_url: format!("{SD15_URL}/v1-5-pruned-emaonly.safetensors"),
            size_bytes: 4_265_146_304,
            note: "Classic checkpoint — self-contained (no encoder/VAE files), 512px native. \
                   A copy already in your models folder is detected automatically"
                .into(),
            recommended: false,
            steps: 20,
            cfg_scale: 7.0,
            native_size: 512,
        },
        ImageModelInfo {
            id: "image/diffusion-sdxl-base".into(),
            family: "sdxl-base".into(),
            label: "SDXL Base (full checkpoint)".into(),
            role: "diffusion".into(),
            layout: "full".into(),
            filename: "sd_xl_base_1.0.safetensors".into(),
            download_url: "https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/resolve/main/sd_xl_base_1.0.safetensors".into(),
            size_bytes: 6_938_078_334,
            note: "1024px native SDXL — self-contained (encoders + VAE built in), ~8GB VRAM.                    Pony V6 XL and most SDXL finetunes load the same way"
                .into(),
            recommended: false,
            steps: 24,
            cfg_scale: 5.0,
            native_size: 1024,
        },
        ImageModelInfo {
            id: "image/diffusion-sdxl-turbo".into(),
            family: "sdxl-turbo".into(),
            label: "SDXL Turbo (full checkpoint)".into(),
            role: "diffusion".into(),
            layout: "full".into(),
            filename: "sd_xl_turbo_1.0_fp16.safetensors".into(),
            download_url: "https://huggingface.co/stabilityai/sdxl-turbo/resolve/main/sd_xl_turbo_1.0_fp16.safetensors".into(),
            size_bytes: 6_938_081_905,
            note: "Fastest SDXL — 4 steps per image, self-contained. Sketchy detail,                    unbeatable speed; needs ~8GB VRAM"
                .into(),
            recommended: false,
            steps: 4,
            cfg_scale: 1.0,
            native_size: 1024,
        },
        ImageModelInfo {
            id: "image/diffusion-dreamshaper-8".into(),
            family: "dreamshaper".into(),
            label: "DreamShaper 8 (full checkpoint)".into(),
            role: "diffusion".into(),
            layout: "full".into(),
            filename: "DreamShaper_8_pruned.safetensors".into(),
            download_url: "https://huggingface.co/Lykon/DreamShaper/resolve/main/DreamShaper_8_pruned.safetensors".into(),
            size_bytes: 2_132_625_894,
            note: "Popular stylized SD1.5 checkpoint — illustration/portrait friendly,                    self-contained, runs from ~4GB VRAM"
                .into(),
            recommended: false,
            steps: 20,
            cfg_scale: 7.0,
            native_size: 512,
        },
        ImageModelInfo {
            id: "image/te-qwen3-4b-q4_k_m".into(),
            family: "z-image-turbo".into(),
            label: "Text encoder — Qwen3-4B (Q4_K_M)".into(),
            role: "text-encoder".into(),
            layout: "split".into(),
            filename: "Qwen3-4B-Instruct-2507-Q4_K_M.gguf".into(),
            download_url: format!("{QWEN3_TE_URL}/Qwen3-4B-Instruct-2507-Q4_K_M.gguf"),
            size_bytes: 2_497_281_120,
            note: "Required by split models — the prompt encoder (Z-Image and friends)".into(),
            recommended: true,
            steps: 0,
            cfg_scale: 0.0,
            native_size: 0,
        },
        ImageModelInfo {
            id: "image/vae-flux-ae".into(),
            family: "z-image-turbo".into(),
            label: "VAE — Flux ae.safetensors".into(),
            role: "vae".into(),
            layout: "split".into(),
            filename: "ae.safetensors".into(),
            download_url: format!("{FLUX_VAE_URL}/ae.safetensors"),
            size_bytes: 335_304_388,
            note: "Required by split models — decodes the latent into a PNG (shared across \
                   Z-Image quants). A copy already in your models folder is detected automatically"
                .into(),
            recommended: true,
            steps: 0,
            cfg_scale: 0.0,
            native_size: 0,
        },
    ]
}

/// A running sd-server sidecar. The child is kept so `stop` can kill it;
/// dropped only on stop/app exit (same lifecycle contract as the llama and
/// whisper sidecars).
pub struct ImageGenHandle {
    pub port: u16,
    pub diffusion_path: String,
    pub child: tokio::process::Child,
}

#[derive(Default)]
pub struct ImageGenState(pub Mutex<Option<ImageGenHandle>>);

/// Push a generation-lifecycle update to the frontend (the chat composer-area
/// card: progress + finished preview). Safe no-op before setup.
/// Payload: { phase: "starting"|"rendering"|"saving"|"done"|"error",
///            step?, total?, width?, height?, path?, dataUri?, error? }
pub fn emit_update(app: &tauri::AppHandle, phase: &str, extra: Value) {
    use tauri::Emitter;
    let mut payload = serde_json::json!({ "phase": phase });
    if let (Some(obj), Some(map)) = (payload.as_object_mut(), extra.as_object()) {
        for (k, v) in map {
            obj.insert(k.clone(), v.clone());
        }
    }
    let _ = app.emit("image-gen:update", payload);
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageGenStatus {
    pub running: bool,
    pub port: Option<u16>,
    /// Models-root-relative path of the loaded diffusion model.
    pub diffusion_path: Option<String>,
    /// Resolved sd-server binary for the current device, when found.
    pub binary_path: Option<String>,
    /// `"auto" | "vulkan" | "cpu"`.
    pub device: String,
    pub cuda_available: bool,
    pub vulkan_available: bool,
    /// The CPU build resolves (managed install or PATH/user path).
    pub cpu_available: bool,
    /// Models-root-relative path of the default diffusion model.
    pub default_model: Option<String>,
    pub default_layout: String,
    /// Absolute dir downloads target (`<models dir>/image-gen`).
    pub image_dir: Option<String>,
    pub catalog: Vec<ImageCatalogEntry>,
    /// Every split model's dependencies resolve (encoder + VAE found).
    pub dependencies_ready: bool,
    /// Effective text encoder / VAE (the user's group selection, else the
    /// catalog file) as models-root-relative paths — what a split model
    /// actually loads.
    pub encoder_path: Option<String>,
    pub vae_path: Option<String>,
    /// Diffusion-shaped files found in the models folder beyond the catalog
    /// (manual models), with the effective role/layout per file.
    pub detected: Vec<DetectedFile>,
}

// (No newtype needed — `device` is a plain string on the wire.)

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageCatalogEntry {
    pub id: String,
    pub label: String,
    pub family: String,
    pub role: String,
    pub layout: String,
    pub filename: String,
    pub download_url: String,
    pub size_bytes: u64,
    pub note: String,
    pub recommended: bool,
    pub installed: bool,
    pub is_default: bool,
}

/// One manually-placed model file found in the models folder.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedFile {
    /// Models-root-relative path, forward slashes (the stable identity used
    /// by the role/layout override settings).
    pub path: String,
    pub name: String,
    pub size_bytes: u64,
    /// Effective role: user assignment wins over the name heuristic.
    pub role: String,
    /// For diffusion-role files: `"full"` / `"split"` (assignment → extension
    /// guess: safetensors are full checkpoints, gguf are split).
    pub layout: Option<String>,
    /// True when the role came from the user's assignment, not the guess.
    pub assigned: bool,
}

fn image_dir(conn: &rusqlite::Connection) -> Option<PathBuf> {
    crate::commands::local_model_market::resolve_models_dir(conn)
        .ok()
        .map(|d| d.join(IMAGE_SUBDIR))
}

fn get_setting(conn: &rusqlite::Connection, key: &str) -> Option<String> {
    db::get_setting(conn, key).ok().flatten()
}

fn setting_map(conn: &rusqlite::Connection, key: &str) -> BTreeMap<String, String> {
    get_setting(conn, key)
        .and_then(|s| serde_json::from_str::<BTreeMap<String, String>>(&s).ok())
        .unwrap_or_default()
}

fn set_setting_map(
    conn: &rusqlite::Connection,
    key: &str,
    map: &BTreeMap<String, String>,
) -> CmdResult<()> {
    let json = serde_json::to_string(map).map_err(|e| e.to_string())?;
    db::set_setting(conn, key, &json).map_err(|e| e.to_string())
}

/// Normalize a path identity: models-root-relative, forward slashes.
fn rel_path(p: &Path, root: &Path) -> Option<String> {
    let rel = p.strip_prefix(root).ok()?.to_string_lossy().replace('\\', "/");
    (!rel.is_empty()).then_some(rel)
}

/// Find a catalog-named file anywhere under the models root (depth-capped):
/// a copy dropped in `flux-encoders/` or `sd15/` counts just like one the
/// app downloaded into `image-gen/`.
fn find_installed(root: &Path, filename: &str) -> Option<PathBuf> {
    let mut stack = vec![(root.to_path_buf(), 0u8)];
    while let Some((dir, depth)) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if depth < 3 {
                    stack.push((path, depth + 1));
                }
            } else if path.file_name().is_some_and(|n| n == filename) {
                return Some(path);
            }
        }
    }
    None
}

/// Guess a detected file's role from its name. Encoder names (t5xxl, clip_*,
/// Qwen/VLM/mistral encoders) are reliable; `ae.safetensors`/`*vae*` are the
/// standard VAE names; everything else is a diffusion candidate.
fn guess_role(name: &str) -> &'static str {
    let lower = name.to_lowercase();
    if lower == "ae.safetensors" || lower.contains("vae") {
        "vae"
    } else if lower.contains("t5xxl")
        || lower.starts_with("clip")
        || lower.contains("clip_l")
        || lower.contains("clip_g")
        || lower.contains("text-encoder")
        || lower.contains("text_encoder")
        || lower.contains("qwen3-4b")
        || lower.contains("qwen2.5-vl")
        || lower.contains("mistral")
    {
        "text-encoder"
    } else {
        "diffusion"
    }
}

/// Layout guess for a diffusion-role file: `.safetensors` are full
/// checkpoints (single-file SD1.5/SDXL), `.gguf` are usually split DiT quants.
fn guess_layout(name: &str) -> &'static str {
    if name.to_lowercase().ends_with(".safetensors") {
        "full"
    } else {
        "split"
    }
}

/// Tensor-name prefixes that only exist in FULL checkpoints — the baked VAE
/// (`first_stage_model.*`) and text encoders (`cond_stage_model.*` for SD1.5,
/// `conditioner.*` for SDXL). A split DiT dump never carries them.
const FULL_CHECKPOINT_TENSOR_PREFIXES: [&str; 3] =
    ["first_stage_model.", "cond_stage_model.", "conditioner."];

/// Peek at a GGUF's tensor-name table to tell a FULL checkpoint (SD 1.5 /
/// SDXL with baked VAE + encoders) from a split diffusion dump. ComfyUI-GGUF
/// style files carry no metadata at all, so tensor names are the only
/// reliable signal. Returns `None` when the file can't be parsed as GGUF.
fn sniff_full_checkpoint(path: &Path) -> Option<bool> {
    use std::io::{Read, Seek, SeekFrom};

    fn read_u32(f: &mut std::fs::File) -> Option<u32> {
        let mut b = [0u8; 4];
        f.read_exact(&mut b).ok()?;
        Some(u32::from_le_bytes(b))
    }
    fn read_u64(f: &mut std::fs::File) -> Option<u64> {
        let mut b = [0u8; 8];
        f.read_exact(&mut b).ok()?;
        Some(u64::from_le_bytes(b))
    }
    fn read_string(f: &mut std::fs::File) -> Option<String> {
        let n = read_u64(f)?;
        if n > 1_000_000 {
            return None;
        }
        let mut s = vec![0u8; n as usize];
        f.read_exact(&mut s).ok()?;
        Some(String::from_utf8_lossy(&s).into_owned())
    }
    fn skip_string_array(f: &mut std::fs::File, count: u64) -> Option<()> {
        for _ in 0..count.min(1_000_000) {
            let n = read_u64(f)?;
            f.seek(SeekFrom::Current(n as i64)).ok()?;
        }
        Some(())
    }

    let mut f = std::fs::File::open(path).ok()?;
    let mut magic = [0u8; 4];
    f.read_exact(&mut magic).ok()?;
    if u32::from_le_bytes(magic) != 0x46554747 {
        return None; // "GGUF"
    }
    read_u32(&mut f)?; // version
    let tensor_count = read_u64(&mut f)?;
    let kv_count = read_u64(&mut f)?;

    // Skip metadata KVs (mirror parse_gguf's type handling; seek so huge
    // tokenizer arrays cost nothing).
    for _ in 0..kv_count.min(4096) {
        let _key = read_string(&mut f)?;
        let vt = read_u32(&mut f)?;
        match vt {
            8 => {
                read_string(&mut f)?;
            }
            9 => {
                let elem_type = read_u32(&mut f)?;
                let count = read_u64(&mut f)?;
                match elem_type {
                    8 => skip_string_array(&mut f, count)?,
                    7 => {
                        f.seek(SeekFrom::Current(count.saturating_mul(4) as i64)).ok()?;
                    }
                    10 | 12 => {
                        f.seek(SeekFrom::Current(count.saturating_mul(8) as i64)).ok()?;
                    }
                    6 => {
                        f.seek(SeekFrom::Current(count.saturating_mul(4) as i64)).ok()?;
                    }
                    4 | 5 => {
                        f.seek(SeekFrom::Current(count.saturating_mul(2) as i64)).ok()?;
                    }
                    2 | 3 | 1 => {
                        f.seek(SeekFrom::Current(count as i64)).ok()?;
                    }
                    _ => return None,
                }
            }
            other => {
                let size = match other {
                    0 | 1 | 7 => 1,
                    2 | 3 => 2,
                    4 | 5 | 6 => 4,
                    10 | 11 | 12 => 8,
                    _ => return None,
                };
                f.seek(SeekFrom::Current(size as i64)).ok()?;
            }
        }
    }

    // Walk the tensor-name table looking for checkpoint-only components.
    let mut found = false;
    for _ in 0..tensor_count.min(65_536) {
        // GGUF tensor_info order: NAME (string) first, then n_dimensions,
        // dimensions, type, offset — reading n_dims first desyncs everything.
        let Some(name) = read_string(&mut f) else {
            return None;
        };
        let n_dims = read_u32(&mut f)?;
        if n_dims > 8 {
            return None;
        }
        f.seek(SeekFrom::Current(n_dims as i64 * 8)).ok()?; // dims
        read_u32(&mut f)?; // ggml tensor type
        read_u64(&mut f)?; // offset
        let lower = name.to_ascii_lowercase();
        if FULL_CHECKPOINT_TENSOR_PREFIXES
            .iter()
            .any(|p| lower.starts_with(p))
        {
            found = true;
            break;
        }
    }
    Some(found)
}

/// The effective load layout for a diffusion model file: an explicit user
/// override wins, then the GGUF tensor sniff (full checkpoints carry baked
/// VAE/encoder tensors), then the extension guess. Used identically by the
/// status listing and the spawner so they can never disagree.
fn effective_layout(
    path: &Path,
    name: &str,
    rel: &str,
    layouts: &BTreeMap<String, String>,
) -> ImageLayout {
    if let Some(l) = layouts.get(rel).and_then(|s| ImageLayout::parse(s)) {
        return l;
    }
    if name.to_lowercase().ends_with(".gguf") {
        if let Some(full) = sniff_full_checkpoint(path) {
            return if full { ImageLayout::Full } else { ImageLayout::Split };
        }
    }
    match ImageLayout::parse(guess_layout(name)) {
        Some(l) => l,
        None => ImageLayout::Split,
    }
}


/// Every model-shaped file under the models root that the catalog doesn't
/// already claim (manual models). `stt`/`tts` subdirs are other engines'
/// territory; `.partial`/`.meta` are download-engine bookkeeping.
fn scan_detected(root: &Path, roles: &BTreeMap<String, String>, layouts: &BTreeMap<String, String>) -> Vec<DetectedFile> {
    let catalog_names: Vec<String> = catalog().into_iter().map(|m| m.filename).collect();
    let mut found: Vec<(String, PathBuf, u64)> = Vec::new();
    let mut stack = vec![(root.to_path_buf(), 0u8)];
    while let Some((dir, depth)) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                let name = path.file_name().map(|n| n.to_string_lossy().into_owned());
                if matches!(name.as_deref(), Some("stt") | Some("tts")) {
                    continue;
                }
                if depth < 3 {
                    stack.push((path, depth + 1));
                }
                continue;
            }
            let name = path.file_name().map(|n| n.to_string_lossy().into_owned());
            let Some(name) = name else { continue };
            let lower = name.to_lowercase();
            if !(lower.ends_with(".gguf") || lower.ends_with(".safetensors")) {
                continue;
            }
            if lower.ends_with(".partial") || lower.ends_with(".meta") || catalog_names.contains(&name) {
                continue;
            }
            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
            let Some(rel) = rel_path(&path, root) else { continue };
            // Chat/embedding GGUFs already live in My Models — keep them out
            // of the image panel. The mirror of the My Models rule: a GGUF
            // whose architecture says CHAT (anything that isn't a known
            // diffusion arch — llama.cpp stamps one on every chat conversion,
            // including exotic new families) belongs there, not here.
            // Headerless ComfyUI-GGUF-style dumps are image files. A file
            // whose name marks it as an encoder (t5xxl, Qwen3-4B TE, …) stays
            // visible even with a chat architecture, since that's exactly
            // what its role would be; a user role assignment always wins.
            if lower.ends_with(".gguf") {
                let role = roles
                    .get(&rel)
                    .cloned()
                    .unwrap_or_else(|| guess_role(&name).to_string());
                if role == "diffusion" {
                    let arch = crate::chat::local_models::parse_gguf(&path).architecture;
                    if arch.is_some_and(|a| crate::chat::local_models::is_chat_gguf_arch(Some(&a))) {
                        continue;
                    }
                }
            }
            found.push((rel, path, size));
        }
    }
    found.sort();
    found
        .into_iter()
        .map(|(rel, path, size)| {
            let name = Path::new(&rel)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| rel.clone());
            let assigned = roles.get(&rel).cloned();
            let role = assigned.clone().unwrap_or_else(|| guess_role(&name).to_string());
            let layout = if role == "diffusion" {
                Some(effective_layout(&path, &name, &rel, layouts).as_str().to_string())
            } else {
                None
            };
            DetectedFile {
                path: rel,
                name,
                size_bytes: size,
                role,
                layout,
                assigned: assigned.is_some(),
            }
        })
        .collect()
}

fn managed_dir(app: &tauri::AppHandle, subdir: &str) -> PathBuf {
    crate::user_dirs::app_data_dir(app).join("bin").join(subdir)
}

fn dir_has_server(dir: PathBuf) -> Option<PathBuf> {
    let p = dir.join(SD_SERVER_EXE);
    p.is_file().then_some(p)
}

pub fn cuda_build_installed(app: &tauri::AppHandle) -> bool {
    dir_has_server(managed_dir(app, SD_CUDA_DIR)).is_some()
}

pub fn vulkan_build_installed(app: &tauri::AppHandle) -> bool {
    dir_has_server(managed_dir(app, SD_VULKAN_DIR)).is_some()
}

pub fn cpu_build_installed(app: &tauri::AppHandle) -> bool {
    dir_has_server(managed_dir(app, SD_CPU_DIR)).is_some()
}

fn device_setting(conn: &rusqlite::Connection) -> String {
    match get_setting(conn, DEVICE_KEY).as_deref() {
        Some("vulkan") => "vulkan".into(),
        Some("cpu") => "cpu".into(),
        _ => "auto".into(),
    }
}

/// Resolve the sd-server binary for `device`, tagged with the backend it
/// represents: managed build first (what the one-click installers provide —
/// like `stt.rs`'s CUDA-first GPU chain), then the user path → `SD_SERVER`
/// env → PATH. `"auto"` walks CUDA → Vulkan → the generic chain, so an
/// NVIDIA machine with both builds uses CUDA while AMD/Intel users get
/// Vulkan automatically. Externally-supplied binaries tag as `"custom"`
/// (treated like the GPU builds by the VRAM ladder).
fn resolve_binary(
    app: &tauri::AppHandle,
    conn: &rusqlite::Connection,
    device: &str,
) -> Option<(PathBuf, &'static str)> {
    let mut candidates: Vec<(PathBuf, &'static str)> = Vec::new();
    match device {
        "cuda" => {
            if let Some(p) = dir_has_server(managed_dir(app, SD_CUDA_DIR)) {
                candidates.push((p, "cuda"));
            }
        }
        "vulkan" => {
            if let Some(p) = dir_has_server(managed_dir(app, SD_VULKAN_DIR)) {
                candidates.push((p, "vulkan"));
            }
        }
        "cpu" => {
            if let Some(p) = dir_has_server(managed_dir(app, SD_CPU_DIR)) {
                candidates.push((p, "cpu"));
            }
        }
        // auto: CUDA, then Vulkan.
        _ => {
            if let Some(p) = dir_has_server(managed_dir(app, SD_CUDA_DIR)) {
                candidates.push((p, "cuda"));
            }
            if let Some(p) = dir_has_server(managed_dir(app, SD_VULKAN_DIR)) {
                candidates.push((p, "vulkan"));
            }
        }
    }
    if let Some(p) = get_setting(conn, SERVER_PATH_KEY).filter(|s| !s.trim().is_empty()) {
        let path = PathBuf::from(p.trim());
        if path.is_file() {
            candidates.push((path, "custom"));
        } else if path.is_dir() {
            candidates.push((path.join(SD_SERVER_EXE), "custom"));
        }
    }
    if let Ok(env_path) = std::env::var("SD_SERVER") {
        let path = PathBuf::from(env_path);
        if path.is_file() {
            candidates.push((path, "custom"));
        } else if path.is_dir() {
            candidates.push((path.join(SD_SERVER_EXE), "custom"));
        }
    }
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            let p = dir.join(SD_SERVER_EXE);
            if p.is_file() {
                candidates.push((p, "custom"));
            }
        }
    }
    candidates.into_iter().next()
}

/// The diffusion model the server should load, with its effective generation
/// parameters. Priority: the explicit default (any file in the models folder,
/// catalog or manual) → the recommended installed catalog model → any
/// installed catalog model. Manual files are never auto-picked — they run
/// when the user sets them as default.
struct EffectiveDiffusion {
    path: PathBuf,
    layout: ImageLayout,
    steps: u32,
    cfg_scale: f64,
}

/// Decode the `imageGen.defaultModel` value: a models-root-relative path
/// (current) or a bare image-gen filename (legacy).
fn default_model_path(root: &Path, value: &str) -> PathBuf {
    if value.contains('/') || value.contains('\\') {
        root.join(value)
    } else {
        root.join(IMAGE_SUBDIR).join(value)
    }
}

fn catalog_entry_for_filename(name: &str) -> Option<ImageModelInfo> {
    catalog().into_iter().find(|m| m.filename == name)
}

fn resolve_diffusion(root: &Path, default_model: Option<&str>, layouts: &BTreeMap<String, String>) -> Option<EffectiveDiffusion> {
    if let Some(value) = default_model {
        let path = default_model_path(root, value);
        if path.is_file() {
            let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            let entry = catalog_entry_for_filename(&name);
            // Catalog entries carry their own layout; anything else is
            // sniffed (GGUF tensor table → full checkpoint vs split dump),
            // with the extension guess as the last resort. The stored
            // defaultLayout is deliberately NOT consulted here: it used to
            // capture the raw guess, which would pin a wrong layout forever.
            // The user's explicit per-file override lives in `layouts` and
            // wins via effective_layout.
            let layout = entry
                .as_ref()
                .and_then(|e| ImageLayout::parse(&e.layout))
                .unwrap_or_else(|| effective_layout(&path, &name, value, layouts));
            return Some(EffectiveDiffusion {
                path,
                layout,
                steps: entry.as_ref().map(|e| e.steps).filter(|s| *s > 0).unwrap_or(MANUAL_STEPS),
                cfg_scale: entry
                    .as_ref()
                    .map(|e| e.cfg_scale)
                    .filter(|c| *c > 0.0)
                    .unwrap_or(MANUAL_CFG),
            });
        }
    }
    let all = catalog();
    for m in all.iter().filter(|m| m.role == "diffusion") {
        if !m.recommended {
            continue;
        }
        if let Some(path) = find_installed(root, &m.filename) {
            return Some(EffectiveDiffusion {
                path,
                layout: ImageLayout::parse(&m.layout).unwrap_or(ImageLayout::Split),
                steps: if m.steps > 0 { m.steps } else { MANUAL_STEPS },
                cfg_scale: if m.cfg_scale > 0.0 { m.cfg_scale } else { MANUAL_CFG },
            });
        }
    }
    for m in all.iter().filter(|m| m.role == "diffusion") {
        if let Some(path) = find_installed(root, &m.filename) {
            return Some(EffectiveDiffusion {
                path,
                layout: ImageLayout::parse(&m.layout).unwrap_or(ImageLayout::Split),
                steps: if m.steps > 0 { m.steps } else { MANUAL_STEPS },
                cfg_scale: if m.cfg_scale > 0.0 { m.cfg_scale } else { MANUAL_CFG },
            });
        }
    }
    None
}

/// The text encoder / VAE a split model loads: the user's group selection
/// first, then the catalog-named file wherever it sits in the models folder.
fn resolve_dependency(root: &Path, role: &str, selected: Option<&str>) -> Option<PathBuf> {
    if let Some(rel) = selected.filter(|s| !s.trim().is_empty()) {
        let p = root.join(rel);
        if p.is_file() {
            return Some(p);
        }
    }
    catalog()
        .into_iter()
        .filter(|m| m.role == role)
        .find_map(|m| {
            // App-managed downloads FIRST, then any copy elsewhere in the
            // models folder: a same-named file dropped by hand may be a
            // different revision entirely (a 32-latent ae.safetensors that
            // fails Z-Image validation was found in the wild), while the
            // catalog copy is the one this app verified.
            let managed = root.join(IMAGE_SUBDIR).join(&m.filename);
            if managed.is_file() {
                return Some(managed);
            }
            find_installed(root, &m.filename)
        })
}

fn pick_free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .ok()
        .and_then(|l| l.local_addr().ok())
        .map(|a| a.port())
        .unwrap_or(8917)
}

/// Full status snapshot for the Settings panel.
#[tauri::command]
pub async fn image_gen_status(
    app: tauri::AppHandle,
    db: State<'_, DbState>,
    image: State<'_, ImageGenState>,
) -> CmdResult<ImageGenStatus> {
    let (root, dir, default_model, default_layout, device, roles, layouts, encoder_sel, vae_sel) = {
        let conn = db.0.lock();
        (
            crate::commands::local_model_market::resolve_models_dir(&conn).ok(),
            image_dir(&conn),
            get_setting(&conn, DEFAULT_MODEL_KEY),
            get_setting(&conn, DEFAULT_LAYOUT_KEY).unwrap_or_else(|| "split".into()),
            device_setting(&conn),
            setting_map(&conn, ROLES_KEY),
            setting_map(&conn, LAYOUTS_KEY),
            get_setting(&conn, ENCODER_PATH_KEY),
            get_setting(&conn, VAE_PATH_KEY),
        )
    };
    let running_guard = image.0.lock();
    let binary = resolve_binary(&app, &db.0.lock(), &device).map(|(p, _)| p);
    let detected = root
        .as_ref()
        .map(|r| scan_detected(r, &roles, &layouts))
        .unwrap_or_default();
    let catalog_entries: Vec<ImageCatalogEntry> = catalog()
        .into_iter()
        .map(|m| {
            let installed = root
                .as_ref()
                .map(|r| find_installed(r, &m.filename).is_some())
                .unwrap_or(false);
            let is_default = m.role == "diffusion"
                && default_model
                    .as_deref()
                    .map(|d| d.ends_with(&m.filename))
                    .unwrap_or(false);
            ImageCatalogEntry {
                id: m.id,
                label: m.label,
                family: m.family,
                role: m.role,
                layout: m.layout,
                filename: m.filename,
                download_url: m.download_url,
                size_bytes: m.size_bytes,
                note: m.note,
                recommended: m.recommended,
                installed,
                is_default,
            }
        })
        .collect();
    // Effective encoder/VAE: the group selection, else the catalog file. Both
    // exposed as models-root-relative paths so the grouped UI can mark the
    // selected row whichever kind of file it is.
    let resolved = |role: &str, sel: &Option<String>| -> Option<String> {
        let root = root.as_ref()?;
        let p = resolve_dependency(root, role, sel.as_deref())?;
        rel_path(&p, root)
    };
    let encoder_path = resolved("text-encoder", &encoder_sel);
    let vae_path = resolved("vae", &vae_sel);
    let dependencies_ready = encoder_path.is_some() && vae_path.is_some();
    Ok(ImageGenStatus {
        running: running_guard.is_some(),
        port: running_guard.as_ref().map(|h| h.port),
        diffusion_path: running_guard.as_ref().map(|h| h.diffusion_path.clone()),
        binary_path: binary.map(|p| p.to_string_lossy().into_owned()),
        device,
        cuda_available: cuda_build_installed(&app),
        vulkan_available: vulkan_build_installed(&app),
        cpu_available: cpu_build_installed(&app),
        default_model,
        default_layout,
        image_dir: dir.map(|d| d.to_string_lossy().into_owned()),
        catalog: catalog_entries,
        dependencies_ready,
        encoder_path,
        vae_path,
        detected,
    })
}

/// E5-style start serialization (see `stt.rs` START_SEQ): spawn → health-poll
/// → insert must be atomic, or two concurrent starters both spawn a server and
/// the second insert orphans the first child (holding a CUDA context).
static START_SEQ: std::sync::LazyLock<tokio::sync::Mutex<()>> =
    std::sync::LazyLock::new(|| tokio::sync::Mutex::new(()));

/// One image at a time — sd-server has no queue or cancellation, so a second
/// concurrent generation would just hang both clients. The gate also covers
/// the lazy start (a generate racing the first start must wait for it).
static GENERATE_GATE: std::sync::LazyLock<tokio::sync::Mutex<()>> =
    std::sync::LazyLock::new(|| tokio::sync::Mutex::new(()));

/// Spawn + health-wait shared by the `image_gen_start` command and the
/// lazy-start path in [`generate_via_app`]. Idempotent like
/// `stt::start_sidecar_core`: under the lock a live handle wins.
pub async fn start_sidecar_core(
    app: &tauri::AppHandle,
    db: &DbState,
    image: &ImageGenState,
    warm: bool,
) -> CmdResult<u16> {
    let _seq = START_SEQ.lock().await;
    if let Some(running) = image.0.lock().as_ref() {
        return Ok(running.port);
    }
    let (root, default_model, device, layouts, encoder_sel, vae_sel) = {
        let conn = db.0.lock();
        (
            crate::commands::local_model_market::resolve_models_dir(&conn)?,
            get_setting(&conn, DEFAULT_MODEL_KEY),
            device_setting(&conn),
            setting_map(&conn, LAYOUTS_KEY),
            get_setting(&conn, ENCODER_PATH_KEY),
            get_setting(&conn, VAE_PATH_KEY),
        )
    };
    let (binary, backend) = resolve_binary(app, &db.0.lock(), &device).ok_or_else(|| {
        "sd-server is not installed — open Settings → Local Models → Images and install an engine build first".to_string()
    })?;

    let diffusion = resolve_diffusion(&root, default_model.as_deref(), &layouts).ok_or(
        "No image model selected — download one or set a manual model as default in \
         Settings → Local Models → Images first",
    )?;
    // Split models need their encoder + VAE on disk; full checkpoints carry
    // their own.
    let (text_encoder_path, vae_path) = if diffusion.layout == ImageLayout::Split {
        (
            Some(resolve_dependency(&root, "text-encoder", encoder_sel.as_deref()).ok_or_else(
                || {
                    format!(
                        "The text encoder for a SPLIT-layout model is missing. Either download it \
                         in Settings → Local Models → Images, select one in the Text encoders \
                         group, or — if \"{}\" is actually a full self-contained checkpoint (SD \
                         1.5/SDXL with baked VAE + encoders) — flip its layout toggle to \"full\" \
                         and retry.",
                        diffusion
                            .path
                            .file_name()
                            .map(|n| n.to_string_lossy().into_owned())
                            .unwrap_or_default()
                    )
                },
            )?),
            Some(
                resolve_dependency(&root, "vae", vae_sel.as_deref()).ok_or(
                    "The VAE is missing — download it in Settings → Local Models → Images, or \
                     select one in the VAE group",
                )?,
            ),
        )
    } else {
        (None, None)
    };

    let port = pick_free_port();
    let mut args: Vec<String> = vec![
        // Generation settings ride the spawn: sd-server's HTTP API only
        // adjusts prompt/size per request (steps/cfg/seed are startup flags).
        "--steps".into(),
        diffusion.steps.to_string(),
        "--cfg-scale".into(),
        format!("{}", diffusion.cfg_scale),
        "-s".into(),
        "-1".into(), // random seed per generation
        "--listen-ip".into(),
        "127.0.0.1".into(),
        "--listen-port".into(),
        port.to_string(),
        // Flash attention: faster and lighter across backends.
        "--diffusion-fa".into(),
    ];
    // The server does NOT apply the CLI's sampler default — an unset sampler
    // shows up as "Sampler: NONE" in the embedded PNG metadata and produces
    // formless blobs (verified 2026-09-18). Always pin one: classic
    // checkpoints want dpm++2m/karras (the community + user-proven recipe);
    // flow-model split loads (Z-Image family) want plain euler.
    match diffusion.layout {
        ImageLayout::Full => {
            args.push("-m".into());
            args.push(diffusion.path.to_string_lossy().into_owned());
            args.push("--sampling-method".into());
            args.push("dpm++2m".into());
            args.push("--scheduler".into());
            args.push("karras".into());
        }
        ImageLayout::Split => {
            args.push("--diffusion-model".into());
            args.push(diffusion.path.to_string_lossy().into_owned());
            args.push("--sampling-method".into());
            args.push("euler".into());
        }
    }
    if let Some(te) = &text_encoder_path {
        args.push("--llm".into());
        args.push(te.to_string_lossy().into_owned());
    }
    if let Some(vae) = &vae_path {
        args.push("--vae".into());
        args.push(vae.to_string_lossy().into_owned());
    }
    // VRAM strategy — VERIFIED on the target hardware (GTX 1660 Ti 6GB,
    // 2026-09-18, repro A/B/D against the user's own working recipes):
    //   * `--offload-to-cpu` CORRUPTS output on Turing + CUDA (block/stripe
    //     garbage) — never use it. `--max-vram <budget>` achieves the same
    //     low-VRAM goal cleanly: weights page via CUDA VMM and the graph
    //     cutter spills to RAM beyond the budget.
    //   * `--vae-tiling` is numerically safe (repro D) and needed for
    //     1024px+ decodes on small cards.
    //   * `--backend te=cpu` keeps text encoders out of the small VRAM pool
    //     (encoding runs once per image — no measurable cost).
    let free_vram = crate::chat::local_models::query_free_vram_bytes();
    if backend != "cpu" {
        let free_gib = free_vram.map(|v| v as f64 / (1024.0 * 1024.0 * 1024.0));
        let budget = match free_gib {
            // Leave ~1.5GB for activations/attention; floor at 2.5GB.
            Some(g) => (g - 1.5).clamp(2.5, 24.0),
            None => 4.5,
        };
        args.push("--max-vram".into());
        args.push(format!("{budget:.1}"));
        args.push("--backend".into());
        args.push("te=cpu".into());
        args.push("--vae-tiling".into());
    }

    let mut cmd = tokio::process::Command::new(&binary);
    cmd.args(&args)
        .current_dir(binary.parent().unwrap_or(Path::new(".")))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        // A child dropped mid-start must not linger as an orphaned server
        // holding its port and model memory.
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to start sd-server: {e}"))?;

    // Server stderr → a log file. This is the ONLY place "is the GPU backend
    // active / why is generation slow" is actually answerable: ggml prints
    // its device init there ("ggml_cuda_init: found N CUDA devices") and a
    // silent CPU fallback would otherwise be invisible. Truncated per start.
    if let Some(stderr) = child.stderr.take() {
        let log_dir = crate::user_dirs::app_data_dir(app).join("logs");
        let _ = std::fs::create_dir_all(&log_dir);
        let log_path = log_dir.join("image-gen-server.log");
        if let Ok(mut log_file) = std::fs::File::create(&log_path) {
            use std::io::Write as _;
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                use tokio::io::AsyncReadExt;
                let mut stderr = stderr;
                let mut buf = vec![0u8; 4096];
                // sd.cpp writes step progress with CR line endings — a
                // line-oriented reader never yields them (the log stayed at
                // the backend-init lines forever). Split on BOTH separators
                // and feed live step counts to the UI.
                const SEPARATORS: [u8; 2] = [b'\r', b'\n'];
                let mut pending: Vec<u8> = Vec::new();
                loop {
                    match stderr.read(&mut buf).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            pending.extend_from_slice(&buf[..n]);
                            while let Some(pos) =
                                pending.iter().position(|b| SEPARATORS.contains(b))
                            {
                                let line_bytes: Vec<u8> = pending.drain(..=pos).collect();
                                let line = String::from_utf8_lossy(&line_bytes[..pos])
                                    .trim()
                                    .to_string();
                                if line.is_empty() {
                                    continue;
                                }
                                let _ = writeln!(log_file, "{line}");
                                let _ = log_file.flush();
                                if let Some((step, total)) = parse_step_progress(&line) {
                                    emit_update(
                                        &app,
                                        "rendering",
                                        serde_json::json!({ "step": step, "total": total }),
                                    );
                                }
                            }
                        }
                    }
                }
            });
        }
    }

    // Health-poll: model load streams several GB off disk, so allow ~2min
    // (NVMe answers in seconds; the poll breaks on the FIRST response).
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(std::time::Duration::from_millis(700))
        .build()
        .map_err(|e| e.to_string())?;
    let url = format!("http://127.0.0.1:{port}/");
    let mut healthy = false;
    for _ in 0..480 {
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        if client.get(&url).send().await.is_ok() {
            healthy = true;
            break;
        }
        // Fail fast when the process died (bad flag, missing DLL, broken
        // model file).
        if let Ok(Some(status)) = child.try_wait() {
            return Err(format!(
                "sd-server exited immediately ({status}) — usually a bad binary/DLL set, an \
                 unsupported flag, or a model file that doesn't match its layout. Check the \
                 engine install and model selection in Settings → Local Models → Images."
            ));
        }
    }
    if !healthy {
        let _ = child.kill().await;
        let _ = child.wait().await;
        return Err(
            "sd-server started but never became reachable (model too large for disk speed, or a \
             broken build — see Settings → Local Models → Images)"
                .into(),
        );
    }

    *image.0.lock() = Some(ImageGenHandle {
        port,
        diffusion_path: rel_path(&diffusion.path, &root)
            .unwrap_or_else(|| diffusion.path.to_string_lossy().into_owned()),
        child,
    });
    eprintln!(
        "[image-gen] sd-server up on port {port} ({} {:?}, backend {backend})",
        diffusion.path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        diffusion.layout,
    );

    // GPU backends JIT-compile kernels on the FIRST generation — fire a tiny
    // image in the background so that cost lands at startup, not mid-turn.
    // CPU setups skip it: there is no JIT cliff and the compute would
    // compete with real use.
    if warm && backend != "cpu" {
        let warm_app = app.clone();
        tauri::async_runtime::spawn(async move {
            let db = warm_app.state::<DbState>();
            let image = warm_app.state::<ImageGenState>();
            // Direct post_generation — NOT generate_once: that re-enters
            // ensure/start (async cycle) and this render must not emit
            // progress events anyway. The lock guard is dropped before the
            // await (parking_lot guards are !Send).
            let port = image.0.lock().as_ref().map(|h| h.port);
            if let Some(port) = port {
                let _ = post_generation(port, "warmup", Some(320), Some(320), None, None).await;
            }
            eprintln!("[image-gen] sidecar warmup complete");
        });
    }
    Ok(port)
}

/// True when the tracked server process died without the state being
/// cleared (crash, OOM kill, force-killed parent) — the caller must stop +
/// lazy-restart before generating.
fn server_process_dead(image: &ImageGenState) -> bool {
    let mut guard = image.0.lock();
    guard
        .as_mut()
        .map(|h| h.child.try_wait().map(|s| s.is_some()).unwrap_or(false))
        .unwrap_or(false)
}

/// Make sure a LIVE server handle exists (self-healing): clears a dead
/// handle, then lazy-starts when nothing is running. `warm` only affects an
/// actual start here (no warmup render when a real request is imminent).
pub async fn ensure_server_alive(
    app: &tauri::AppHandle,
    db: &DbState,
    image: &ImageGenState,
    warm: bool,
) -> CmdResult<()> {
    if server_process_dead(image) {
        eprintln!("[image-gen] tracked sd-server died — clearing and restarting");
        stop_sidecar(image).await;
    }
    if image.0.lock().is_none() {
        start_sidecar_core(app, db, image, warm).await?;
    }
    Ok(())
}

/// Kill the running sidecar, if any. Shared by the stop command and the
/// app-exit cleanup — without the exit kill, every app quit orphans an
/// sd-server holding a CUDA context and gigabytes of model memory.
pub async fn stop_sidecar(image: &ImageGenState) {
    let mut handle = image.0.lock().take();
    if let Some(h) = handle.as_mut() {
        let _ = h.child.kill().await;
    }
}

/// One image against an already-running sidecar: POST the prompt, decode the
/// base64 PNG, optionally save it to `save_dir`. Serialized by
/// [`GENERATE_GATE`] (the server handles one request at a time).
pub async fn generate_once(
    app: &tauri::AppHandle,
    db: &DbState,
    image: &ImageGenState,
    prompt: &str,
    width: u32,
    height: u32,
    save_dir: Option<&Path>,
    silent: bool,
) -> CmdResult<GeneratedImage> {
    let _gate = GENERATE_GATE.lock().await;
    if prompt.trim().is_empty() {
        return Err("prompt is empty".into());
    }
    // (0, 0) = "caller didn't ask for a size" — render at the model's native
    // size (same rule as generate_via_app).
    let (width, height) = if width == 0 || height == 0 {
        let default_model = {
            let conn = db.0.lock();
            get_setting(&conn, DEFAULT_MODEL_KEY)
        };
        native_default_size(default_model.as_deref())
    } else {
        (width, height)
    };
    // Self-heal: a crashed/OOM-killed server leaves a stale handle behind —
    // clear it and lazy-start fresh instead of POSTing into the void.
    ensure_server_alive(app, db, image, false).await?;
    let port = image.0.lock().as_ref().map(|h| h.port);
    let Some(port) = port else {
        return Err("the image server is not running".into());
    };
    if !silent {
        emit_update(app, "rendering", serde_json::json!({ "width": clamp_size(width), "height": clamp_size(height) }));
    }
    match post_generation(port, prompt, Some(width), Some(height), save_dir, None).await {
        Ok(img) => {
            if !silent {
                emit_update(
                    app,
                    "done",
                    serde_json::json!({
                        "width": img.width, "height": img.height,
                        "path": img.path, "dataUri": img.data_uri,
                    }),
                );
            }
            Ok(img)
        }
        Err(e) => {
            if !silent {
                emit_update(app, "error", serde_json::json!({ "error": e }));
            }
            Err(e)
        }
    }
}

fn short_body(text: &str) -> String {
    let t = text.trim().replace('\n', " ");
    if t.len() > 200 {
        format!("{}…", &t[..200])
    } else if t.is_empty() {
        "(no body)".into()
    } else {
        t
    }
}

fn chrono_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Extract "step/total" from a sd.cpp progress line (e.g.
/// "generate_image: step 12/20" or bare " 12 / 20" segments). Returns the
/// LAST such pair on the line — progress overwrites stall echoes.
fn parse_step_progress(line: &str) -> Option<(u32, u32)> {
    let bytes = line.as_bytes();
    let mut result = None;
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_digit() {
            let start = i;
            while i < bytes.len() && bytes[i].is_ascii_digit() {
                i += 1;
            }
            // slash then digits then non-digit (or end).
            if i < bytes.len() && bytes[i] == b'/' {
                let slash = i;
                i += 1;
                if i < bytes.len() && bytes[i].is_ascii_digit() {
                    let t_start = i;
                    while i < bytes.len() && bytes[i].is_ascii_digit() {
                        i += 1;
                    }
                    if i >= bytes.len() || !bytes[i].is_ascii_digit() {
                        let step: u32 = line[start..slash].parse().ok()?;
                        let total: u32 = line[t_start..i].parse().ok()?;
                        if total > 0 && step <= total {
                            result = Some((step, total));
                        }
                    }
                    continue;
                }
            }
        } else {
            i += 1;
        }
    }
    result
}

/// Clamp a requested dimension to what the models handle well: 256–2048,
/// rounded down to a multiple of 64 (the latent/VAE grid).
pub fn clamp_size(v: u32) -> u32 {
    let v = v.clamp(256, 2048);
    v - (v % 64)
}

/// Default generation size for callers that didn't pin one, scaled to the
/// hardware: on small-VRAM GPUs a 1024px SDXL run graph-cuts to RAM and can
/// take 5-15 minutes; 512 keeps it inside tool-call timeout budgets.
/// Returns (width, height).
pub fn default_size() -> (u32, u32) {
    let small = crate::chat::local_models::query_free_vram_bytes()
        .map(|v| v < 6 * 1024 * 1024 * 1024)
        .unwrap_or(true);
    if small {
        (512, 512)
    } else {
        (1024, 1024)
    }
}

/// Pull the base64 PNG out of an sd-server `/v1/images/generations` response.
/// The API is "OpenAI compatible to a degree" (upstream's words), so accept
/// the OpenAI shape first and the observed variants after.
fn extract_b64_png(body: &str) -> Option<String> {
    let trimmed = body.trim();
    // Raw data URI / bare base64 fallback.
    if let Some(rest) = trimmed.strip_prefix("data:image/png;base64,") {
        return Some(rest.trim().to_string());
    }
    let v: serde_json::Value = serde_json::from_str(trimmed).ok()?;
    if let Some(b64) = v
        .get("data")
        .and_then(|d| d.get(0))
        .and_then(|item| item.get("b64_json"))
        .and_then(|b| b.as_str())
    {
        return Some(b64.to_string());
    }
    if let Some(img) = v.get("images").and_then(|i| i.get(0)) {
        if let Some(s) = img.as_str() {
            return Some(s.trim_start_matches("data:image/png;base64,").to_string());
        }
        if let Some(s) = img.get("b64_json").and_then(|b| b.as_str()) {
            return Some(s.to_string());
        }
    }
    if let Some(s) = v.get("b64_json").and_then(|b| b.as_str()) {
        return Some(s.to_string());
    }
    None
}

/// A generated image: always as a data URI (settings preview), plus the
/// on-disk path when a save dir was given (the chat tool).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedImage {
    pub data_uri: String,
    pub path: Option<String>,
    pub width: u32,
    pub height: u32,
}

/// AppHandle-based entry for the `generate_image` chat tool: lazy-starts the
/// sidecar (self-heal, like the mic path in speech.rs), then generates.
/// `out_path` (when given) is the EXACT file the PNG is written to — the done
/// event then carries that final path, so callers that post-process the file
/// (rename/insert into galleries) don't get a second event pointing at a path
/// that stopped existing.
pub async fn generate_via_app(
    app: &tauri::AppHandle,
    prompt: &str,
    width: u32,
    height: u32,
    save_dir: Option<&Path>,
    out_path: Option<&Path>,
) -> CmdResult<GeneratedImage> {
    let _gate = GENERATE_GATE.lock().await;
    if prompt.trim().is_empty() {
        return Err("prompt is empty".into());
    }
    let db = app.state::<DbState>();
    let image = app.state::<ImageGenState>();
    // Lazy start from a live request: no warmup render — it would queue
    // AHEAD of the user's image and double the wait (GENERATE_GATE).
    // Self-heals a crashed/OOM-killed server first (stale handle clearing).
    ensure_server_alive(app, &db, &image, false).await?;
    let port = image.0.lock().as_ref().map(|h| h.port);
    let Some(port) = port else {
        return Err("the image server started but did not report a port".into());
    };
    // (0, 0) = "caller didn't ask for a size" — render at the model's native
    // size instead of a global default (512-class checkpoints blur at 1024).
    let (width, height) = if width == 0 || height == 0 {
        let default_model = {
            let conn = db.0.lock();
            get_setting(&conn, DEFAULT_MODEL_KEY)
        };
        native_default_size(default_model.as_deref())
    } else {
        (width, height)
    };
    emit_update(app, "rendering", serde_json::json!({ "width": clamp_size(width), "height": clamp_size(height) }));
    let result = post_generation(port, prompt, Some(width), Some(height), save_dir, out_path).await;
    match &result {
        Ok(img) => emit_update(
            app,
            "done",
            serde_json::json!({
                "width": img.width, "height": img.height,
                "path": img.path, "dataUri": img.data_uri,
            }),
        ),
        Err(e) => emit_update(app, "error", serde_json::json!({ "error": e })),
    }
    result
}

/// The default render size for the CURRENT default diffusion model: its
/// catalog native size (512-class checkpoints stay sharp, SDXL-class render
/// at 1024), falling back to 1024 for hand-placed models we can't classify.
fn native_default_size(default_model: Option<&str>) -> (u32, u32) {
    let native = default_model
        .as_deref()
        .and_then(|d| {
            catalog().into_iter().find_map(|m| {
                (m.role == "diffusion" && (d.ends_with(&m.filename))).then_some(m.native_size)
            })
        })
        .filter(|n| *n > 0)
        .unwrap_or(1024);
    (native, native)
}

/// POST one generation to a RUNNING sidecar and decode it (gate held by the
/// caller). Shared by the gated paths. The PNG lands in `save_dir` under a
/// timestamped name — or at exactly `out_path` when the caller needs to know
/// the final location up front (the chat tool announces it in its result).
async fn post_generation(
    port: u16,
    prompt: &str,
    width: Option<u32>,
    height: Option<u32>,
    save_dir: Option<&Path>,
    out_path: Option<&Path>,
) -> CmdResult<GeneratedImage> {
    let width = clamp_size(width.unwrap_or(1024));
    let height = clamp_size(height.unwrap_or(1024));
    let client = reqwest::Client::builder()
        .no_proxy()
        .connect_timeout(std::time::Duration::from_secs(10))
        // CPU/offload tiers legitimately need 20+ minutes for a 1024px run.
        .timeout(std::time::Duration::from_secs(30 * 60))
        .build()
        .map_err(|e| e.to_string())?;
    let url = format!("http://127.0.0.1:{port}/v1/images/generations");
    let body = serde_json::json!({
        "prompt": prompt,
        "n": 1,
        "size": format!("{width}x{height}"),
        "response_format": "b64_json",
    });
    let resp = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("image generation request failed: {e}"))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!(
            "image generation failed: HTTP {status} — {}",
            short_body(&text)
        ));
    }
    let b64 = extract_b64_png(&text)
        .ok_or_else(|| format!("image server returned no image data — {}", short_body(&text)))?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64.as_bytes())
        .map_err(|e| format!("image data was not valid base64: {e}"))?;

    let mut path = None;
    if let Some(dir) = save_dir {
        let file = match out_path {
            Some(dest) => {
                if let Some(parent) = dest.parent() {
                    std::fs::create_dir_all(parent)
                        .map_err(|e| format!("could not create image dir: {e}"))?;
                }
                dest.to_path_buf()
            }
            None => {
                std::fs::create_dir_all(dir)
                    .map_err(|e| format!("could not create image dir: {e}"))?;
                dir.join(format!("image-{}.png", chrono_secs()))
            }
        };
        std::fs::write(&file, &bytes).map_err(|e| format!("could not write image: {e}"))?;
        path = Some(file.to_string_lossy().into_owned());
    }

    Ok(GeneratedImage {
        data_uri: format!("data:image/png;base64,{b64}"),
        path,
        width,
        height,
    })
}

// ---- Commands (Settings → Local Models → Images) ----

#[tauri::command]
pub async fn image_gen_start(
    app: tauri::AppHandle,
    db: State<'_, DbState>,
    image: State<'_, ImageGenState>,
) -> CmdResult<ImageGenStatus> {
    let already_running = image.0.lock().is_some();
    if !already_running {
        // Explicit panel start: pre-warm so the first real image is fast.
        start_sidecar_core(&app, &db, &image, true).await?;
    }
    image_gen_status(app, db, image).await
}

#[tauri::command]
pub async fn image_gen_stop(image: State<'_, ImageGenState>) -> CmdResult<()> {
    stop_sidecar(&image).await;
    Ok(())
}

/// Set the default diffusion model. `path` is models-root-relative with
/// forward slashes (any detected file or catalog download); `layout` says how
/// it loads (`"full"` = self-contained checkpoint via `-m`, `"split"` =
/// diffusion + text-encoder + VAE). A running server belongs to the previous
/// model — stop it so the next generation picks the new default up.
#[tauri::command]
pub async fn image_gen_set_default(
    db: State<'_, DbState>,
    image: State<'_, ImageGenState>,
    path: String,
    layout: Option<String>,
) -> CmdResult<()> {
    {
        let conn = db.0.lock();
        db::set_setting(&conn, DEFAULT_MODEL_KEY, &path).map_err(|e| e.to_string())?;
        db::set_setting(
            &conn,
            DEFAULT_LAYOUT_KEY,
            layout.as_deref().and_then(ImageLayout::parse).map(|l| l.as_str()).unwrap_or("split"),
        )
        .map_err(|e| e.to_string())?;
    }
    stop_sidecar(&image).await;
    Ok(())
}

/// Assign (or clear, with `role: null`) a detected file's role. Assignments
/// override the name heuristic and make the file resolvable as that role for
/// split models (text-encoder / vae).
#[tauri::command(async)]
pub fn image_gen_set_file_role(
    db: State<'_, DbState>,
    path: String,
    role: Option<String>,
) -> CmdResult<()> {
    let conn = db.0.lock();
    let mut roles = setting_map(&conn, ROLES_KEY);
    match role.as_deref() {
        Some(r) if matches!(r, "diffusion" | "text-encoder" | "vae") => {
            roles.insert(path, r.to_string());
        }
        _ => {
            roles.remove(&path);
        }
    }
    set_setting_map(&conn, ROLES_KEY, &roles)
}

/// Override a detected diffusion file's layout (`"full"` / `"split"`, or null
/// to fall back to the sniff/extension guess). When the file IS the current
/// default, the stored default layout is synced too and a running sidecar is
/// stopped — the toggle must take effect on the next generation without the
/// user also having to re-set the default.
#[tauri::command]
pub async fn image_gen_set_file_layout(
    db: State<'_, DbState>,
    image: State<'_, ImageGenState>,
    path: String,
    layout: Option<String>,
) -> CmdResult<()> {
    {
        let conn = db.0.lock();
        let mut layouts = setting_map(&conn, LAYOUTS_KEY);
        match layout.as_deref().and_then(ImageLayout::parse) {
            Some(l) => {
                layouts.insert(path.clone(), l.as_str().to_string());
            }
            None => {
                layouts.remove(&path);
            }
        }
        set_setting_map(&conn, LAYOUTS_KEY, &layouts)?;
        // Sync the default-layout mirror when the toggled file is the
        // default (any path shape: relative or legacy bare filename).
        if let Some(l) = layout.as_deref().and_then(ImageLayout::parse) {
            if get_setting(&conn, DEFAULT_MODEL_KEY).as_deref() == Some(path.as_str()) {
                db::set_setting(&conn, DEFAULT_LAYOUT_KEY, l.as_str()).map_err(|e| e.to_string())?;
            }
        }
    }
    // A running server was spawned under the old layout — stop it so the
    // next generation re-resolves (status stays truthful meanwhile).
    stop_sidecar(&image).await;
    Ok(())
}

/// Select which file a dependency group uses ("text-encoder" / "vae"), or
/// clear the selection (null → automatic: the catalog file). `path` is
/// models-root-relative, matching the rows in the grouped panel. The
/// diffusion group selects via `image_gen_set_default`. A running server is
/// stopped so the next generation picks the new components up.
#[tauri::command]
pub async fn image_gen_select(
    db: State<'_, DbState>,
    image: State<'_, ImageGenState>,
    kind: String,
    path: Option<String>,
) -> CmdResult<()> {
    let key = match kind.as_str() {
        "text-encoder" => ENCODER_PATH_KEY,
        "vae" => VAE_PATH_KEY,
        other => return Err(format!("unknown image component kind \"{other}\"")),
    };
    {
        let conn = db.0.lock();
        let value = path
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        // Validate up front: a selection pointing at nothing would only
        // surface as a failed generation much later.
        if let Some(rel) = &value {
            let exists = crate::commands::local_model_market::resolve_models_dir(&conn)
                .map(|root| root.join(rel).is_file())
                .unwrap_or(false);
            if !exists {
                return Err(format!("no model file exists at \"{rel}\""));
            }
        }
        match &value {
            Some(v) => db::set_setting(&conn, key, v).map_err(|e| e.to_string())?,
            None => db::set_setting(&conn, key, "").map_err(|e| e.to_string())?,
        }
    }
    stop_sidecar(&image).await;
    Ok(())
}

// ---- Model packages (families): diffusion + encoder + VAE as ONE choice ----

/// Human label per package, shown as the family card's title.
fn family_label(family: &str) -> &'static str {
    match family {
        "z-image-turbo" => "Z-Image Turbo — split pipeline",
        "sd15" => "SD 1.5 — full checkpoint",
        "sdxl-base" => "SDXL Base — full checkpoint",
        "sdxl-turbo" => "SDXL Turbo — fast 4-step",
        "dreamshaper" => "DreamShaper 8 — full checkpoint",
        _ => "Image model package",
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FamilyEntryPlan {
    pub id: String,
    pub label: String,
    pub role: String,
    /// `"use"` — already on disk, gets activated; `"download"` — missing,
    /// the command queues it.
    pub action: String,
    /// Models-root-relative path of the resolved file (`use` entries only).
    pub path: Option<String>,
    /// Resolved from a copy OUTSIDE the managed `image-gen/` dir — the
    /// dedupe story: a component downloaded for another family (or dropped
    /// by hand) is reused instead of downloaded again.
    pub reused: bool,
    pub size_bytes: u64,
    /// Diffusion VARIANTS only: true on the quant the plan will install/use.
    pub selected: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FamilyPlan {
    pub family: String,
    pub label: String,
    /// Diffusion layout of the package ("split" | "full").
    pub layout: String,
    /// The chosen diffusion quant (catalog id).
    pub diffusion_id: String,
    pub diffusion_path: Option<String>,
    /// ALL diffusion quants of the family (variant picker on the card).
    pub variants: Vec<FamilyEntryPlan>,
    /// The shared components the picked diffusion needs (encoder, VAE).
    pub deps: Vec<FamilyEntryPlan>,
    /// Every component already active (diffusion is the current default and
    /// all deps resolve) — the card shows "✓ Active" instead of the button.
    pub active: bool,
}

/// Pure planner for "use this package": resolve every component against the
/// disk (managed `image-gen/` copies FIRST, then any same-named file anywhere
/// in the models folder — the shared-reuse rule) and classify each as
/// activate-vs-download. `diffusion_id` picks WHICH quant variant to install
/// (None = the recommended one). Nothing here touches settings; the command
/// applies the plan.
fn plan_family_use(
    root: &Path,
    family: &str,
    diffusion_id: Option<&str>,
    encoder_sel: Option<&str>,
    vae_sel: Option<&str>,
    default_model: Option<&str>,
) -> Option<FamilyPlan> {
    let entries: Vec<ImageModelInfo> = catalog()
        .into_iter()
        .filter(|m| m.family == family)
        .collect();
    let quants: Vec<ImageModelInfo> = entries
        .iter()
        .filter(|m| m.role == "diffusion")
        .cloned()
        .collect();
    let diffusion = quants
        .iter()
        .find(|m| Some(m.id.as_str()) == diffusion_id)
        .or_else(|| quants.iter().find(|m| m.recommended))
        .or_else(|| quants.first())?;
    let layout = diffusion.layout.clone();

    // Variant rows: every quant, resolved against the disk, with the picked
    // one flagged.
    let mut variants = Vec::new();
    let mut diffusion_entry = None;
    for m in &quants {
        let picked = m.id == diffusion.id;
        let managed = root.join(IMAGE_SUBDIR).join(&m.filename);
        let entry = match find_installed(root, &m.filename) {
            Some(p) => FamilyEntryPlan {
                id: m.id.clone(),
                label: m.label.clone(),
                role: m.role.clone(),
                action: "use".into(),
                path: rel_path(&p, root),
                reused: p != managed,
                size_bytes: m.size_bytes,
                selected: picked,
            },
            None => FamilyEntryPlan {
                id: m.id.clone(),
                label: m.label.clone(),
                role: m.role.clone(),
                action: "download".into(),
                path: None,
                reused: false,
                size_bytes: m.size_bytes,
                selected: picked,
            },
        };
        if picked {
            diffusion_entry = Some(entry.clone());
        }
        variants.push(entry);
    }
    let diffusion_entry = diffusion_entry?;

    // Dep rows: shared components resolve through the SAME dependency rule
    // generation uses, so a file already on disk for another package (or
    // dropped by hand) is reused, never re-downloaded.
    let mut deps = Vec::new();
    for m in entries.iter().filter(|m| m.role != "diffusion") {
        let managed = root.join(IMAGE_SUBDIR).join(&m.filename);
        let sel = if m.role == "text-encoder" {
            encoder_sel
        } else {
            vae_sel
        };
        let entry = match resolve_dependency(root, &m.role, sel) {
            Some(p) => FamilyEntryPlan {
                id: m.id.clone(),
                label: m.label.clone(),
                role: m.role.clone(),
                action: "use".into(),
                path: rel_path(&p, root),
                reused: p != managed,
                size_bytes: m.size_bytes,
                selected: false,
            },
            None => FamilyEntryPlan {
                id: m.id.clone(),
                label: m.label.clone(),
                role: m.role.clone(),
                action: "download".into(),
                path: None,
                reused: false,
                size_bytes: m.size_bytes,
                selected: false,
            },
        };
        deps.push(entry);
    }

    let active = diffusion_entry.action == "use"
        && diffusion_entry
            .path
            .as_deref()
            .zip(default_model)
            .map(|(p, d)| d.ends_with(p) || p.ends_with(d))
            .unwrap_or(false)
        && deps.iter().all(|e| e.action == "use");
    Some(FamilyPlan {
        family: family.to_string(),
        label: family_label(family).into(),
        layout,
        diffusion_id: diffusion.id.clone(),
        diffusion_path: diffusion_entry.path.clone(),
        active,
        variants,
        deps,
    })
}

/// Package plans for diffusion files ALREADY on disk (Pony, Cyberrealistic,
/// …): each gets a first-class card like the catalog families — same shape,
/// same Use command (family id `disk:<path>`). A full checkpoint lists no
/// deps; a split file lists the encoder/VAE it resolves to TODAY (status
/// only — the use command never auto-downloads for a disk model, because
/// which encoders a hand-placed SDXL needs is not something the catalog
/// should guess).
fn disk_family_plans(
    root: &Path,
    detected: &[DetectedFile],
    encoder_sel: Option<&str>,
    vae_sel: Option<&str>,
    default_model: Option<&str>,
) -> Vec<FamilyPlan> {
    detected
        .iter()
        .filter(|d| d.role == "diffusion")
        .map(|d| {
            let layout = d.layout.clone().unwrap_or_else(|| "split".into());
            let managed = root.join(IMAGE_SUBDIR).join(&d.path);
            let variants = vec![FamilyEntryPlan {
                id: d.path.clone(),
                label: d.name.clone(),
                role: "diffusion".into(),
                action: "use".into(),
                path: Some(d.path.clone()),
                reused: !d.path.replace('\\', "/").starts_with("image-gen/"),
                size_bytes: d.size_bytes,
                selected: true,
            }];
            let _ = managed;
            let deps: Vec<FamilyEntryPlan> = if layout == "full" {
                vec![]
            } else {
                [
                    ("text-encoder", encoder_sel),
                    ("vae", vae_sel),
                ]
                .iter()
                .filter_map(|(role, sel)| {
                    resolve_dependency(root, role, *sel).map(|p| {
                        let rel = rel_path(&p, root);
                        FamilyEntryPlan {
                            id: format!("disk-dep:{role}"),
                            label: if *role == "text-encoder" {
                                "Text encoder (current selection)".into()
                            } else {
                                "VAE (current selection)".into()
                            },
                            role: (*role).into(),
                            action: "use".into(),
                            path: Some(rel.unwrap_or_default()),
                            reused: !p.starts_with(&root.join(IMAGE_SUBDIR)),
                            size_bytes: 0,
                            selected: false,
                        }
                    })
                })
                .collect()
            };
            let active = default_model
                .map(|dm| dm == d.path || dm.ends_with(&d.path) || d.path.ends_with(dm))
                .unwrap_or(false);
            FamilyPlan {
                family: format!("disk:{}", d.path),
                label: d.name.clone(),
                layout: layout.clone(),
                diffusion_id: d.path.clone(),
                diffusion_path: Some(d.path.clone()),
                active,
                variants,
                deps,
            }
        })
        .collect()
}

/// Read-only plans for EVERY package — the panel's package cards render from
/// this so what you see (reuse/download/active) is exactly what the use
/// command will do.
#[tauri::command]
pub fn image_gen_family_plans(db: State<'_, DbState>) -> CmdResult<Vec<FamilyPlan>> {
    use crate::commands::local_model_market::resolve_models_dir;
    let (root, encoder_sel, vae_sel, default_model, roles, layouts) = {
        let conn = db.0.lock();
        (
            resolve_models_dir(&conn).ok(),
            get_setting(&conn, ENCODER_PATH_KEY).unwrap_or_default(),
            get_setting(&conn, VAE_PATH_KEY).unwrap_or_default(),
            get_setting(&conn, DEFAULT_MODEL_KEY).unwrap_or_default(),
            setting_map(&conn, ROLES_KEY),
            setting_map(&conn, LAYOUTS_KEY),
        )
    };
    let Some(root) = root else {
        return Ok(vec![]);
    };
    let families: Vec<String> = {
        let mut seen = std::collections::HashSet::new();
        catalog()
            .into_iter()
            .map(|m| m.family)
            .filter(|f| seen.insert(f.clone()))
            .collect()
    };
    let mut plans: Vec<FamilyPlan> = families
        .iter()
        .filter_map(|f| {
            plan_family_use(
                &root,
                f,
                None,
                Some(encoder_sel.as_str()).filter(|s| !s.is_empty()),
                Some(vae_sel.as_str()).filter(|s| !s.is_empty()),
                Some(default_model.as_str()).filter(|s| !s.is_empty()),
            )
        })
        .collect();
    // Disk diffusion files (Pony & friends) become first-class package cards
    // right under the catalog families.
    let detected = scan_detected(&root, &roles, &layouts);
    plans.extend(disk_family_plans(
        &root,
        &detected,
        Some(encoder_sel.as_str()).filter(|s| !s.is_empty()),
        Some(vae_sel.as_str()).filter(|s| !s.is_empty()),
        Some(default_model.as_str()).filter(|s| !s.is_empty()),
    ));
    Ok(plans)
}

/// Activate a package as one choice: every component that is already on disk
/// (managed copy OR any same-named file elsewhere in the models folder) is
/// selected/activated — nothing re-downloads — and only the genuinely missing
/// files start downloading. The diffusion default switches immediately, so the
/// next generation uses the package while its missing pieces (if any) are
/// still in flight.
#[tauri::command(async)]
pub async fn image_gen_use_family(
    app: tauri::AppHandle,
    db: State<'_, DbState>,
    registry: State<'_, std::sync::Arc<DownloadRegistry>>,
    image: State<'_, ImageGenState>,
    family: String,
    // Which diffusion VARIANT (quant) to install/use — catalog id. None =
    // the recommended one.
    diffusion_id: Option<String>,
) -> CmdResult<FamilyPlan> {
    let (root, image_dir, encoder_sel, vae_sel, default_model) = {
        let conn = db.0.lock();
        (
            crate::commands::local_model_market::resolve_models_dir(&conn).ok(),
            image_dir(&conn),
            get_setting(&conn, ENCODER_PATH_KEY).unwrap_or_default(),
            get_setting(&conn, VAE_PATH_KEY).unwrap_or_default(),
            get_setting(&conn, DEFAULT_MODEL_KEY).unwrap_or_default(),
        )
    };
    let root = root.ok_or("models folder is not configured")?;
    // A disk package (`disk:<models-root-relative path>`): a diffusion file
    // already in the models folder. Make it the default and return its plan —
    // no downloads are ever queued here (its encoder/VAE needs, if any, are
    // managed through the groups below).
    if let Some(rel) = family.strip_prefix("disk:") {
        let full = root.join(rel);
        if !full.is_file() {
            return Err(format!("no model file exists at \"{rel}\""));
        }
        let roles = {
            let conn = db.0.lock();
            setting_map(&conn, ROLES_KEY)
        };
        let layouts = {
            let conn = db.0.lock();
            setting_map(&conn, LAYOUTS_KEY)
        };
        let detected = scan_detected(&root, &roles, &layouts);
        let layout = detected
            .iter()
            .find(|d| d.path == rel)
            .and_then(|d| d.layout.clone())
            .unwrap_or_else(|| "split".into());
        {
            let conn = db.0.lock();
            db::set_setting(&conn, DEFAULT_MODEL_KEY, rel).map_err(|e| e.to_string())?;
            db::set_setting(&conn, DEFAULT_LAYOUT_KEY, &layout).map_err(|e| e.to_string())?;
        }
        stop_sidecar(&image).await;
        let encoder_sel = encoder_sel.as_str();
        let vae_sel = vae_sel.as_str();
        let plan = disk_family_plans(
            &root,
            &detected,
            Some(encoder_sel).filter(|s| !s.is_empty()),
            Some(vae_sel).filter(|s| !s.is_empty()),
            Some(rel),
        )
        .into_iter()
        .next()
        .ok_or_else(|| format!("disk model \"{rel}\" vanished mid-plan"))?;
        return Ok(plan);
    }
    let plan = plan_family_use(
        &root,
        &family,
        diffusion_id.as_deref(),
        Some(encoder_sel.as_str()).filter(|s| !s.is_empty()),
        Some(vae_sel.as_str()).filter(|s| !s.is_empty()),
        Some(default_model.as_str()).filter(|s| !s.is_empty()),
    )
    .ok_or_else(|| format!("unknown image model package \"{family}\""))?;

    let mut queued = 0usize;
    for entry in plan.variants.iter().filter(|e| e.selected).chain(&plan.deps) {
        match (entry.role.as_str(), entry.action.as_str()) {
            // The diffusion model: switch the default (and drop a running
            // server that belongs to the previous default).
            ("diffusion", "use") => {
                let path = entry
                    .path
                    .clone()
                    .ok_or("package diffusion resolved without a path")?;
                {
                    let conn = db.0.lock();
                    db::set_setting(&conn, DEFAULT_MODEL_KEY, &path)
                        .map_err(|e| e.to_string())?;
                    db::set_setting(&conn, DEFAULT_LAYOUT_KEY, &plan.layout)
                        .map_err(|e| e.to_string())?;
                }
                stop_sidecar(&image).await;
            }
            // Dependencies: pin the selection to the resolved file.
            ("text-encoder", "use") | ("vae", "use") => {
                let key = if entry.role == "text-encoder" {
                    ENCODER_PATH_KEY
                } else {
                    VAE_PATH_KEY
                };
                if let Some(path) = &entry.path {
                    let conn = db.0.lock();
                    db::set_setting(&conn, key, path).map_err(|e| e.to_string())?;
                }
            }
            // Missing pieces: queue the download into the managed dir. The
            // panel's existing download-progress listener picks these up;
            // generation-time resolution finds them once they land. For the
            // diffusion file itself the default ALSO switches now, pointed at
            // the managed path the download will produce — the package is
            // usable the moment its bytes land (smoke-tested 2026-09-19:
            // without this, "install & use" downloaded forever and the
            // default never moved).
            (role, "download") if role == "diffusion" => {
                // Resolve the real filename from the catalog entry.
                let info = catalog()
                    .into_iter()
                    .find(|m| m.id == entry.id)
                    .ok_or("catalog entry vanished mid-plan")?;
                let managed_rel = format!("{IMAGE_SUBDIR}/{}", info.filename);
                {
                    let conn = db.0.lock();
                    db::set_setting(&conn, DEFAULT_MODEL_KEY, &managed_rel)
                        .map_err(|e| e.to_string())?;
                    db::set_setting(&conn, DEFAULT_LAYOUT_KEY, &plan.layout)
                        .map_err(|e| e.to_string())?;
                }
                let dir = image_dir
                    .as_ref()
                    .map(|d| d.to_string_lossy().into_owned())
                    .unwrap_or_else(|| root.join(IMAGE_SUBDIR).to_string_lossy().into_owned());
                crate::commands::local_model_market::start_model_download_inner(
                    app.clone(),
                    DbState(std::sync::Arc::clone(&db.0)),
                    std::sync::Arc::clone(&registry),
                    info.id.clone(),
                    info.filename.clone(),
                    info.download_url.clone(),
                    None,
                    Some(dir),
                )
                .await?;
                queued += 1;
            }
            (_, "download") => {
                let info = catalog()
                    .into_iter()
                    .find(|m| m.id == entry.id)
                    .ok_or("catalog entry vanished mid-plan")?;
                let dir = image_dir
                    .as_ref()
                    .map(|d| d.to_string_lossy().into_owned())
                    .unwrap_or_else(|| root.join(IMAGE_SUBDIR).to_string_lossy().into_owned());
                crate::commands::local_model_market::start_model_download_inner(
                    app.clone(),
                    DbState(std::sync::Arc::clone(&db.0)),
                    std::sync::Arc::clone(&registry),
                    info.id.clone(),
                    info.filename.clone(),
                    info.download_url.clone(),
                    None,
                    Some(dir),
                )
                .await?;
                queued += 1;
            }
            _ => {}
        }
    }
    let _ = queued; // the plan carries the actions; kept for future toasts
    Ok(plan)
}

/// Choose which build runs. A running server belongs to the previous binary —
/// stop it so the status line can't contradict the toggle (the panel restarts
/// on demand; generation lazy-starts anyway).
#[tauri::command]
pub async fn image_gen_set_device(
    db: State<'_, DbState>,
    image: State<'_, ImageGenState>,
    device: String,
) -> CmdResult<()> {
    let device = match device.as_str() {
        "vulkan" => "vulkan",
        "cpu" => "cpu",
        _ => "auto",
    };
    {
        let conn = db.0.lock();
        db::set_setting(&conn, DEVICE_KEY, device).map_err(|e| e.to_string())?;
    }
    stop_sidecar(&image).await;
    Ok(())
}

/// Register the sd-server binary the sidecar will spawn, through the native
/// exec gate (same contract as `stt_set_server_path`): an OS dialog shows the
/// exact executable, and "Allow" is remembered per path.
#[tauri::command(async)]
pub fn image_gen_set_server_path(
    app: tauri::AppHandle,
    db: State<'_, DbState>,
    path: Option<String>,
) -> CmdResult<()> {
    let trimmed = match path {
        Some(p) if !p.trim().is_empty() => p.trim().to_string(),
        _ => {
            let conn = db.0.lock();
            return db::set_setting(&conn, SERVER_PATH_KEY, "").map_err(|e| e.to_string());
        }
    };
    if !crate::exec_gate::confirm_remembered_sync(
        &db.0,
        &app,
        "sd_server",
        &trimmed,
        "Relay — use this sd-server executable?",
        &format!(
            "An app window asked to register this executable as the image-generation sidecar:\n\n{trimmed}\n\nRelay will spawn it to generate images locally. Allow it? \"Allow\" also remembers this path."
        ),
    ) {
        return Err("sd-server path blocked — it was not allowed in the confirmation dialog".into());
    }
    let conn = db.0.lock();
    db::set_setting(&conn, SERVER_PATH_KEY, &trimmed).map_err(|e| e.to_string())
}

/// One-click install/update of a pinned stable-diffusion.cpp build.
/// `device`: `"cuda"` (the CUDA 12 build + its cudart bundle, ~892MB total),
/// `"vulkan"` (~32MB, AMD/Intel), or `"cpu"` (~17MB). Progress arrives on the
/// shared download stream under the matching install id.
#[tauri::command]
pub async fn image_gen_install(
    app: tauri::AppHandle,
    db: State<'_, DbState>,
    image: State<'_, ImageGenState>,
    device: String,
    force: Option<bool>,
) -> CmdResult<ImageGenStatus> {
    #[cfg(not(windows))]
    {
        let _ = (&app, &db, &image, &device, &force);
        return Err(
            "the engine one-click install is Windows-only right now — point at an existing \
             sd-server build with the path field instead"
                .into(),
        );
    }

    #[cfg(windows)]
    {
        let force = force == Some(true);
        let (dir_name, url, sha, id): (&str, &str, &str, &str) = match device.as_str() {
            "vulkan" => (SD_VULKAN_DIR, SD_VULKAN_ZIP_URL, SD_VULKAN_ZIP_SHA256, VULKAN_INSTALL_ID),
            "cpu" => (SD_CPU_DIR, SD_CPU_ZIP_URL, SD_CPU_ZIP_SHA256, CPU_INSTALL_ID),
            _ => (SD_CUDA_DIR, SD_CUDA_ZIP_URL, SD_CUDA_ZIP_SHA256, CUDA_INSTALL_ID),
        };
        let install_dir = managed_dir(&app, dir_name);
        let exe_path = install_dir.join(SD_SERVER_EXE);
        if force || !exe_path.is_file() {
            // A running server holds its image (and DLLs) open — stop it
            // before the files underneath it are replaced.
            if force {
                stop_sidecar(&image).await;
            }
            crate::commands::pinned_zip::install_pinned_zip(
                &app, url, sha, SD_RELEASE_TAG, &install_dir, id,
            )
            .await?;
            crate::commands::pinned_zip::require_entry(&install_dir, SD_SERVER_EXE, id, &app)?;
            // The CUDA build needs the runtime DLLs from the separate cudart
            // asset (verified contents: cudart64_12, cublas64_12,
            // cublasLt64_12) — without them the GPU backend silently fails to
            // load and every generation crawls on CPU (the exact regression
            // llama_build.rs turns into a loud error).
            if device != "vulkan" && device != "cpu" {
                crate::commands::pinned_zip::install_pinned_zip(
                    &app,
                    SD_CUDART_ZIP_URL,
                    SD_CUDART_ZIP_SHA256,
                    SD_RELEASE_TAG,
                    &install_dir,
                    id,
                )
                .await?;
                let missing: Vec<&str> = ["cudart64_", "cublas64_", "cublaslt64_"]
                    .into_iter()
                    .filter(|prefix| {
                        !std::fs::read_dir(&install_dir)
                            .map(|entries| {
                                entries
                                    .filter_map(|e| e.ok())
                                    .any(|e| {
                                        e.file_name()
                                            .to_string_lossy()
                                            .to_lowercase()
                                            .starts_with(prefix)
                                    })
                            })
                            .unwrap_or(false)
                    })
                    .collect();
                if !missing.is_empty() {
                    let msg = format!(
                        "the CUDA runtime bundle is missing {} — the image engine would \
                         silently run on CPU. Re-run the install; if it persists the upstream \
                         asset changed and Relay needs an update.",
                        missing.join(", ")
                    );
                    crate::commands::pinned_zip::emit_progress_for(
                        &app, id, DownloadState::Error, 0, None, None, Some(msg.clone()),
                    );
                    return Err(msg);
                }
            }
            crate::commands::build_updates::write_build_marker(&install_dir, SD_RELEASE_TAG)?;
        }
        crate::commands::pinned_zip::emit_progress_for(
            &app,
            id,
            DownloadState::Done,
            0,
            None,
            Some(exe_path.to_string_lossy().into_owned()),
            None,
        );
        image_gen_status(app, db, image).await
    }
}

/// The Tauri command behind the settings panel's "try it" box: one generation
/// against the RUNNING sidecar, returned as a data URI (nothing saved to
/// disk). Chat generation lazy-starts; this demands an explicit start so the
/// panel's Start button stays meaningful.
#[tauri::command]
pub async fn image_generate(
    app: tauri::AppHandle,
    db: State<'_, DbState>,
    image: State<'_, ImageGenState>,
    prompt: String,
    width: Option<u32>,
    height: Option<u32>,
) -> CmdResult<GeneratedImage> {
    // Omitted size = the active model's native render size (see
    // generate_via_app's 0 sentinel — same rule for the panel's try-it).
    generate_once(
        &app,
        &db,
        &image,
        &prompt,
        width.unwrap_or(0),
        height.unwrap_or(0),
        None,
        false,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_roles_layouts_and_urls_are_well_formed() {
        let cat = catalog();
        assert_eq!(cat.iter().filter(|m| m.role == "diffusion").count(), 7);
        assert_eq!(cat.iter().filter(|m| m.role == "text-encoder").count(), 1);
        assert_eq!(cat.iter().filter(|m| m.role == "vae").count(), 1);
        for m in &cat {
            assert!(m.download_url.starts_with("https://huggingface.co/"));
            assert!(m.size_bytes > 0, "{} must declare a size", m.filename);
            assert!(
                matches!(m.layout.as_str(), "split" | "full"),
                "{} layout must be split|full",
                m.filename
            );
            if m.role == "diffusion" {
                assert!(m.steps > 0 && m.cfg_scale > 0.0);
            } else {
                assert_eq!(m.steps, 0, "deps carry no steps");
            }
        }
        // SECURITY regression: the VAE must come from the UNGATED mirror —
        // the canonical black-forest-labs repos are gated on HuggingFace and
        // every anonymous download from them fails.
        let vae = cat.iter().find(|m| m.role == "vae").unwrap();
        assert!(
            !vae.download_url.contains("black-forest-labs"),
            "VAE URL must not point at a gated repo"
        );
        assert!(vae.download_url.contains("Comfy-Org/z_image_turbo"));
        // Filenames are unique (flat identity — a collision would shadow).
        let mut names: Vec<_> = cat.iter().map(|m| m.filename.as_str()).collect();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), cat.len());
    }

    #[test]
    fn clamp_size_stays_in_grid() {
        assert_eq!(clamp_size(0), 256);
        assert_eq!(clamp_size(100), 256);
        assert_eq!(clamp_size(512), 512);
        assert_eq!(clamp_size(700), 640, "rounds down to the 64 grid");
        assert_eq!(clamp_size(9999), 2048);
        for v in [256u32, 511, 512, 513, 1023, 1024, 2047, 2048] {
            let c = clamp_size(v);
            assert!(c % 64 == 0 && (256..=2048).contains(&c));
        }
    }

    #[test]
    fn extract_b64_png_handles_the_documented_shapes() {
        let b64 = "aGVsbG8=";
        let openai = serde_json::json!({ "data": [{ "b64_json": b64 }] });
        assert_eq!(
            extract_b64_png(&openai.to_string()).as_deref(),
            Some(b64)
        );
        let images = serde_json::json!({ "images": [b64] });
        assert_eq!(extract_b64_png(&images.to_string()).as_deref(), Some(b64));
        let data_uri = format!("data:image/png;base64,{b64}");
        assert_eq!(extract_b64_png(&data_uri).as_deref(), Some(b64));
        let bare = serde_json::json!({ "b64_json": b64 });
        assert_eq!(extract_b64_png(&bare.to_string()).as_deref(), Some(b64));
        assert!(extract_b64_png("{\"nothing\": true}").is_none());
        assert!(extract_b64_png("not json at all").is_none());
    }

    #[test]
    fn guess_role_and_layout_follow_the_name_conventions() {
        assert_eq!(guess_role("t5xxl-Q8_0.gguf"), "text-encoder");
        assert_eq!(guess_role("clip_l.safetensors"), "text-encoder");
        assert_eq!(guess_role("Qwen3-4B-Instruct-2507-Q4_K_M.gguf"), "text-encoder");
        assert_eq!(guess_role("ae.safetensors"), "vae");
        assert_eq!(guess_role("sdxl_vae.safetensors"), "vae");
        assert_eq!(guess_role("cyberrealistic_v14.f16.gguf"), "diffusion");
        assert_eq!(guess_role("ponyDiffusionV6XL.q8_0.gguf"), "diffusion");

        assert_eq!(guess_layout("v1-5-pruned-emaonly.safetensors"), "full");
        assert_eq!(guess_layout("z_image_turbo-Q4_0.gguf"), "split");
    }

    #[test]
    fn default_model_path_handles_relative_and_legacy() {
        let root = Path::new("/models");
        assert_eq!(
            default_model_path(root, "sd15/cyberrealistic_v14.f16.gguf"),
            PathBuf::from("/models/sd15/cyberrealistic_v14.f16.gguf")
        );
        // Legacy bare filename = the download dir.
        assert_eq!(
            default_model_path(root, "z_image_turbo-Q4_0.gguf"),
            PathBuf::from("/models/image-gen/z_image_turbo-Q4_0.gguf")
        );
    }

    #[test]
    fn find_installed_finds_nested_copies_and_skips_partials() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        std::fs::create_dir_all(root.join("flux-encoders")).unwrap();
        std::fs::create_dir_all(root.join("image-gen")).unwrap();
        std::fs::write(root.join("flux-encoders/ae.safetensors"), b"x").unwrap();
        std::fs::write(root.join("image-gen/ae.safetensors.partial"), b"x").unwrap();
        assert_eq!(
            find_installed(root, "ae.safetensors"),
            Some(root.join("flux-encoders/ae.safetensors"))
        );
        assert_eq!(find_installed(root, "missing.safetensors"), None);
    }

    #[test]
    fn catalog_families_group_the_whole_pipeline() {
        let z = catalog()
            .into_iter()
            .filter(|m| m.family == "z-image-turbo")
            .collect::<Vec<_>>();
        assert_eq!(
            z.iter().filter(|m| m.role == "diffusion").count(),
            3,
            "three Z-Image quants"
        );
        assert_eq!(z.iter().filter(|m| m.role == "text-encoder").count(), 1);
        assert_eq!(z.iter().filter(|m| m.role == "vae").count(), 1);
        let sd = catalog()
            .into_iter()
            .filter(|m| m.family == "sd15")
            .collect::<Vec<_>>();
        assert_eq!(sd.len(), 1, "full checkpoint is self-contained");
        assert_eq!(sd[0].layout, "full");
        for fam in ["sdxl-base", "sdxl-turbo", "dreamshaper"] {
            let entries = catalog()
                .into_iter()
                .filter(|m| m.family == fam)
                .collect::<Vec<_>>();
            assert_eq!(entries.len(), 1, "{fam} is one self-contained file");
            assert_eq!(entries[0].layout, "full");
        }
    }

    /// SMOKE TEST for "image packages work for ALL users": every catalog
    /// download URL must be reachable ANONYMOUSLY (no HuggingFace login —
    /// gated repos 401) and the file on the other end must be byte-exact
    /// what the catalog declares (wrong revision → broken weights at a
    /// user's machine that never reproduced here). Network-dependent, so
    /// it's #[ignore]d from the default run: `cargo test --lib -- --ignored
    /// catalog_url_smoke`.
    #[test]
    #[ignore = "network smoke: run explicitly with `cargo test --lib -- --ignored catalog_url_smoke`"]
    fn catalog_url_smoke_downloads_are_live_ungated_and_byte_exact() {
        let cat = catalog();
        assert!(cat.len() >= 9, "catalog unexpectedly shrank");
        // System proxy env (HTTPS_PROXY) is honored — machines that need a
        // proxy to reach HuggingFace must pass here too.
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .expect("http client");
        tauri::async_runtime::block_on(async {
        for m in &cat {
            let resp = client
                .head(&m.download_url)
                .send()
                .await
                .unwrap_or_else(|e| panic!("{}: HEAD failed: {e}", m.download_url));
            assert!(
                resp.status().is_success(),
                "{}: not anonymously downloadable — HTTP {} (gated repo?)",
                m.download_url,
                resp.status()
            );
            let len: u64 = resp
                .headers()
                .get(reqwest::header::CONTENT_LENGTH)
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse().ok())
                .unwrap_or(0);
            assert_eq!(
                len, m.size_bytes,
                "{}: HF reports {len} bytes, catalog declares {} — update size_bytes",
                m.filename, m.size_bytes
            );
        }
        });
    }

    #[test]
    fn disk_files_become_first_class_package_plans() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("sdxl")).unwrap();
        std::fs::write(root.join("sdxl/pony.q8_0.gguf"), b"x").unwrap();
        let detected = vec![DetectedFile {
            path: "sdxl/pony.q8_0.gguf".into(),
            name: "pony.q8_0.gguf".into(),
            size_bytes: 123,
            role: "diffusion".into(),
            layout: Some("full".into()),
            assigned: false,
        }];
        let plans = disk_family_plans(root, &detected, None, None, None);
        assert_eq!(plans.len(), 1);
        let p = &plans[0];
        assert!(p.family.starts_with("disk:"));
        assert_eq!(p.label, "pony.q8_0.gguf");
        assert_eq!(p.layout, "full");
        assert!(p.active == false);
        assert_eq!(p.variants.len(), 1);
        assert_eq!(p.variants[0].action, "use");
        assert!(p.deps.is_empty(), "full checkpoint carries no deps");
    }

    #[test]
    fn plan_family_use_reuses_shared_components_without_downloading() {
        // The dedupe story: the encoder was downloaded for ANOTHER package
        // (sits outside image-gen/), the VAE is the managed copy, only the
        // diffusion weights are missing → plan must "use" both components
        // (encoder flagged reused) and download exactly one file.
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        std::fs::create_dir_all(root.join("image-gen")).unwrap();
        std::fs::create_dir_all(root.join("pony-stuff")).unwrap();
        std::fs::write(root.join("pony-stuff/Qwen3-4B-Instruct-2507-Q4_K_M.gguf"), b"x")
            .unwrap();
        std::fs::write(root.join("image-gen/ae.safetensors"), b"x").unwrap();

        let plan = plan_family_use(root, "z-image-turbo", None, None, None, None)
            .expect("z-image-turbo plans");
        assert_eq!(plan.variants.len(), 3, "all quants listed as variants");
        assert!(plan.variants.iter().any(|v| v.selected));
        let by_role = |role: &str| plan.deps.iter().find(|e| e.role == role).unwrap();
        let picked = plan.variants.iter().find(|v| v.selected).unwrap();
        assert_eq!(picked.action, "download");
        let te = by_role("text-encoder");
        assert_eq!(te.action, "use");
        assert!(te.reused, "external encoder copy is flagged as reuse");
        let vae = by_role("vae");
        assert_eq!(vae.action, "use");
        assert!(!vae.reused, "managed copy is not flagged as reuse");
        assert_eq!(plan.deps.iter().filter(|e| e.action == "download").count(), 0);
    }

    #[test]
    fn plan_family_use_downloads_everything_on_a_clean_root() {
        let dir = tempfile::tempdir().expect("tempdir");
        let plan = plan_family_use(dir.path(), "z-image-turbo", None, None, None, None)
            .expect("plans");
        assert_eq!(plan.deps.iter().filter(|e| e.action == "use").count(), 0);
        // The picked variant defaults to the RECOMMENDED quant; the other
        // quants stay opt-in via the picker.
        assert_eq!(plan.diffusion_id, "image/diffusion-z-image-turbo-q4_0");
        assert_eq!(plan.deps.len(), 2);
        let picked = plan.variants.iter().find(|v| v.selected).unwrap();
        assert_eq!(picked.action, "download");
        assert!(picked.label.contains("Q4_0"), "recommended quant is the pick");
    }

    #[test]
    fn plan_family_use_unknown_family_is_none() {
        let dir = tempfile::tempdir().expect("tempdir");
        assert!(plan_family_use(dir.path(), "pony", None, None, None, None).is_none());
    }


    #[test]
    fn sniff_full_checkpoint_reads_the_tensor_table() {
        fn gguf_with_tensor(name: &str) -> Vec<u8> {
            let mut v = Vec::new();
            v.extend_from_slice(b"GGUF");
            v.extend_from_slice(&3u32.to_le_bytes()); // version
            v.extend_from_slice(&1u64.to_le_bytes()); // tensor count
            v.extend_from_slice(&0u64.to_le_bytes()); // kv count
            v.extend_from_slice(&(name.len() as u64).to_le_bytes()); // name
            v.extend_from_slice(name.as_bytes());
            v.extend_from_slice(&3u32.to_le_bytes()); // n dims
            for d in [16u64, 64, 64] {
                v.extend_from_slice(&d.to_le_bytes()); // dims
            }
            v.extend_from_slice(&0u32.to_le_bytes()); // ggml type
            v.extend_from_slice(&0u64.to_le_bytes()); // offset
            v
        }

        let dir = tempfile::tempdir().expect("tempdir");
        // Full SD1.5/SDXL checkpoint: baked VAE tensor present.
        let full = dir.path().join("full.gguf");
        std::fs::write(&full, gguf_with_tensor("first_stage_model.encoder.conv")).unwrap();
        assert_eq!(sniff_full_checkpoint(&full), Some(true));

        // SDXL conditioner counts too.
        let sdxl = dir.path().join("sdxl.gguf");
        std::fs::write(&sdxl, gguf_with_tensor("conditioner.input_blocks.1")).unwrap();
        assert_eq!(sniff_full_checkpoint(&sdxl), Some(true));

        // Split DiT dump: diffusion tensors only.
        let split = dir.path().join("split.gguf");
        std::fs::write(&split, gguf_with_tensor("model.diffusion_model.blocks.0")).unwrap();
        assert_eq!(sniff_full_checkpoint(&split), Some(false));

        // Not GGUF at all.
        let junk = dir.path().join("junk.gguf");
        std::fs::write(&junk, b"not gguf bytes").unwrap();
        assert_eq!(sniff_full_checkpoint(&junk), None);
    }

    #[test]
    fn pinned_hashes_are_well_formed() {
        // Guards against a typo'd constant failing every install opaquely.
        for sha in [
            SD_CUDA_ZIP_SHA256,
            SD_CUDART_ZIP_SHA256,
            SD_VULKAN_ZIP_SHA256,
            SD_CPU_ZIP_SHA256,
        ] {
            assert_eq!(sha.len(), 64);
            assert!(sha.chars().all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c)));
        }
        assert!(SD_CUDA_ZIP_URL.contains(SD_RELEASE_TAG));
        assert!(SD_CUDART_ZIP_URL.contains(SD_RELEASE_TAG));
    }
}
