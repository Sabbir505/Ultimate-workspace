// Regression tests for the unified-diff parser (L14): `--- `/`+++ ` lines
// are file headers only before the first `@@` hunk; inside a hunk body they
// are ordinary del/add lines and must keep their line numbers.
import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "../lib/diff";

describe("parseUnifiedDiff", () => {
  it("treats --- / +++ lines before the first hunk as file headers", () => {
    const diff = [
      "diff --git a/src/auth.ts b/src/auth.ts",
      "index 1111111..2222222 100644",
      "--- a/src/auth.ts",
      "+++ b/src/auth.ts",
      "@@ -1,1 +1,1 @@",
      "-old",
      "+new",
    ].join("\n");
    const files = parseUnifiedDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0].oldPath).toBe("src/auth.ts");
    expect(files[0].newPath).toBe("src/auth.ts");
    const meta = files[0].lines.filter((l) => l.type === "meta");
    expect(meta.map((l) => l.text)).toEqual([
      "diff --git a/src/auth.ts b/src/auth.ts",
      "index 1111111..2222222 100644",
      "--- a/src/auth.ts",
      "+++ b/src/auth.ts",
    ]);
  });

  it("keeps hunk-body lines starting with --- / +++ as del/add content", () => {
    const diff = [
      "diff --git a/f.txt b/f.txt",
      "--- a/f.txt",
      "+++ b/f.txt",
      "@@ -1,3 +1,3 @@",
      " ctx",
      "--- a",
      "+++ b",
      " end",
    ].join("\n");
    const files = parseUnifiedDiff(diff);
    expect(files).toHaveLength(1);
    const lines = files[0].lines;
    // The --- a line must stay a del body line (content "-- a") with the old
    // line number, and +++ b an add body line with the new line number.
    const del = lines.find((l) => l.type === "del");
    const add = lines.find((l) => l.type === "add");
    expect(del).toMatchObject({ text: "-- a", oldLine: 2, newLine: null });
    expect(add).toMatchObject({ text: "++ b", oldLine: null, newLine: 2 });
    // Neither line leaked into meta or clobbered the file paths.
    expect(files[0].oldPath).toBe("f.txt");
    expect(files[0].newPath).toBe("f.txt");
    expect(lines.filter((l) => l.type === "meta")).toHaveLength(3);
  });
});
