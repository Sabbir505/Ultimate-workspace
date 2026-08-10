// Split-layout terminal "spotlight" selection (pure functions).
//
// When a browser pane is open alongside terminals, the left side of the split
// shows up to 2 stacked terminals (the "spotlight"). These functions pick
// WHICH terminals those are from the pane list, based on recency
// (lastInputAt preferred, lastUsedAt fallback — both monotonic counters from
// the same clock, so max() is a valid merge) plus an explicit user override.
//
// Kept pure and separate from the panes store so they're trivially unit-
// testable (see test/spotlight.test.ts) and so the store stays focused on
// state mutation. Re-exported from state/panes.ts for import convenience.
import type { Pane } from "./panes";

/** Terminal panes in grid order. */
export function terminalPanes(panes: Pane[]): Pane[] {
  return panes.filter((p) => p.data.kind === "terminal");
}

/**
 * Split-layout spotlight selection. An explicit user choice wins while that
 * pane still exists; otherwise the most recently interacted-with terminal —
 * last input preferred, focus recency as fallback (both are monotonic
 * counters from the same clock, so max() is a valid merge).
 */
export function activeTerminalId(panes: Pane[], override: string | null): string | null {
  const terminals = terminalPanes(panes);
  if (terminals.length === 0) return null;
  if (override && terminals.some((p) => p.paneId === override)) return override;
  const recency = (p: Pane) => Math.max(p.lastInputAt, p.lastUsedAt);
  return terminals.reduce((best, p) => (recency(p) > recency(best) ? p : best)).paneId;
}

/**
 * Cycle the spotlight through terminal panes in grid order. `direction` is
 * +1 (next) or -1 (previous), wrapping at the ends. Returns null when there
 * are no terminal panes.
 */
export function cycleTerminalId(
  panes: Pane[],
  currentId: string | null,
  direction: 1 | -1,
): string | null {
  const terminals = terminalPanes(panes);
  if (terminals.length === 0) return null;
  const idx = terminals.findIndex((p) => p.paneId === currentId);
  if (idx === -1) return direction === 1 ? terminals[0].paneId : terminals[terminals.length - 1].paneId;
  return terminals[(idx + direction + terminals.length) % terminals.length].paneId;
}

/**
 * Returns the paneIds for the top and bottom spotlight terminal slots. When
 * an explicit `override` (spotlightOverride) is set and the terminal still
 * exists, that terminal goes into the top slot; the bottom slot is the most
 * recent other terminal. If no override, both slots are simply the two most
 * recently used terminals.
 *
 * Returns [topId, bottomId] where bottomId may be null when there is only 1
 * terminal (or 0). Callers MUST handle the 1-terminal case by rendering the
 * single terminal full-height with NO bottom slot or horizontal splitter.
 */
export function activeTerminalPair(
  panes: Pane[],
  override: string | null,
): [string | null, string | null] {
  const terminals = terminalPanes(panes).slice(); // shallow copy for sorting
  if (terminals.length === 0) return [null, null];

  // Sort terminals by recency (descending): lastInputAt preferred, lastUsedAt fallback.
  const recency = (p: Pane) => Math.max(p.lastInputAt, p.lastUsedAt);
  terminals.sort((a, b) => recency(b) - recency(a));

  if (override && terminals.some((t) => t.paneId === override)) {
    // Override terminal is the top slot; bottom slot is the next most-recent
    // terminal that isn't the override. If only 1 terminal, bottom is null.
    if (terminals.length === 1) return [override, null];
    const bottom = terminals.find((t) => t.paneId !== override)!.paneId;
    return [override, bottom];
  }

  if (terminals.length === 1) return [terminals[0].paneId, null];
  return [terminals[0].paneId, terminals[1].paneId];
}

/**
 * Cycle the terminal pair displayed in the split layout. The bottom terminal
 * moves to the top slot; the new bottom slot picks the most-recent terminal
 * that is NOT already in the new pair. With only 2 terminals, this simply
 * swaps them. With 1 terminal, it is a no-op.
 *
 * Returns [newTopId, newBottomId] — the caller should persist
 * `newTopId` as the new `spotlightOverride` so the choice sticks.
 */
export function cycleTerminalPair(
  panes: Pane[],
  currentPair: [string | null, string | null],
  direction: 1 | -1,
): [string | null, string | null] {
  const terminals = terminalPanes(panes);
  if (terminals.length <= 1) return currentPair;

  const [top, bottom] = currentPair;
  if (!top) return currentPair;

  const recency = (p: Pane) => Math.max(p.lastInputAt, p.lastUsedAt);
  const sortedByRecency = terminalPanes(panes)
    .slice()
    .sort((a, b) => recency(b) - recency(a));

  if (!bottom) {
    // 1 terminal visible in 2+ terminal world (shouldn't normally happen,
    // but handle gracefully): just pick the two most recent.
    const newTop = sortedByRecency[0].paneId;
    const newBottom = sortedByRecency.length > 1 ? sortedByRecency[1].paneId : null;
    return [newTop, newBottom];
  }

  // Build the full ordered list of all terminal ids by recency.
  const allIds = sortedByRecency.map((t) => t.paneId);

  if (direction === 1) {
    // Forward: bottom moves to top, new bottom is the most-recent not in the pair.
    const newTop = bottom;
    const newBottom = allIds.find((id) => id !== newTop && id !== top) ?? top;
    return [newTop, newBottom];
  } else {
    // Backward: top moves to bottom, new top is the most-recent not in the pair.
    // For a pair [top, bottom], backward swaps their roles — bottom becomes top
    // and the previous top becomes bottom. With 2 terminals this is just a swap.
    if (terminals.length === 2) {
      return [bottom, top];
    }
    // 3+ terminals: find a "previous" terminal that isn't the current pair.
    // Take the most-recent terminal that is neither top nor bottom as new top,
    // keep the old top as the new bottom.
    const newTop = allIds.find((id) => id !== top && id !== bottom) ?? bottom;
    const newBottom = top;
    return [newTop, newBottom];
  }
}
