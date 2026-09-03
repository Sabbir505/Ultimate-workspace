// Tests for the automations failure-banner install affordance: the pure
// decision of when "Run again" becomes a one-time "Install" (harness
// registered but not installed), plus the plain-language hint copy.
import { describe, expect, it } from "vitest";
import { friendlyRunError, harnessNeedsInstall } from "../components/automations/shared";

const REGISTRY = [
  { id: "claude_code", installed: true },
  { id: "kimi_code", installed: true },
  { id: "opencode", installed: true },
  { id: "pi", installed: false },
  { id: "omp", installed: false },
  { id: "commandcode", installed: true },
];

describe("harnessNeedsInstall", () => {
  it("is true when the automation's harness is registered but not installed", () => {
    expect(harnessNeedsInstall("pi", REGISTRY)).toBe(true);
    expect(harnessNeedsInstall("omp", REGISTRY)).toBe(true);
  });

  it("is false when the harness is installed", () => {
    expect(harnessNeedsInstall("claude_code", REGISTRY)).toBe(false);
    expect(harnessNeedsInstall("commandcode", REGISTRY)).toBe(false);
  });

  it("is false for provider/local agents that aren't harnesses at all", () => {
    expect(harnessNeedsInstall("anthropic", REGISTRY)).toBe(false);
    expect(harnessNeedsInstall("local_gguf", REGISTRY)).toBe(false);
    expect(harnessNeedsInstall("", REGISTRY)).toBe(false);
  });
});

describe("spawn-failure hint copy", () => {
  it("points at the one-time Install button", () => {
    const friendly = friendlyRunError("failed to spawn program pi");
    expect(friendly.hint).toMatch(/Install/i);
    expect(friendly.hint).toMatch(/Run again/i);
  });
});
