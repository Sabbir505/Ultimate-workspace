// Extracted domain of lib/ipc.ts (see its header). Command names and
// payload shapes are binding (CONTRACT.md).
import { safeInvoke, safeListen } from "../ipcCore";

// ---- Voice input (roadmap #16) ----

export interface TranscriptionResult {
  text: string;
  baseUrl: string;
}

/** Transcribe a recorded audio clip (base64 WAV/MP3) via a whisper-compatible
 *  endpoint. Returns the recognized text. `tag` opts the request into
 *  cancellation via cancelTranscription — the whisper server aborts inference
 *  early when its client disconnects, freeing the serial inference queue. */
export const transcribeAudio = (payload: string, mime?: string, tag?: string) =>
  safeInvoke<TranscriptionResult | null>("transcribe_audio", {
    payload,
    mime: mime ?? null,
    tag: tag ?? null,
    // Diagnostics: lets the Rust side measure the webview→host transport lag
    // (a stalled delivery showed up as multi-second "last line" delays).
    sentAt: Date.now(),
  });

/** Abort an in-flight transcription request previously sent with `tag`.
 *  No-op when that request already finished. */
export const cancelTranscription = (tag: string) =>
  safeInvoke<void>("transcribe_cancel", { tag });

// ---- Speech-to-text models (Settings → Knowledge manages; mic uses) ----

export interface SttModelInfo {
  id: string;
  label: string;
  filename: string;
  downloadUrl: string;
  sizeBytes: number;
  note: string;
  recommended: boolean;
  installed: boolean;
  isDefault: boolean;
}

export interface SttStatus {
  running: boolean;
  port: number | null;
  modelPath: string | null;
  binaryPath: string | null;
  /** Which whisper.cpp build is selected: "cpu" or "gpu". */
  device: string;
  /** A CUDA build is on disk, so "gpu" can actually be honoured. */
  gpuAvailable: boolean;
  defaultModel: string | null;
  autoStart: boolean;
  sttDir: string | null;
  catalog: SttModelInfo[];
}

export const sttStatus = () => safeInvoke<SttStatus>("stt_status");
export const sttStart = () => safeInvoke<SttStatus>("stt_start");
export const sttStop = () => safeInvoke<void>("stt_stop");
/** One-click install: downloads the pinned upstream whisper.cpp release,
 *  extracts whisper-server.exe (+ DLLs) into the app-data bin dir, and saves
 *  its path into `stt.whisperServerPath`. Progress arrives on
 *  `onModelDownloadProgress` under id "stt-whisper-server". */
export const sttInstallServer = () => safeInvoke<SttStatus>("stt_install_server");
export const sttSetDefault = (filename: string) =>
  safeInvoke<void>("stt_set_default", { filename });
export const sttSetAutoStart = (autoStart: boolean) =>
  safeInvoke<void>("stt_set_auto_start", { autoStart });
export const sttSetServerPath = (path: string | null) =>
  safeInvoke<void>("stt_set_server_path", { path: path ?? null });
/** Choose the CPU or CUDA whisper.cpp build. Stops a running server — the live
 *  process belongs to the previous device. */
export const sttSetDevice = (device: "cpu" | "gpu") =>
  safeInvoke<SttStatus>("stt_set_device", { device });

// ---- Text-to-speech (Kokoro-82M, runs in-process — no cloud, no key) ----
// Read-aloud for assistant answers and text artifacts. The player asks for one
// sentence at a time so audio starts before a long answer is fully voiced;
// results are WAV bytes, base64-encoded, and cached on disk by the backend.

export interface TtsVoiceInfo {
  /** Speaker index passed to the engine. */
  id: number;
  /** The model's own name for the voice (`af_heart`, `zf_xiaoxiao`, …). */
  name: string;
  /** Language tag from Kokoro's naming convention ("en-US", "zh", …). */
  language: string;
}

export interface TtsCatalogEntry {
  id: string;
  label: string;
  dirName: string;
  sizeBytes: number;
  note: string;
  languages: string;
  recommended: boolean;
  installed: boolean;
  isSelected: boolean;
}

export interface TtsStatus {
  modelId: string | null;
  modelDir: string | null;
  /** Whether the engine is resident in memory (the first speak loads it). */
  loaded: boolean;
  voice: string | null;
  speed: number;
  autoRead: boolean;
  /** "cpu" (in-process) or "gpu" (CUDA child process). */
  device: string;
  /** Hold the model in memory from app start until the app exits. */
  keepLoaded: boolean;
  voices: TtsVoiceInfo[];
  ttsDir: string | null;
  cacheBytes: number;
  catalog: TtsCatalogEntry[];
}

/** Readiness of the optional CUDA runtime, as the backend sees it. */
export interface TtsGpuStatus {
  installed: boolean;
  exePath: string | null;
  cudaRuntime: string | null;
  cudnn: boolean;
  root: string;
  /** What is still missing; empty means GPU is ready to use. */
  missing: string[];
}

export interface TtsAudio {
  audioBase64: string;
  mime: string;
  sampleRate: number;
  durationSec: number;
  cached: boolean;
  voice: string;
}

export const ttsStatus = () => safeInvoke<TtsStatus>("tts_status");
/** Voice one chunk of text. Callers pass a single sentence (see
 *  `splitSentences` in lib/tts) so playback can start on the first one. */
export const ttsSpeak = (text: string, voice?: string | null, speed?: number | null) =>
  safeInvoke<TtsAudio>("tts_speak", {
    text,
    voice: voice ?? null,
    speed: speed ?? null,
  });
/** Load the engine without synthesizing — call after an install or a model
 *  switch so the first press of play isn't the call that pays for the load. */
export const ttsPreload = () => safeInvoke<boolean>("tts_preload", {});
export const ttsUnload = () => safeInvoke<TtsStatus>("tts_unload", {});
/** Download + extract a Kokoro bundle and select it. Idempotent — an already
 *  installed bundle just becomes the selection. Progress arrives on
 *  `onModelDownloadProgress` under the model's catalog id, and an in-flight
 *  download can be stopped with `cancelModelDownload(id)`. */
export const ttsInstallModel = (id: string) => safeInvoke<TtsStatus>("tts_install_model", { id });
export const ttsSetModel = (id: string) => safeInvoke<void>("tts_set_model", { id });
export const ttsSetVoice = (voice: string) => safeInvoke<void>("tts_set_voice", { voice });
/** Persists the clamped value and returns it — the UI should adopt the result. */
export const ttsSetSpeed = (speed: number) => safeInvoke<number>("tts_set_speed", { speed });
export const ttsSetAutoRead = (autoRead: boolean) =>
  safeInvoke<void>("tts_set_auto_read", { autoRead });
/** Switch synthesis between the in-process CPU engine and the CUDA child. */
export const ttsSetDevice = (device: "cpu" | "gpu") =>
  safeInvoke<TtsStatus>("tts_set_device", { device });
/** Keep the model resident from app start (CPU engine only — the GPU path has
 *  no resident engine). Rejects when there is nothing to load. */
export const ttsSetKeepLoaded = (keep: boolean) =>
  safeInvoke<TtsStatus>("tts_set_keep_loaded", { keep });
export const ttsGpuStatus = () => safeInvoke<TtsGpuStatus>("tts_gpu_status");
/** One-click GPU runtime: the CUDA voice engine (~456 MB) plus the cuDNN 9
 *  runtime (~420 MB), both SHA-256 pinned. Progress arrives on
 *  `onModelDownloadProgress` under id "tts-gpu-runtime". */
export const ttsInstallGpu = () => safeInvoke<TtsGpuStatus>("tts_install_gpu");

/** Pop a chat session out into its own OS window (roadmap #17). */
export const popOutChat = (sessionId: string) =>
  safeInvoke<void>("pop_out_chat", { sessionId });
