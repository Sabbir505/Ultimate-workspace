import { describe, expect, it } from "vitest";
import { fuzzyFilter, fuzzyScore } from "../lib/fuzzy";

describe("fuzzyScore", () => {
  it("matches subsequence case-insensitively", () => {
    expect(fuzzyScore("auth", "Auth Refactor")).not.toBeNull();
    expect(fuzzyScore("AR", "auth refactor")).not.toBeNull();
  });

  it("returns null when the query is not a subsequence", () => {
    expect(fuzzyScore("xyz", "auth refactor")).toBeNull();
    expect(fuzzyScore("autz", "auth refactor")).toBeNull();
  });

  it("returns null when query is longer than target", () => {
    expect(fuzzyScore("abcdefgh", "abc")).toBeNull();
  });

  it("empty query matches everything with score 0", () => {
    expect(fuzzyScore("", "anything")).toEqual({ score: 0, matches: [] });
  });

  it("prefers matches at word boundaries", () => {
    const boundary = fuzzyScore("ref", "auth refactor")!;
    const midWord = fuzzyScore("ref", "arefreshing")!;
    expect(boundary.score).toBeGreaterThan(midWord.score);
  });

  it("prefers consecutive matches over scattered ones", () => {
    const consecutive = fuzzyScore("abc", "abc x y z")!;
    const scattered = fuzzyScore("abc", "a x b x c x")!;
    expect(consecutive.score).toBeGreaterThan(scattered.score);
  });

  it("prefers shorter targets for the same match", () => {
    const short = fuzzyScore("fix", "fix")!;
    const long = fuzzyScore("fix", "fix the database pool leak please")!;
    expect(short.score).toBeGreaterThan(long.score);
  });

  it("records matched character indices", () => {
    const res = fuzzyScore("ab", "xab")!;
    expect(res.matches).toEqual([1, 2]);
  });
});

describe("fuzzyFilter", () => {
  const items = ["auth refactor", "fix DB pool leak", "backtester sweep", "db migration"];

  it("ranks better matches first", () => {
    const ranked = fuzzyFilter("db", items, (x) => x);
    expect(ranked.length).toBe(2);
    // "db migration" hits at a word boundary at index 0; "fix DB pool leak" mid-string.
    expect(ranked[0].item).toBe("db migration");
  });

  it("filters out non-matches", () => {
    const ranked = fuzzyFilter("sweep", items, (x) => x);
    expect(ranked.map((r) => r.item)).toEqual(["backtester sweep"]);
  });

  it("respects the limit", () => {
    const ranked = fuzzyFilter("a", items, (x) => x, 2);
    expect(ranked.length).toBe(2);
  });
});
