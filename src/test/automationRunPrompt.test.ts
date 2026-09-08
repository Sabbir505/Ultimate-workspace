import { describe, it, expect } from "vitest";
import { buildAutomationRunPrompt } from "../components/automations/shared";

describe("buildAutomationRunPrompt", () => {
  it("compiles description and steps into a self-sufficient run prompt", () => {
    const prompt = buildAutomationRunPrompt({
      name: "Nightly sync",
      description: "Keep the two systems in sync.",
      steps: [
        { label: "Fetch", action: "Run fetch-sync --since yesterday", description: "Use the prod token." },
        { label: "Report", action: "Write the diff summary to sync-log.md" },
      ],
      inputs: [{ name: "target", description: "Sync destination slug" }],
    });

    expect(prompt).toContain("# Nightly sync");
    expect(prompt).toContain("Goal: Keep the two systems in sync.");
    expect(prompt).toContain("1. Fetch: Run fetch-sync --since yesterday");
    expect(prompt).toContain("   Use the prod token.");
    expect(prompt).toContain("2. Report: Write the diff summary to sync-log.md");
    expect(prompt).toContain("Inputs:");
    expect(prompt).toContain("- target: Sync destination slug");
  });

  it("trims the description and tolerates sparse specs", () => {
    expect(buildAutomationRunPrompt({ description: "  Just do it.  " })).toBe(
      "Goal: Just do it.\n\nComplete each step in order:",
    );
    // Legacy stored specs may carry no steps at all.
    expect(buildAutomationRunPrompt({ name: "X", description: "d", steps: [] })).not.toContain("1.");
  });
});
