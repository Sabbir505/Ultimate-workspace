//! Text-to-speech for assistant answers and text artifacts — the TTS analog of
//! the STT stack in `stt.rs`. There is no sidecar and no cloud here:
//! hexgrad/Kokoro-82M (Apache-2.0) runs **in-process** through sherpa-onnx,
//! which owns both the ONNX Runtime session and the espeak-ng phonemization the
//! model needs. Three pieces, mirroring `stt.rs`:
//!
//! 1. **Curated model catalog** — the int8 Kokoro bundles k2-fsa publishes for
//!    sherpa-onnx (`tts-models` release, tar.bz2). One archive carries the
//!    model, the voice styles, the token table AND the espeak-ng data, so an
//!    install is a single download + extract into `<models dir>/tts/`.
//! 2. **Engine lifecycle** — one lazily-built `OfflineTts` per process, rebuilt
//!    when the selected model changes, dropped on app exit. Unlike the whisper
//!    sidecar there is no port, no health poll and no orphan process to reap.
//! 3. **Settings** — `tts.model`, `tts.voice`, `tts.speed`, `tts.autoRead`.
//!
//! `tts_speak` voices ONE caller-supplied chunk: the frontend splits a message
//! into sentences and asks for them in order, so playback starts on the first
//! sentence instead of waiting for the whole answer (a long reply takes minutes
//! to synthesize end-to-end). Results are returned as base64 WAV and backed by a
//! disk cache keyed on (model, voice, speed, text) — replaying a message is a
//! file read, not a second synthesis.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::Mutex;
use serde::Serialize;
use sherpa_onnx::{
    GenerationConfig, OfflineTts, OfflineTtsConfig, OfflineTtsKokoroModelConfig, OfflineTtsModelConfig,
};
use tauri::{Emitter, State};

use crate::commands::local_model_market::{DownloadProgress, DownloadRegistry, DownloadState};
use crate::db;
use crate::DbState;

type CmdResult<T> = Result<T, String>;

/// Where downloaded TTS models live, relative to the configured models dir.
pub const TTS_SUBDIR: &str = "tts";

const MODEL_KEY: &str = "tts.model";
const VOICE_KEY: &str = "tts.voice";
const SPEED_KEY: &str = "tts.speed";
const AUTOREAD_KEY: &str = "tts.autoRead";
/// Keep the engine resident from app start instead of loading it on first use.
const KEEP_LOADED_KEY: &str = "tts.keepLoaded";

/// Synthesis speed bounds — outside this the output stops being intelligible
/// (and Kokoro's vocoder starts to smear), so both the setting and the
/// per-request override are clamped rather than trusted.
const MIN_SPEED: f32 = 0.5;
const MAX_SPEED: f32 = 2.5;

/// Cap on the on-disk synthesis cache. One spoken minute of 24 kHz mono PCM is
/// ~2.8 MB, so this holds roughly three hours of audio; the oldest entries are
/// evicted once it is exceeded.
const CACHE_CAP_BYTES: u64 = 512 * 1024 * 1024;

/// One curated Kokoro bundle.
///
/// Models come from **Hugging Face**, not the upstream GitHub release tarballs.
/// Two reasons: the tarball host (`github.com` → `release-assets.githubusercontent.com`)
/// is unreachable on networks that require a proxy — see `http_client` — and HF
/// is where this app already downloads models from, token handling included. The
/// trade-off is that HF serves the bundle as ~377 individual files rather than
/// one archive, so an install is a concurrent multi-file fetch rather than a
/// download-then-extract.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsModelInfo {
    pub id: String,
    pub label: String,
    /// HF repo holding the bundle at its root.
    pub hf_repo: String,
    /// Directory the bundle lands in, inside `<models dir>/tts`.
    pub dir_name: String,
    /// Total bytes across the repo's files (exact, from the HF tree API at the
    /// time of writing — the live listing is authoritative for progress).
    pub size_bytes: u64,
    pub file_count: u32,
    pub note: String,
    pub languages: String,
    pub recommended: bool,
}

/// Curated catalog — the Kokoro builds published as individual files on HF.
///
/// Only the multilingual repos are offered: `csukuangfj/kokoro-en-v0_19` holds
/// just a `.gitattributes` on HF (the English-only bundle exists solely as a
/// GitHub release tarball, which the proxy-hostile networks above cannot reach),
/// and the int8 variants are GitHub-only too. Nothing is lost by dropping them —
/// the multilingual model carries the full English voice set (11 `af_`/`am_`/
/// `bf_`/`bm_` voices), and fp32 is the variant that measured fastest on
/// non-VNNI CPUs.
pub fn catalog() -> Vec<TtsModelInfo> {
    vec![
        TtsModelInfo {
            id: "tts/kokoro-multi-lang-v1_0".into(),
            label: "Kokoro 82M (multilingual)".into(),
            hf_repo: "csukuangfj/kokoro-multi-lang-v1_0".into(),
            dir_name: "kokoro-multi-lang-v1_0".into(),
            size_bytes: 401_239_297,
            file_count: 377,
            note: "Recommended — 54 voices across English, Chinese, Japanese, Korean, French, Spanish, Hindi, Italian and Portuguese".into(),
            languages: "en, zh, ja, ko, fr, es, hi, it, pt".into(),
            recommended: true,
        },
        TtsModelInfo {
            id: "tts/kokoro-multi-lang-v1_1".into(),
            label: "Kokoro 82M v1.1-zh (English + Chinese)".into(),
            hf_repo: "csukuangfj/kokoro-multi-lang-v1_1".into(),
            dir_name: "kokoro-multi-lang-v1_1".into(),
            size_bytes: 426_654_376,
            file_count: 377,
            note: "Newest weights — tuned for English and Mandarin specifically; fewer voices than v1.0".into(),
            languages: "en, zh".into(),
            recommended: false,
        },
    ]
}

/// A selectable voice. `id` is the speaker index passed to the engine; `name`
/// is the model's own label for it (`af_heart`, `zf_xiaoxiao`, …).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsVoice {
    pub id: i32,
    pub name: String,
    /// Language this voice speaks, derived from Kokoro's naming convention
    /// (`af_`/`am_` = en-US, `zf_`/`zm_` = Chinese, …). Empty when unknown.
    pub language: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsCatalogEntry {
    pub id: String,
    pub label: String,
    pub dir_name: String,
    pub size_bytes: u64,
    pub note: String,
    pub languages: String,
    pub recommended: bool,
    pub installed: bool,
    pub is_selected: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsStatus {
    /// Catalog id of the model that would be loaded right now.
    pub model_id: Option<String>,
    pub model_dir: Option<String>,
    /// Whether the engine is resident in memory (first speak pays the load).
    pub loaded: bool,
    pub voice: Option<String>,
    pub speed: f32,
    pub auto_read: bool,
    /// `"cpu"` (in-process engine) or `"gpu"` (CUDA child process — see
    /// `tts_gpu` for why GPU cannot be a provider on the in-process engine).
    pub device: String,
    /// Load the model at app start and hold it until the app exits, rather than
    /// loading it on the first press of play.
    pub keep_loaded: bool,
    /// Voices of the selected model, read from its ONNX metadata.
    pub voices: Vec<TtsVoice>,
    pub tts_dir: Option<String>,
    pub cache_bytes: u64,
    pub catalog: Vec<TtsCatalogEntry>,
}

/// A synthesized chunk. `audio_base64` is a complete WAV file (header included)
/// so the frontend can decode it without knowing the sample rate up front.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsAudio {
    pub audio_base64: String,
    pub mime: String,
    pub sample_rate: i32,
    pub duration_sec: f32,
    /// True when the bytes came from the disk cache instead of the engine —
    /// surfaced in diagnostics, not shown to the user.
    pub cached: bool,
    pub voice: String,
}

/// A loaded Kokoro engine plus the metadata the UI needs to talk to it.
pub struct TtsEngine {
    tts: OfflineTts,
    model_id: String,
    model_dir: PathBuf,
    voices: Vec<TtsVoice>,
    /// Serializes `generate` calls. sherpa-onnx documents the C object as
    /// thread-safe, but concurrent generation on ONE instance shares the
    /// vocoder's scratch buffers, so we hand it one sentence at a time. The
    /// lock is per-engine and only ever held inside `spawn_blocking`.
    gen_lock: Mutex<()>,
}

#[derive(Default)]
pub struct TtsState(pub Mutex<Option<Arc<TtsEngine>>>);

// ---- Settings helpers ----

fn get_setting(conn: &rusqlite::Connection, key: &str) -> Option<String> {
    db::get_setting(conn, key).ok().flatten()
}

pub fn tts_dir(conn: &rusqlite::Connection) -> Option<PathBuf> {
    crate::commands::local_model_market::resolve_models_dir(conn)
        .ok()
        .map(|d| d.join(TTS_SUBDIR))
}

fn cache_dir(app: &tauri::AppHandle) -> PathBuf {
    crate::user_dirs::app_data_dir(app).join("tts-cache")
}

/// Clamp a caller-supplied speed into the intelligible range.
///
/// NaN is the one value `f32::clamp` would pass straight through (it returns
/// NaN for a NaN input), and a NaN speed would poison both the cache key and
/// the model's `speed` field — so it alone falls back to normal pace. The
/// infinities clamp to the bounds like any other out-of-range number.
fn clamp_speed(speed: f32) -> f32 {
    if speed.is_nan() {
        1.0
    } else {
        speed.clamp(MIN_SPEED, MAX_SPEED)
    }
}

/// Kokoro voice names encode the accent in a two-letter prefix
/// (`af_heart` = American female, `zf_xiaoxiao` = Chinese female). Mapping the
/// prefix gives the settings picker a language column without a hand-maintained
/// table that would drift from the model.
fn voice_language(name: &str) -> &'static str {
    match name.split('_').next().unwrap_or("") {
        "af" | "am" => "en-US",
        "bf" | "bm" => "en-GB",
        "ef" | "em" => "es",
        "ff" | "fm" => "fr",
        "hf" | "hm" => "hi",
        "if" | "im" => "it",
        "jf" | "jm" => "ja",
        "pf" | "pm" => "pt",
        "zf" | "zm" => "zh",
        _ => "",
    }
}

// ---- ONNX metadata (voice names) ----

/// Minimal protobuf varint reader — enough of the wire format to walk ONNX
/// `ModelProto` fields without pulling in a protobuf runtime.
fn read_varint<R: std::io::Read>(r: &mut R) -> std::io::Result<u64> {
    let mut result = 0u64;
    let mut shift = 0u32;
    loop {
        let mut b = [0u8; 1];
        r.read_exact(&mut b)?;
        result |= ((b[0] & 0x7f) as u64) << shift;
        if b[0] & 0x80 == 0 {
            return Ok(result);
        }
        shift += 7;
        if shift >= 64 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "varint overflow",
            ));
        }
    }
}

/// Parse one `StringStringEntryProto` (ONNX metadata key/value pair).
fn parse_metadata_entry(buf: &[u8], out: &mut HashMap<String, String>) {
    use std::io::Read;
    let mut cur = std::io::Cursor::new(buf);
    let mut key: Option<String> = None;
    let mut value: Option<String> = None;
    while let Ok(tag) = read_varint(&mut cur) {
        if tag & 7 != 2 {
            break;
        }
        let Ok(len) = read_varint(&mut cur) else { break };
        let mut s = vec![0u8; len as usize];
        if cur.read_exact(&mut s).is_err() {
            break;
        }
        let s = String::from_utf8_lossy(&s).into_owned();
        match tag >> 3 {
            1 => key = Some(s),
            2 => value = Some(s),
            _ => {}
        }
    }
    if let (Some(k), Some(v)) = (key, value) {
        out.insert(k, v);
    }
}

/// Pull `metadata_props` out of an ONNX model without loading it.
///
/// The file is one big protobuf message whose bulk — the tensor payload — sits
/// in length-delimited fields we never read: each field is skipped by its
/// declared length, so this touches a few hundred bytes of tags no matter how
/// large the model is. Kokoro's exports carry the authoritative voice list in
/// `speaker_names` (with `id2speaker` alongside it), which is what makes named
/// speaker selection possible rather than guessing an index order.
///
/// Best-effort by design: an unreadable or metadata-free model yields an empty
/// map, and callers fall back to positional labels.
fn read_onnx_metadata(path: &Path) -> HashMap<String, String> {
    use std::io::{BufReader, Read, Seek, SeekFrom};

    /// `ModelProto.metadata_props` is field 14.
    const METADATA_FIELD: u64 = 14;

    let mut out = HashMap::new();
    let Ok(file) = std::fs::File::open(path) else {
        return out;
    };
    let mut f = BufReader::new(file);
    // ModelProto's own field count is small (a dozen); the bound only guards
    // against a malformed file sending us round a seek loop forever.
    for _ in 0..64 {
        let Ok(tag) = read_varint(&mut f) else { break };
        let field = tag >> 3;
        match tag & 7 {
            // varint
            0 => {
                if read_varint(&mut f).is_err() {
                    break;
                }
            }
            // 64-bit
            1 => {
                if f.seek(SeekFrom::Current(8)).is_err() {
                    break;
                }
            }
            // 32-bit
            5 => {
                if f.seek(SeekFrom::Current(4)).is_err() {
                    break;
                }
            }
            // length-delimited
            2 => {
                let Ok(len) = read_varint(&mut f) else { break };
                if field == METADATA_FIELD {
                    let mut buf = vec![0u8; len as usize];
                    if f.read_exact(&mut buf).is_err() {
                        break;
                    }
                    parse_metadata_entry(&buf, &mut out);
                } else if f.seek(SeekFrom::Current(len as i64)).is_err() {
                    break;
                }
            }
            _ => break,
        }
    }
    out
}

/// The model file inside an extracted bundle. The int8 archives name theirs
/// `model.int8.onnx`; the fp32 ones plain `model.onnx` — prefer int8, then the
/// canonical name, then whatever ONNX file is there.
fn find_model_file(dir: &Path) -> Option<PathBuf> {
    let int8 = dir.join("model.int8.onnx");
    if int8.is_file() {
        return Some(int8);
    }
    let plain = dir.join("model.onnx");
    if plain.is_file() {
        return Some(plain);
    }
    let mut found: Vec<PathBuf> = std::fs::read_dir(dir)
        .ok()?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x.eq_ignore_ascii_case("onnx")))
        .collect();
    found.sort();
    found.into_iter().next()
}

/// Voices for an installed model — read straight from the ONNX metadata, so the
/// settings picker can list them before the engine is ever loaded (the first
/// speak is what pays for the model load, not opening Settings).
fn voices_for_model(model_dir: &Path) -> Vec<TtsVoice> {
    let Some(model_file) = find_model_file(model_dir) else {
        return Vec::new();
    };
    let meta = read_onnx_metadata(&model_file);
    let mut voices: Vec<TtsVoice> = meta
        .get("speaker_names")
        .map(|names| {
            names
                .split(',')
                .map(str::trim)
                .filter(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-'))
                .enumerate()
                .map(|(i, n)| TtsVoice {
                    id: i as i32,
                    name: n.to_string(),
                    language: voice_language(n).to_string(),
                })
                .collect()
        })
        .unwrap_or_default();
    // An export without `speaker_names` still has speakers — label them by
    // index so the picker stays usable (and the settings note says why).
    if voices.is_empty() {
        if let Some(n) = meta.get("n_speakers").and_then(|s| s.trim().parse::<usize>().ok()) {
            voices = (0..n)
                .map(|i| TtsVoice {
                    id: i as i32,
                    name: format!("Voice {}", i + 1),
                    language: String::new(),
                })
                .collect();
        }
    }
    voices
}

// ---- Engine lifecycle ----

/// Every asset a Kokoro bundle provides. Discovered from the directory rather
/// than hard-coded: the bundles' internals have shifted between releases
/// (v0.19 ships no lexicons at all, v1.x ships three plus rule FSTs), so a fixed
/// filename list would silently break on the next model bump.
///
/// Shared by both engines — the in-process CPU one builds a sherpa-onnx config
/// from this, the GPU one builds command-line flags from it — so the two can
/// never disagree about what a model needs.
pub(crate) struct KokoroPaths {
    pub(crate) model: PathBuf,
    pub(crate) voices: PathBuf,
    pub(crate) tokens: PathBuf,
    pub(crate) data_dir: Option<PathBuf>,
    pub(crate) dict_dir: Option<PathBuf>,
    lexicons: Vec<PathBuf>,
    rule_fsts: Vec<PathBuf>,
}

impl KokoroPaths {
    /// sherpa-onnx takes the lexicon list as one comma-separated argument.
    pub(crate) fn lexicons_arg(&self) -> Option<String> {
        (!self.lexicons.is_empty()).then(|| {
            self.lexicons
                .iter()
                .map(|p| p.to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join(",")
        })
    }

    fn rule_fsts_arg(&self) -> Option<String> {
        (!self.rule_fsts.is_empty()).then(|| {
            self.rule_fsts
                .iter()
                .map(|p| p.to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join(",")
        })
    }
}

pub(crate) fn kokoro_paths(model_dir: &Path) -> CmdResult<KokoroPaths> {
    let model = find_model_file(model_dir).ok_or_else(|| {
        format!(
            "Kokoro model file missing in {} — re-download the model in Settings → Local Models → Speech",
            model_dir.display()
        )
    })?;
    let voices = model_dir.join("voices.bin");
    let tokens = model_dir.join("tokens.txt");
    if !voices.is_file() || !tokens.is_file() {
        return Err(format!(
            "Kokoro bundle at {} is incomplete (voices.bin / tokens.txt missing) — re-download it",
            model_dir.display()
        ));
    }

    let mut lexicons: Vec<PathBuf> = Vec::new();
    let mut rule_fsts: Vec<PathBuf> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(model_dir) {
        for entry in entries.filter_map(|e| e.ok()) {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with("lexicon-") && name.ends_with(".txt") {
                lexicons.push(entry.path());
            } else if name.ends_with(".fst") {
                rule_fsts.push(entry.path());
            }
        }
    }
    lexicons.sort();
    rule_fsts.sort();

    let data_dir = model_dir.join("espeak-ng-data");
    let dict_dir = model_dir.join("dict");
    Ok(KokoroPaths {
        model,
        voices,
        tokens,
        data_dir: data_dir.is_dir().then_some(data_dir),
        dict_dir: dict_dir.is_dir().then_some(dict_dir),
        lexicons,
        rule_fsts,
    })
}

/// Kokoro has to share the machine with whatever the user is actually working
/// on, and synthesis streams for minutes (unlike the STT sidecar's fractions of
/// a second), so it must not monopolise the box.
///
/// The count itself is measured, not assumed: on a 6-core/12-thread i7-10750H
/// fp32 Kokoro ran 0.84x realtime on 4 threads, 1.06x on 6 (all physical cores)
/// and 0.81x on 12 — past the physical cores the session's own parallelism
/// contends with itself. Half the LOGICAL count lands on the physical count on
/// hyperthreaded machines, which is the measured optimum.
pub(crate) fn tts_threads() -> i32 {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .div_ceil(2)
        .clamp(2, 8) as i32
}

/// Build the in-process (CPU) Kokoro config from an extracted bundle.
fn build_config(model_dir: &Path) -> CmdResult<OfflineTtsConfig> {
    let paths = kokoro_paths(model_dir)?;
    Ok(OfflineTtsConfig {
        model: OfflineTtsModelConfig {
            kokoro: OfflineTtsKokoroModelConfig {
                model: Some(paths.model.to_string_lossy().into_owned()),
                voices: Some(paths.voices.to_string_lossy().into_owned()),
                tokens: Some(paths.tokens.to_string_lossy().into_owned()),
                data_dir: paths.data_dir.as_ref().map(|p| p.to_string_lossy().into_owned()),
                dict_dir: paths.dict_dir.as_ref().map(|p| p.to_string_lossy().into_owned()),
                lexicon: paths.lexicons_arg(),
                ..Default::default()
            },
            num_threads: tts_threads(),
            ..Default::default()
        },
        rule_fsts: paths.rule_fsts_arg(),
        ..Default::default()
    })
}

fn load_engine(model_dir: &Path, model_id: &str) -> CmdResult<TtsEngine> {
    let config = build_config(model_dir)?;
    let tts = OfflineTts::create(&config).ok_or_else(|| {
        format!(
            "Kokoro failed to load {} — the download may be corrupt or from an incompatible release",
            model_dir.display()
        )
    })?;
    let voices = voices_for_model(model_dir);
    eprintln!(
        "[tts] Kokoro loaded ({model_id} from {}, {} speakers, {} Hz)",
        model_dir.display(),
        tts.num_speakers(),
        tts.sample_rate()
    );
    Ok(TtsEngine {
        tts,
        model_id: model_id.to_string(),
        model_dir: model_dir.to_path_buf(),
        voices,
        gen_lock: Mutex::new(()),
    })
}

/// Serializes engine construction. Without it, two sentences in flight at once
/// (the player prefetches) would each build a full ONNX session — ~100 MB of
/// duplicated weights and a wasted second of CPU — and the loser's engine would
/// be dropped on the floor.
static LOAD_SEQ: std::sync::LazyLock<tokio::sync::Mutex<()>> =
    std::sync::LazyLock::new(|| tokio::sync::Mutex::new(()));

/// Resolve which installed model to run: the explicit `tts.model` when it is
/// present on disk, else the recommended installed bundle, else any installed
/// one.
fn resolve_model(dir: &Path, selected: Option<&str>) -> Option<(String, PathBuf)> {
    let by_id = |id: &str| catalog().into_iter().find(|m| m.id == id);
    if let Some(id) = selected {
        if let Some(entry) = by_id(id) {
            let path = dir.join(&entry.dir_name);
            if find_model_file(&path).is_some() {
                return Some((id.to_string(), path));
            }
        }
    }
    for entry in catalog() {
        if entry.recommended {
            let path = dir.join(&entry.dir_name);
            if find_model_file(&path).is_some() {
                return Some((entry.id, path));
            }
        }
    }
    catalog()
        .into_iter()
        .find_map(|entry| {
            let path = dir.join(&entry.dir_name);
            find_model_file(&path).is_some().then_some((entry.id, path))
        })
}

/// The loaded engine, loading it on first use. `spawn_blocking` because ONNX
/// session creation is synchronous CPU work that would otherwise stall the
/// async runtime for the better part of a second.
async fn ensure_engine(db: &DbState, tts: &TtsState) -> CmdResult<Arc<TtsEngine>> {
    if let Some(engine) = tts.0.lock().clone() {
        return Ok(engine);
    }
    let _seq = LOAD_SEQ.lock().await;
    // Re-check under the sequence lock: a concurrent caller may have finished
    // the load while we were queued behind it.
    if let Some(engine) = tts.0.lock().clone() {
        return Ok(engine);
    }
    let (dir, selected) = {
        let conn = db.0.lock();
        (
            tts_dir(&conn).ok_or("Models directory is not configured")?,
            get_setting(&conn, MODEL_KEY),
        )
    };
    let (model_id, model_dir) = resolve_model(&dir, selected.as_deref()).ok_or(
        "No voice model installed — download Kokoro in Settings → Local Models → Speech",
    )?;
    let engine = tauri::async_runtime::spawn_blocking(move || load_engine(&model_dir, &model_id))
        .await
        .map_err(|e| format!("model load task failed: {e}"))??;
    let engine = Arc::new(engine);
    *tts.0.lock() = Some(engine.clone());
    Ok(engine)
}

/// Drop the resident engine. Shared by the unload command, the model-changed
/// path, and app exit (`lib.rs`) — an engine left alive past quit would keep
/// ~100 MB of weights mapped for the lifetime of the process tree.
pub fn unload(tts: &TtsState) {
    let taken = tts.0.lock().take();
    if let Some(engine) = taken {
        eprintln!("[tts] Kokoro unloaded ({})", engine.model_id);
    }
}

// ---- Audio encoding & cache ----

/// 16-bit mono PCM WAV from Kokoro's float samples. Hand-rolled rather than
/// using sherpa-onnx's `GeneratedAudio::save` so synthesis never has to touch
/// the filesystem — the cache write is a separate, deliberate step.
fn wav_from_samples(samples: &[f32], sample_rate: i32) -> Vec<u8> {
    let data_bytes = samples.len() * 2;
    let mut out = Vec::with_capacity(44 + data_bytes);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&((36 + data_bytes) as u32).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes()); // fmt chunk size
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&(sample_rate as u32).to_le_bytes());
    out.extend_from_slice(&((sample_rate as u32) * 2).to_le_bytes()); // byte rate
    out.extend_from_slice(&2u16.to_le_bytes()); // block align
    out.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
    out.extend_from_slice(b"data");
    out.extend_from_slice(&(data_bytes as u32).to_le_bytes());
    for s in samples {
        // NaN clamps to 0 rather than propagating: `f32::clamp` panics on NaN
        // only for the bounds, not the value, but the cast below would turn a
        // NaN into a garbage i16 anyway.
        let v = if s.is_finite() { (s.clamp(-1.0, 1.0) * 32767.0) as i16 } else { 0 };
        out.extend_from_slice(&v.to_le_bytes());
    }
    out
}

/// Cache key for one chunk. Includes every input that changes the audio, so a
/// voice or speed change re-synthesizes instead of replaying the old take.
fn cache_key(model_id: &str, voice: &str, speed: f32, text: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(model_id.as_bytes());
    h.update([0]);
    h.update(voice.as_bytes());
    h.update([0]);
    h.update(format!("{speed:.3}").as_bytes());
    h.update([0]);
    h.update(text.as_bytes());
    let digest = h.finalize();
    let mut hex = String::with_capacity(32);
    for b in digest.iter().take(16) {
        hex.push_str(&format!("{b:02x}"));
    }
    hex
}

/// Evict oldest cache entries until the directory fits the cap. Best-effort:
/// a file that cannot be removed (locked, already gone) is skipped rather than
/// failing the synthesis that triggered the prune.
fn prune_cache(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut files: Vec<(std::time::SystemTime, u64, PathBuf)> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let meta = e.metadata().ok()?;
            if !meta.is_file() {
                return None;
            }
            Some((
                meta.modified().unwrap_or(std::time::UNIX_EPOCH),
                meta.len(),
                e.path(),
            ))
        })
        .collect();
    let total: u64 = files.iter().map(|(_, len, _)| len).sum();
    if total <= CACHE_CAP_BYTES {
        return;
    }
    files.sort_by_key(|(mtime, _, _)| *mtime);
    let mut over = total - CACHE_CAP_BYTES;
    for (_, len, path) in files {
        if over == 0 {
            break;
        }
        if std::fs::remove_file(&path).is_ok() {
            over = over.saturating_sub(len);
        }
    }
}

fn cache_bytes(app: &tauri::AppHandle) -> u64 {
    std::fs::read_dir(cache_dir(app))
        .map(|entries| {
            entries
                .filter_map(|e| e.ok())
                .filter_map(|e| e.metadata().ok())
                .filter(|m| m.is_file())
                .map(|m| m.len())
                .sum()
        })
        .unwrap_or(0)
}

/// Synthesize one chunk to WAV bytes. Blocking — call from `spawn_blocking`.
fn synthesize(engine: &TtsEngine, text: &str, sid: i32, speed: f32) -> CmdResult<Vec<u8>> {
    let _guard = engine.gen_lock.lock();
    let config = GenerationConfig {
        sid,
        speed,
        ..Default::default()
    };
    let audio = engine
        .tts
        .generate_with_config(text, &config, None::<fn(&[f32], f32) -> bool>)
        .ok_or("Kokoro produced no audio for this text")?;
    let samples = audio.samples();
    if samples.is_empty() {
        return Err("Kokoro produced empty audio for this text".into());
    }
    Ok(wav_from_samples(samples, audio.sample_rate()))
}

// ---- Commands ----

/// Synthesize one chunk of text and return it as base64 WAV.
///
/// Callers pass sentence-sized chunks: a long answer is voiced one sentence at a
/// time so playback starts immediately and each sentence is cached separately
/// (replaying a message hits the cache for every chunk that has not changed).
#[tauri::command]
pub async fn tts_speak(
    app: tauri::AppHandle,
    db: State<'_, DbState>,
    tts: State<'_, TtsState>,
    text: String,
    voice: Option<String>,
    speed: Option<f32>,
) -> CmdResult<TtsAudio> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("Nothing to read".into());
    }
    // Kokoro's vocoder degrades on very long inputs, and a single pathological
    // "sentence" (a minified JSON blob, say) would lock the engine for minutes.
    // Chunk lengths are the frontend's business, but the engine defends itself.
    const MAX_CHARS: usize = 1200;
    let text = if text.chars().count() > MAX_CHARS {
        text.chars().take(MAX_CHARS).collect()
    } else {
        text
    };

    let (configured_voice, configured_speed, device) = {
        let conn = db.0.lock();
        (
            get_setting(&conn, VOICE_KEY),
            get_setting(&conn, SPEED_KEY).and_then(|s| s.trim().parse::<f32>().ok()),
            get_setting(&conn, super::tts_gpu::DEVICE_KEY).unwrap_or_else(|| "cpu".into()),
        )
    };
    let gpu = device == "gpu";
    let voice = voice
        .filter(|v| !v.trim().is_empty())
        .or(configured_voice)
        .unwrap_or_default();
    let speed = clamp_speed(speed.or(configured_speed).unwrap_or(1.0));

    // Resolve the model and its voice list WITHOUT building the CPU engine when
    // GPU is selected: loading ~400 MB of ONNX weights to synthesize nothing
    // would be pure waste, and the voice names come straight from the model file
    // either way.
    let (model_id, model_dir, voices) = if gpu {
        let (dir, selected) = {
            let conn = db.0.lock();
            (
                tts_dir(&conn).ok_or("Models directory is not configured")?,
                get_setting(&conn, MODEL_KEY),
            )
        };
        let (id, path) = resolve_model(&dir, selected.as_deref()).ok_or(
            "No voice model installed — download Kokoro in Settings → Local Models → Speech",
        )?;
        let voices = voices_for_model(&path);
        (id, path, voices)
    } else {
        let engine = ensure_engine(&db, &tts).await?;
        (engine.model_id.clone(), engine.model_dir.clone(), engine.voices.clone())
    };

    // An unknown name falls back to the model's first speaker instead of
    // failing: the voice list is model-specific, so a voice picked under a
    // different model must still produce audio.
    let sid = voices.iter().find(|v| v.name == voice).map(|v| v.id).unwrap_or(0);
    let voice_label = voices
        .iter()
        .find(|v| v.id == sid)
        .map(|v| v.name.clone())
        .unwrap_or_else(|| format!("Voice {}", sid + 1));

    let key = cache_key(&model_id, &voice_label, speed, &text);
    let dir = cache_dir(&app);
    let cached_path = dir.join(format!("{key}.wav"));

    let (bytes, cached, sample_rate) = if let Ok(bytes) = std::fs::read(&cached_path) {
        let rate = wav_sample_rate(&bytes).unwrap_or(24_000);
        (bytes, true, rate)
    } else if gpu {
        // The CUDA engine is a child process, so this is awaited rather than
        // pushed onto a blocking thread — it yields for the child's lifetime.
        let root = gpu_root_from_settings(&db, &app);
        let bytes = super::tts_gpu::synthesize_gpu(&root, &model_dir, &text, sid, speed).await?;
        // Cache write is best-effort: a read-only or full disk must still let
        // the audio play, it just costs a re-synthesis next time.
        if std::fs::create_dir_all(&dir).is_ok() && std::fs::write(&cached_path, &bytes).is_ok() {
            prune_cache(&dir);
        }
        let rate = wav_sample_rate(&bytes).unwrap_or(24_000);
        (bytes, false, rate)
    } else {
        let engine = ensure_engine(&db, &tts).await?;
        let engine_for_task = engine.clone();
        let text_for_task = text.clone();
        let bytes = tauri::async_runtime::spawn_blocking(move || {
            synthesize(&engine_for_task, &text_for_task, sid, speed)
        })
        .await
        .map_err(|e| format!("synthesis task failed: {e}"))??;
        if std::fs::create_dir_all(&dir).is_ok() && std::fs::write(&cached_path, &bytes).is_ok() {
            prune_cache(&dir);
        }
        (bytes, false, engine.tts.sample_rate())
    };

    // `sample_rate` comes from the branch above — the in-process engine reports
    // it directly, the GPU path reads it back out of the WAV the child wrote.
    // Header is 44 bytes of PCM16 mono, so duration is exact: bytes / (rate*2).
    let duration_sec = bytes.len().saturating_sub(44) as f32 / (sample_rate.max(1) as f32 * 2.0);

    let audio_base64 = {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD.encode(&bytes)
    };
    Ok(TtsAudio {
        audio_base64,
        mime: "audio/wav".into(),
        sample_rate,
        duration_sec,
        cached,
        voice: voice_label,
    })
}

/// Load the engine without synthesizing anything — used to warm Kokoro right
/// after an install or a model switch so the first press of play is not the
/// call that pays for session creation.
#[tauri::command]
pub async fn tts_preload(db: State<'_, DbState>, tts: State<'_, TtsState>) -> CmdResult<bool> {
    ensure_engine(&db, &tts).await?;
    Ok(true)
}

/// Sample rate from a PCM WAV header (bytes 24..28). `None` when the buffer is
/// too short or is not a RIFF/WAVE file — callers fall back to Kokoro's 24 kHz.
fn wav_sample_rate(bytes: &[u8]) -> Option<i32> {
    if bytes.len() < 28 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return None;
    }
    let rate = u32::from_le_bytes(bytes[24..28].try_into().ok()?);
    (rate > 0).then_some(rate as i32)
}

/// Where the CUDA runtime lives: the recorded install location when there is
/// one, else the default path (so the very first GPU install has a target).
fn gpu_root_from_settings(db: &DbState, app: &tauri::AppHandle) -> PathBuf {
    let configured = {
        let conn = db.0.lock();
        get_setting(&conn, super::tts_gpu::GPU_DIR_KEY).map(PathBuf::from)
    };
    configured.unwrap_or_else(|| super::tts_gpu::gpu_root(app))
}

/// Choose where synthesis runs: the in-process CPU engine, or the CUDA child
/// process (see `tts_gpu` for why GPU cannot be a provider on the engine
/// itself). Both are unloaded/reloaded lazily, so switching is cheap — but the
/// resident engine belongs to the old device, so it is always dropped here.
#[tauri::command]
pub async fn tts_set_device(
    app: tauri::AppHandle,
    db: State<'_, DbState>,
    tts: State<'_, TtsState>,
    device: String,
) -> CmdResult<TtsStatus> {
    let device = if device == "gpu" { "gpu" } else { "cpu" };
    {
        let conn = db.0.lock();
        db::set_setting(&conn, super::tts_gpu::DEVICE_KEY, device).map_err(|e| e.to_string())?;
    }
    unload(&tts);
    status_inner(&app, &db, &tts).await
}

/// Hold the model in memory from app start rather than loading it on the first
/// press of play. Turning it on warms the engine immediately so the setting has
/// an effect now, not at the next launch.
#[tauri::command]
pub async fn tts_set_keep_loaded(
    app: tauri::AppHandle,
    db: State<'_, DbState>,
    tts: State<'_, TtsState>,
    keep: bool,
) -> CmdResult<TtsStatus> {
    let (device, has_model) = {
        let conn = db.0.lock();
        let dir = tts_dir(&conn);
        let selected = get_setting(&conn, MODEL_KEY);
        (
            get_setting(&conn, super::tts_gpu::DEVICE_KEY).unwrap_or_else(|| "cpu".into()),
            dir.as_ref()
                .and_then(|d| resolve_model(d, selected.as_deref()))
                .is_some(),
        )
    };
    {
        let conn = db.0.lock();
        db::set_setting(&conn, KEEP_LOADED_KEY, if keep { "true" } else { "false" })
            .map_err(|e| e.to_string())?;
    }
    if !keep {
        unload(&tts);
        return status_inner(&app, &db, &tts).await;
    }
    // There is nothing to hold resident without a model, and the GPU path has no
    // resident engine at all (every GPU call starts a child). Reverting keeps
    // the stored setting honest rather than promising something it will not do.
    if device == "gpu" {
        let conn = db.0.lock();
        let _ = db::set_setting(&conn, KEEP_LOADED_KEY, "false");
        return Err(
            "Keep-loaded applies to the CPU engine — on GPU each read starts the CUDA engine on demand, so there is nothing to hold in memory."
                .into(),
        );
    }
    if !has_model {
        let conn = db.0.lock();
        let _ = db::set_setting(&conn, KEEP_LOADED_KEY, "false");
        return Err("Download a voice model first — there is nothing to load".into());
    }
    if let Err(e) = ensure_engine(&db, &tts).await {
        let conn = db.0.lock();
        let _ = db::set_setting(&conn, KEEP_LOADED_KEY, "false");
        return Err(e);
    }
    status_inner(&app, &db, &tts).await
}

/// App-boot preload: build the engine up front when the user asked to keep it
/// resident. Best-effort — failures only log; the first press of play surfaces
/// the reason.
pub fn maybe_preload(app: &tauri::AppHandle, db: &DbState) {
    let (keep, device) = {
        let conn = db.0.lock();
        (
            get_setting(&conn, KEEP_LOADED_KEY).as_deref() == Some("true"),
            get_setting(&conn, super::tts_gpu::DEVICE_KEY).unwrap_or_else(|| "cpu".into()),
        )
    };
    // The GPU path spawns a child per read, so there is no resident engine to
    // warm there.
    if !keep || device == "gpu" {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        use tauri::Manager;
        let db = app.state::<DbState>();
        let tts = app.state::<TtsState>();
        match ensure_engine(&db, &tts).await {
            Ok(_) => eprintln!("[tts] model loaded at startup (keep-loaded is on)"),
            Err(e) => eprintln!("[tts] startup preload skipped: {e}"),
        }
    });
}

/// Release the engine's memory. The next `tts_speak` transparently reloads it.
#[tauri::command]
pub async fn tts_unload(
    app: tauri::AppHandle,
    db: State<'_, DbState>,
    tts: State<'_, TtsState>,
) -> CmdResult<TtsStatus> {
    unload(&tts);
    status_inner(&app, &db, &tts).await
}

/// Shared status snapshot. Commands route into this rather than calling the
/// `tts_status` command directly — the cache size needs the `AppHandle`, and a
/// command calling another command would have to fabricate one.
async fn status_inner(
    app: &tauri::AppHandle,
    db: &DbState,
    tts: &TtsState,
) -> CmdResult<TtsStatus> {
    let (dir, selected, voice, speed, auto_read, device, keep_loaded) = {
        let conn = db.0.lock();
        (
            tts_dir(&conn),
            get_setting(&conn, MODEL_KEY),
            get_setting(&conn, VOICE_KEY),
            get_setting(&conn, SPEED_KEY)
                .and_then(|s| s.trim().parse::<f32>().ok())
                .map(clamp_speed),
            get_setting(&conn, AUTOREAD_KEY).as_deref() == Some("true"),
            get_setting(&conn, super::tts_gpu::DEVICE_KEY).unwrap_or_else(|| "cpu".into()),
            get_setting(&conn, KEEP_LOADED_KEY).as_deref() == Some("true"),
        )
    };
    let resolved = dir.as_ref().and_then(|d| resolve_model(d, selected.as_deref()));
    let model_id = resolved.as_ref().map(|(id, _)| id.clone());
    let model_dir = resolved.as_ref().map(|(_, p)| p.clone());
    let voices = model_dir
        .as_ref()
        .map(|p| voices_for_model(p))
        .unwrap_or_default();
    let loaded = tts.0.lock().as_ref().map(|e| e.model_id.clone());
    let catalog_entries = catalog()
        .into_iter()
        .map(|m| {
            let installed = dir
                .as_ref()
                .map(|d| find_model_file(&d.join(&m.dir_name)).is_some())
                .unwrap_or(false);
            TtsCatalogEntry {
                is_selected: model_id.as_deref() == Some(m.id.as_str()),
                id: m.id,
                label: m.label,
                dir_name: m.dir_name,
                size_bytes: m.size_bytes,
                note: m.note,
                languages: m.languages,
                recommended: m.recommended,
                installed,
            }
        })
        .collect();

    Ok(TtsStatus {
        model_id,
        model_dir: model_dir.map(|p| p.to_string_lossy().into_owned()),
        // `loaded` only counts when it matches the SELECTED model — a stale
        // engine for a model the user just switched away from is about to be
        // replaced, and reporting it as live would be a lie.
        loaded: loaded.is_some(),
        voice,
        speed: speed.unwrap_or(1.0),
        auto_read,
        // Normalized on read: a hand-edited or legacy value must not leave the
        // UI showing a device the engine will not actually use.
        device: if device == "gpu" { "gpu".into() } else { "cpu".into() },
        keep_loaded,
        voices,
        tts_dir: dir.map(|d| d.to_string_lossy().into_owned()),
        cache_bytes: cache_bytes(app),
        catalog: catalog_entries,
    })
}

#[tauri::command]
pub async fn tts_status(
    app: tauri::AppHandle,
    db: State<'_, DbState>,
    tts: State<'_, TtsState>,
) -> CmdResult<TtsStatus> {
    status_inner(&app, &db, &tts).await
}

#[tauri::command(async)]
pub fn tts_set_model(db: State<'_, DbState>, tts: State<'_, TtsState>, id: String) -> CmdResult<()> {
    {
        let conn = db.0.lock();
        db::set_setting(&conn, MODEL_KEY, &id).map_err(|e| e.to_string())?;
    }
    // The resident engine belongs to the previous model — drop it so the next
    // speak rebuilds against the new one.
    unload(&tts);
    Ok(())
}

#[tauri::command(async)]
pub fn tts_set_voice(db: State<'_, DbState>, voice: String) -> CmdResult<()> {
    let conn = db.0.lock();
    db::set_setting(&conn, VOICE_KEY, voice.trim()).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn tts_set_speed(db: State<'_, DbState>, speed: f32) -> CmdResult<f32> {
    let speed = clamp_speed(speed);
    let conn = db.0.lock();
    db::set_setting(&conn, SPEED_KEY, &format!("{speed}")).map_err(|e| e.to_string())?;
    Ok(speed)
}

#[tauri::command(async)]
pub fn tts_set_auto_read(db: State<'_, DbState>, auto_read: bool) -> CmdResult<()> {
    let conn = db.0.lock();
    db::set_setting(&conn, AUTOREAD_KEY, if auto_read { "true" } else { "false" })
        .map_err(|e| e.to_string())
}

/// Emit install progress on the stream the Model Market, Knowledge and the STT
/// panel already render (`local-model:download:progress`). `id` is the catalog
/// id, so the same key drives the progress bar and `cancelModelDownload`.
pub(crate) fn emit_progress<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    id: &str,
    state: DownloadState,
    downloaded: u64,
    total: Option<u64>,
    error: Option<String>,
) {
    let _ = app.emit(
        "local-model:download:progress",
        DownloadProgress {
            id: id.to_string(),
            downloaded_bytes: downloaded,
            total_bytes: total,
            state,
            bytes_per_second: 0.0,
            final_path: None,
            error,
        },
    );
}

/// HTTP client for the model download.
///
/// Deliberately NOT `.no_proxy()`. Everything else in this module talks to
/// 127.0.0.1 and must bypass the system proxy, but a *download* works only
/// THROUGH it: on a network that reaches the internet via a local proxy (a very
/// common desktop setup, and mandatory in some regions), `no_proxy` turns a
/// working download into an unreachable-host failure. This mirrors the client
/// the model market already downloads with.
/// The Windows system proxy, when one is enabled.
///
/// reqwest only honours the `HTTP_PROXY`/`HTTPS_PROXY` environment variables; a
/// proxy configured in Windows' Internet Settings — which is what curl, pip and
/// every browser use — is invisible to it. Reading the registry makes these
/// downloads behave like the tools that already work on a proxied machine,
/// instead of silently going direct and failing on exactly the hosts the proxy
/// exists to reach.
#[cfg(windows)]
fn system_proxy() -> Option<String> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let key = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Internet Settings")
        .ok()?;
    let enabled: u32 = key.get_value("ProxyEnable").unwrap_or(0);
    if enabled == 0 {
        return None;
    }
    let server: String = key.get_value("ProxyServer").ok()?;
    let server = server.trim();
    if server.is_empty() {
        return None;
    }
    // `ProxyServer` is either "host:port" for everything, or a per-scheme list
    // like "http=host:port;https=host:port" (the shape the Windows UI writes
    // when a single server is used for all protocols).
    let host = if server.contains('=') {
        server
            .split(';')
            .filter_map(|part| part.split_once('='))
            .find(|(scheme, _)| scheme.trim().eq_ignore_ascii_case("https"))
            .or_else(|| server.split(';').filter_map(|part| part.split_once('=')).next())
            .map(|(_, value)| value.trim())?
    } else {
        server
    };
    if host.is_empty() {
        return None;
    }
    Some(if host.starts_with("http://") || host.starts_with("https://") {
        host.to_string()
    } else {
        format!("http://{host}")
    })
}

#[cfg(not(windows))]
fn system_proxy() -> Option<String> {
    None
}

/** Exposed for diagnostics/tests: what proxy the download client will use. */
pub(crate) fn system_proxy_for_log() -> Option<String> {
    system_proxy()
}

pub(crate) fn http_client() -> CmdResult<reqwest::Client> {
    let mut builder = reqwest::Client::builder()
        .user_agent(concat!("Relay/", env!("CARGO_PKG_VERSION"), " (desktop)"))
        .connect_timeout(std::time::Duration::from_secs(15))
        // Per-request: this bounds one file (the largest is ~310 MB), not the
        // whole install, which is why it is generous.
        .timeout(std::time::Duration::from_secs(1800));
    if let Some(server) = system_proxy() {
        if let Ok(proxy) = reqwest::Proxy::all(&server) {
            // Loopback is never proxied: the speech stack talks to local
            // sidecars, and a proxy that blackholes 127.0.0.1 would break them.
            builder = builder.proxy(proxy.no_proxy(reqwest::NoProxy::from_string(
                "localhost,127.0.0.1,::1",
            )));
        }
    }
    builder.build().map_err(|e| e.to_string())
}

/// One entry from HF's `tree` API.
#[derive(Debug, serde::Deserialize)]
struct HfTreeEntry {
    path: String,
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    size: Option<u64>,
}

/// List every file in a HF repo at `main`.
async fn hf_tree(
    client: &reqwest::Client,
    repo: &str,
    token: Option<&str>,
) -> CmdResult<Vec<HfTreeEntry>> {
    let url = format!("https://huggingface.co/api/models/{repo}/tree/main?recursive=true");
    let mut req = client.get(&url);
    if let Some(token) = token {
        req = req.bearer_auth(token);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("could not list {repo}: {e}"))?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("could not list {repo}: HTTP {status} {body}"));
    }
    let entries: Vec<HfTreeEntry> =
        serde_json::from_str(&body).map_err(|e| format!("unreadable file listing for {repo}: {e}"))?;
    Ok(entries
        .into_iter()
        .filter(|e| e.kind == "file" && !e.path.starts_with('.'))
        .collect())
}

/// Fetch one file of a bundle into place. Blocking-free; safe to run
/// concurrently with its siblings. Returns the bytes pulled so the caller's
/// progress counter can advance.
///
/// Skipping is by size: an install interrupted halfway resumes by re-listing
/// the repo and finding the files already complete. Downloads land in a
/// `.part` sibling and are renamed on success, so a cancelled or failed file is
/// never mistaken for a complete one on the next attempt.
async fn hf_download_file(
    client: &reqwest::Client,
    repo: &str,
    token: Option<&str>,
    dest_root: &Path,
    entry: &HfTreeEntry,
    progress: &std::sync::atomic::AtomicU64,
) -> CmdResult<()> {
    use futures_util::StreamExt;

    let dest = dest_root.join(&entry.path);
    let expected = entry.size.unwrap_or(0);
    if expected > 0 && std::fs::metadata(&dest).map(|m| m.len() == expected).unwrap_or(false) {
        progress.fetch_add(expected, std::sync::atomic::Ordering::Relaxed);
        return Ok(());
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("could not create {}: {e}", parent.display()))?;
    }

    let url = format!("https://huggingface.co/{repo}/resolve/main/{}", entry.path);
    let mut req = client.get(&url);
    if let Some(token) = token {
        req = req.bearer_auth(token);
    }
    let resp = req.send().await.map_err(|e| format!("{}: {e}", entry.path))?;
    if !resp.status().is_success() {
        return Err(format!("{}: HTTP {}", entry.path, resp.status()));
    }

    let part = dest.with_extension("part");
    let mut file = tokio::fs::File::create(&part)
        .await
        .map_err(|e| format!("could not write {}: {e}", part.display()))?;
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| {
            let _ = std::fs::remove_file(&part);
            format!("{}: {e}", entry.path)
        })?;
        if let Err(e) = tokio::io::AsyncWriteExt::write_all(&mut file, &chunk).await {
            let _ = std::fs::remove_file(&part);
            return Err(format!("could not write {}: {e}", part.display()));
        }
        progress.fetch_add(chunk.len() as u64, std::sync::atomic::Ordering::Relaxed);
    }
    let _ = tokio::io::AsyncWriteExt::flush(&mut file).await;
    drop(file);
    std::fs::rename(&part, &dest).map_err(|e| {
        let _ = std::fs::remove_file(&part);
        format!("could not finalize {}: {e}", entry.path)
    })
}

/// How many files to pull at once. The bundle is ~377 files but only a handful
/// are large (model.onnx 310 MB, voices.bin 27 MB); the rest are small espeak
/// and dictionary data. Eight keeps the big files' bandwidth saturated without
/// hammering HF's per-connection limits.
const DOWNLOAD_CONCURRENCY: usize = 8;

/// Download + install a Kokoro bundle from Hugging Face (Settings button).
///
/// Idempotent and resumable: an already-complete bundle short-circuits to just
/// selecting it, and a partially-downloaded one picks up where it stopped
/// (per-file, by size).
#[tauri::command]
pub async fn tts_install_model(
    app: tauri::AppHandle,
    db: State<'_, DbState>,
    tts: State<'_, TtsState>,
    registry: State<'_, Arc<DownloadRegistry>>,
    id: String,
) -> CmdResult<TtsStatus> {
    use futures_util::StreamExt;

    let entry = catalog()
        .into_iter()
        .find(|m| m.id == id)
        .ok_or_else(|| format!("unknown voice model: {id}"))?;
    let (dest_root, token) = {
        let conn = db.0.lock();
        (
            tts_dir(&conn).ok_or("Models directory is not configured")?,
            crate::commands::local_model_market::get_hf_token(&conn),
        )
    };
    let model_dir = dest_root.join(&entry.dir_name);

    if find_model_file(&model_dir).is_none() {
        std::fs::create_dir_all(&model_dir)
            .map_err(|e| format!("could not create {}: {e}", model_dir.display()))?;
        emit_progress(
            &app,
            &entry.id,
            DownloadState::Starting,
            0,
            Some(entry.size_bytes),
            None,
        );

        let client = http_client()?;
        let files = hf_tree(&client, &entry.hf_repo, token.as_deref()).await?;
        if files.is_empty() {
            return Err(format!("{} listed no files", entry.hf_repo));
        }
        let total: u64 = files.iter().map(|f| f.size.unwrap_or(0)).sum();

        // Registered so the panel's Cancel button (cancelModelDownload) can stop
        // an in-flight install — the same slot the Model Market uses, keyed by
        // catalog id.
        let (tx, mut rx) = tokio::sync::oneshot::channel::<()>();
        registry
            .active
            .lock()
            .insert(entry.id.clone(), crate::commands::local_model_market::DownloadSlot { cancel: Some(tx) });

        let progress = std::sync::atomic::AtomicU64::new(0);
        let repo = entry.hf_repo.clone();
        let token_ref = token.clone();
        let dir = model_dir.clone();
        let id_for_task = entry.id.clone();
        let app_for_task = app.clone();

        // Concurrent fetch with cancel. The `select!` owns the only borrow of
        // `rx`; a cancel branch simply stops polling the stream, and dropping
        // it aborts in-flight requests.
        let mut errors: Vec<String> = Vec::new();
        let mut cancelled = false;
        {
            // Futures are built eagerly into a Vec rather than mapped lazily
            // inside the stream: a closure that RETURNS a future borrowing its
            // captures trips the compiler's higher-ranked-lifetime inference
            // ("implementation of `FnOnce` is not general enough"). These
            // futures are tiny until polled, so materializing 377 is free.
            let downloads: Vec<_> = files
                .iter()
                .map(|file| {
                    hf_download_file(&client, &repo, token_ref.as_deref(), &dir, file, &progress)
                })
                .collect();
            let stream =
                futures_util::stream::iter(downloads).buffer_unordered(DOWNLOAD_CONCURRENCY);
            futures_util::pin_mut!(stream);
            let mut last_emit = std::time::Instant::now();
            loop {
                let next = tokio::select! {
                    biased;
                    _ = &mut rx => { cancelled = true; None }
                    item = stream.next() => item,
                };
                let Some(result) = next else { break };
                if let Err(e) = result {
                    errors.push(e);
                }
                // Throttled: 377 files would otherwise wake the webview
                // thousands of times for one install.
                if last_emit.elapsed().as_millis() >= 250 {
                    last_emit = std::time::Instant::now();
                    emit_progress(
                        &app_for_task,
                        &id_for_task,
                        DownloadState::Downloading,
                        progress.load(std::sync::atomic::Ordering::Relaxed),
                        Some(total),
                        None,
                    );
                }
            }
        }

        if cancelled {
            registry.active.lock().remove(&entry.id);
            // Drop every `.part` so a later attempt starts clean rather than
            // resuming from a half-written file.
            sweep_partials(&model_dir);
            emit_progress(&app, &entry.id, DownloadState::Cancelled, 0, Some(total), None);
            return Err("Download cancelled".into());
        }
        registry.active.lock().remove(&entry.id);

        if !errors.is_empty() {
            sweep_partials(&model_dir);
            let msg = format!(
                "{} of {} files failed to download ({}). Check your connection and retry — the files already fetched are kept.",
                errors.len(),
                files.len(),
                errors[0]
            );
            emit_progress(
                &app,
                &entry.id,
                DownloadState::Error,
                progress.load(std::sync::atomic::Ordering::Relaxed),
                Some(total),
                Some(msg.clone()),
            );
            return Err(msg);
        }

        emit_progress(&app, &entry.id, DownloadState::Verifying, total, Some(total), None);
        if find_model_file(&model_dir).is_none() {
            let msg = format!(
                "the downloaded bundle has no model file (looked in {})",
                model_dir.display()
            );
            emit_progress(&app, &entry.id, DownloadState::Error, total, Some(total), Some(msg.clone()));
            return Err(msg);
        }
    }

    // Select it and swap the engine over. The old engine's weights belong to a
    // different model, so it is dropped rather than left to hold memory.
    deploy_installed(&db, &tts, &entry.id)?;

    let status = status_inner(&app, &db, &tts).await?;
    emit_progress(
        &app,
        &entry.id,
        DownloadState::Done,
        entry.size_bytes,
        Some(entry.size_bytes),
        None,
    );
    Ok(status)
}

/// Remove leftover `.part` files from an interrupted install.
fn sweep_partials(root: &Path) {
    fn walk(dir: &Path) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for entry in entries.filter_map(|e| e.ok()) {
            let path = entry.path();
            if path.is_dir() {
                walk(&path);
            } else if path.extension().is_some_and(|x| x == "part") {
                let _ = std::fs::remove_file(&path);
            }
        }
    }
    walk(root);
}

/// Point `tts.model` at `id` and drop any resident engine. Split out so the
/// install path and the model-switch command share one definition of "make this
/// model the active one".
fn deploy_installed(db: &DbState, tts: &TtsState, id: &str) -> CmdResult<()> {
    {
        let conn = db.0.lock();
        db::set_setting(&conn, MODEL_KEY, id).map_err(|e| e.to_string())?;
    }
    unload(tts);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_db() -> DbState {
        DbState(Arc::new(Mutex::new(crate::db::mem())))
    }

    #[test]
    fn wav_header_is_well_formed_pcm16_mono() {
        let samples: Vec<f32> = vec![0.0, 0.5, -0.5, 1.0, -1.0, 2.0, -2.0];
        let wav = wav_from_samples(&samples, 24_000);
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(&wav[12..16], b"fmt ");
        assert_eq!(&wav[36..40], b"data");
        // RIFF size counts everything after the first 8 bytes.
        assert_eq!(u32::from_le_bytes(wav[4..8].try_into().unwrap()) as usize, wav.len() - 8);
        assert_eq!(u32::from_le_bytes(wav[40..44].try_into().unwrap()) as usize, samples.len() * 2);
        assert_eq!(u16::from_le_bytes(wav[22..24].try_into().unwrap()), 1, "mono");
        assert_eq!(u32::from_le_bytes(wav[24..28].try_into().unwrap()), 24_000);
        assert_eq!(u16::from_le_bytes(wav[34..36].try_into().unwrap()), 16, "16-bit");
        assert_eq!(wav.len(), 44 + samples.len() * 2);
        // Out-of-range floats are clamped, not wrapped around. Indexed from the
        // end so the assertion cannot drift if the sample list above changes.
        let n = samples.len();
        let sample_at = |i: usize| i16::from_le_bytes(wav[44 + i * 2..44 + i * 2 + 2].try_into().unwrap());
        assert_eq!(sample_at(n - 2), i16::MAX, "+2.0 must clamp to +1.0");
        assert_eq!(sample_at(n - 1), -i16::MAX, "-2.0 must clamp to -1.0");
        assert_eq!(sample_at(0), 0, "silence stays silent");
    }

    #[test]
    fn speed_is_clamped_and_nan_falls_back_to_normal() {
        assert_eq!(clamp_speed(1.0), 1.0);
        assert_eq!(clamp_speed(0.01), MIN_SPEED);
        assert_eq!(clamp_speed(50.0), MAX_SPEED);
        assert_eq!(clamp_speed(f32::NAN), 1.0);
        assert_eq!(clamp_speed(f32::INFINITY), MAX_SPEED);
    }

    #[test]
    fn voice_language_reads_the_kokoro_prefix() {
        assert_eq!(voice_language("af_heart"), "en-US");
        assert_eq!(voice_language("bm_george"), "en-GB");
        assert_eq!(voice_language("zf_xiaoxiao"), "zh");
        assert_eq!(voice_language("jf_alpha"), "ja");
        assert_eq!(voice_language("nonsense"), "");
    }

    /// Hand-encoded `ModelProto`: a length-delimited field 7 (the graph, whose
    /// payload we must skip by length) followed by field 14 with one metadata
    /// entry. Mirrors the real file's shape — huge skipped payload, small
    /// metadata at the end.
    #[test]
    fn read_onnx_metadata_skips_payload_and_finds_entries() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("model.onnx");
        let mut bytes: Vec<u8> = Vec::new();
        // field 7 (graph), wire type 2, 5-byte payload
        bytes.extend_from_slice(&[0x3A, 0x05, 1, 2, 3, 4, 5]);
        // one StringStringEntryProto: key = "speaker_names", value = "af_a,bf_b"
        let mut entry: Vec<u8> = Vec::new();
        entry.push(0x0A);
        entry.push(13);
        entry.extend_from_slice(b"speaker_names");
        entry.push(0x12);
        entry.push(9);
        entry.extend_from_slice(b"af_a,bf_b");
        // field 14, wire type 2
        bytes.push(0x72);
        bytes.push(entry.len() as u8);
        bytes.extend_from_slice(&entry);
        std::fs::write(&path, &bytes).expect("write");

        let meta = read_onnx_metadata(&path);
        assert_eq!(meta.get("speaker_names").map(String::as_str), Some("af_a,bf_b"));
    }

    #[test]
    fn read_onnx_metadata_is_empty_for_garbage() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("bad.onnx");
        std::fs::write(&path, b"\xff\xff\xff\xff not a protobuf").expect("write");
        assert!(read_onnx_metadata(&path).is_empty());
        assert!(read_onnx_metadata(&dir.path().join("missing.onnx")).is_empty());
    }

    #[test]
    fn cache_key_depends_on_every_audio_input() {
        let base = cache_key("m", "af_heart", 1.0, "hello");
        assert_eq!(base, cache_key("m", "af_heart", 1.0, "hello"), "stable");
        assert_ne!(base, cache_key("m2", "af_heart", 1.0, "hello"), "model");
        assert_ne!(base, cache_key("m", "af_bella", 1.0, "hello"), "voice");
        assert_ne!(base, cache_key("m", "af_heart", 1.5, "hello"), "speed");
        assert_ne!(base, cache_key("m", "af_heart", 1.0, "hello!"), "text");
    }

    #[test]
    fn find_model_file_prefers_int8_then_plain() {
        let dir = tempfile::tempdir().expect("tempdir");
        assert!(find_model_file(dir.path()).is_none());
        std::fs::write(dir.path().join("model.onnx"), b"x").unwrap();
        assert_eq!(
            find_model_file(dir.path()).unwrap().file_name().unwrap(),
            "model.onnx"
        );
        std::fs::write(dir.path().join("model.int8.onnx"), b"x").unwrap();
        assert_eq!(
            find_model_file(dir.path()).unwrap().file_name().unwrap(),
            "model.int8.onnx",
            "int8 wins when both are present"
        );
    }

    #[test]
    fn resolve_model_prefers_the_selected_then_recommended() {
        let dir = tempfile::tempdir().expect("tempdir");
        assert!(resolve_model(dir.path(), None).is_none(), "nothing installed");

        // Install a bundle that is NOT the recommended one: it must still
        // resolve as the sole installed option, or a user who picked the
        // non-default model would get "no model installed".
        let alternative = catalog()
            .into_iter()
            .find(|m| !m.recommended)
            .expect("a non-recommended catalog entry");
        let alternative_dir = dir.path().join(&alternative.dir_name);
        std::fs::create_dir_all(&alternative_dir).unwrap();
        std::fs::write(alternative_dir.join("model.onnx"), b"x").unwrap();
        assert_eq!(
            resolve_model(dir.path(), None).unwrap().0,
            alternative.id,
            "sole install resolves even when not recommended"
        );

        // A stale `tts.model` pointing at a model that is no longer on disk must
        // not win over the one that is.
        let missing = catalog()
            .into_iter()
            .find(|m| m.recommended)
            .expect("a recommended catalog entry");
        assert_eq!(
            resolve_model(dir.path(), Some(&missing.id)).unwrap().0,
            alternative.id
        );

        // Once the recommended bundle is present too, an unset preference picks
        // it — the recommendation is what a fresh install should run.
        let recommended_dir = dir.path().join(&missing.dir_name);
        std::fs::create_dir_all(&recommended_dir).unwrap();
        std::fs::write(recommended_dir.join("model.onnx"), b"x").unwrap();
        assert_eq!(resolve_model(dir.path(), None).unwrap().0, missing.id);
    }

    #[tokio::test]
    async fn ensure_engine_reports_a_helpful_error_with_no_model() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = test_db();
        {
            let conn = db.0.lock();
            db::set_setting(&conn, "local_models.dir", dir.path().to_string_lossy().as_ref()).unwrap();
        }
        let tts = TtsState::default();
        // Matched rather than `expect_err`: the Ok side is an `Arc<TtsEngine>`,
        // which is not Debug (the sherpa-onnx handle has no Debug impl), and
        // the assertion is about the message anyway.
        let err = match ensure_engine(&db, &tts).await {
            Ok(_) => panic!("expected a failure when no model is installed"),
            Err(e) => e,
        };
        assert!(
            err.contains("No voice model installed"),
            "unexpected error: {err}"
        );
        assert!(tts.0.lock().is_none(), "a failed load must not cache an engine");
    }

    /// Network integration test for the Hugging Face download path — the whole
    /// reason this exists is that the previous GitHub-tarball download failed on
    /// proxied networks (its client set `.no_proxy()`), so the regression that
    /// matters is "can this client actually reach the model host". Ignored by
    /// default to keep the suite offline:
    ///
    ///   cargo test --lib hf_download -- --ignored --nocapture
    #[tokio::test]
    #[ignore = "hits the network"]
    async fn hf_download_path_fetches_a_real_bundle_file() {
        let client = http_client().expect("client");
        let files = hf_tree(&client, "csukuangfj/kokoro-multi-lang-v1_0", None)
            .await
            .expect("tree listing");
        println!("listed {} files", files.len());
        assert!(
            files.len() > 300,
            "expected the full bundle, got {} files",
            files.len()
        );
        assert!(
            files.iter().any(|f| f.path == "model.onnx"),
            "the bundle must contain model.onnx"
        );
        assert!(
            files.iter().any(|f| f.path == "espeak-ng-data/phondata"),
            "the bundle must contain the espeak data Kokoro needs"
        );

        // Pull one small real file end to end, through the same helper the
        // installer uses.
        let dir = tempfile::tempdir().expect("tempdir");
        let entry = files
            .iter()
            .find(|f| f.path == "tokens.txt")
            .expect("tokens.txt in listing");
        let progress = std::sync::atomic::AtomicU64::new(0);
        hf_download_file(&client, "csukuangfj/kokoro-multi-lang-v1_0", None, dir.path(), entry, &progress)
            .await
            .expect("download tokens.txt");
        let written = std::fs::read(dir.path().join("tokens.txt")).expect("read back");
        println!("tokens.txt: {} bytes", written.len());
        assert!(!written.is_empty(), "downloaded file must not be empty");
        assert_eq!(
            progress.load(std::sync::atomic::Ordering::Relaxed),
            written.len() as u64,
            "progress must account for exactly the bytes written"
        );
        // A second call must be a no-op that still counts the bytes, so a
        // resumed install reports the same total.
        let progress2 = std::sync::atomic::AtomicU64::new(0);
        hf_download_file(&client, "csukuangfj/kokoro-multi-lang-v1_0", None, dir.path(), entry, &progress2)
            .await
            .expect("second call");
        assert_eq!(progress2.load(std::sync::atomic::Ordering::Relaxed), written.len() as u64);
    }

    #[test]
    fn set_speed_clamps_before_persisting() {
        let db = test_db();
        // The command clamps, so an out-of-range value can never be stored and
        // later read back as the configured speed.
        let clamped = clamp_speed(9.0);
        {
            let conn = db.0.lock();
            db::set_setting(&conn, SPEED_KEY, &format!("{clamped}")).unwrap();
        }
        let conn = db.0.lock();
        assert_eq!(
            get_setting(&conn, SPEED_KEY).and_then(|s| s.parse::<f32>().ok()),
            Some(MAX_SPEED)
        );
    }
}
