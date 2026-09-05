// B6 (ISSUES.md): PdfViewer's full-document search is unserialized — two
// overlapping searches (Enter while a slow scan is in flight) both wrote
// `setHits`, so whichever resolved LAST won even if it was the STALE query.
// A generation counter must discard superseded runs: the displayed hits must
// always correspond to the newest search.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";

const { pendingText } = vi.hoisted(() => ({
  pendingText: [] as Array<(v: { items: Array<{ str: string }> }) => void>,
}));

vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
  getDocument: () => ({
    promise: Promise.resolve({
      numPages: 1,
      getPage: async () => ({
        getViewport: () => ({ width: 595, height: 842 }),
        render: () => ({ promise: Promise.resolve() }),
        // Each search's getTextContent parks here until the test resolves
        // it — giving full control over completion order.
        getTextContent: () =>
          new Promise<{ items: Array<{ str: string }> }>((resolve) => {
            pendingText.push(resolve);
          }),
      }),
    }),
    destroy: () => {},
  }),
  // TextLayer is intentionally absent: pages never become visible under the
  // IntersectionObserver stub, so the component never constructs one (and a
  // `class` expression here trips a vi.mock hoisting bug in this vitest
  // version — transform TDZ).
}));

import { PdfViewer } from "../components/chat/PdfViewer";

/** jsdom lacks IntersectionObserver — keep pages non-visible so no canvas
 *  render machinery runs; search does not depend on visibility. */
if (typeof (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver === "undefined") {
  (globalThis as unknown as Record<string, unknown>).IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

afterEach(() => cleanup());

async function renderViewer() {
  // createElement (not JSX): the JSX runtime import interacts badly with the
  // hoisted vi.mock("pdfjs-dist") under this vitest version (transform TDZ).
  render(
    createElement(PdfViewer, {
      dataUri: "data:application/pdf;base64,AAAA",
      filename: "doc.pdf",
    }),
  );
  const input = (await screen.findByPlaceholderText("Search…")) as HTMLInputElement;
  // The Search button is disabled while the query is empty — typing first is
  // what enables it; by then the document is open too (Enter path is active).
  return { input };
}

/** Run one getTextContent parker by queue position (0 = first search). */
function resolveText(i: number, text: string) {
  const resolve = pendingText[i];
  if (resolve) resolve({ items: [{ str: text }] });
}

async function microtasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("PdfViewer search serialization", () => {
  it("keeps results from the SECOND query when the first resolves last", async () => {
    pendingText.length = 0;
    const { input } = await renderViewer();

    // Search #1: slow scan for "alpha".
    fireEvent.change(input, { target: { value: "alpha" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await microtasks();
    expect(pendingText.length).toBe(1);

    // Search #2 for "beta" starts while #1 is still parked in getTextContent.
    fireEvent.change(input, { target: { value: "beta" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await microtasks();
    expect(pendingText.length).toBe(2);

    // #2 completes FIRST with two hits, then the stale #1 lands with one.
    await act(async () => {
      resolveText(1, "beta one beta two");
      await Promise.resolve();
    });
    await act(async () => {
      resolveText(0, "alpha only");
      await Promise.resolve();
    });

    // The counter must reflect the NEWEST search (2 hits, match 1/2). With
    // the bug the stale single-hit result overwrote it ("1/1").
    expect(screen.getByText("1/2")).toBeTruthy();
  });
});
