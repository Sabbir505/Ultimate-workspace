// VaultPdfViewer page rendering — specifically the cancellation path.
// pdf.js rejects a render task with RenderingCancelledException whenever a
// newer render supersedes it or the document is destroyed, which this viewer
// does routinely (zoom remounts every page; the split resize re-fits them;
// closing the note destroys the doc). Those rejections used to escape the
// `void renderPage(n)` call as "Uncaught (in promise)" spam, and a cancelled
// page stayed marked rendered — so it drew blank until the next zoom.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "@testing-library/react";

const getDocumentMock = vi.fn();
const destroyMock = vi.fn();

vi.mock("pdfjs-dist", async (importOriginal) => {
  const mod = await importOriginal<Record<string, unknown>>();
  return { ...mod, getDocument: (...a: unknown[]) => getDocumentMock(...a) };
});

vi.mock("../lib/ipc", () => ({
  vaultReadBinary: vi.fn().mockResolvedValue(["application/pdf", ""]),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

import { VaultPdfViewer } from "../components/vault/VaultPdfViewer";

/** pdf.js signals a cancelled task with this error NAME. */
function cancelled() {
  const e = new Error("Rendering cancelled");
  e.name = "RenderingCancelledException";
  return e;
}

/** A document whose page renders resolve or reject on demand. */
function fakeDoc(render: () => Promise<void>, textContent: () => Promise<unknown> = async () => ({ items: [] })) {
  return {
    numPages: 1,
    destroy: (...a: unknown[]) => destroyMock(...a),
    getPage: async () => ({
      getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }),
      render: () => ({ promise: render(), cancel() {} }),
      getTextContent: textContent,
    }),
  };
}

// jsdom has no IntersectionObserver, and the viewer only renders a page once
// one is reported intersecting. Report every observed element immediately.
class ImmediateObserver {
  constructor(private cb: (entries: { isIntersecting: boolean; target: Element }[]) => void) {}
  observe(el: Element) {
    this.cb([{ isIntersecting: true, target: el }]);
  }
  unobserve() {}
  disconnect() {}
}

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IntersectionObserver", ImmediateObserver);
  // jsdom ships no canvas 2D context, and renderPage bails on a null ctx —
  // which would make every test below pass without ever calling page.render().
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({})) as never;
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("VaultPdfViewer render cancellation", () => {
  it("treats a text-layer request that outlives its worker as an abort, not a failure", async () => {
    // "Worker task was terminated" is what pdf.js reports when getTextContent
    // is in flight and the document is destroyed (note closed, file switched).
    const terminated = new Error("Worker task was terminated");
    getDocumentMock.mockReturnValue({
      promise: Promise.resolve(
        fakeDoc(() => Promise.resolve(), () => Promise.reject(terminated)),
      ),
      destroy: (...a: unknown[]) => destroyMock(...a),
    });
    await act(async () => {
      const { render } = await import("@testing-library/react");
      render(<VaultPdfViewer path="Journal/spec.pdf" />);
      await new Promise((r) => setTimeout(r, 30));
    });
    // The canvas already painted; losing the text layer costs selection on
    // that page only, so it must not be reported as an error.
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("does not build a text layer into a page element that was remounted mid-render", async () => {
    // Page elements are keyed on zoom + pane width, so a zoom landing during
    // a render leaves the captured host detached. TextLayer walks up from its
    // container to find the page and throws ("Node cannot be found in the
    // current page") when handed a dead subtree.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    let textCalls = 0;
    getDocumentMock.mockReturnValue({
      promise: Promise.resolve(
        fakeDoc(
          () => Promise.resolve(),
          () => {
            textCalls += 1;
            // Simulate the remount landing between the render and the text
            // request: drop the page subtree the closure captured.
            document.querySelector(".pdf-pages")?.replaceChildren();
            return Promise.resolve({ items: [] });
          },
        ),
      ),
      destroy: (...a: unknown[]) => destroyMock(...a),
    });
    await act(async () => {
      const { render } = await import("@testing-library/react");
      render(<VaultPdfViewer path="Journal/spec.pdf" />);
      await new Promise((r) => setTimeout(r, 30));
    });
    // The text request itself is fine; what must not happen is TextLayer
    // being constructed against the detached container.
    expect(textCalls).toBe(1);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("swallows a cancelled render instead of letting it escape as an unhandled rejection", async () => {
    getDocumentMock.mockReturnValue({
      promise: Promise.resolve(fakeDoc(() => Promise.reject(cancelled()))),
      destroy: (...a: unknown[]) => destroyMock(...a),
    });
    await act(async () => {
      const { render } = await import("@testing-library/react");
      render(<VaultPdfViewer path="Journal/spec.pdf" />);
      // Let the load effect, getPage and the render settle.
      await new Promise((r) => setTimeout(r, 30));
    });
    // Cancellation is a normal outcome, not something to report: nothing
    // reached the console, and nothing rejected unhandled (the test would
    // have failed on an unhandled rejection).
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("still surfaces a genuine render failure", async () => {
    const boom = new Error("canvas exploded");
    getDocumentMock.mockReturnValue({
      promise: Promise.resolve(fakeDoc(() => Promise.reject(boom))),
      destroy: (...a: unknown[]) => destroyMock(...a),
    });
    await act(async () => {
      const { render } = await import("@testing-library/react");
      render(<VaultPdfViewer path="Journal/spec.pdf" />);
      await new Promise((r) => setTimeout(r, 30));
    });
    // A real fault must not be hidden by the cancellation handling.
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("page 1 failed to render"),
      boom,
    );
  });

  it("destroys the document on unmount, which is what cancels in-flight renders", async () => {
    getDocumentMock.mockReturnValue({
      promise: Promise.resolve(fakeDoc(() => Promise.resolve())),
      destroy: (...a: unknown[]) => destroyMock(...a),
    });
    let unmount!: () => void;
    await act(async () => {
      const { render } = await import("@testing-library/react");
      ({ unmount } = render(<VaultPdfViewer path="Journal/spec.pdf" />));
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(destroyMock).not.toHaveBeenCalled();
    await act(async () => {
      unmount();
    });
    expect(destroyMock).toHaveBeenCalled();
  });
});
