// Cursor-aware slash/@-menu detection (ChatComposer.tokenAtCaret).
//
// Regression: the popups only opened while the ENTIRE draft was the partial
// token (`/^\/(\S*)$/`), so "/" invocation worked only at position 0. The
// token now resolves from the caret instead, and text before/after the token
// survives a pick. The marker must START a word (line start or after
// whitespace) so URLs and paths never open the menu.
import { describe, expect, it } from "vitest";
import { tokenAtCaret } from "../components/chat/ChatComposer";

describe("tokenAtCaret", () => {
  it("finds a bare leading token (legacy position-0 behavior)", () => {
    expect(tokenAtCaret("/ski", 4, "/")).toEqual({ query: "ski", start: 0, end: 4 });
    expect(tokenAtCaret("/", 1, "/")).toEqual({ query: "", start: 0, end: 1 });
  });

  it("finds a token mid-sentence at the caret", () => {
    // "explain this /ski" — caret at the end.
    expect(tokenAtCaret("explain this /ski", 17, "/")).toEqual({
      query: "ski",
      start: 13,
      end: 17,
    });
  });

  it("ignores the token when the caret is elsewhere", () => {
    // Caret before the "/" — no token under it.
    expect(tokenAtCaret("explain this /ski", 4, "/")).toBeNull();
  });

  it("keeps the query partial while typing, ends at the caret", () => {
    expect(tokenAtCaret("run /doc", 8, "/")).toEqual({ query: "doc", start: 4, end: 8 });
    // Caret parked mid-token: only the part before the caret counts.
    expect(tokenAtCaret("run /docs", 7, "/")).toEqual({ query: "do", start: 4, end: 7 });
  });

  it("stops at whitespace — a sentence with spaces has no token", () => {
    expect(tokenAtCaret("/skill did a thing", 18, "/")).toBeNull();
    expect(tokenAtCaret("hello /world how are you", 24, "/")).toBeNull();
  });

  it("requires the marker to start a word (paths and URLs never match)", () => {
    expect(tokenAtCaret("see a/doc file", 10, "/")).toBeNull();
    expect(tokenAtCaret("https://example.com/a", 21, "/")).toBeNull();
  });

  it("handles newlines as word boundaries", () => {
    const text = "first line\n/do";
    expect(tokenAtCaret(text, text.length, "/")).toEqual({ query: "do", start: 11, end: 14 });
  });

  it("works for the @-attach marker the same way", () => {
    expect(tokenAtCaret("check @gm", 9, "@")).toEqual({ query: "gm", start: 6, end: 9 });
    expect(tokenAtCaret("email me at a@b", 15, "@")).toBeNull();
  });

  it("clamps out-of-range carets", () => {
    expect(tokenAtCaret("/x", 99, "/")).toEqual({ query: "x", start: 0, end: 2 });
    // Clamped to 0, nothing precedes the caret — no token.
    expect(tokenAtCaret("/x", -1, "/")).toBeNull();
  });
});
