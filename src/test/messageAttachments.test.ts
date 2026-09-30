// Unit tests for parseAttachments — the parser that lifts attachment markers
// out of a message's content so they render as visual cards instead of inline
// text. Covers all marker shapes produced by state/chat.ts + the backend's
// process_attachments(): images, doc/text with extracted content, and
// unreadable docs, plus the live-thumbnail merge for the optimistic message.
import { describe, expect, it } from "vitest";
import { parseAttachments } from "../components/chat/MessageAttachments";

describe("parseAttachments", () => {
  it("parses an image marker into an image card and strips it from text", () => {
    const content = `Look at this photo.\n\n[Attached image: cat.png]`;
    const { attachments, text } = parseAttachments(content);
    expect(attachments).toHaveLength(1);
    expect(attachments[0].kind).toBe("image");
    expect(attachments[0].name).toBe("cat.png");
    // History from before uploads were written to disk carries no path; such
    // an attachment can only show the placeholder tile.
    expect(attachments[0].path).toBeUndefined();
    expect(text).toBe("Look at this photo.");
  });

  it("splits the saved upload path out of a persisted image marker", () => {
    // What the backend persists now: the path rides inside the marker so the
    // card can re-render the real image after a restart.
    const path = "C:\\Users\\me\\AppData\\relay\\chat-uploads\\1756-shot.png";
    const { attachments, text } = parseAttachments(
      `Look at this.\n\n[Attached image: shot.png|${path}]`,
    );
    expect(attachments).toHaveLength(1);
    expect(attachments[0].name).toBe("shot.png");
    expect(attachments[0].path).toBe(path);
    expect(text).toBe("Look at this.");
  });

  it("keeps the path verbatim, spaces and drive colon included", () => {
    const { attachments } = parseAttachments(
      `[Attached image: Screenshot 2026-09-16 at 10.14.33.png|C:\\Users\\a b\\AppData\\relay\\chat-uploads\\1756-Screenshot.png]`,
    );
    expect(attachments[0].name).toBe("Screenshot 2026-09-16 at 10.14.33.png");
    expect(attachments[0].path).toBe(
      "C:\\Users\\a b\\AppData\\relay\\chat-uploads\\1756-Screenshot.png",
    );
  });

  it("parses a doc/text attachment with extracted content into a card with a preview", () => {
    const content = `Here is the report.\n\nAttached file: report.pdf\n\`\`\`\nSome extracted text\nline two\n\`\`\``;
    const { attachments, text } = parseAttachments(content);
    expect(attachments).toHaveLength(1);
    expect(attachments[0].kind).toBe("doc");
    expect(attachments[0].name).toBe("report.pdf");
    expect(attachments[0].preview).toContain("Some extracted text");
    // The code block + marker are stripped from the inline text.
    expect(text).toBe("Here is the report.");
  });

  it("classifies a .txt attachment as text, not doc", () => {
    const content = `notes\n\nAttached file: notes.txt\n\`\`\`\nhello\n\`\`\``;
    const { attachments } = parseAttachments(content);
    expect(attachments[0].kind).toBe("text");
    expect(attachments[0].name).toBe("notes.txt");
  });

  it("parses an unreadable-doc marker into a doc card", () => {
    const content = `See this.\n\n[Attached file scan.jpeg could not be read as text.]`;
    const { attachments, text } = parseAttachments(content);
    expect(attachments).toHaveLength(1);
    expect(attachments[0].kind).toBe("doc");
    expect(attachments[0].name).toBe("scan.jpeg");
    expect(attachments[0].preview).toContain("Could not be read");
    expect(text).toBe("See this.");
  });

  it("handles multiple attachments of mixed kinds in order", () => {
    const content =
      `Intro.\n\n[Attached image: a.png]\n\nAttached file: b.md\n\`\`\`\nbody\n\`\`\`\n\n[Attached file c.bin could not be read as text.]`;
    const { attachments, text } = parseAttachments(content);
    expect(attachments).toHaveLength(3);
    expect(attachments.map((a) => a.name)).toEqual(["a.png", "b.md", "c.bin"]);
    expect(attachments.map((a) => a.kind)).toEqual(["image", "text", "doc"]);
    expect(text).toBe("Intro.");
  });

  it("leaves content with no attachments untouched", () => {
    const content = `Just a normal message with **markdown**.`;
    const { attachments, text } = parseAttachments(content);
    expect(attachments).toHaveLength(0);
    expect(text).toBe(content);
  });

  it("merges a live image thumbnail from optimistic attachments by name", () => {
    const content = `[Attached image: photo.jpg]`;
    const { attachments } = parseAttachments(content, [
      {
        name: "photo.jpg",
        kind: "image",
        data: "AAAA",
        mediaType: "image/jpeg",
      },
    ]);
    expect(attachments[0].thumbDataUri).toBe("data:image/jpeg;base64,AAAA");
  });

  it("does not crash and returns empty when content is empty", () => {
    const { attachments, text } = parseAttachments("");
    expect(attachments).toHaveLength(0);
    expect(text).toBe("");
  });
});
