// A7 (ISSUES.md): loadSyntaxHighlighter cached the import promise in `loading`
// WITHOUT resetting it on rejection — a single failed dynamic import (dev-
// server hiccup, chunk fetch error) left a rejected promise cached forever,
// so every later code block rendered unhighlighted for the whole app session.
// The fix resets `loading = null` in a .catch so the next call retries.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const importState = vi.hoisted(() => ({
  // Start failing; the test flips this after the first (expected) failure.
  fail: true,
  attempts: 0,
}));

vi.mock("react-syntax-highlighter", () => {
  importState.attempts++;
  if (importState.fail) {
    throw new Error("chunk fetch failed");
  }
  return { Prism: function FakePrism() { return null; } };
});

import { loadSyntaxHighlighter } from "../lib/syntaxHighlighter";

beforeEach(() => {
  importState.fail = true;
  importState.attempts = 0;
});

afterEach(() => {
  importState.fail = false;
});

describe("A7: a failed lazy import is retried on the next call", () => {
  it("rejects once, retries, then resolves from cache (single lifecycle)", async () => {
    // 1) First call: the import fails.
    await expect(loadSyntaxHighlighter()).rejects.toThrow();
    expect(importState.attempts).toBe(1);

    // 2) Simulate the environment healing (chunk reachable now) — the next
    // call must RETRY the dynamic import instead of replaying the cached
    // rejected promise.
    importState.fail = false;
    const component = await loadSyntaxHighlighter();
    expect(component).toBeTypeOf("function");
    expect(importState.attempts).toBeGreaterThanOrEqual(2);

    // 3) A succeeded import resolves synchronously from cache (no further
    // import attempts).
    const again = await loadSyntaxHighlighter();
    expect(again).toBe(component);
  });
});
