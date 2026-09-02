// Composer attachment classification (ChatComposer.classifyAttachment +
// fileToAttachment) — the pipeline shared by the "+" file picker and the new
// paste-to-attach path. Pasted files are messier than picked ones: screenshots
// arrive with the generic name "image.png" (or none at all), and OS-copied
// files can carry unregistered extensions — so MIME fallback and the binary
// sniff are the contract under test.
import { describe, expect, it } from "vitest";
import { classifyAttachment, fileToAttachment } from "../components/chat/ChatComposer";

describe("classifyAttachment", () => {
  it("routes images by extension", () => {
    expect(classifyAttachment({ name: "shot.png", type: "" }).kind).toBe("image");
    expect(classifyAttachment({ name: "photo.JPG", type: "" }).kind).toBe("image");
    expect(classifyAttachment({ name: "anim.webp", type: "" }).kind).toBe("image");
  });

  it("routes images by MIME when the name is generic or missing", () => {
    // Pasted screenshots often carry only "image.png"; some clipboard sources
    // provide no useful name at all — the MIME type is what identifies them.
    expect(classifyAttachment({ name: "image.png", type: "image/png" }).kind).toBe("image");
    expect(classifyAttachment({ name: "", type: "image/png" }).kind).toBe("image");
    expect(classifyAttachment({ name: "clipboard", type: "image/webp" }).kind).toBe("image");
  });

  it("never treats SVG as an image (it is not valid vision input)", () => {
    expect(classifyAttachment({ name: "icon.svg", type: "image/svg+xml" }).kind).toBe("text");
  });

  it("routes documents by extension", () => {
    for (const ext of ["docx", "pptx", "xlsx", "pdf", "doc", "ppt", "xls"]) {
      expect(classifyAttachment({ name: `brief.${ext}`, type: "" }).kind).toBe("doc");
      expect(classifyAttachment({ name: `brief.${ext}`, type: "" }).ext).toBe(ext);
    }
  });

  it("treats unknown extensions as text (binary content is caught later)", () => {
    expect(classifyAttachment({ name: "notes.md", type: "" }).kind).toBe("text");
    expect(classifyAttachment({ name: "main.rs", type: "" }).kind).toBe("text");
    expect(classifyAttachment({ name: "noext", type: "" }).kind).toBe("text");
  });
});

describe("fileToAttachment", () => {
  it("inlines a plain-text file", async () => {
    const file = new File(["hello world"], "notes.txt", { type: "text/plain" });
    expect(await fileToAttachment(file)).toMatchObject({
      name: "notes.txt",
      kind: "text",
      text: "hello world",
    });
  });

  it("base64-encodes a pasted screenshot and keeps its MIME", async () => {
    // 0x89 0x50 0x4e 0x47 — the PNG magic; real bytes, not text.
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "image.png", {
      type: "image/png",
    });
    const attachment = await fileToAttachment(file);
    expect(attachment.kind).toBe("image");
    expect(attachment.mediaType).toBe("image/png");
    expect(attachment.data).toBe("iVBORw==");
  });

  it("maps .jpg to image/jpeg when the OS reports no MIME", async () => {
    const file = new File([""], "pic.jpg", { type: "" });
    expect((await fileToAttachment(file)).mediaType).toBe("image/jpeg");
  });

  it("keeps the doc format for a pasted PDF", async () => {
    const file = new File(["%PDF-1.4"], "report.pdf", { type: "application/pdf" });
    expect(await fileToAttachment(file)).toMatchObject({ kind: "doc", format: "pdf" });
  });

  it("rejects binary content pasted with an unknown extension", async () => {
    // "MZ\0…" — a PE executable header; the NUL byte is what the sniff keys on.
    const file = new File([new Uint8Array([0x4d, 0x5a, 0x00, 0x01])], "setup.exe", { type: "" });
    await expect(fileToAttachment(file)).rejects.toThrow(/not a supported attachment type/);
  });

  it("enforces the per-kind size caps with a readable message", async () => {
    // Image cap is 15 MB (docs 10 MB, text 512 KB) — a paste never bypasses it.
    const huge = new File([new Uint8Array(15 * 1024 * 1024 + 1)], "huge.png", {
      type: "image/png",
    });
    await expect(fileToAttachment(huge)).rejects.toThrow("huge.png is too large (max 15 MB)");
  });
});
