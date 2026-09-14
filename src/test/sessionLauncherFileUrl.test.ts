// Audit 2026-09-14 #14: artifact file:/// URLs must escape a literal `%` to
// `%25` BEFORE encodeURI — encodeURI passes `%` through, so a Windows path
// like `...\Temp\report%20final.html` produced a corrupt URL (the literal
// `%20` survives as an escape for a space that isn't there). `#`/`?` handling
// is unchanged (audit L5). Windows separators are built without backslash
// literals (shell/escaping safety, same trick as docdesignQa.test.tsx).
import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/ipc", () => ({
  runHarnessLogin: vi.fn().mockResolvedValue(undefined),
  spawnAgentSession: vi.fn().mockResolvedValue(undefined),
  spawnShell: vi.fn().mockResolvedValue(undefined),
  touchSession: vi.fn().mockResolvedValue(undefined),
}));

import { artifactFileUrl } from "../lib/sessionLauncher";

const SEP = String.fromCharCode(92);

describe("artifactFileUrl", () => {
  it("escapes a literal % in a Windows path before encodeURI", () => {
    const p = [
      "C:",
      "Users",
      "u",
      "AppData",
      "Local",
      "Temp",
      "report%20final.html",
    ].join(SEP);
    expect(artifactFileUrl(p)).toBe(
      "file:///C:/Users/u/AppData/Local/Temp/report%2520final.html",
    );
  });

  it("still percent-encodes # and ?", () => {
    const p = ["C:", "a b", "v2#1?.png"].join(SEP);
    expect(artifactFileUrl(p)).toBe("file:///C:/a%20b/v2%231%3F.png");
  });

  it("leaves ordinary Windows paths alone apart from slash conversion", () => {
    const p = ["C:", "work", "deck.pptx"].join(SEP);
    expect(artifactFileUrl(p)).toBe("file:///C:/work/deck.pptx");
  });
});
