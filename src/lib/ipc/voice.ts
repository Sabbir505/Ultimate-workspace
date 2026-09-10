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

/** Pop a chat session out into its own OS window (roadmap #17). */
export const popOutChat = (sessionId: string) =>
  safeInvoke<void>("pop_out_chat", { sessionId });
