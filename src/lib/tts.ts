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
/** Kept under the backend's own 1200-character guard (commands/tts.rs truncates
 *  there), which a group has to clear with its join spaces included. */
const GPU_CHUNK_CHARS = 1100;

/** Budget for the FIRST GPU call. This one is on the critical path — the
 *  listener is waiting for the first word — so it stays near a sentence instead
 *  of a whole paragraph. A paragraph-sized call costs ~4.5s of process start
 *  plus its synthesis before anything is audible; the rest of the text is
 *  voiced in the background while this plays. */
const GPU_WARMUP_CHARS = 260;

/** Shortest GPU group worth a process of its own. A heading or a one-line note
 *  is a paragraph, so grouping bounded strictly by paragraphs would spend a
 *  ~4.5s process start on a few words — "Buffering…" after every heading, which
 *  is exactly where a document's short paragraphs sit. Below this size the
 *  paragraph joins the one after it instead. */
const GPU_MIN_GROUP_CHARS = 200;

/** Silence inserted before the first sentence of a new paragraph. Sentence
 *  transitions rely on the trailing silence the model already renders, but a
 *  paragraph break is a structural pause — without it, a list of separate
 *  points reads as one continuous run-on. */
const PARAGRAPH_PAUSE_MS = 280;

/** Audio the player wants buffered ahead of the playhead before a read starts.
 *
 *  Synthesis only runs at ~1.5x realtime on CPU (TTS_FEATURE_RESEARCH.md) while
 *  playback consumes at 1x, so a queue thin enough to drain is silence in the
 *  middle of the read — and it is the FIRST read of a text that feels it, since
 *  every later read comes back from the engine's cache and never waits. A lead
 *  measured in audio seconds (rather than "the next chunk is ready") is what
 *  keeps a run of short headings and list items fed, and building it once up
 *  front is what keeps the rest of the read free of boundary stalls.
 *
 *  Kept as small as the rule allows: this is the wait before the FIRST word,
 *  and the background walk is already filling the queue while it is spent, so
 *  the read does not need a deep lead to start — only enough that the sentence
 *  after the opening one is not a surprise. */
const LEAD_SECS = 6;

/** Mid-read the queue is only ever WAITED on when it is nearly dry; everything
 *  after it is voiced in the background while the read runs. Waiting at every
 *  boundary would turn an engine running at ~1x into a stutter of small waits. */
const LEAD_FLOOR_SECS = 4;

/** Synthesis requests the background walk keeps in flight. Two is enough to
 *  keep a serial engine fed across the request round-trip, and low enough that
 *  GPU mode never has more than a couple of engine processes alive at once. */
const MAX_INFLIGHT = 2;

// ---- Text preparation ----

/** A rule: what to match, and either the replacement text or a function that
 *  builds one from the match's groups (the date rule needs to resolve a month
 *  number to a name). */
type SpeechRule = [RegExp, string | ((match: string, ...groups: string[]) => string)];

/** What the B/K/M/T suffixes on a parameter count mean. */
const UNIT_WORDS: Record<string, string> = {
  B: "billion",
  M: "million",
  K: "thousand",
  T: "trillion",
};

/** Month names for the ISO-date rule; an out-of-range month is left as the
 *  digits the document wrote. */
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** Symbols and abbreviations that are read badly or not at all. Applied before
 *  the markdown pass, because several of them (`&`, `→`) also appear inside
 *  constructs the markdown pass has to see intact. */
const SPEECH_SUBSTITUTIONS: SpeechRule[] = [
  // Latin abbreviations: the letters get spelled out one by one otherwise.
  [/\be\.g\.,?\s*/gi, "for example, "],
  [/\bi\.e\.,?\s*/gi, "that is, "],
  [/\betc\./gi, "et cetera"],
  [/\bvs\.?\b/gi, "versus"],
  [/\bcf\./gi, "compare"],
  [/\bapprox\./gi, "approximately"],
  [/\bw\/o\b/gi, "without"],
  [/\bw\//gi, "with "],
  // Dates first: "2024-01-05" is a date, and the number-range rule below would
  // otherwise read it as two ranges ("2024 to 01 to 05").
  [
    /\b(\d{4})-(\d{2})-(\d{2})\b/g,
    (_m, y: string, m: string, d: string) =>
      `${MONTHS[Number(m) - 1] ?? m} ${Number(d)}, ${y}`,
  ],
  // Numbers: the engine reads the punctuation around them literally.
  //   "1/4"        → "1 slash 4"
  //   "10-20 mins" → "10, 20 mins" (the em/en-dash rule below treats every
  //                  dash as an aside, which is wrong between numbers)
  // The leading `(^|[^\w.])` keeps both rules out of the middle of a token:
  // without it "Qwen3-30B" is a "3 to 30" range. No lookbehind — it is a parse
  // error on older WKWebView (see the module header).
  [/(^|[^\w.])(\d+)\s*\/\s*(\d+)\b/g, "$1$2 over $3"],
  [/(^|[^\w.])(\d+)\s*[-–—]\s*(\d+)\b/g, "$1$2 to $3"],
  [/(\d)\s*\+\s*(\d)/g, "$1 plus $2"],
  [/(\d)\s*x\b/g, "$1 times"],
  // Units per unit ("MB/s", "km/h"). Both sides must be 2+ characters: a
  // single-letter pair is far more likely to be a path component ("src/m/s")
  // than a rate, and `\b` alone cannot tell them apart.
  [
    /\b(km|cm|mm|kg|mg|MB|GB|KB|TB|ms|fps|mi|ft|lb|kW|kHz|MHz|Hz|W|V)\s*\/\s*(hr|h|sec|min|day|wk|mo|yr|s|d)\b/g,
    "$1 per $2",
  ],
  // Version and issue numbers: "v0.4.2" and "#7" are spoken words, not a letter
  // and a hash. `\b` keeps "rev2" and "#ff0000" out of it.
  [/\bv(\d[\d.]*)/g, "version $1"],
  [/#(\d)/g, "number $1"],
  [/\bNo\.\s*(\d)/g, "number $1"],
  // "1.5B parameters" — the B/K/M/T convention from model cards, spoken as the
  // number it stands for. Narrow on purpose: "Qwen3-30B-A3B" and "256B of RAM"
  // are not this shape, and reading them as "billion" would be wrong.
  [
    /\b(\d+(?:\.\d+)?)\s*([BMKT])\b(?=\s+(?:parameters?|params?|tokens?|context))/g,
    (_m, num: string, unit: string) => `${num} ${UNIT_WORDS[unit] ?? unit}`,
  ],
  // "30 billion (B) parameters": the parenthesis repeats the word it follows,
  // so reading it adds a stray letter ("billion, bee, parameters"). Only the
  // matching-initial case is dropped — "grade (B)" keeps its B.
  [
    /\b([A-Za-z]+)\s*\(([A-Z])\)/g,
    (match, word: string, letter: string) =>
      word[0]?.toUpperCase() === letter ? word : match,
  ],
  // Initialisms read as letters: the engine says "llm" as a word and "MoE" as
  // "moe", where everyone who writes them says the letters.
  [
    /\(([A-Z]{2,5})\)/g,
    (_m, letters: string) => `(${letters.toUpperCase().split("").join(" ")})`,
  ],
  [
    /\b([A-Z][a-z][A-Z])(s?)\b/g,
    (_m, letters: string, plural: string) =>
      `${letters.toUpperCase().split("").join(" ")}${plural}`,
  ],
  // Symbols the engine either skips or mispronounces.
  [/→/g, " to "],
  [/←/g, " from "],
  [/≥/g, " greater than or equal to "],
  [/≤/g, " less than or equal to "],
  [/≈/g, " approximately "],
  [/≠/g, " not equal to "],
  [/±/g, " plus or minus "],
  [/÷/g, " divided by "],
  [/√/g, " square root of "],
  [/∞/g, " infinity "],
  [/×/g, " times "],
  [/°C/g, " degrees Celsius"],
  [/°F/g, " degrees Fahrenheit"],
  [/°/g, " degrees"],
  [/[µμ]/g, "micro"],
  // "~~struck out~~" is emphasis the engine would read as "approximately".
  [/~~([^~]+)~~/g, "$1"],
  [/~(\d)/g, "approximately $1"],
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
    // Split rather than passing the union to `replace`, whose two overloads do
    // not accept one.
    out = typeof replacement === "function" ? out.replace(pattern, replacement) : out.replace(pattern, replacement);
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

/** Merge sentences back into as few chunks as the budget allows.
 *
 *  This is the GPU path's whole reason for existing: a GPU call is a child
 *  process, so it pays ~4.5s of startup before it voices anything, and a call
 *  per sentence spends that on every couple of seconds of audio. `maxChars` is
 *  a budget to FILL, not a limit to split at — splitting is `splitSentences`'
 *  job, and doing only that is what left GPU reads stalling between sentences.
 *
 *  Paragraph boundaries are where the pause between paragraphs comes from, so
 *  they survive grouping — unless the paragraph so far is still shorter than
 *  `minChars`, in which case the next one joins it (a heading is not worth a
 *  process start of its own). */
export function groupSentences(
  chunks: SpeechChunk[],
  maxChars: number,
  minChars = 0,
  firstMaxChars = maxChars,
): SpeechChunk[] {
  const out: SpeechChunk[] = [];
  let group: SpeechChunk | null = null;
  for (const chunk of chunks) {
    // The first call is the one being waited on, so it gets its own (smaller)
    // budget; everything after it uses the full one.
    const budget = out.length === 0 ? firstMaxChars : maxChars;
    const startsParagraph = chunk.paragraphStart && (group?.text.length ?? 0) >= minChars;
    if (group && !startsParagraph && group.text.length + 1 + chunk.text.length <= budget) {
      group = { text: `${group.text} ${chunk.text}`, paragraphStart: group.paragraphStart };
      continue;
    }
    if (group) out.push(group);
    group = { ...chunk };
  }
  if (group) out.push(group);
  return out;
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
  /** Audio seconds per decoded sentence, keyed like `buffers`. The lead rule
   *  needs durations for sentences it has not started playing, and the decoded
   *  buffer is the only place that knows them. */
  private durations = new Map<string, number>();
  /** Synthesis calls in flight, keyed like `buffers`. The lookahead rule below
   *  awaits a chunk the prefetch already asked for, and the same chunk is
   *  re-requested every time the queue runs dry — without this, each of those
   *  was another engine call for text already being voiced, queued behind
   *  everything else, which lengthened the stall it was meant to cover. */
  private pending = new Map<string, Promise<AudioBuffer | null>>();
  private source: AudioBufferSourceNode | null = null;
  private index = 0;
  /** Resume point inside `sentences[index]`, in seconds. */
  private offset = 0;
  private startedAt = 0;
  private currentOffset = 0;
  /** Set by next()/prev() while a sentence is playing; pump applies the jump
   *  when that sentence reports back. Also set between sentences, where the
   *  pump picks it up before starting the one it was already loading. */
  private skipTarget: number | null = null;
  /** Pause asked for while nothing was sounding (a lookahead wait or a
   *  synthesis in flight): the pump stops before starting the next sentence
   *  instead of the click being dropped. */
  private pausePending = false;
  /** Settles the in-flight sentence's promise when `stopSource` cuts it short
   *  (see there for why the `onended` path cannot). */
  private settle: ((result: SentenceResult) => void) | null = null;
  private voice: string | null = null;
  private speed = 1;
  private device: string | null = null;
  /** Synthesis requests in flight (see topUp). */
  private inflight = 0;
  /** Invalidates in-flight work after stop()/replay — every async step checks
   *  it before touching the audio graph or the store. */
  private token = 0;

  /** Play `text`, replacing whatever was playing. */
  async play({ key, label, text }: PlayTextOptions): Promise<void> {
    const my = (this.token += 1);
    this.skipTarget = null;
    this.pausePending = false;
    this.inflight = 0; // a new read starts a fresh pipeline
    this.stopSource("stopped");
    const store = useTtsStore.getState();
    store.set({ key, label: label ?? null, error: null, phase: "loading", index: 0, total: 0 });

    const status = await this.resolveSettings();
    if (my !== this.token) return;
    if (!status) return;
    const sentences = splitSentences(
      markdownToSpeech(text),
      this.device === "gpu" ? GPU_CHUNK_CHARS : CPU_CHUNK_CHARS,
    );
    // CPU voices in-process, where a call costs nothing — sentence-sized chunks
    // there keep skip/prev fine-grained. GPU pays a process per call, so it
    // fills each call with as many sentences as the budget holds.
    const chunks =
      this.device === "gpu"
        ? groupSentences(sentences, GPU_CHUNK_CHARS, GPU_MIN_GROUP_CHARS, GPU_WARMUP_CHARS)
        : sentences;
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
    const ctx = sharedAudioContext();
    if (!this.source) {
      // Between sentences: the lead is being built, or the next sentence is
      // still being voiced. Nothing is sounding, so the request has to be
      // remembered for the pump rather than dropped — otherwise Pause looked
      // dead for as long as the queue was being filled, which is most of a
      // cold read's first minutes.
      const phase = useTtsStore.getState().phase;
      if (phase === "playing" || phase === "buffering") {
        this.pausePending = true;
        useTtsStore.getState().set({ phase: "paused" });
      }
      return;
    }
    // Remember the resume point BEFORE stopping: the source stops here, so
    // this is the last moment `currentTime` still describes the audio position.
    if (ctx) this.offset = this.currentOffset + (ctx.currentTime - this.startedAt);
    // Report the pause from here, not on the pump's next turn: the button must
    // flip to Resume on the click, and resume() refuses while the store still
    // says "playing".
    useTtsStore.getState().set({ phase: "paused" });
    this.stopSource("paused");
  }

  /** Stop and clear. The store returns to idle so the play button reverts. */
  stop(): void {
    this.token += 1;
    this.skipTarget = null;
    this.pausePending = false;
    this.stopSource("stopped");
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
    if (phase === "playing" || phase === "buffering") {
      // The running sentence is interrupted; pump sees `skipTarget` and lands on
      // it instead of advancing. While buffering there is nothing sounding to
      // stop — `playSentence` picks the target up before it starts the audio.
      this.skipTarget = clamped;
      // "ended", not "stopped": the pump applies the jump on its continue
      // path, so a "stopped" result here would swallow it.
      this.stopSource("ended");
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
    // The device is part of the prefix because the two paths produce different
    // bytes for the same sentence — a cached CPU buffer must never be replayed
    // as if it came from the GPU (or vice versa).
    this.cachePrefix = `${status.modelId}|${this.voice ?? ""}|${this.speed}|${status.device}`;
    return status;
  }

  /** Stop the running sentence and settle the promise `pump` is awaiting.
   *
   *  The `onended` handler is detached before the stop — a handler left on a
   *  cancelled source would race the decision already taken here — so the
   *  promise has to be resolved explicitly. Leaving it pending parked `pump`
   *  at its `await` forever: pause never reached the store's "paused" phase
   *  (so the bar kept offering Pause and a second click was a no-op), and
   *  next/prev stopped the audio without ever advancing to the target. */
  private stopSource(result: SentenceResult): void {
    const src = this.source;
    this.source = null;
    const settle = this.settle;
    if (src) {
      src.onended = null;
      try {
        src.stop();
      } catch {
        /* never started, or already stopped */
      }
    }
    // `settle` clears the slot itself — that is how it claims the resolution.
    // Clearing it here first made the claim fail, so the promise stayed
    // pending and this whole fix did nothing.
    settle?.(result);
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
    // The chunk about to be PLAYED is requested before the lookahead: the
    // backend voices one chunk at a time behind a single engine lock, so
    // issuing the prefetch first put the sentence the user is waiting for at
    // the BACK of that queue — behind everything the lookahead asked for.
    const buffer = await this.bufferFor(ctx, index);
    if (my !== this.token) return "stopped";
    if (!buffer) {
      // One failed sentence must not kill the whole read — report it and move
      // on to the next.
      useTtsStore.getState().set({ error: "Could not synthesize part of this text" });
      return "ended";
    }
    this.topUp(ctx, index);
    await this.awaitLead(my, ctx, index, buffer);
    if (my !== this.token) return "stopped";
    // A next/prev/pause that arrived while this chunk was being fetched or
    // waited on: report it instead of starting audio the user has moved past.
    // "ended" hands the skip to the pump, which is the only place that applies
    // it; pausePending is consumed here because the pump would re-enter with it.
    if (this.skipTarget != null) return "ended";
    if (this.pausePending) {
      this.pausePending = false;
      return "paused";
    }
    useTtsStore.getState().set({ phase: "playing", index: index + 1, error: null });
    return this.startSource(ctx, buffer, this.offset);
  }

  /** Seconds of decoded audio from `index` on: the contiguous run of buffered
   *  sentences starting at the playhead. Contiguous is the whole point — a
   *  sentence already voiced five chunks ahead is no use to playback arriving
   *  at a hole now. */
  private leadSecs(index: number, current: AudioBuffer): number {
    let secs = Math.max(current.duration - this.offset, 0);
    for (let j = index + 1; j < this.chunks.length; j += 1) {
      const text = this.chunks[j]?.text;
      const buffered = text ? this.durations.get(`${this.cachePrefix}|${text}`) : undefined;
      if (buffered == null) break;
      secs += buffered;
    }
    return secs;
  }

  /** Build the queue before a sentence starts, one sentence at a time so the
   *  first word arrives as soon as the lead is met rather than after the whole
   *  text is voiced. A replay is served from the engine's cache, so this costs
   *  a few IPC hops and nothing else — which is why the first read of a text is
   *  the one the lead exists for. */
  private async awaitLead(my: number, ctx: AudioContext, index: number, buffer: AudioBuffer): Promise<void> {
    const target = index === 0 ? LEAD_SECS : LEAD_FLOOR_SECS;
    let lead = this.leadSecs(index, buffer);
    if (lead >= target) return;
    // A wait the listener can see coming: the bar reports `buffering` rather
    // than pretending a silent read is a playing one.
    useTtsStore.getState().set({ phase: "buffering" });
    for (let j = index + 1; j < this.chunks.length && lead < target; j += 1) {
      // Superseded (a replay, a stop): stop asking for sentences of a read
      // nobody is listening to — the engine is serial, so those requests would
      // sit in front of the new read's first word.
      if (my !== this.token) return;
      const next = await this.bufferFor(ctx, j);
      // A sentence that failed to voice is the pump's to report; waiting on it
      // here would hold the whole read hostage to one bad chunk.
      if (!next) return;
      lead += next.duration;
    }
  }

  /** Keep the engine working on what comes AFTER the playhead — all the way to
   *  the end of the text, one call at a time.
   *
   *  A cap here is what broke GPU reads: the queue was filled to "a couple of
   *  paragraphs ahead" and then left alone, which on an engine whose chunk IS a
   *  paragraph meant the target was met by the chunk already playing, the next
   *  one was never requested, and the engine idled through the whole paragraph.
   *  Playback then hit the boundary, the call started from cold, and the read
   *  waited. There is no useful stopping point: whatever is left unvoiced is
   *  audio the reader may reach, so the walk runs to the end and the cached
   *  chunks make every later read of the same text instant. */
  private topUp(ctx: AudioContext, index: number): void {
    const my = this.token;
    for (let j = index + 1; j < this.chunks.length; j += 1) {
      if (this.inflight >= MAX_INFLIGHT) return;
      const text = this.chunks[j]?.text;
      if (!text) return;
      const key = `${this.cachePrefix}|${text}`;
      // Voiced already, or being voiced right now — either way this walk is not
      // the thing that will make it ready, so it moves on.
      if (this.buffers.has(key) || this.pending.has(key)) continue;
      this.inflight += 1;
      void this.bufferForText(ctx, text).finally(() => {
        // A stalled request must not leave the counter stuck above zero: a new
        // read resets it, and the decrement cannot go negative.
        this.inflight = Math.max(0, this.inflight - 1);
        // Only while the read is live: a paused or stopped read should not keep
        // grinding through the rest of the artifact.
        if (my !== this.token) return;
        const phase = useTtsStore.getState().phase;
        if (phase === "playing" || phase === "buffering") this.topUp(ctx, this.index);
      });
    }
  }

  /** Decoded audio for one sentence — from the in-memory cache, else the
   *  backend (which has its own disk cache, so a replay is a fast IPC hop).
   *  Concurrent asks for the same sentence share one synthesis. */
  private bufferFor(ctx: AudioContext, index: number): Promise<AudioBuffer | null> {
    return this.bufferForText(ctx, this.chunks[index]?.text);
  }

  /** The same, keyed by the sentence itself — what the background pipeline holds
   *  in flight, which knows the text but not where it sits in the queue. */
  private bufferForText(ctx: AudioContext, text: string | undefined): Promise<AudioBuffer | null> {
    if (!text) return Promise.resolve(null);
    const key = `${this.cachePrefix}|${text}`;
    const hit = this.buffers.get(key);
    if (hit) return Promise.resolve(hit);
    const inFlight = this.pending.get(key);
    if (inFlight) return inFlight;
    const job = this.fetchBuffer(ctx, key, text).finally(() => {
      this.pending.delete(key);
    });
    this.pending.set(key, job);
    // The lead rule reads durations by text, so record one as soon as a
    // sentence is decoded — including for chunks the prefetch raced ahead on.
    void job.then((decoded) => {
      if (decoded) this.durations.set(key, decoded.duration);
      return undefined;
    });
    return job;
  }

  private async fetchBuffer(
    ctx: AudioContext,
    key: string,
    text: string,
  ): Promise<AudioBuffer | null> {
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
    for (const key of keys.slice(0, keys.length - 100)) {
      this.buffers.delete(key);
      this.durations.delete(key);
    }
  }

  /** Start one buffer and resolve when it finishes, pauses, or is stopped.
   *
   *  Exactly one of the two paths resolves: a natural end through `onended`, or
   *  an interruption (pause / skip / stop / replay) through `stopSource`, which
   *  claims `this.settle` first. Whoever claims it wins — that is what keeps an
   *  `ended` event queued behind a pause from overwriting the pause. */
  private startSource(ctx: AudioContext, buffer: AudioBuffer, offset: number): Promise<SentenceResult> {
    return new Promise<SentenceResult>((resolve) => {
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(ctx.destination);
      const startAt = Math.min(Math.max(offset, 0), Math.max(buffer.duration - 0.02, 0));
      const done = (result: SentenceResult) => {
        if (this.settle !== done) return;
        this.settle = null;
        resolve(result);
      };
      src.onended = () => {
        if (this.source === src) this.source = null;
        done("ended");
      };
      this.settle = done;
      this.source = src;
      this.startedAt = ctx.currentTime;
      this.currentOffset = startAt;
      try {
        src.start(0, startAt);
      } catch (err) {
        console.warn("[relay] TTS playback failed", err);
        this.source = null;
        done("ended");
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
