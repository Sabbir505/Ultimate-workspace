/**
 * tts — read-aloud through the phone's own speaker.
 *
 * Wraps `expo-speech`, which drives the OS text-to-speech engine, so every
 * read-aloud surface in the app (chat turns, artifacts, wiki/vault notes,
 * terminal output…) sounds like the rest of the phone: same voices, same
 * rate control the user tuned in system settings.
 *
 * Design notes:
 *   - ONE utterance at a time. `Speech.speak` queues on the OS side, but a
 *     queue would keep reading after the user hit stop, so chunks are chained
 *     through `onDone` instead, with a generation counter making every
 *     async callback check it is still the current playback.
 *   - Keys identify WHAT is being read (`msg:<id>`, `artifact:<path>`) so a
 *     speak button can show its active state and tapping it stops the read.
 *   - The text normalisation (markdownToSpeech → splitSentences) is a direct
 *     port of the desktop reader (src/lib/tts.ts) — the same replacements
 *     that make an assistant answer sound right out loud: code fences and
 *     math dropped, links reduced to their label, bullets read as sentence
 *     breaks, identifiers spoken as words.
 */
import * as Speech from 'expo-speech';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

const RATE_KEY = 'tts.rate';
const VOICE_KEY = 'tts.voice';
export const RATE_MIN = 0.5;
export const RATE_MAX = 2;
export const RATE_STEP = 0.25;
export const DEFAULT_RATE = 1;

/** Chunks are paragraph-sized, not sentence-sized — Android's TTS engine
 *  restarts (with an audible ~half-second gap) on every Speech.speak() call,
 *  so one utterance per PARAGRAPH removes the long pauses a per-sentence
 *  chain had. Sentences longer than this are hard-wrapped. */
const MAX_SENTENCE_CHARS = 480;

export type TtsPhase = 'idle' | 'speaking';

export interface TtsState {
  /** Identity of what is being read (`msg:<id>`, `artifact:<path>`, …). */
  key: string | null;
  /** Short label for the floating player pill. */
  label: string | null;
  phase: TtsPhase;
  /** 0-based index of the sentence currently being spoken. */
  chunkIndex: number;
  chunkCount: number;
  rate: number;
  /** Voice identifier (from getAvailableVoicesAsync), or null for default. */
  voice: string | null;
  error: string | null;
}

type Listener = (s: TtsState) => void;
const listeners = new Set<Listener>();

let state: TtsState = {
  key: null,
  label: null,
  phase: 'idle',
  chunkIndex: 0,
  chunkCount: 0,
  rate: DEFAULT_RATE,
  voice: null,
  error: null,
};

let rateLoaded = false;
/** Bumped on every stop/new play so stale async callbacks bail. */
let generation = 0;
/** Queue of sentences for the current read, plus progress. */
let queue: string[] = [];
let queueIndex = 0;
let currentLabel: string | null = null;

function emit() {
  listeners.forEach((fn) => fn(state));
}

function patch(next: Partial<TtsState>) {
  state = { ...state, ...next };
  emit();
}

export function subscribeTts(fn: Listener): () => void {
  listeners.add(fn);
  // Emit the CURRENT state right away so a fresh subscriber (a SpeakButton
  // mounting mid-read, the pill after navigation) doesn't paint stale.
  fn(state);
  return () => { listeners.delete(fn); };
}

export function getTtsState(): TtsState {
  return state;
}

/** Restore persisted rate/voice once per process. */
async function loadPrefs() {
  if (rateLoaded) return;
  rateLoaded = true;
  try {
    const [r, v] = await Promise.all([
      AsyncStorage.getItem(RATE_KEY),
      AsyncStorage.getItem(VOICE_KEY),
    ]);
    const rate = r != null ? Number(r) : NaN;
    patch({
      rate: Number.isFinite(rate) ? clampRate(rate) : DEFAULT_RATE,
      voice: v ?? null,
    });
  } catch {
    /* defaults stand */
  }
}
void loadPrefs();

export function clampRate(rate: number): number {
  return Math.min(RATE_MAX, Math.max(RATE_MIN, Math.round(rate / RATE_STEP) * RATE_STEP));
}

export async function setRate(rate: number): Promise<void> {
  const next = clampRate(rate);
  patch({ rate: next });
  // Re-speak the current chunk at the new rate — but only AFTER the pending
  // stop settles: on Android a speak() racing an in-flight stop() is
  // silently cancelled, which used to look like a frozen player (pill says
  // speaking, no audio).
  if (queue.length > 0 && queueIndex < queue.length) {
    // Bump the generation FIRST so the old utterance's onDone can't advance
    // the queue while the stop is settling.
    generation += 1;
    const gen = generation;
    void Speech.stop().catch(() => {}).then(() => {
      if (gen !== generation) return;
      speakChunk(queueIndex, gen);
    });
  }
  try { await AsyncStorage.setItem(RATE_KEY, String(next)); } catch { /* ignore */ }
}

export async function setVoice(voice: string | null): Promise<void> {
  patch({ voice });
  // Same stop-then-restart dance as setRate (see above).
  if (queue.length > 0 && queueIndex < queue.length) {
    generation += 1;
    const gen = generation;
    void Speech.stop().catch(() => {}).then(() => {
      if (gen !== generation) return;
      speakChunk(queueIndex, gen);
    });
  }
  try { await AsyncStorage.setItem(VOICE_KEY, voice ?? ''); } catch { /* ignore */ }
}

/** True when `key` is the thing currently being read. */
export function isSpeakingKey(key: string): boolean {
  return state.key === key && state.phase === 'speaking';
}

/**
 * Speak `text` (markdown ok). If the SAME key is already being read, this
 * stops it — the one-tap toggle every speak button uses.
 */
export function toggleSpeak(key: string, text: string, label?: string): void {
  if (isSpeakingKey(key)) {
    stopSpeaking();
    return;
  }
  void speak(key, text, label);
}

export function speak(key: string, text: string, label?: string): void {
  const chunks = splitForSpeech(markdownToSpeech(text));
  if (chunks.length === 0) {
    patch({ error: 'Nothing readable to read aloud.' });
    return;
  }
  generation += 1;
  const gen = generation;
  queue = chunks;
  queueIndex = 0;
  currentLabel = label ?? null;
  patch({ key, label: label ?? null, phase: 'speaking', chunkIndex: 0, chunkCount: chunks.length, error: null });
  // Let any previous utterance's stop settle before the first chunk — on
  // Android the new speak() is cancelled outright if a stop is still in
  // flight (the classic "tap play, pill appears, silence forever" bug).
  void Speech.stop().catch(() => {}).then(() => {
    if (gen !== generation) return;
    speakChunk(0, gen);
  });
}

function speakChunk(index: number, gen: number) {
  if (gen !== generation) return;
  queueIndex = index;
  const text = queue[index];
  if (text == null) {
    // Queue drained — natural end of the read.
    if (gen === generation) {
      generation += 1;
      queue = [];
      queueIndex = 0;
      currentLabel = null;
      patch({ key: null, phase: 'idle', chunkIndex: 0, chunkCount: 0, label: null });
    }
    return;
  }
  patch({ chunkIndex: index });
  try {
    Speech.speak(text, {
      rate: state.rate,
      ...(state.voice ? { voice: state.voice } : {}),
      onDone: () => {
        if (gen !== generation) return;
        speakChunk(index + 1, gen);
      },
      onError: (e: Error) => {
        if (gen !== generation) return;
        generation += 1;
        queue = [];
        patch({
          key: null,
          phase: 'idle',
          error: e?.message ? `Read aloud failed: ${e.message}` : 'Read aloud failed.',
        });
      },
      onStopped: () => {
        // Only fires for the utterance in flight when Speech.stop() is
        // called — generation has already moved on, so nothing to do.
      },
    });
  } catch (e) {
    if (gen !== generation) return;
    generation += 1;
    patch({ key: null, phase: 'idle', error: 'Read aloud failed.' });
  }
}

export function stopSpeaking(): void {
  generation += 1;
  queue = [];
  queueIndex = 0;
  currentLabel = null;
  Speech.stop().catch(() => {});
  patch({ key: null, label: null, phase: 'idle', chunkIndex: 0, chunkCount: 0 });
}

/** Step the rate and keep reading from the current sentence (desktop parity:
 *  the pill's rate arrows). */
export function nudgeRate(delta: number): void {
  void setRate(clampRate(state.rate + delta));
}

// ---- speech text preparation ----
// Direct ports of the desktop reader's normalization (src/lib/tts.ts
// `markdownToSpeech` / `splitSentences` / `hardWrap`), which are covered by
// 13 unit tests there. Same rules so both platforms read the same way: code
// fences and math are dropped (spelling out a listing is noise), links keep
// their label, bullets become sentence breaks, and identifiers ("userId",
// "MAX_BUFFER") are spoken as words rather than gibberish.

const SPEECH_SUBSTITUTIONS: [RegExp, string | ((...args: string[]) => string)][] = [
  // RELEASE_BLOCK-style file annotations and stripped tool tags (mobile
  // carries raw markers inside message text when a turn is unfinished).
  [/<\/?(think|tool)>/g, " "],
  // Theoka relay markers that can survive inside an assistant answer.
  [/RELAY_ASK:[\s\S]*?(?=\n\n|$)/g, " "],
];

/** Speak identifiers ("getUserById", "MAX_BUFFER_BYTES") as words: camelCase
 *  boundaries and underscores become spaces. Runs before emphasis cleanup so
 *  `_` used as emphasis is already gone. */
function speakableIdentifiers(text: string): string {
  let out = text;
  // snake_case / SCREAMING_SNAKE → spaced words
  out = out.replace(/([a-z0-9])_+([a-zA-Z])/g, "$1 $2");
  out = out.replace(/[A-Z]{2,}_([A-Z])/g, "$1 ");
  // camelCase / PascalCase boundaries
  out = out.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return out;
}

export function markdownToSpeech(md: string): string {
  let out = md;
  for (const [pattern, replacement] of SPEECH_SUBSTITUTIONS) {
    out = typeof replacement === "function" ? out.replace(pattern, replacement) : out.replace(pattern, replacement);
  }
  // Fenced code (``` and ~~~), including unterminated fences (live streams).
  out = out.replace(/```[\s\S]*?(?:```|$)/g, " ");
  out = out.replace(/~~~[\s\S]*?(?:~~~|$)/g, " ");
  // Display math — raw LaTeX has no readable prosody.
  out = out.replace(/\$\$[\s\S]*?\$\$/g, " ");
  // Inline math.
  out = out.replace(/\$([^$\n]+)\$/g, "$1");
  // Table separator rows, then the pipes themselves (cell text stays).
  out = out.replace(/^[ \t]*\|?[ \t:|-]+\|[ \t:|-]*$/gm, " ");
  out = out.replace(/\|/g, ", ");
  // Images: alt text is usually a filename.
  out = out.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
  // Links: keep the label, drop the URL.
  out = out.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  out = out.replace(/<https?:\/\/[^>]+>/g, " ");
  out = out.replace(/https?:\/\/\S+/g, " ");
  // Inline code: the content is usually an identifier worth hearing.
  out = out.replace(/`([^`]+)`/g, "$1");
  // Headings: the trailing full stop gives the reader a beat before the body.
  out = out.replace(/^[ \t]{0,3}#{1,6}[ \t]+(.*)$/gm, (_m, title: string) => {
    const clean = title.trim().replace(/[.:;,!?]+$/, "");
    return clean ? `${clean}.\n\n` : "";
  });
  out = out.replace(/^[ \t]{0,3}>[ \t]?/gm, "");
  // List markers: bullets become sentence breaks so items don't run together.
  out = out.replace(/^[ \t]*[-*+][ \t]+/gm, ". ");
  out = out.replace(/^[ \t]*\[[ xX]\][ \t]*/gm, "");
  out = out.replace(/^[ \t]*\d+[.)][ \t]+/gm, "");
  out = out.replace(/^[ \t]*([-*_])[ \t]*\1[ \t]*\1[-*_ \t]*$/gm, "\n\n");
  // A standalone "Label:" line reads as a section header too.
  out = out.replace(/^[ \t]*([^\W_][^\n:*]{0,58}?)\s*:[ \t]*$/gm, (_m, label: string) => {
    const clean = label.trim();
    return /^[!?.,;]+$/.test(clean) ? _m : `${clean}.\n\n`;
  });
  // Emphasis markers, keeping the words (only * — lone _ is usually inside
  // an identifier).
  out = out.replace(/(\*\*)([^*]+)\1/g, "$2");
  out = out.replace(/\*([^*\n]+)\*/g, "$1");
  // Dashes used as asides read as a beat in speech.
  out = out.replace(/\s*[—–]\s*/g, ", ");
  out = speakableIdentifiers(out);
  return out
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function splitForSpeech(text: string, maxChars = MAX_SENTENCE_CHARS): string[] {
  // Latin terminators only split when followed by whitespace or the end
  // ("3.14", "v1.2" stay whole); CJK terminators need no such guard.
  const parts = text.split(/([.!?]+["')\]”’]?(?=\s|$)|[。！？…]+["')\]”’]?)(\s*)/);
  const sentences: string[] = [];
  for (let i = 0; i < parts.length; i += 3) {
    const sentence = ((parts[i] ?? "") + (parts[i + 1] ?? "")).trim();
    if (sentence) sentences.push(sentence);
  }
  // Greedy-merge short sentences into one utterance each: a chunk is ONE
  // Speech.speak() call, and on Android every extra call costs a visible
  // engine-restart pause. Newlines are preserved inside a merged chunk so
  // the engine still hears paragraph breaks as natural beats.
  const out: string[] = [];
  let buf = "";
  for (const s of sentences) {
    if (!buf) { buf = s; continue; }
    if (buf.length + 1 + s.length <= maxChars) buf = `${buf} ${s}`;
    else { out.push(buf); buf = s; }
  }
  if (buf) out.push(buf);
  return out.flatMap((chunk) => (chunk.length <= maxChars ? [chunk] : hardWrap(chunk, maxChars)));
}

function hardWrap(sentence: string, maxChars: number): string[] {
  if (sentence.length <= maxChars) return [sentence];
  const boundaries = [", ", "，", "; ", "；", ": ", "：", "、", "。", ". "];
  const out: string[] = [];
  let rest = sentence;
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars);
    let cut = -1;
    for (const sep of boundaries) {
      const at = window.lastIndexOf(sep);
      if (at > cut) cut = at + sep.length;
    }
    // A boundary in the first 40% is worse than a plain space break — it
    // would emit a stub sentence.
    if (cut < maxChars * 0.4) {
      const space = window.lastIndexOf(" ");
      cut = space >= maxChars * 0.4 ? space : window.length;
    }
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
    if (!rest) break;
  }
  if (rest) out.push(rest);
  return out.filter((s) => s.length > 0);
}

/** iOS reads aloud to the media stream; on Android the weekly speech volume
 *  is the system stream. Kept as a helper for future callers that need to
 *  know whether pause/resume is supported. */
export const supportsPause = Platform.OS === 'ios';
