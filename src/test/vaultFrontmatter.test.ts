import { describe, expect, it } from "vitest";
import { serializeFrontmatter, splitFrontmatter, withFrontmatter } from "../lib/vaultFrontmatter";

describe("vaultFrontmatter", () => {
  it("splits a fenced block from the body", () => {
    const note = "---\ntags: ml, basics\n---\n\n# Body\n\ntext";
    const { data, body, raw } = splitFrontmatter(note);
    expect(data.tags).toBe("ml, basics");
    expect(body).toBe("\n# Body\n\ntext");
    expect(raw).toBe("---\ntags: ml, basics\n---");
  });

  it("parses lists and strips quotes", () => {
    const note = '---\naliases:\n  - "Linear Regression"\n  - LR\ntitle: \'Lesson 1\'\n---\nbody';
    const { data } = splitFrontmatter(note);
    expect(data.aliases).toEqual(["Linear Regression", "LR"]);
    expect(data.title).toBe("Lesson 1");
  });

  it("treats a missing or unterminated fence as no frontmatter", () => {
    expect(splitFrontmatter("no fences here").raw).toBeNull();
    expect(splitFrontmatter("---\nkey: value\nbut never closed").raw).toBeNull();
    // Leading blank lines are allowed before the opening fence.
    expect(splitFrontmatter("\n\n---\nk: v\n---\nb").data.k).toBe("v");
  });

  it("round-trips through serialize", () => {
    const data = { tags: "ml", aliases: ["A", "B"], empty: [] };
    const text = serializeFrontmatter(data);
    expect(splitFrontmatter(`${text}\nbody`).data).toEqual(data);
  });

  it("quotes values that would break YAML", () => {
    const text = serializeFrontmatter({ tricky: 'has: colon' });
    expect(text).toContain('tricky: "has: colon"');
    expect(splitFrontmatter(`${text}\n`).data.tricky).toBe("has: colon");
  });

  it("withFrontmatter inserts, replaces, and removes the block", () => {
    const body = "# Title\n\ntext";
    const added = withFrontmatter(body, { tags: "x" });
    expect(added.startsWith("---\ntags: x\n---\n\n# Title")).toBe(true);
    const replaced = withFrontmatter(added, { tags: "y", n: "2" });
    expect(splitFrontmatter(replaced).data.tags).toBe("y");
    // The blank separator line after a fence is part of the body per
    // splitFrontmatter's contract — normalize it when comparing.
    expect(splitFrontmatter(replaced).body.replace(/^\n+/, "")).toBe(body);
    const removed = withFrontmatter(added, null);
    expect(removed).toBe(body);
  });

  it("handles CRLF content", () => {
    const { data, body } = splitFrontmatter("---\r\nkey: value\r\n---\r\n\r\nbody line\r\n");
    expect(data.key).toBe("value");
    expect(body).toContain("body line");
  });
});
