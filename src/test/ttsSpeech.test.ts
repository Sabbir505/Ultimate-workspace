// Tests for read-aloud text preparation. These exist because the failures they
// cover are only audible: a manglemd identifier or a missing paragraph pause is
// obvious when listening and invisible when reading the rendered answer.
import { describe, expect, it } from "vitest";
import { markdownToSpeech, splitSentences } from "../lib/tts";

describe("markdownToSpeech", () => {
  it("drops fenced code, which would otherwise be spelled out", () => {
    const out = markdownToSpeech("Before.\n\n```ts\nconst x = 1;\n```\n\nAfter.");
    expect(out).not.toContain("const x");
    expect(out).toContain("Before.");
    expect(out).toContain("After.");
  });

  it("keeps the blank line between paragraphs so the splitter can see the break", () => {
    const out = markdownToSpeech("First para.\n\nSecond para.");
    expect(out).toContain("\n\n");
  });

  it("expands the latin abbreviations that would be spelled out letter by letter", () => {
    expect(markdownToSpeech("Use a lock, e.g. a mutex.")).toContain("for example, a mutex");
    expect(markdownToSpeech("The fast path, i.e. the cache.")).toContain("that is, the cache");
    expect(markdownToSpeech("a, b, etc.")).toContain("et cetera");
  });

  it("says symbols rather than skipping them", () => {
    expect(markdownToSpeech("A → B")).toContain("A to B");
    expect(markdownToSpeech("cpu & gpu")).toContain("and");
    expect(markdownToSpeech("50% faster")).toContain("50 percent faster");
  });

  it("splits identifiers so they are pronounceable", () => {
    expect(markdownToSpeech("See MessageBubble.tsx now.")).toContain("Message Bubble");
    expect(markdownToSpeech("the max_sentence_chars limit")).toContain("max sentence chars");
    expect(markdownToSpeech("MAX_CODE_BLOCK_BYTES")).toContain("MAX CODE BLOCK BYTES");
  });

  it("leaves ordinary prose alone", () => {
    // The identifier pass keys on an interior capital, so plain words are safe.
    const prose = "The quick brown fox jumps over the lazy dog.";
    expect(markdownToSpeech(prose)).toBe(prose);
  });

  it("keeps link text and drops the URL", () => {
    const out = markdownToSpeech("See [the docs](https://example.com/a/b) for more.");
    expect(out).toContain("the docs");
    expect(out).not.toContain("example.com");
  });

  it("ends a heading with a full stop so body text does not run on", () => {
    const out = markdownToSpeech("## Setup\n\nInstall it.");
    expect(out).toContain("Setup.");
  });
});

describe("splitSentences", () => {
  it("does NOT break on a semicolon or comma — those are breaths, not ends", () => {
    // Splitting here would insert a full stop's silence mid-thought, which is
    // exactly the "doesn't know where to pause" complaint.
    const chunks = splitSentences("First clause; second clause, still going. Then done.");
    expect(chunks).toHaveLength(2);
    expect(chunks[0].text).toBe("First clause; second clause, still going.");
  });

  it("breaks on the strong terminators, latin and CJK", () => {
    expect(splitSentences("One. Two! Three?").map((c) => c.text)).toEqual([
      "One.",
      "Two!",
      "Three?",
    ]);
    expect(splitSentences("第一句。第二句！")).toHaveLength(2);
  });

  it("marks the first sentence of a new paragraph", () => {
    const chunks = splitSentences("Alpha one. Alpha two.\n\nBeta one.");
    expect(chunks.map((c) => c.paragraphStart)).toEqual([false, false, true]);
  });

  it("hard-wraps an over-long sentence at a clause boundary", () => {
    const long = `${"word ".repeat(80)}end.`;
    const chunks = splitSentences(long, 120);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.text.length).toBeLessThanOrEqual(120);
  });

  it("returns nothing for empty input", () => {
    expect(splitSentences("")).toEqual([]);
    expect(splitSentences("   \n  ")).toEqual([]);
  });
});
