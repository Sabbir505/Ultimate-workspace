# Task: Visual Feedback Layer for Agent-Driven Browser Actions (Cursor, Typing, Highlights)

## Context

Companion task `task-conduit-browser-mcp.md` makes it functionally possible for a Dev-tab agent to control the browser pane via DOM injection (no real OS-level cursor exists in this approach — it's element-targeted, not pixel-coordinate-based). This task adds a purely visual layer so a human watching the pane can actually follow what's happening, the way Devin's browser sessions are watchable — a synthetic cursor that moves, click ripples, animated typing, and pre-action element highlights. None of this affects how the agent actually interacts with the page; it's overlay-only, for the human.

## What to build

All of this lives in the same JS bridge injected into the pane (extend the bridge from the browser-extraction/MCP tasks, don't create a separate injection mechanism).

### 1. Synthetic cursor overlay

- A small fixed-position cursor icon element, absolutely positioned, injected once per page load (re-inject on navigation, since a fresh page load clears injected DOM).
- Before any `click`/`type` action targets an element: compute the target's position via `getBoundingClientRect()` (already needed for element targeting regardless of this task), then animate the cursor from its last known position to the target over ~300-500ms using a CSS transition or `requestAnimationFrame` tween — not an instant jump.
- Only after the tween completes does the actual click/input event fire — sequence matters, don't fire the real action concurrently with the animation.

### 2. Click feedback

- A brief expanding-ripple effect (small circle, scale + fade over ~250-400ms) centered on the click point, so a click reads as a discrete visible event rather than a silent DOM mutation with no on-screen indication anything happened.

### 3. Animated typing

- Instead of setting an input's value in one bulk operation, insert text character by character with a small per-character delay (~30-60ms, slightly randomized +/-15ms so it doesn't look robotically uniform).
- Dispatch real `input` and `keydown`/`keyup` events per character (not just a final `input` event after the fact) — this matters functionally, not just visually, since React/Vue-style controlled inputs on the page under test need per-keystroke events to register the change correctly, same as a real user typing.
- Show a visible blinking caret at the current insertion point during this process.

### 4. Pre-action element highlight

- A brief glow/outline on the target element (reuse the existing pane-state glow visual language already used elsewhere in the app for consistency) that appears just before the cursor arrives and fades shortly after the action completes — gives a "this is what's about to happen" cue distinct from the cursor/click feedback itself.

### 5. Deliberate action pacing

- Add a configurable delay between discrete agent actions (default ~400-800ms) purely for watchability — the underlying DOM operations are instant, this delay exists so a human can follow the sequence rather than see a UI blur through ten actions in 50ms.
- Make this a Settings-level or per-session toggle (e.g. "Watch mode" on/off, or a speed slider) — an agent running unattended overnight doesn't need artificial pacing burning wall-clock time; a user actively watching the pane does. Default: on, when a human is likely to be watching (e.g. pane is currently focused/visible); consider auto-disabling pacing for panes that are backgrounded/not currently visible, to avoid slowing down agent work nobody's watching.

## Acceptance criteria

- [ ] Cursor overlay visibly tweens from last position to each new target before the real click/type action fires — verified by watching an agent session interact with a real page.
- [ ] Click ripple appears at the correct coordinates on every click action.
- [ ] Typing animates character-by-character with visible caret, and the target page's own input handling correctly registers the typed value (test against a real controlled-input form, e.g. a React form with an `onChange` handler, to confirm per-keystroke events aren't silently swallowed).
- [ ] Element highlight appears before interaction and fades appropriately after.
- [ ] Watch-mode pacing delay is configurable and defaults sensibly (on for focused/visible panes, reduced or off for backgrounded ones).
- [ ] Overlay elements (cursor, ripples, highlights) are correctly re-injected after page navigation and never interfere with the actual page's own functionality (verify they don't intercept clicks meant for the real page, don't get captured in the `read_page` accessibility-tree output as if they were real page content, and don't appear in any screenshot/export the user takes of the page itself).
- [ ] Regression check: `conduit-browser-mcp`'s functional tool calls (from the companion task) still work correctly with this visual layer active — confirm the animation delay doesn't introduce race conditions where a tool call's result is read before the visual sequence (and underlying action) has actually completed.

## Out of scope for this task

- Any change to how elements are targeted/read (accessibility tree, selectors) — this task is purely the visual overlay on top of targeting that already works via the companion task.

## Process reminder

Per PRD §13: this is a visually-judged feature — do a real manual watch-through against a live local dev server as the primary verification method, not just automated checks that the DOM elements exist. Log in `BUILD_LOG.md` which pacing/timing values were chosen and why, since these are subjective tuning decisions (300ms vs 500ms cursor tween, etc.) worth being able to revisit later rather than treating as arbitrary constants buried in code.
