// Tests for read-aloud text preparation. These exist because the failures they
// cover are only audible: a manglemd identifier or a missing paragraph pause is
// obvious when listening and invisible when reading the rendered answer.
import { describe, expect, it } from "vitest";
import { groupSentences, markdownToSpeech, splitSentences } from "../lib/tts";

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

// The engine reads punctuation literally, so anything numeric written the way
// documents write it arrives as "slash", "dash" or nothing at all. These are
// the shapes a technical doc actually contains.
describe("markdownToSpeech — numbers and symbols", () => {
  it("reads a fraction as 'over', not 'slash'", () => {
    expect(markdownToSpeech("Use 1/4 of the memory.")).toContain("1 over 4");
    expect(markdownToSpeech("3 / 4 done")).toContain("3 over 4");
  });

  it("reads a numeric range as 'to'", () => {
    expect(markdownToSpeech("Between 10-20 minutes.")).toContain("10 to 20");
    expect(markdownToSpeech("24–48 hours")).toContain("24 to 48");
    expect(markdownToSpeech("3—5 retries")).toContain("3 to 5");
    // A non-numeric dash is still the aside beat, not a range.
    expect(markdownToSpeech("a lock — the mutex — is held")).toContain("lock, the mutex, is held");
  });

  it("reads a rate as 'per unit' but leaves paths alone", () => {
    expect(markdownToSpeech("It writes 50 MB/s")).toContain("MB per s");
    expect(markdownToSpeech("about 90 km/h")).toContain("km per h");
    // Single letters are a path (or an abbreviation), not a rate.
    expect(markdownToSpeech("see src/m/s for the file")).toContain("src/m/s");
  });

  it("speaks a date instead of splicing it into ranges", () => {
    expect(markdownToSpeech("Shipped 2026-09-11.")).toContain("September 11, 2026");
  });

  it("speaks version and issue markers", () => {
    expect(markdownToSpeech("Relay v0.4.2 is out.")).toContain("version 0.4.2");
    expect(markdownToSpeech("See issue #42.")).toContain("number 42");
    expect(markdownToSpeech("No. 7 of the list.")).toContain("number 7");
    // A hex colour is not an issue number.
    expect(markdownToSpeech("colour #ff0000 here")).toContain("#ff0000");
  });

  it("says the maths symbols out loud", () => {
    expect(markdownToSpeech("x ± 2")).toContain("plus or minus");
    expect(markdownToSpeech("a ≠ b")).toContain("not equal to");
    expect(markdownToSpeech("√16 is 4")).toContain("square root of");
    expect(markdownToSpeech("8 ÷ 2")).toContain("divided by");
    expect(markdownToSpeech("2 + 3")).toContain("2 plus 3");
    expect(markdownToSpeech("10x faster")).toContain("10 times faster");
  });

  it("speaks degrees and micro", () => {
    expect(markdownToSpeech("Heat to 180°C.")).toContain("180 degrees Celsius");
    expect(markdownToSpeech("A 45° turn")).toContain("45 degrees turn");
    expect(markdownToSpeech("takes 200µs")).toContain("200micros");
  });

  it("keeps struck-out text but drops the strikethrough markers", () => {
    const out = markdownToSpeech("~~old~~ new");
    expect(out).toContain("old");
    expect(out).not.toContain("approximately");
  });

  it("reads a leading tilde as 'approximately' only before a number", () => {
    expect(markdownToSpeech("~50 requests")).toContain("approximately 50");
    expect(markdownToSpeech("edit ~/config/app.toml")).toContain("~/config");
  });

  it("expands a parameter-count suffix", () => {
    expect(markdownToSpeech("a 1.5B parameter model")).toContain("1.5 billion parameter");
    expect(markdownToSpeech("8M tokens of context")).toContain("8 million tokens");
    expect(markdownToSpeech("128K context")).toContain("128 thousand context");
    // Not a parameter count — a model name and a byte size must not be turned
    // into a number ("Qwen3-30B" is a name, and the hyphen is not a range).
    const model = markdownToSpeech("Qwen3-30B-A3B is out");
    expect(model).not.toContain("billion");
    expect(model).not.toContain("Qwen3 to 30");
    expect(markdownToSpeech("256B of RAM")).not.toContain("billion");
  });

  it("drops a parenthetical that just respells the word before it", () => {
    const out = markdownToSpeech("Qwen3 is a 30 billion (B) parameter MoE model.");
    expect(out).toContain("30 billion parameter");
    expect(out).not.toContain("(B)");
    // The initial does not match, so this parenthesis still carries meaning.
    expect(markdownToSpeech("his grade (B) was fine")).toContain("(B)");
  });

  it("speaks initialisms as letters", () => {
    expect(markdownToSpeech("a Mixture of Experts (MoE) model")).toContain("(M O E)");
    expect(markdownToSpeech("the MoE runs locally")).toContain("M O E runs");
    expect(markdownToSpeech("two MoEs")).toContain("M O Es");
    expect(markdownToSpeech("an LLM (LLM) call")).toContain("(L L M)");
    // A word with an inner capital is NOT spelled out — this is the case a
    // rule cannot decide, so it must not guess. (The identifier pass may still
    // space its humps, which is harmless: "Lo RA" says the same word.)
    expect(markdownToSpeech("LoRA adapters")).not.toContain("L O R");
  });
});

// Artifacts (decks, PDFs, docs) are read aloud with the same pipeline, and
// they are full of quotation marks, date abbreviations and decoration the
// engine reads as clicks and stray syllables.
describe("markdownToSpeech — quotes, abbreviations and decoration", () => {
  it("drops quotation marks but keeps the quoted words", () => {
    const out = markdownToSpeech('She said “hello world” and a "straight" one.');
    expect(out).toContain("hello world");
    expect(out).toContain("a straight one");
    expect(out).not.toContain("“");
    expect(out).not.toContain('"');
  });

  it("keeps apostrophes as apostrophes", () => {
    expect(markdownToSpeech("don’t stop")).toContain("don't stop");
    expect(markdownToSpeech("it's fine")).toContain("it's fine");
  });

  it("expands month abbreviations, including before a dotted date", () => {
    expect(markdownToSpeech("Ships Sep 13, 2026.")).toContain("September 13, 2026");
    expect(markdownToSpeech("In Oct. 2026 we ship.")).toContain("In October 2026 we ship");
    expect(markdownToSpeech("done in Sept")).toContain("September");
  });

  it("leaves full month names — and the word May — alone", () => {
    expect(markdownToSpeech("In May it rains.")).toBe("In May it rains.");
    expect(markdownToSpeech("September was busy.")).toBe("September was busy.");
  });

  it("expands weekday abbreviations; Sat/Sun only in a date", () => {
    expect(markdownToSpeech("Kickoff Wed 14 Sep")).toContain("Wednesday 14 September");
    expect(markdownToSpeech("Review Fri.")).toContain("Review Friday.");
    expect(markdownToSpeech("Due Sat 21")).toContain("Saturday 21");
    // The words, not the weekdays.
    expect(markdownToSpeech("The Sun rises.")).toBe("The Sun rises.");
  });

  it("spells number-attached units out", () => {
    expect(markdownToSpeech("a 200 ms delay")).toContain("200 milliseconds");
    expect(markdownToSpeech("needs 5 mins")).toContain("5 minutes");
    expect(markdownToSpeech("64 GB of RAM")).toContain("64 gigabytes of RAM");
  });

  it("voices currency as the amount plus the unit", () => {
    expect(markdownToSpeech("€5 per user")).toContain("5 euros");
    expect(markdownToSpeech("costs £3")).toContain("3 pounds");
  });

  it("reads comparison operators between words or numbers", () => {
    expect(markdownToSpeech("when 5 < 6")).toContain("5 less than 6");
    expect(markdownToSpeech("count > 3")).toContain("count greater than 3");
    expect(markdownToSpeech("x = 5")).toContain("x equals 5");
    expect(markdownToSpeech("a -> b")).toContain("a to b");
    expect(markdownToSpeech("written in C++")).toContain("C plus plus");
  });

  it("drops html tags and entities but keeps their text", () => {
    const out = markdownToSpeech("a <b>bold</b> move");
    expect(out).toContain("bold");
    expect(out).not.toContain("<b>");
    expect(markdownToSpeech("A &amp; B")).toContain("and");
    expect(markdownToSpeech("A &amp; B")).not.toContain("amp");
  });

  it("reads deck slide headers as labels, not dashes", () => {
    const out = markdownToSpeech("--- Slide 2 ---\nQuarterly numbers");
    expect(out).toContain("Slide 2.");
    expect(out).not.toContain("---");
  });

  it("expands honorifics and handles", () => {
    expect(markdownToSpeech("Ask Dr. Chen")).toContain("Doctor Chen");
    expect(markdownToSpeech("ping @sabbir")).toContain("at sabbir");
  });

  it("turns decoration into words or silence", () => {
    expect(markdownToSpeech("© 2026 ACME")).toContain("copyright 2026");
    expect(markdownToSpeech("see § 2.1")).toContain("section 2.1");
    expect(markdownToSpeech("Wait… more")).toContain("Wait, more");
    expect(markdownToSpeech("Done 🎉")).toBe("Done");
  });

  it("never reads a markdown blockquote marker as 'greater than'", () => {
    const out = markdownToSpeech("> quoted line");
    expect(out).toContain("quoted line");
    expect(out).not.toContain("greater than");
  });
});

// GPU synthesis is a child process per call (~4.5s of startup), so the chunk
// budget there is a target to fill rather than a limit to split at. Splitting
// only — which is all `splitSentences` does — left a process start per
// sentence, which is what "it buffers on every sentence" was.
describe("groupSentences", () => {
  it("fills the budget with as many sentences as fit", () => {
    const sentences = splitSentences("One two. Three four. Five six.");
    const grouped = groupSentences(sentences, 26, 0);
    // "One two. Three four." is 21 characters — the next sentence would not fit.
    expect(grouped).toHaveLength(2);
    expect(grouped[0].text).toBe("One two. Three four.");
    expect(grouped[1].text).toBe("Five six.");
  });

  it("keeps the paragraph boundary so the pause between paragraphs survives", () => {
    const sentences = splitSentences("Alpha one. Alpha two.\n\nBeta one. Beta two.");
    const grouped = groupSentences(sentences, 1000, 0);
    expect(grouped).toHaveLength(2);
    expect(grouped.map((c) => c.paragraphStart)).toEqual([false, true]);
  });

  it("folds a too-short paragraph into the next one", () => {
    const sentences = splitSentences("Benchmarks.\n\nIt ran far faster than before.");
    const grouped = groupSentences(sentences, 1000, 200);
    // A heading is not worth 4.5s of process start on its own.
    expect(grouped).toHaveLength(1);
    expect(grouped[0].text).toBe("Benchmarks. It ran far faster than before.");
  });

  it("never exceeds the budget", () => {
    const sentences = splitSentences("Alpha one. Bravo two. Charlie three. Delta four.", 10);
    const grouped = groupSentences(sentences, 20, 0);
    for (const chunk of grouped) expect(chunk.text.length).toBeLessThanOrEqual(20);
  });
});

// The shapes users actually complained the reader mangles: glued durations,
// dollar magnitudes, clock times, model-format acronyms, and research
// citations.
describe("markdownToSpeech — durations, money, times and citations", () => {
  it("speaks abbreviated durations as the words they stand for", () => {
    expect(markdownToSpeech("it ships in 4d")).toContain("4 days");
    expect(markdownToSpeech("done in 4days")).toContain("4 days");
    expect(markdownToSpeech("over 2wks")).toContain("2 weeks");
    expect(markdownToSpeech("3mo ago")).toContain("3 months");
    expect(markdownToSpeech("a 1yr warranty")).toContain("1 year");
    expect(markdownToSpeech("waited 6h")).toContain("6 hours");
    expect(markdownToSpeech("about 45s")).toContain("45 seconds");
  });

  it("does not mistake decades, watts or approximations for durations", () => {
    expect(markdownToSpeech("the 1990s style")).toContain("the 1990s");
    expect(markdownToSpeech("a 10W charger")).not.toContain("10 weeks");
    expect(markdownToSpeech("100s of pages")).toContain("100s of");
    // Whole words are already readable — just unglue them.
    expect(markdownToSpeech("in 4days time")).toContain("4 days");
  });

  it("speaks dollar magnitudes and per-token pricing", () => {
    expect(markdownToSpeech("raised $5M")).toContain("5 million dollars");
    expect(markdownToSpeech("a $1.5B deal")).toContain("1.5 billion dollars");
    expect(markdownToSpeech("it costs $3/M")).toContain("3 dollars per million");
    expect(markdownToSpeech("priced at $0.5/K")).toContain("0.5 dollars per thousand");
    expect(markdownToSpeech("$5M/yr contract")).toContain("dollars per year");
  });

  it("speaks clock times instead of raw digit runs", () => {
    expect(markdownToSpeech("starts at 04:00")).toContain("4 o'clock");
    expect(markdownToSpeech("from 04:00 to 04:30")).toContain("4 o'clock");
    expect(markdownToSpeech("the 14:30 train")).toContain("14 30");
    expect(markdownToSpeech("lands 09:05 am")).toContain("9 5 a m");
    // Ratios and durations with seconds stay untouched.
    expect(markdownToSpeech("a 16:9 image")).toContain("16:9");
    expect(markdownToSpeech("length 04:00:12")).toContain("04:00:12");
  });

  it("spells out model formats and size codes", () => {
    expect(markdownToSpeech("exported to gguf")).toContain("G G U F");
    expect(markdownToSpeech("a GGML model")).toContain("G G M L");
    expect(markdownToSpeech("the XXS quant")).toContain("extra extra small");
    expect(markdownToSpeech("size XS")).toContain("extra small");
  });

  it("voices citation markers as sources", () => {
    expect(markdownToSpeech("The benchmark confirms it [3].")).toContain("source 3");
    expect(markdownToSpeech("Two teams agree [1,2].")).toContain("sources 1,2");
    // A markdown link keeps its label; an array index is not a citation.
    const link = markdownToSpeech("see [1](https://x.io/a) there");
    expect(link).toContain("1 there");
    expect(markdownToSpeech("copy a[1] over")).not.toContain("source");
  });

  it("gives headings and pseudo-headers a spoken beat", () => {
    // The blank line after a heading is what the splitter turns into a
    // paragraph pause — a bare newline left the header glued to the body.
    expect(markdownToSpeech("## Sources\n\nFirst entry.")).toContain("Sources.\n\n");
    expect(markdownToSpeech("**Overview**\n\nBody text.")).toContain("Overview.\n\n");
    expect(markdownToSpeech("Sources:\n\nFirst entry.")).toContain("Sources.\n\n");
    // A "key: value" line is content, not a header.
    expect(markdownToSpeech("status: ok")).toContain("status: ok");
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
