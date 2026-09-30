// Tests for inline chat visuals (InlineDiagram):
//   1. Static diagrams keep the sanitized, scripts-blocked measuring frame.
//   2. Interactive HTML (scripts/buttons) renders LIVE inline — an
//      allow-scripts iframe (no same-origin) with the postMessage resize
//      reporter injected, clamped to the height bounds — and does NOT fall
//      back to a chip.
//   3. The postMessage handshake clamps runaway heights.
//   4. Non-visual kinds still fall back (chip).
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { fireEvent } from "@testing-library/react";

vi.mock("../lib/ipc", () => ({
  readArtifactPreview: vi.fn(),
  downloadArtifact: vi.fn(),
}));

const { readArtifactPreview } = await import("../lib/ipc");
const readMock = vi.mocked(readArtifactPreview);
import { InlineDiagram } from "../components/chat/InlineDiagram";

const artifact = { path: "D:/artifacts/viz.html", filename: "viz.html" };

function basePreview(over: Record<string, unknown> = {}) {
  return {
    path: artifact.path,
    filename: artifact.filename,
    ext: "html",
    kind: "html",
    text: null as string | null,
    dataUri: null as string | null,
    originalBytes: null,
    size: 10,
    truncated: false,
    ...over,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** jsdom lays nothing out, so the frame-sizing code reads a column width of 0
 *  and never leaves the "fits as-is" branch. Give the block a real width. */
function stubChatColumnWidth(px: number): () => void {
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get: () => px,
  });
  return () => {
    if (original) Object.defineProperty(HTMLElement.prototype, "clientWidth", original);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth;
  };
}

describe("InlineDiagram", () => {
  it("renders static diagrams with the sanitized scripts-blocked frame", async () => {
    readMock.mockResolvedValue(
      basePreview({ text: "<svg width='100' height='80'><rect /></svg>" }) as never,
    );
    const onFallback = vi.fn(() => <div>chip</div>);
    const { container } = render(<InlineDiagram artifact={artifact} onFallback={onFallback} />);

    await waitFor(() => {
      expect(container.querySelector("iframe.chat-diagram-frame")).not.toBeNull();
    });
    const frame = container.querySelector("iframe.chat-diagram-frame")!;
    expect(frame.getAttribute("sandbox")).toBe("allow-same-origin");
    expect(frame.getAttribute("srcdoc")).not.toContain("<script");
    expect(onFallback).not.toHaveBeenCalled();
  });

  it("renders interactive HTML live inline instead of falling back to a chip", async () => {
    readMock.mockResolvedValue(
      basePreview({
        text: "<button id='go' onclick='go()'>Run</button><script>function go(){}</script>",
      }) as never,
    );
    const onFallback = vi.fn(() => <div>chip</div>);
    const { container } = render(<InlineDiagram artifact={artifact} onFallback={onFallback} />);

    await waitFor(() => {
      expect(container.querySelector("iframe.chat-live-viz-frame")).not.toBeNull();
    });
    const frame = container.querySelector("iframe.chat-live-viz-frame")!;
    const sandbox = frame.getAttribute("sandbox") ?? "";
    expect(sandbox).toContain("allow-scripts");
    expect(sandbox).not.toContain("allow-same-origin");
    // The postMessage resize reporter is injected into the document…
    expect(frame.getAttribute("srcdoc")).toContain("__relayInlineVizHeight");
    // …the page's own script survives (live, not sanitized)…
    expect(frame.getAttribute("srcdoc")).toContain("function go()");
    // …and no chip fallback happened.
    expect(onFallback).not.toHaveBeenCalled();
  });

  it("clamps the live frame height reported via postMessage", async () => {
    readMock.mockResolvedValue(
      basePreview({ text: "<script>document.body.style.height='9000px'</script>" }) as never,
    );
    const { container } = render(
      <InlineDiagram artifact={artifact} onFallback={() => <div>chip</div>} />,
    );
    await waitFor(() => {
      expect(container.querySelector("iframe.chat-live-viz-frame")).not.toBeNull();
    });
    const frame = container.querySelector("iframe.chat-live-viz-frame") as HTMLIFrameElement;
    // The handshake now requires the report to come from the frame's own
    // contentWindow and carry the per-instance token embedded in the srcdoc
    // script (B4) — simulate exactly what the injected reporter posts.
    const fakeWin = {} as Window;
    Object.defineProperty(frame, "contentWindow", { value: fakeWin });
    const token = /__relayInlineVizToken:"([^"]+)"/.exec(
      frame.getAttribute("srcdoc") ?? "",
    )?.[1];

    // A runaway page reports a huge height — the frame clamps at 520px.
    fireEvent(window, new MessageEvent("message", { source: fakeWin, data: { __relayInlineVizHeight: 9000, __relayInlineVizToken: token } }));
    await waitFor(() => {
      const h = (container.querySelector("iframe.chat-live-viz-frame") as HTMLElement).style.height;
      expect(h).toBe("520px");
    });

    // Below the floor clamps up to 120px.
    fireEvent(window, new MessageEvent("message", { source: fakeWin, data: { __relayInlineVizHeight: 20, __relayInlineVizToken: token } }));
    await waitFor(() => {
      const h = (container.querySelector("iframe.chat-live-viz-frame") as HTMLElement).style.height;
      expect(h).toBe("120px");
    });
  });

  it("falls back to the chip for non-visual kinds", async () => {
    readMock.mockResolvedValue(basePreview({ kind: "text", text: "plain notes" }) as never);
    const onFallback = vi.fn(() => <div>chip</div>);
    render(<InlineDiagram artifact={artifact} onFallback={onFallback} />);

    await waitFor(() => {
      expect(onFallback).toHaveBeenCalled();
    });
  });

  it("caps a too-tall inline artifact at a fixed height and fits it to the card", async () => {
    // A tall flowchart: 600x3000 at the chat's ~456px content width would be
    // ~2280px tall — taller than the viewport.
    readMock.mockResolvedValue(
      basePreview({
        text: '<svg viewBox="0 0 600 3000" width="600" height="3000"><rect /></svg>',
      }) as never,
    );
    const restore = stubChatColumnWidth(480);
    try {
      const { container } = render(
        <InlineDiagram artifact={artifact} onFallback={() => <div>chip</div>} />,
      );

      const frame = await waitFor(() => {
        const el = container.querySelector<HTMLElement>("iframe.chat-diagram-frame");
        expect(el).not.toBeNull();
        return el!;
      });
      // The first paint sizes from an unknown column width; the width effect
      // settles the frame on the next commit.
      await waitFor(() => expect(frame.style.height).toBe("520px"));
      const h = parseInt(frame.style.height, 10);
      expect(h).toBeGreaterThan(0);
      expect(h).toBeLessThanOrEqual(520);
      // The card narrows to the diagram's aspect so the scaled drawing fills
      // it instead of floating in a full-width white box.
      const block = container.querySelector<HTMLElement>(".chat-diagram-block")!;
      expect(parseInt(block.style.maxWidth, 10)).toBeLessThan(480);
      // …and the injected fit style caps the SVG's height so the diagram
      // scales INTO the fixed frame rather than overflowing it.
      expect(frame.getAttribute("srcdoc")).toContain("max-height:100%!important");
    } finally {
      restore();
    }
  });

  it("leaves a short inline artifact at its natural height", async () => {
    readMock.mockResolvedValue(
      basePreview({ text: '<svg viewBox="0 0 400 200" width="400" height="200"><rect /></svg>' }) as never,
    );
    const restore = stubChatColumnWidth(480);
    try {
      const { container } = render(
        <InlineDiagram artifact={artifact} onFallback={() => <div>chip</div>} />,
      );
      const frame = await waitFor(() => {
        const el = container.querySelector<HTMLElement>("iframe.chat-diagram-frame");
        expect(el).not.toBeNull();
        return el!;
      });
      // Settles on the column's natural height (the pre-measure floor is 120).
      await waitFor(() => expect(parseInt(frame.style.height, 10)).toBeGreaterThan(120));
      // Landscape: fits the column without the cap kicking in.
      expect(parseInt(frame.style.height, 10)).toBeLessThan(520);
      // No fitted width: it stays as wide as the card allows.
      expect(container.querySelector<HTMLElement>(".chat-diagram-block")!.style.maxWidth).toBe("");
    } finally {
      restore();
    }
  });
});
