// Read-aloud player. Two responsibilities:
//
// 1. **Text preparation** — `markdownToSpeech` + `splitSentences` turn a rendered
//    answer (or a text artifact) into speech-ready sentences. Both are exported
//    for tests; they are pure functions with no audio dependency.
// 2. **Playback** — synthesize and play one sentence at a time through the
//    shared AudioContext, prefetching the next few while the current one plays.
//
// One sentence at a time is the whole design: the backend synthesizes ~10x
// faster than real time on CPU, so a long answer would otherwise sit silent for
// tens of seconds before the first word. Chunking starts audio after the first
// short sentence, makes per-sentence navigation (and pause) exact, and lets the
// backend cache each chunk independently — replaying a message is instant.
//
// Deliberately no lookbehind regexes anywhere in this file: older WKWebView
// builds (macOS) reject them at PARSE time, which would break the whole module
// rather than degrade a feature.
import { sharedAudioContext } from "./sound";
import { ttsSpeak, ttsStatus, type TtsStatus } from "./ipc";
import { useTtsStore } from "../state/tts";

/** Sentences longer than this are split further at clause boundaries. Kokoro's
 *  vocoder slows down and destabilises on very long inputs, and a 600-character
 *  "sentence" is a long wait before a single word is audible. */
const MAX_SENTENCE_CHARS = 240;

/** Chunk budget by device — the single most important difference between the
 *  two paths.
 *
 *  CPU synthesis runs at roughly playback speed, so sentence-sized chunks keep
 *  the pipeline fed while giving fine-grained pause/skip. The GPU path
 *  synthesizes ~3x faster but starts a fresh process for every call, paying
 *  ~4.5s of process start + model load each time (measured; see
 *  src-tauri/src/commands/tts_gpu.rs). Per-sentence calls would therefore spend
 *  4.5s loading for every couple of seconds of audio, so GPU mode groups
 *  sentences into as few, as large, calls as the engine accepts. */
const CPU_CHUNK_CHARS = MAX_SENTENCE_CHARS;
const GPU_CHUNK_CHARS = 1200;

/** Silence inserted before the first sentence of a new paragraph. Sentence
 *  transitions rely on the trailing silence the model already renders, but a
 *  paragraph break is a structural pause — without it, a list of separate
 *  points reads as one continuous run-on. */
const PARAGRAPH_PAUSE_MS = 280;

/** How many sentences ahead to synthesize while one is playing. `undefined`
 *  means "prefetch the rest of the text", which is what GPU mode wants: its
 *  chunks are already large, and one extra call in flight hides the next model
 *  load behind the audio already playing. */
function prefetchAhead(device: string | null): number {
  return device === "gpu" ? 1 : 4;
}

// ---- Text preparation ----

/** Symbols and abbreviations that are read badly or not at all. Applied before
 *  the markdown pass, because several of them (`&`, `→`) also appear inside
 *  constructs the markdown pass has to see intact. */
const SPEECH_SUBSTITUTIONS: [RegExp, string][] = [
  // Latin abbreviations: the letters get spelled out one by one otherwise.
  [/\be\.g\.,?\s*/gi, "for example, "],
  [/\bi\.e\.,?\s*/gi, "that is, "],
  [/\betc\./gi, "et cetera"],
  [/\bvs\.?\b/gi, "versus"],
  [/\bcf\./gi, "compare"],
  [/\bapprox\./gi, "approximately"],
  [/\bw\/o\b/gi, "without"],
  [/\bw\//gi, "with "],
  // Symbols the engine either skips or mispronounces.
  [/→/g, " to "],
  [/←/g, " from "],
  [/≥/g, " greater than or equal to "],
  [/≤/g, " less than or equal to "],
  [/≈/g, " approximately "],
  [/×/g, " times "],
  [/&/g, " and "],
  [/%/g, " percent"],
];

/** Break identifiers into pronounceable words: `MessageBubble` becomes
 *  "Message Bubble" and `max_sentence_chars` becomes "max sentence chars".
 *  Technical answers are full of these, and a run-together identifier is either
 *  spelled out letter by letter or mangled — neither of which the reader can
 *  follow. The camelCase pattern requires an interior capital, so ordinary
 *  English words are untouched. */
function speakableIdentifiers(text: string): string {
  // camelCase AND PascalCase: a capital following a lowercase letter or digit
  // opens a word. The previous pattern required a lowercase START, so it missed
  // `MessageBubble` — the single most common shape in a code answer.
  let out = text.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  // Acronym runs: a capital followed by a lowercase ends the run, so
  // `HTTPServer` becomes "HTTP Server" rather than "H T T P Server".
  out = out.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  // snake_case / SCREAMING_SNAKE: one pass resolves consecutive underscores
  // because the scan resumes after each match.
  out = out.replace(/(\w)_/g, "$1 ");
  return out;
}

/** Strip the markdown scaffolding that reads badly aloud, and normalise the
 *  technical shorthand an answer is likely to contain. Code fences and math are
 *  dropped outright — spelling out a listing character by character is noise,
 *  and it would dominate the audio for a coding answer. */
export function markdownToSpeech(md: string): string {
  let out = md;
  for (const [pattern, replacement] of SPEECH_SUBSTITUTIONS) {
    out = out.replace(pattern, replacement);
  }
  // Fenced code (``` and ~~~), including unterminated fences while streaming.
  out = out.replace(/```[\s\S]*?(?:```|$)/g, " ");
  out = out.replace(/~~~[\s\S]*?(?:~~~|$)/g, " ");
  // Display math — raw LaTeX has no readable prosody.
  out = out.replace(/\$\$[\s\S]*?\$\$/g, " ");
  // Table separator rows, then the pipes themselves (cell text stays readable).
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
  // Inline math.
  out = out.replace(/\$([^$\n]+)\$/g, "$1");
  // Headings and blockquote markers. The trailing punctuation a heading carries
  // (or gains here) is what gives the reader a beat before the body text, so
  // headings end in a full stop rather than running straight on.
  out = out.replace(/^[ \t]{0,3}#{1,6}[ \t]+(.*)$/gm, (_m, title: string) => {
    const clean = title.trim().replace(/[.:;,!?]+$/, "");
    return clean ? `${clean}.\n` : "";
  });
  out = out.replace(/^[ \t]{0,3}>[ \t]?/gm, "");
  // List markers: the bullet becomes a full stop so items are separated by a
  // sentence break instead of running together.
  out = out.replace(/^[ \t]*[-*+][ \t]+/gm, "");
  out = out.replace(/^[ \t]*\[[ xX]\][ \t]*/gm, "");
  out = out.replace(/^[ \t]*\d+[.)][ \t]+/gm, "");
  out = out.replace(/^[ \t]*([-*_])[ \t]*\1[ \t]*\1[-*_ \t]*$/gm, "\n\n");
  // Emphasis markers, keeping the words. Only `*`/`**` are touched — a lone
  // underscore is far more likely to be inside an identifier (which the pass
  // above has already spaced out) than to be emphasis in a technical answer.
  out = out.replace(/(\*\*)([^*]+)\1/g, "$2");
  out = out.replace(/\*([^*\n]+)\*/g, "$1");
  // Dashes used as asides read as a beat in speech.
  out = out.replace(/\s*[—–]\s*/g, ", ");
  out = speakableIdentifiers(out);
  // Collapse runs of spaces and blank lines, but KEEP the blank line between
  // paragraphs: it is the only signal the splitter has for where a longer pause
  // belongs.
  return out
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** One unit of speech: the text to synthesize, plus whether it begins a new
 *  paragraph. The flag is what lets playback insert a longer beat between
 *  paragraphs than between sentences — the difference between a list of facts
 *  and an undifferentiated stream. */
export interface SpeechChunk {
  text: string;
  paragraphStart: boolean;
}

/** Split text into sentence-sized chunks.
 *
 *  Only STRONG terminators split (`. ! ?` and the full-width forms): a
 *  semicolon or comma is a breath inside a sentence, and cutting there forces a
 *  chunk boundary — a full stop's worth of silence — mid-thought. Uses `split`
 *  with capture groups rather than a lookbehind (see the module header), so the
 *  terminators come back as separate array entries that get re-attached. */
export function splitSentences(text: string, maxChars = MAX_SENTENCE_CHARS): SpeechChunk[] {
  const chunks: SpeechChunk[] = [];
  // Two branches, because the two writing systems space differently:
  //
  //  · Latin terminators only count when followed by whitespace or the end of
  //    the text. Without that guard "3.14" and "v1.2" split mid-number.
  //  · CJK terminators need no such guard — Chinese and Japanese do not put a
  //    space after 。！？, so requiring one meant an entire CJK answer never
  //    split at all and went to the engine as one enormous chunk.
  //
  // A lookahead, not a lookbehind: lookbehind is a parse error on older
  // WKWebView, which would break this whole module rather than one rule.
  const parts = text.split(/([.!?]+["')\]”’]?(?=\s|$)|[。！？…]+["')\]”’]?)(\s*)/);
  // parts is [text, terminator, whitespace, text, terminator, whitespace, …].
  //
  // The whitespace captured with a sentence is the gap that FOLLOWS it, so it
  // describes the NEXT sentence — which is why the flag is assigned after the
  // push, not before. (Getting this backwards marked the sentence *before* a
  // paragraph break, so the pause landed one sentence too early.)
  let paragraphStart = false;
  for (let i = 0; i < parts.length; i += 3) {
    const raw = (parts[i] ?? "") + (parts[i + 1] ?? "");
    const sentence = raw.trim();
    if (sentence) {
      for (const piece of hardWrap(sentence, maxChars)) {
        chunks.push({ text: piece, paragraphStart });
      }
    }
    paragraphStart = (parts[i + 2] ?? "").includes("\n\n");
  }
  return chunks.filter((c) => c.text.length > 0);
}

/** Break a too-long sentence at its last clause boundary, falling back to a
 *  space and finally to a hard cut (a single unbroken run — a long token that
 *  survived cleanup). */
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
    // A boundary in the first 40% of the window is worse than a plain space
    // break — it would emit a stub sentence.
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

// ---- Playback ----

export interface PlayTextOptions {
  /** Identity of the source, so the UI can tell whether IT is the one playing
   *  (`msg:<id>`, `artifact:<path>`). */
  key: string;
  /** Short label for the player bar. */
  label?: string;
  text: string;
}

type SentenceResult = "ended" | "stopped" | "paused";

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

class TtsPlayer {
  private chunks: SpeechChunk[] = [];
  /** Identifies the (model, voice, speed) a decoded buffer was made with —
   *  changing the voice in Settings must not replay the previous voice. */
  private cachePrefix = "";
  private buffers = new Map<string, AudioBuffer>();
  private source: AudioBufferSourceNode | null = null;
  private index = 0;
  /** Resume point inside `sentences[index]`, in seconds. */
  private offset = 0;
  private startedAt = 0;
  private currentOffset = 0;
  private pauseRequested = false;
  /** Set by next()/prev() while a sentence is playing; pump applies the jump
   *  when that sentence reports back. */
  private skipTarget: number | null = null;
  private voice: string | null = null;
  private speed = 1;
  private device: string | null = null;
  private ahead = 4;
  /** Invalidates in-flight work after stop()/replay — every async step checks
   *  it before touching the audio graph or the store. */
  private token = 0;

  /** Play `text`, replacing whatever was playing. */
  async play({ key, label, text }: PlayTextOptions): Promise<void> {
    const my = (this.token += 1);
    this.skipTarget = null;
    this.pauseRequested = false;
    this.stopSource();
    const store = useTtsStore.getState();
    store.set({ key, label: label ?? null, error: null, phase: "loading", index: 0, total: 0 });

    const status = await this.resolveSettings();
    if (my !== this.token) return;
    if (!status) return;
    const chunks = splitSentences(
      markdownToSpeech(text),
      this.device === "gpu" ? GPU_CHUNK_CHARS : CPU_CHUNK_CHARS,
    );
    if (chunks.length === 0) {
      store.set({ phase: "idle", key: null, label: null, error: "Nothing to read here" });
      return;
    }

    this.chunks = chunks;
    this.index = 0;
    this.offset = 0;
    store.set({ total: chunks.length });

    const ctx = sharedAudioContext();
    if (!ctx) {
      store.set({ phase: "idle", key: null, label: null, error: "Audio playback is unavailable" });
      return;
    }
    // A context created without a user gesture starts suspended; resuming here
    // is what makes auto-read work after the user's first interaction.
    if (ctx.state === "suspended") {
      try {
        await ctx.resume();
      } catch {
        /* stays suspended — playback below will simply not advance */
      }
    }
    await this.pump(my, ctx);
  }

  /** Resume a paused read from where it stopped. */
  resume(): void {
    if (useTtsStore.getState().phase !== "paused" || this.chunks.length === 0) return;
    const ctx = sharedAudioContext();
    if (!ctx) return;
    useTtsStore.getState().set({ phase: "loading" });
    void this.pump(this.token, ctx);
  }

  pause(): void {
    if (!this.source) return;
    const ctx = sharedAudioContext();
    // Remember the resume point BEFORE stopping — `onended` fires async and
    // `ctx.currentTime` has moved on by the time it would be read there.
    if (ctx) this.offset = this.currentOffset + (ctx.currentTime - this.startedAt);
    this.pauseRequested = true;
    this.stopSource();
  }

  /** Stop and clear. The store returns to idle so the play button reverts. */
  stop(): void {
    this.token += 1;
    this.skipTarget = null;
    this.pauseRequested = false;
    this.stopSource();
    this.chunks = [];
    this.index = 0;
    this.offset = 0;
    useTtsStore.getState().set({
      phase: "idle",
      key: null,
      label: null,
      index: 0,
      total: 0,
      error: null,
    });
  }

  next(): void {
    this.skipTo(this.index + 1);
  }

  prev(): void {
    this.skipTo(this.index - 1);
  }

  private skipTo(target: number): void {
    if (this.chunks.length === 0) return;
    const clamped = Math.max(0, Math.min(target, this.chunks.length - 1));
    this.offset = 0;
    const phase = useTtsStore.getState().phase;
    if (phase === "playing") {
      // The running sentence is interrupted; pump sees `skipTarget` and lands on
      // it instead of advancing.
      this.skipTarget = clamped;
      this.stopSource();
      return;
    }
    this.index = clamped;
    if (phase === "paused") {
      useTtsStore.getState().set({ phase: "loading" });
      const ctx = sharedAudioContext();
      if (ctx) void this.pump(this.token, ctx);
    }
  }

  /** Fetch the settings that every chunk of this read must share, and record
   *  the device so prefetch depth and chunk size match. Returns null once an
   *  error has been surfaced to the store. */
  private async resolveSettings(): Promise<TtsStatus | null> {
    const store = useTtsStore.getState();
    let status: TtsStatus | null = null;
    try {
      status = await ttsStatus();
    } catch {
      /* fall through to the no-model branch */
    }
    if (!status?.modelId) {
      store.set({
        phase: "idle",
        key: null,
        label: null,
        error: "No voice model installed — add one in Settings → Local Models → Speech",
      });
      return null;
    }
    // Resolved ONCE per play: every chunk must be voiced with the same
    // model/voice/speed, or the cache prefix below would be a lie.
    this.voice = status.voice ?? status.voices[0]?.name ?? null;
    this.speed = status.speed ?? 1;
    this.device = status.device;
    this.ahead = prefetchAhead(status.device);
    // The device is part of the prefix because the two paths produce different
    // bytes for the same sentence — a cached CPU buffer must never be replayed
    // as if it came from the GPU (or vice versa).
    this.cachePrefix = `${status.modelId}|${this.voice ?? ""}|${this.speed}|${status.device}`;
    return status;
  }

  private stopSource(): void {
    const src = this.source;
    this.source = null;
    if (!src) return;
    src.onended = null;
    try {
      src.stop();
    } catch {
      /* never started, or already stopped */
    }
  }

  private async pump(my: number, ctx: AudioContext): Promise<void> {
    while (this.index < this.chunks.length) {
      if (my !== this.token) return;
      const result = await this.playSentence(my, ctx);
      if (my !== this.token) return;
      if (result === "stopped") return;
      if (result === "paused") {
        useTtsStore.getState().set({ phase: "paused" });
        return;
      }
      if (this.skipTarget != null) {
        this.index = this.skipTarget;
        this.skipTarget = null;
      } else {
        this.index += 1;
      }
      this.offset = 0;
      // Beat between paragraphs. The token is re-checked after the wait, so a
      // stop or a replay during the pause is not resumed into.
      if (this.chunks[this.index]?.paragraphStart) {
        await new Promise((resolve) => setTimeout(resolve, PARAGRAPH_PAUSE_MS));
        if (my !== this.token) return;
      }
    }
    this.chunks = [];
    useTtsStore.getState().set({ phase: "idle", key: null, label: null, index: 0, total: 0 });
  }

  private async playSentence(my: number, ctx: AudioContext): Promise<SentenceResult> {
    const index = this.index;
    this.prefetch(ctx, index);
    const buffer = await this.bufferFor(ctx, index);
    if (my !== this.token) return "stopped";
    if (!buffer) {
      // One failed sentence must not kill the whole read — report it and move
      // on to the next.
      useTtsStore.getState().set({ error: "Could not synthesize part of this text" });
      return "ended";
    }
    useTtsStore.getState().set({ phase: "playing", index: index + 1, error: null });
    return this.startSource(ctx, buffer, this.offset);
  }

  private prefetch(ctx: AudioContext, index: number): void {
    for (let n = index + 1; n <= index + this.ahead && n < this.chunks.length; n += 1) {
      void this.bufferFor(ctx, n);
    }
  }

  /** Decoded audio for one sentence — from the in-memory cache, else the
   *  backend (which has its own disk cache, so a replay is a fast IPC hop). */
  private async bufferFor(ctx: AudioContext, index: number): Promise<AudioBuffer | null> {
    const text = this.chunks[index]?.text;
    if (!text) return null;
    const key = `${this.cachePrefix}|${text}`;
    const hit = this.buffers.get(key);
    if (hit) return hit;
    try {
      const audio = await ttsSpeak(text, this.voice, this.speed);
      if (!audio?.audioBase64) return null;
      const buffer = await ctx.decodeAudioData(base64ToBytes(audio.audioBase64).buffer as ArrayBuffer);
      // Cache AFTER decoding so a late failure can't leave a poisoned entry.
      this.buffers.set(key, buffer);
      this.trimBuffers();
      return buffer;
    } catch (err) {
      console.warn("[relay] TTS synthesis failed", err);
      return null;
    }
  }

  /** Bounded decoded-audio cache. ~150 short sentences is a few MB of PCM and
   *  far more than one answer's playback queue needs. */
  private trimBuffers(): void {
    if (this.buffers.size <= 150) return;
    const keys = [...this.buffers.keys()];
    for (const key of keys.slice(0, keys.length - 100)) this.buffers.delete(key);
  }

  /** Start one buffer and resolve when it finishes, pauses, or is stopped. */
  private startSource(ctx: AudioContext, buffer: AudioBuffer, offset: number): Promise<SentenceResult> {
    return new Promise<SentenceResult>((resolve) => {
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(ctx.destination);
      const startAt = Math.min(Math.max(offset, 0), Math.max(buffer.duration - 0.02, 0));
      src.onended = () => {
        if (this.source === src) this.source = null;
        // A `paused` resolution is driven by pauseRequested/stopSource; a stop()
        // or replay already resolved this promise through its own path, and a
        // second resolve is a no-op.
        resolve(this.pauseRequested ? "paused" : "ended");
      };
      this.source = src;
      this.pauseRequested = false;
      this.startedAt = ctx.currentTime;
      this.currentOffset = startAt;
      try {
        src.start(0, startAt);
      } catch (err) {
        console.warn("[relay] TTS playback failed", err);
        this.source = null;
        resolve("ended");
      }
    });
  }
}

export const ttsPlayer = new TtsPlayer();

/** Toggle helper for play buttons: starts `text`, or stops when `key` is
 *  already the thing being read. */
export function toggleReadAloud(opts: PlayTextOptions): void {
  const state = useTtsStore.getState();
  if (state.key === opts.key && state.phase !== "idle") {
    ttsPlayer.stop();
    return;
  }
  void ttsPlayer.play(opts);
}
