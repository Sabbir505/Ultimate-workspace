// Lazy-loaded syntax highlighter adapter.
//
// react-syntax-highlighter (Prism build) + its bundled language definitions is
// the single heaviest dep in the chat surface (~700 KB raw / ~230 KB gzip).
// It's only needed once a code fence or tool-step block actually renders, so
// we defer the import until then. This module exports a thin wrapper that
// calls the real SyntaxHighlighter on the first use and caches the module.
//
// The type export lets MessageBubble annotate the props without importing the
// real module at the top level (which would pull it into the main bundle).
import type { CSSProperties } from "react";

export type SyntaxStyle = Record<string, CSSProperties>;

export type SyntaxHighlighterProps = {
  style: SyntaxStyle;
  language: string;
  PreTag: string;
  customStyle: Record<string, unknown>;
  codeTagProps: Record<string, unknown>;
  children: string;
};

type SyntaxHighlighterComponent = (props: SyntaxHighlighterProps) => React.ReactNode;

let cached: SyntaxHighlighterComponent | null = null;
let loading: Promise<SyntaxHighlighterComponent> | null = null;

/** Returns the lazy-loaded Prism SyntaxHighlighter component.
 *  On first call it triggers a dynamic import(); subsequent calls
 *  resolve synchronously from cache. */
export async function loadSyntaxHighlighter(): Promise<SyntaxHighlighterComponent> {
  if (cached) return cached;
  if (loading) return loading;
  loading = import("react-syntax-highlighter").then((mod) => {
    // The Prism build is the default export of the prism entry; cast through
    // unknown because the subpath types aren't declared in @types.
    const C = (mod as unknown as { Prism: SyntaxHighlighterComponent }).Prism;
    cached = C;
    loading = null;
    return C;
  });
  return loading;
}

