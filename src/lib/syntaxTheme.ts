// Syntax highlighting theme for react-syntax-highlighter that reads from CSS
// custom properties (--syntax-* tokens defined in global.css). The
// "useTheme" hook applies data-theme to <html>, which re-resolves the
// variables, so this object always reflects the current theme.
//
// The shape mirrors the subset of react-syntax-highlighter's style schema
// that we actually use (code + comment + string + keyword + function +
// variable + number + operator + tag + attr-name + attr-value + punctuation
// + deleted + inserted). Untyped keys fall back to editor-fg.
import type { CSSProperties } from "react";

type SyntaxStyle = Record<string, CSSProperties>;

/** Returns the current theme's syntax style by reading CSS custom properties
 *  off the document root. Reactivity comes from the data-theme attribute
 *  change; callers should re-invoke this when the theme changes. */
export function getSyntaxTheme(): SyntaxStyle {
  if (typeof document === "undefined") return {};
  const cs = getComputedStyle(document.documentElement);
  const cssVar = (name: string) => cs.getPropertyValue(name).trim();

  const v = (name: string, fallback: string): string => cssVar(name) || fallback;

  return {
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
}
