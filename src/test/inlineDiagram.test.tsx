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
    expect(frame.getAttribute("srcdoc")).toContain("__conduitInlineVizHeight");
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

    // A runaway page reports a huge height — the frame clamps at 520px.
    fireEvent(window, new MessageEvent("message", { data: { __conduitInlineVizHeight: 9000 } }));
    await waitFor(() => {
      const h = (container.querySelector("iframe.chat-live-viz-frame") as HTMLElement).style.height;
      expect(h).toBe("520px");
    });

    // Below the floor clamps up to 120px.
    fireEvent(window, new MessageEvent("message", { data: { __conduitInlineVizHeight: 20 } }));
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
});
