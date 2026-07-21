import { describe, expect, it } from "vitest";
import { expandSkillCommand } from "../lib/skillExpansion";

const skills = [
  { slashCommand: "/audit-ai-slop", content: "Review the diff for AI-generated slop." },
  { slashCommand: "/tdd", content: "Write a failing test first, then implement." },
];

describe("expandSkillCommand", () => {
  it("expands a bare slash command to the template", () => {
    expect(expandSkillCommand("/audit-ai-slop", skills)).toBe("Review the diff for AI-generated slop.");
  });

  it("appends trailing context after the template", () => {
    expect(expandSkillCommand("/tdd the login form", skills)).toBe(
      "Write a failing test first, then implement.\n\nthe login form",
    );
  });

  it("leaves unknown commands untouched", () => {
    expect(expandSkillCommand("/unknown-cmd do stuff", skills)).toBe("/unknown-cmd do stuff");
  });

  it("leaves non-slash input untouched", () => {
    expect(expandSkillCommand("just a normal prompt", skills)).toBe("just a normal prompt");
  });

  it("only considers the first token", () => {
    expect(expandSkillCommand("please run /tdd now", skills)).toBe("please run /tdd now");
  });

  it("handles leading whitespace before the command", () => {
    expect(expandSkillCommand("   /tdd", skills)).toBe("Write a failing test first, then implement.");
  });

  it("is case-sensitive on the command name", () => {
    expect(expandSkillCommand("/TDD", skills)).toBe("/TDD");
  });

  it("returns input unchanged with an empty skill list", () => {
    expect(expandSkillCommand("/tdd", [])).toBe("/tdd");
  });
});
