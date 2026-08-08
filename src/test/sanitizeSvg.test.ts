// Tests for the SVG sanitization policy used before mermaid output (or any
// other model-authored SVG/HTML) is injected via dangerouslySetInnerHTML in
// the main window. The policy must strip active content while preserving the
// diagram markup mermaid actually emits (incl. <foreignObject> htmlLabels).
import { describe, it, expect } from "vitest";
import { sanitizeSvg } from "../lib/sanitize";

describe("sanitizeSvg", () => {
  it("strips script elements inside SVG", () => {
    const out = sanitizeSvg(
      `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect width="10" height="10"/></svg>`,
    );
    expect(out).not.toContain("<script");
    expect(out).toContain("<rect");
  });

  it("strips inline event handlers", () => {
    const out = sanitizeSvg(
      `<svg><image href="x" onerror="alert(1)"/><text onclick="alert(2)">hi</text></svg>`,
    );
    expect(out).not.toMatch(/on(error|click)=/i);
    expect(out).toContain("hi");
  });

  it("strips javascript: URLs in href and xlink:href", () => {
    const out = sanitizeSvg(
      `<svg><a href="javascript:alert(1)"><text>click</text></a></svg>`,
    );
    expect(out.toLowerCase()).not.toContain("javascript:");
  });

  it("keeps foreignObject htmlLabels (mermaid multi-line labels) but sanitizes their content", () => {
    const dirty =
      `<svg><foreignObject width="100" height="50">` +
      `<div xmlns="http://www.w3.org/1999/xhtml">line1<br/>line2` +
      `<img src="x" onerror="alert(1)"/></div></foreignObject></svg>`;
    const out = sanitizeSvg(dirty);
    expect(out.toLowerCase()).toContain("foreignobject");
    expect(out).toContain("line1");
    expect(out).toContain("<br");
    expect(out).not.toMatch(/onerror=/i);
  });

  it("preserves core presentation attributes mermaid relies on", () => {
    const svg =
      `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">` +
      `<style>.lbl { fill: red; }</style>` +
      `<g transform="translate(1,2)"><path d="M0 0 L10 10" stroke="#000" fill="none" ` +
      `marker-end="url(#arrow)" text-anchor="middle" stroke-dasharray="3 3"/></g></svg>`;
    const out = sanitizeSvg(svg);
    expect(out).toContain("viewBox=");
    expect(out).toContain("<style");
    expect(out).toContain("transform=");
    expect(out).toContain("marker-end=");
    expect(out).toContain("stroke-dasharray=");
    expect(out).toContain("text-anchor=");
  });

  it("returns empty string for empty input", () => {
    expect(sanitizeSvg("")).toBe("");
    expect(sanitizeSvg(null)).toBe("");
    expect(sanitizeSvg(undefined)).toBe("");
  });
});
