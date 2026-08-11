import { describe, expect, it } from "vitest";
import { parseReleaseNotes } from "../lib/releaseNotes";

describe("parseReleaseNotes", () => {
  it("returns empty arrays for null/empty/whitespace input", () => {
    expect(parseReleaseNotes(null)).toEqual({ features: [], bugfixes: [], other: [] });
    expect(parseReleaseNotes("")).toEqual({ features: [], bugfixes: [], other: [] });
    expect(parseReleaseNotes("   \n\n  ")).toEqual({ features: [], bugfixes: [], other: [] });
  });

  it("splits ### Features and ### Bug Fixes blocks into the right buckets", () => {
    const notes = [
      "### Features",
      "- New green Update button in the sidebar",
      "- Hover popover with release notes",
      "",
      "### Bug Fixes",
      "- Browsing a project no longer rebinds the active chat",
      "- Fixed HTML artifact classification",
    ].join("\n");
    const r = parseReleaseNotes(notes);
    expect(r.features).toEqual([
      "New green Update button in the sidebar",
      "Hover popover with release notes",
    ]);
    expect(r.bugfixes).toEqual([
      "Browsing a project no longer rebinds the active chat",
      "Fixed HTML artifact classification",
    ]);
    expect(r.other).toEqual([]);
  });

  it("recognizes heading synonyms (## New, ### Added, ### Fixed)", () => {
    const notes = [
      "## New",
      "- feature one",
      "### Added",
      "- feature two",
      "### Fixed",
      "- bug one",
      "### Bugfixes",
      "- bug two",
    ].join("\n");
    const r = parseReleaseNotes(notes);
    expect(r.features).toEqual(["feature one", "feature two"]);
    expect(r.bugfixes).toEqual(["bug one", "bug two"]);
  });

  it("with no headings, all list items go to features", () => {
    const notes = "- alpha\n- beta\n- gamma";
    const r = parseReleaseNotes(notes);
    expect(r.features).toEqual(["alpha", "beta", "gamma"]);
    expect(r.bugfixes).toEqual([]);
    expect(r.other).toEqual([]);
  });

  it("a prose paragraph under a heading (no list items) becomes one bullet", () => {
    const notes = "### Notes\nThis whole sentence is the bullet text.";
    const r = parseReleaseNotes(notes);
    expect(r.other).toEqual(["This whole sentence is the bullet text."]);
    expect(r.features).toEqual([]);
    expect(r.bugfixes).toEqual([]);
  });

  it("accepts * and + bullet markers and ordered-list items", () => {
    const notes = ["### Features", "* star item", "+ plus item", "1. ordered item"].join("\n");
    const r = parseReleaseNotes(notes);
    expect(r.features).toEqual(["star item", "plus item", "ordered item"]);
  });

  it("strips markdown emphasis but keeps inline-code text", () => {
    const notes = "### Features\n- **bold** and _ital_ and `code` item";
    const r = parseReleaseNotes(notes);
    expect(r.features).toEqual(["bold and ital and code item"]);
  });

  it("routes unrecognized headings to 'other'", () => {
    const notes = "### Internal\n- refactored the bundler";
    const r = parseReleaseNotes(notes);
    expect(r.other).toEqual(["refactored the bundler"]);
    expect(r.features).toEqual([]);
    expect(r.bugfixes).toEqual([]);
  });

  it("ignores a preamble before the first heading (no implicit bucket)", () => {
    // Lines before any heading form a preamble with an empty heading; with at
    // least one real heading present, classify("") => "other".
    const notes = "Loose intro line.\n### Features\n- real feature";
    const r = parseReleaseNotes(notes);
    expect(r.features).toEqual(["real feature"]);
    expect(r.other).toEqual(["Loose intro line."]);
  });
});
