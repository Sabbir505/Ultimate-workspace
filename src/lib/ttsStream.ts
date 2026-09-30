// Streaming read-aloud feeder — decides WHICH parts of a still-generating
// answer are safe to voice NOW.
//
// The chat store hands over the raw accumulating stream (think blocks, tool
// markers and all); this class answers one question per push: "given the text
// so far, which complete sentences have never been fed?" Everything here is
// pure and recomputed from the full accumulated text, so it needs no delta
// bookkeeping: `splitSentences` is deterministic and prefix-stable — a
// sentence that was complete last push is byte-identical this push. The one
// deliberately-unstable item, the trailing fragment (no terminator yet), is
// held back every push until either its terminator arrives or flush() runs at
// stream end. Feeding it early would voice half a word whenever a token
// crossed a sentence boundary mid-split.
import { parseSegments } from "./segments";
import { markdownToSpeech, splitSentences, type SpeechChunk } from "./tts";

export class StreamingSpeechFeeder {
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
    this.chunks = splitSentences(speech);
    // Hold back the trailing chunk only while it can still grow — i.e. the
    // text does not end on a terminator. Position alone is wrong: the moment
    // a fragment's period arrives it is STILL the last chunk, and a plain
    // length-1 hold would keep withholding it (and every sentence after it)
    // forever.
    const terminated = /[.!?…。！？]["')\]”’]?\s*$/.test(speech.trim());
    return this.take(terminated ? this.chunks.length : Math.max(0, this.chunks.length - 1));
  }

  /** The stream is over — voice whatever remains, fragment included. */
  flush(): SpeechChunk[] {
    return this.take(this.chunks.length);
  }

  /** Chunks handed out so far (zero means nothing was ever voiced — the
   *  turn-final auto-read may then still want a go). */
  get fedCount(): number {
    return this.fed;
  }

  private take(end: number): SpeechChunk[] {
    if (end <= this.fed) return [];
    const out = this.chunks.slice(this.fed, end);
    this.fed = end;
    return out;
  }
}
