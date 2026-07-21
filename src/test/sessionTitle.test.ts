import { describe, expect, it } from "vitest";
import { generateSessionTitle, sessionDisplayTitle, TITLE_MAX_LENGTH } from "../lib/sessionTitle";

describe("generateSessionTitle", () => {
  it("uses the first prompt verbatim when short enough", () => {
    expect(generateSessionTitle("fix the auth middleware")).toBe("fix the auth middleware");
  });

  it("collapses newlines and repeated whitespace", () => {
    expect(generateSessionTitle("fix the auth\nmiddleware   now")).toBe("fix the auth middleware now");
  });

  it("trims leading/trailing whitespace", () => {
    expect(generateSessionTitle("   hello world   ")).toBe("hello world");
  });

  it("truncates to ~40 chars with an ellipsis", () => {
    const long = "please refactor the entire authentication middleware layer to support token refresh";
    const title = generateSessionTitle(long)!;
    expect(title.endsWith("…")).toBe(true);
    expect(title.length).toBeLessThanOrEqual(TITLE_MAX_LENGTH + 1);
  });

  it("prefers cutting at a word boundary", () => {
    const long = "aaaaaaaaaa bbbbbbbbbb cccccccccc dddddddddd eeeeeeeeee ffffff";
    const title = generateSessionTitle(long)!;
    // Should end after a complete word, not mid-word.
    const body = title.slice(0, -1);
    expect(long.startsWith(body)).toBe(true);
    expect(long[body.length]).toBe(" ");
  });

  it("returns null for empty / whitespace-only prompts", () => {
    expect(generateSessionTitle("")).toBeNull();
    expect(generateSessionTitle("   \n\t  ")).toBeNull();
  });
});

describe("sessionDisplayTitle", () => {
  it("falls back to Untitled Session", () => {
    expect(sessionDisplayTitle(null)).toBe("Untitled Session");
    expect(sessionDisplayTitle("")).toBe("Untitled Session");
    expect(sessionDisplayTitle("   ")).toBe("Untitled Session");
  });

  it("passes real titles through", () => {
    expect(sessionDisplayTitle("auth refactor")).toBe("auth refactor");
  });
});
