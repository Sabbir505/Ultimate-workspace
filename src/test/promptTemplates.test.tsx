// Prompt template library (roadmap #14) — the shared variable helpers in
// ipc.ts (templateVariables + fillTemplate) still power the composer's `/`
// template menu; the settings-side editor was removed.
import { describe, expect, it } from "vitest";
import {
  templateVariables,
  fillTemplate,
} from "../lib/ipc";

describe("template variable helpers", () => {
  it("extracts unique variables in order", () => {
    expect(templateVariables("write a {{type}} review of {{code}} and a {{type}} summary"))
      .toEqual(["type", "code"]);
    expect(templateVariables("no placeholders here")).toEqual([]);
  });

  it("fills variables and blanks missing ones", () => {
    expect(fillTemplate("{{a}} + {{b}} = {{c}}", { a: "1", b: "2" })).toBe("1 + 2 = ");
  });

  it("handles whitespace inside braces", () => {
    expect(templateVariables("use {{ thing }} here")).toEqual(["thing"]);
    expect(fillTemplate("hi {{x }}", { x: "X" })).toBe("hi X");
  });
});
