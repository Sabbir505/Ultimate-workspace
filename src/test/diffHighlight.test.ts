// Checks for the diff-line syntax highlighter (lib/diffHighlight): path →
// language mapping, one HTML fragment per input line, multi-line token
// state surviving the line split, and HTML escaping of source text.
import { describe, expect, it } from "vitest";
import { langForPath, loadDiffHighlighter } from "../lib/diffHighlight";

describe("langForPath", () => {
  it("maps extensions and special filenames to refractor languages", () => {
    expect(langForPath("src-tauri/src/chat/prompts.rs")).toBe("rust");
    expect(langForPath("src\\components\\App.tsx")).toBe("tsx");
    expect(langForPath("src/main.ts")).toBe("typescript");
    expect(langForPath("package.json")).toBe("json");
    expect(langForPath("Dockerfile")).toBe("docker");
    expect(langForPath("deploy/Dockerfile.web")).toBe("docker");
    expect(langForPath("Makefile")).toBe("makefile");
    expect(langForPath(".github/workflows/ci.yml")).toBe("yaml");
  });

  it("returns null for unknown or extensionless paths", () => {
    expect(langForPath("README")).toBeNull();
    expect(langForPath("some/file.unknownext")).toBeNull();
    expect(langForPath("")).toBeNull();
  });
});

describe("loadDiffHighlighter", () => {
  it("produces one HTML fragment per input line", async () => {
    const hl = await loadDiffHighlighter();
    const code = ["fn main() {", "    let x = 1;", "}"].join("\n");
    const out = hl(code, "rust");
    expect(out).toHaveLength(3);
  });

  it("keeps multi-line comment state across the line split", async () => {
    const hl = await loadDiffHighlighter();
    const code = ["/* starts", "   still comment */", "let after = 1;"].join("\n");
    const out = hl(code, "rust");
    // Line 1 and 2 are inside the block comment — both must carry the
    // comment style even though tokenization saw the whole stream.
    expect(out[0]).toContain("--syntax-comment");
    expect(out[1]).toContain("--syntax-comment");
    expect(out[2]).not.toContain("--syntax-comment");
  });

  it("escapes HTML-significant source characters", async () => {
    const hl = await loadDiffHighlighter();
    const out = hl('let cmp = a < b && c > d;', "rust");
    expect(out.join("")).not.toMatch(/<(?!span|\/span)/);
    expect(out.join("")).toContain("&lt;");
    expect(out.join("")).toContain("&amp;&amp;");
  });

  it("falls back to escaped plain text for unregistered languages", async () => {
    const hl = await loadDiffHighlighter();
    const out = hl("plain <text> & stuff", "no-such-language");
    expect(out).toEqual(["plain &lt;text&gt; &amp; stuff"]);
  });
});
