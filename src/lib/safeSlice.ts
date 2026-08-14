// Code-point-safe string slicing helpers.
//
// JavaScript's String.prototype.slice cuts on UTF-16 code-unit boundaries, so
// slicing a string that contains emoji or other astral characters (surrogate
// pairs) can split a pair in half — the orphaned half renders as U+FFFD and
// corrupts anything downstream (persisted titles, token math, regex scans).
// These helpers step back to the nearest code-point boundary at the cut.

/** Returns `s` truncated to at most `max` CODE POINTS (never splitting a
 *  surrogate pair). `max <= 0` yields "". */
export function sliceCodePoints(s: string, max: number): string {
  if (max <= 0) return "";
  // Array.from iterates code points; for hot paths prefer the fast path when
  // the cut clearly lands inside the BMP (no surrogate at the boundary).
  if (s.length <= max) return s;
  let out = s.slice(0, max);
  // A trailing high surrogate means we cut between the pair's halves — drop it.
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return out;
}

/** Returns the LAST `max` code points of `s` (never splitting a surrogate
 *  pair) — the streaming-buffer tail cap. */
export function tailCodePoints(s: string, max: number): string {
  if (max <= 0) return "";
  if (s.length <= max) return s;
  let out = s.slice(s.length - max);
  // A leading low surrogate means the cut split a pair — drop it.
  const first = out.charCodeAt(0);
  if (first >= 0xdc00 && first <= 0xdfff) out = out.slice(1);
  return out;
}
