// Streaming read-aloud feeder — decides WHICH parts of a still-generating
// answer are safe to voice NOW.
//
// The chat store hands over the raw accumulating stream (think blocks, tool
// markers and all); this class answers one question per push: "given the text
// so far, what should be voiced that hasn't been?"
//
// Two phases:
//
//  · OPENER — until the first chunk is out, time-to-first-audio is the only
//    thing that matters. The opening words are cut at a clause/space boundary
//    and voiced the MOMENT enough text exists, mid-sentence by design: the
//    listener hears the answer begin while the model is still writing it.
//  · STEADY — after the opener, complete sentences only. Everything is
//    recomputed from the full accumulated tail on each push, so it needs no
//    delta bookkeeping: `splitSentences` is deterministic and prefix-stable —
//    a sentence that was complete last push is byte-identical this push. The
//    one deliberately-unstable item, the trailing fragment (no terminator
//    yet), is held back until its terminator arrives or flush() runs at
//    stream end. Feeding it early would voice half a word whenever a token
//    crossed a sentence boundary mid-split.
import { parseSegments } from "./segments";
import { markdownToSpeech, splitSentences, type SpeechChunk } from "./tts";

/** An opener shorter than this sounds clipped — a couple of words that end
 *  before the engine's cadence establishes itself. */
const OPEN_MIN_CHARS = 24;
/** Beyond this, any boundary will do — the opener must not become the thing
 *  the first word waits on. */
const OPEN_MAX_CHARS = 110;

/** Where to cut the opener: the LATEST clause boundary in the window (best
 *  prosody), else the latest space, else — only for an unbroken run — a hard
 *  cut at the cap. 0 = not enough text yet, keep waiting. */
function openerCut(speech: string): number {
  if (speech.length < OPEN_MIN_CHARS) return 0;
  const window = speech.slice(0, OPEN_MAX_CHARS);
  const clauses: number[] = [];
  for (const sep of [", ", ": ", "; ", " — ", "，", "、", "："]) {
    const at = window.lastIndexOf(sep);
    if (at !== -1) clauses.push(at + sep.length);
  }
  const clause = clauses.length > 0 ? Math.max(...clauses) : -1;
  if (clause >= OPEN_MIN_CHARS) return clause;
  const space = window.lastIndexOf(" ");
  if (space + 1 >= OPEN_MIN_CHARS) return space + 1;
  if (speech.length >= OPEN_MAX_CHARS) return OPEN_MAX_CHARS;
  return 0;
}

export class StreamingSpeechFeeder {
  private openerEnd = -1;
  private openerChunks = 0;
  private chunks: SpeechChunk[] = [];
  private fed = 0;

  /** Latest full streaming text. Returns the chunks newly ready to voice
   *  (possibly empty — a stream can go a long time without completing a
   *  sentence, and a tool-only stream never produces any). */
  push(raw: string): SpeechChunk[] {
    // Same prose extraction as the turn-final read: think blocks and tool
    // markup must never be voiced. parseSegments is safe on partial content —
    // an unterminated block swallows the rest instead of leaking it as text.
    const prose = parseSegments(raw)
      .filter((segment): segment is Extract<typeof segment, { type: "text" }> => segment.type === "text")
      .map((segment) => segment.text)
      .join("");
    const speech = markdownToSpeech(prose);

    if (this.openerEnd < 0) {
      const cut = openerCut(speech);
      if (cut <= 0) return [];
      this.openerEnd = cut;
      const opener = splitSentences(speech.slice(0, cut));
      this.openerChunks = opener.length;
      // Prime the tail too — the remainder of the cut sentence is ordinary
      // steady-state material from here on, and a flush() right after this
      // push (stream ended immediately) must still see it.
      this.chunks = splitSentences(speech.slice(cut));
      this.fed = 0;
      return [...opener, ...this.steadyTake(speech)];
    }

    // Steady state: sentences of the text past the opener. The tail's first
    // "sentence" is the remainder of the sentence the opener cut — it voices
    // once its terminator arrives, like any other.
    this.chunks = splitSentences(speech.slice(this.openerEnd));
    return this.steadyTake(speech);
  }

  /** The stream is over — voice whatever remains, fragment included. */
  flush(): SpeechChunk[] {
    return this.take(this.chunks.length);
  }

  /** Chunks handed out so far (zero means nothing was ever voiced — the
   *  turn-final auto-read may then still want a go). */
  get fedCount(): number {
    return this.fed + this.openerChunks;
  }

  /** Feed complete sentences of the current tail. The trailing chunk is held
   *  back only while it can still grow — i.e. the text does not end on a
   *  terminator. Position alone is wrong: the moment a fragment's period
   *  arrives it is STILL the last chunk, and a plain length-1 hold would keep
   *  withholding it (and every sentence after it) forever. */
  private steadyTake(speech: string): SpeechChunk[] {
    const terminated = /[.!?…。！？]["')\]”’]?\s*$/.test(speech.trim());
    return this.take(terminated ? this.chunks.length : Math.max(0, this.chunks.length - 1));
  }

  private take(end: number): SpeechChunk[] {
    if (end <= this.fed) return [];
    const out = this.chunks.slice(this.fed, end);
    this.fed = end;
    return out;
  }
}
