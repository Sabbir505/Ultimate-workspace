// Vault link utilities — the frontend half of the Obsidian-flavored link
// spec. The Rust side (vault/parse.rs) owns the same rules for indexing;
// these tests pin the shared behavior on the render/routing side.
import { describe, expect, it } from "vitest";
import {
  decodeVaultHref,
  encodeVaultHref,
  parseWikiLinkInner,
  resolveAssetPath,
  snippetToPlain,
  splitEmbeds,
  wikilinksToMarkdown,
  basenameOf,
  stemOf,
  folderOf,
} from "../lib/vaultLinks";

describe("parseWikiLinkInner", () => {
  it("splits target, display and subpath", () => {
    expect(parseWikiLinkInner("Note")).toEqual({
      target: "Note",
      display: null,
      subpath: null,
      isEmbed: false,
    });
    expect(parseWikiLinkInner("Folder/Note|alias")).toEqual({
      target: "Folder/Note",
      display: "alias",
      subpath: null,
      isEmbed: false,
    });
    expect(parseWikiLinkInner("Note#Heading")).toMatchObject({
      target: "Note",
      subpath: "#Heading",
    });
    expect(parseWikiLinkInner("Note#^block1")).toMatchObject({
      target: "Note",
      subpath: "#^block1",
    });
    expect(parseWikiLinkInner("#Same note")).toMatchObject({
      target: "",
      subpath: "#Same note",
    });
  });
});

describe("wikilinksToMarkdown", () => {
  it("converts wikilinks to vault:// markdown links", () => {
    const out = wikilinksToMarkdown("see [[Note]] and [[Folder/Note|the alias]]");
    expect(out).toContain("[Note](vault://Note)");
    expect(out).toContain("[the alias](vault://Folder%2FNote)");
  });

  it("keeps inline code untouched", () => {
    const out = wikilinksToMarkdown("use `[[NotALink]]` then [[Yes]]");
    expect(out).toContain("`[[NotALink]]`");
    expect(out).toContain("[Yes](vault://Yes)");
  });

  it("handles heading subpaths and same-note links", () => {
    const out = wikilinksToMarkdown("[[Note#Setup]] [[#Advanced]]");
    expect(out).toContain("(vault://Note#Setup)");
    expect(out).toContain("(vault://#Advanced)");
    // The label is the note name (subpath only deep-links) — Obsidian's rule.
    expect(out).toContain("[Note](vault://Note#Setup)");
    expect(out).toContain("[Advanced](vault://#Advanced)");
  });
});

describe("splitEmbeds", () => {
  it("splits image and note embeds out of the text", () => {
    const segs = splitEmbeds("a\n![[img.png]]\nb ![[Note]] c");
    expect(segs).toHaveLength(5);
    expect(segs[0]).toEqual({ type: "text", text: "a\n" });
    expect(segs[1]).toMatchObject({ type: "embed", target: "img.png" });
    expect(segs[3]).toMatchObject({ type: "embed", target: "Note" });
  });

  it("leaves embeds inside inline code alone", () => {
    const segs = splitEmbeds("code `![[x.png]]` text");
    expect(segs).toHaveLength(1);
    expect(segs[0].type).toBe("text");
  });

  it("plain text stays a single segment", () => {
    expect(splitEmbeds("no embeds here")).toEqual([{ type: "text", text: "no embeds here" }]);
  });
});

describe("vault hrefs", () => {
  it("round-trips target + subpath with spaces", () => {
    const href = encodeVaultHref("My Folder/My Note", "#Some Heading");
    expect(href.startsWith("vault://")).toBe(true);
    const back = decodeVaultHref(href);
    expect(back).toEqual({ target: "My Folder/My Note", subpath: "#Some Heading" });
  });

  it("rejects non-vault hrefs", () => {
    expect(decodeVaultHref("https://x.y")).toBeNull();
  });
});

describe("path helpers", () => {
  it("stem/basename/folder", () => {
    expect(stemOf("Folder/Note.md")).toBe("Note");
    expect(basenameOf("a/b/c.txt")).toBe("c.txt");
    expect(folderOf("a/b/c.md")).toBe("a/b");
    expect(folderOf("c.md")).toBe("");
  });

  it("resolves bare asset targets against the note's folder", () => {
    expect(resolveAssetPath("Journal/2026/day.md", "pic.png")).toBe("Journal/2026/pic.png");
    expect(resolveAssetPath("day.md", "pic.png")).toBe("pic.png");
    expect(resolveAssetPath("Journal/day.md", "./pic.png")).toBe("Journal/pic.png");
    expect(resolveAssetPath("day.md", "Assets/pic.png")).toBe("Assets/pic.png");
  });

  it("collapses ../ relatives (safe_join rejects literal ..)", () => {
    expect(resolveAssetPath("Journal/2026/day.md", "../assets/pic.png")).toBe(
      "Journal/assets/pic.png",
    );
    expect(resolveAssetPath("Journal/2026/day.md", "./../x.png")).toBe("Journal/x.png");
  });

  it("returns null for paths that escape the vault root", () => {
    expect(resolveAssetPath("day.md", "../pic.png")).toBeNull();
    expect(resolveAssetPath("a/b/day.md", "../../../evil.png")).toBeNull();
  });
});

describe("snippetToPlain", () => {
  it("strips markers and collapses whitespace", () => {
    expect(snippetToPlain("hello ⟨world⟩  again")).toBe("hello world again");
  });
});
