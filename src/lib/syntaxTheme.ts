// Syntax highlighting theme for react-syntax-highlighter that reads from CSS
// custom properties (--syntax-* tokens defined in global.css). The
// "useTheme" hook applies data-theme to <html>, which re-resolves the
// variables, so this object always reflects the current theme.
//
// The shape mirrors the subset of react-syntax-highlighter's style schema
// that we actually use (code + comment + string + keyword + function +
// variable + number + operator + tag + attr-name + attr-value + punctuation
// + deleted + inserted). Untyped keys fall back to editor-fg.
//
// Memoized: building the 40-entry style object reads ~16 CSS custom
// properties off the document root each call; that work is identical for a
// given data-theme, so we cache by theme name and only rebuild on a real
// theme change. The MutationObserver in useSyntaxTheme fires on every
// data-theme attribute mutation — without this cache it would rebuild the
// whole object (and re-render every SyntaxHighlighter in the chat) on each
// toggle, even when the value didn't actually change.
import type { CSSProperties } from "react";
import type { SyntaxStyle } from "./syntaxHighlighter";
import { useSettingsStore } from "../state/settings";

let cachedThemeKey: string | null = null;
let cachedStyle: SyntaxStyle | null = null;

/** Hidden probe element that lives INSIDE a `.chat-code-block`. The chat's
 *  code blocks are fixed-dark (ChatGPT-style) in both themes, so their token
 *  palette must be resolved through the block's own `--syntax-*` scope — not
 *  the document root, whose light-theme values are dark-on-light and unreadable
 *  on a near-black surface. chat.css pins the dark token set to the block under
 *  light themes; resolving here picks that up. Custom properties compute
 *  without layout, so a hidden probe resolves them fine. */
let chatProbe: HTMLElement | null = null;
function chatBlockProbe(): HTMLElement {
  if (!chatProbe) {
    chatProbe = document.createElement("div");
    chatProbe.className = "chat-code-block";
    chatProbe.setAttribute("aria-hidden", "true");
    chatProbe.style.cssText =
      "position:absolute;width:0;height:0;overflow:hidden;visibility:hidden;pointer-events:none";
    document.body.appendChild(chatProbe);
  }
  return chatProbe;
}

/** Returns the current theme's syntax style by reading CSS custom properties.
 *  `scope` "root" resolves against <html> (theme-following); "chat-block"
 *  resolves inside a .chat-code-block probe so the fixed-dark chat code
 *  palette wins even in light themes. Reactivity comes from the data-theme
 *  attribute change; callers should re-invoke this when the theme changes. */
export function getSyntaxTheme(scope: "root" | "chat-block" = "root"): SyntaxStyle {
  if (typeof document === "undefined") return {};
  const theme = document.documentElement.getAttribute("data-theme") || "";
  // data-theme is only the resolved light/dark BASE — a custom theme layers
  // inline --syntax-* overrides on top of it, so two custom themes sharing a
  // base leave data-theme unchanged. Include the active custom-theme id in
  // the cache key, or theme A's resolved colors are served forever after
  // switching to theme B (audit #24).
  const customThemeId = useSettingsStore.getState().customThemeId ?? "";
  const themeKey = `${scope}\u0000${customThemeId}\u0000${theme}`;
  if (cachedStyle && cachedThemeKey === themeKey) return cachedStyle;

  const cs = getComputedStyle(scope === "chat-block" ? chatBlockProbe() : document.documentElement);
  const cssVar = (name: string) => cs.getPropertyValue(name).trim();

  const v = (name: string, fallback: string): string => cssVar(name) || fallback;

  const style: SyntaxStyle = {
    "code[class*=\"language-\"]": {
      color: v("--syntax-variable", v("--editor-fg", "#e4e4e4")),
      fontFamily: "var(--font-mono)",
      fontSize: "12px",
      lineHeight: 1.5,
      direction: "ltr",
      textAlign: "left",
      whiteSpace: "pre",
      wordSpacing: "normal",
      wordBreak: "normal",
      tabSize: 2,
      hyphens: "none",
      background: "transparent",
    },
    "pre[class*=\"language-\"]": {
      color: v("--syntax-variable", v("--editor-fg", "#e4e4e4")),
      fontFamily: "var(--font-mono)",
      fontSize: "12px",
      lineHeight: 1.5,
      direction: "ltr",
      textAlign: "left",
      whiteSpace: "pre",
      wordSpacing: "normal",
      wordBreak: "normal",
      tabSize: 2,
      hyphens: "none",
      background: "transparent",
      padding: "1em",
      margin: "0",
      overflow: "auto",
    },
    comment: { color: v("--syntax-comment", "#6a9955"), fontStyle: "italic" },
    prolog: { color: v("--syntax-comment", "#6a9955") },
    doctype: { color: v("--syntax-comment", "#6a9955") },
    cdata: { color: v("--syntax-comment", "#6a9955") },
    punctuation: { color: v("--syntax-punctuation", "#a0a0a0") },
    property: { color: v("--syntax-variable", "#9cdcfe") },
    tag: { color: v("--syntax-tag", "#569cd6") },
    boolean: { color: v("--syntax-number", "#b5cea8") },
    number: { color: v("--syntax-number", "#b5cea8") },
    constant: { color: v("--syntax-number", "#b5cea8") },
    symbol: { color: v("--syntax-number", "#b5cea8") },
    deleted: { color: v("--syntax-deleted", "#ff7b72") },
    selector: { color: v("--syntax-keyword", "#c586c0") },
    "attr-name": { color: v("--syntax-attr-name", "#9cdcfe") },
    string: { color: v("--syntax-string", "#ce9178") },
    char: { color: v("--syntax-string", "#ce9178") },
    builtin: { color: v("--syntax-builtin", "#4ec9b0") },
    inserted: { color: v("--syntax-inserted", "#34d17b") },
    operator: { color: v("--syntax-operator", "#d4d4d4") },
    entity: { color: v("--syntax-operator", "#d4d4d4") },
    url: { color: v("--syntax-string", "#ce9178") },
    ".language-css .token.string": { color: v("--syntax-string", "#ce9178") },
    ".style .token.string": { color: v("--syntax-string", "#ce9178") },
    atrule: { color: v("--syntax-keyword", "#c586c0") },
    "attr-value": { color: v("--syntax-attr-value", "#ce9178") },
    keyword: { color: v("--syntax-keyword", "#c586c0") },
    function: { color: v("--syntax-function", "#dcdcaa") },
    "class-name": { color: v("--syntax-type", "#4ec9b0") },
    regex: { color: v("--syntax-regex", "#d16969") },
    important: { color: v("--syntax-keyword", "#c586c0"), fontWeight: "bold" },
    variable: { color: v("--syntax-variable", "#9cdcfe") },
    bold: { fontWeight: "bold" },
    italic: { fontStyle: "italic" },
  };

  cachedThemeKey = themeKey;
  cachedStyle = style;
  return style;
}
