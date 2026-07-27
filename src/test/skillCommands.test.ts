// Tests the shared slash-token rules for chat skills — these must stay in
// sync with the Rust matcher in src-tauri/src/chat/commands.rs
// (`slugify_command` / `message_has_slash_token`), which decides whether a
// skill is injected into the system prompt for a turn.
import { describe, expect, it } from "vitest";
import { skillCommand, slugifyCommand } from "../lib/skillCommands";

describe("slugifyCommand", () => {
  it("lowercases and collapses non-alphanumerics to single dashes", () => {
    expect(slugifyCommand("Word documents (.docx)")).toBe("word-documents-docx");
    expect(slugifyCommand("Slide decks (.pptx)")).toBe("slide-decks-pptx");
    expect(slugifyCommand("PDF documents")).toBe("pdf-documents");
    expect(slugifyCommand("  Report — Style!! ")).toBe("report-style");
  });

  it("returns an empty string for names with no alphanumerics", () => {
    expect(slugifyCommand("...")).toBe("");
    expect(slugifyCommand("")).toBe("");
  });
});

describe("skillCommand", () => {
  it("prefers the explicit command and strips leading slashes", () => {
    expect(skillCommand({ name: "Word documents (.docx)", command: "docx" })).toBe("docx");
    expect(skillCommand({ name: "X", command: "/deck" })).toBe("deck");
  });

  it("falls back to the slugified name when no command is set", () => {
    expect(skillCommand({ name: "Report Style" })).toBe("report-style");
    expect(skillCommand({ name: "Report Style", command: "  " })).toBe("report-style");
  });
});
