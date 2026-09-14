// Audit 2026-09-14 #2: the app had NO error boundary — any render error
// anywhere unmounted the whole tree into a blank webview with no way
// forward. The root boundary in main.tsx must (a) render children normally
// and (b) render a recoverable full-screen panel with a Reload action and
// the error message available (collapsed) when a child throws.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ErrorBoundary } from "../components/common/ErrorBoundary";

function Boom(): null {
  throw new Error("kaboom-test");
}

afterEach(() => {
  cleanup();
});

describe("ErrorBoundary root boundary", () => {
  it("renders children untouched when nothing throws", () => {
    render(
      <ErrorBoundary>
        <div data-testid="ok">fine</div>
      </ErrorBoundary>,
    );
    expect(screen.getByTestId("ok").textContent).toBe("fine");
  });

  it("renders the recover panel with Reload when a child throws", () => {
    // React logs the caught error to console.error — silence it for the run.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      render(
        <ErrorBoundary>
          <Boom />
        </ErrorBoundary>,
      );
      expect(screen.getByText("Something went wrong")).toBeTruthy();
      const reload = screen.getByText("Reload");
      expect((reload as HTMLButtonElement).tagName).toBe("BUTTON");
      // The raw message stays reachable (collapsed <details>) for bug reports.
      expect(document.querySelector("details")?.textContent).toContain("kaboom-test");
    } finally {
      errSpy.mockRestore();
    }
  });
});
