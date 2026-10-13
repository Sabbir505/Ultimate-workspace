// Per-row syntax highlighting for a parsed unified diff — the shared engine
// behind BOTH the Pulls panel's file patches and the Changes panel's diff
// body, so a C/Rust/TS change reads the same in either place.
//
// The old side (context + deletions) and the new side (context + additions)
// are each tokenized as one program so multi-line constructs (block comments,
// triple-quoted strings) keep their token color across rows; each row then
// renders its own serialized fragment. Rows the language can't cover (hunk
// headers, unknown extensions) come back null and the caller renders plain
// text — no layout shift when the highlighter chunk lands.
import { useEffect, useMemo, useState } from "react";
import { langForPath, loadDiffHighlighter, type HighlightLinesFn } from "../lib/diffHighlight";
import type { DiffLine } from "../lib/diff";

export function useDiffHighlightRows(
  lines: DiffLine[],
  path: string,
): (string | null)[] | null {
  const [highlight, setHighlight] = useState<HighlightLinesFn | null>(null);
  useEffect(() => {
    let live = true;
    loadDiffHighlighter()
      .then((fn) => {
        // The loaded value IS a function — pass it via an updater fn, or
        // React's basicStateReducer invokes it as a setState updater with the
        // previous state (null) as its argument (same trap as DiffCard).
        if (live) setHighlight(() => fn);
      })
      .catch(() => {
        /* highlighting is cosmetic — plain text stays readable */
      });
    return () => {
      live = false;
    };
  }, []);

  const lang = useMemo(() => langForPath(path), [path]);
  const rows = useMemo(() => {
    if (!highlight || !lang) return null;
    const oldText: string[] = [];
    const newText: string[] = [];
    const oldRows: number[] = [];
    const newRows: number[] = [];
    lines.forEach((l, i) => {
      if (l.type === "del" || l.type === "context") {
        oldText.push(l.text);
        oldRows.push(i);
      }
      if (l.type === "add" || l.type === "context") {
        newText.push(l.text);
        newRows.push(i);
      }
    });
    const byRow = new Array<string | null>(lines.length).fill(null);
    const paint = (text: string, textRows: number[]) => {
      const html = highlight(text, lang);
      textRows.forEach((row, i) => {
        if (byRow[row] === null && html[i] != null) byRow[row] = html[i];
      });
    };
    // Context rows paint from the new side first (GitHub's convention); the
    // old side fills any rows the new side didn't cover.
    paint(newText.join("\n"), newRows);
    paint(oldText.join("\n"), oldRows);
    return byRow;
  }, [highlight, lang, lines]);

  return rows;
}
