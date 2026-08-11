// Tests the InlineDiagram gating: artifacts classified as `kind: "diagram"`
// OR `kind: "html"` render inline in the chat. This includes diagrams from
// generate_diagram (with the conduit:diagram marker) AND HTML files from
// write_file/generate_file — API/local models often create diagrams via those
// tools instead of generate_diagram, so both kinds render inline. Non-visual
// kinds (image, text, code) fall back to the download chip.
// readArtifactPreview is mocked so no live artifact on disk is needed.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { InlineDiagram } from "../components/chat/InlineDiagram";
import type { ArtifactPreview } from "../lib/ipc";
import type { ChatArtifact } from "../state/chat";

// jsdom has no ResizeObserver; InlineDiagram uses one to size the frame. Stub a
// no-op that calls back once so the measurement effect runs synchronously.
class RO {
  cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
  }
  observe(t: Element) {
    this.cb([{ target: t } as ResizeObserverEntry], this);
  }
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof RO }).ResizeObserver = RO;

vi.mock("../lib/ipc", () => ({
  readArtifactPreview: vi.fn(),
}));

const { readArtifactPreview } = await import("../lib/ipc");
const mockedRead = vi.mocked(readArtifactPreview);

function artifact(filename = "thing.html", path = "artifacts/thing"): ChatArtifact {
  return { path, filename };
}

function preview(over: Partial<ArtifactPreview>): ArtifactPreview {
  return {
    path: "artifacts/thing",
    filename: "thing.html",
    ext: "html",
    kind: "html",
    text: null,
    dataUri: null,
    size: 0,
    truncated: false,
    ...over,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("InlineDiagram gating (diagram vs plain html)", () => {
  it("renders an inline iframe for a true diagram artifact", async () => {
    mockedRead.mockResolvedValue(
      preview({
        kind: "diagram",
        text: "<!doctype html><html><body><svg viewBox='0 0 100 50'></svg></body></html>",
      }),
    );
    const { container } = render(
      <InlineDiagram artifact={artifact()} onFallback={() => <div className="chip-fallback" />} />,
    );
    await waitFor(() => {
      expect(container.querySelector(".chat-diagram-frame")).not.toBeNull();
    });
    // The fallback chip must NOT have rendered.
    expect(container.querySelector(".chip-fallback")).toBeNull();
  });

  it("renders an inline iframe for a plain html file (e.g. from write_file)", async () => {
    // API/local models often create HTML diagrams via write_file or
    // generate_file — kind stays "html" (no conduit:diagram marker), but
    // it should still render inline since it's visual content.
    mockedRead.mockResolvedValue(
      preview({ kind: "html", text: "<!doctype html><html><body><h1>My diagram</h1></body></html>" }),
    );
    const { container } = render(
      <InlineDiagram artifact={artifact("landing.html")} onFallback={() => <div className="chip-fallback" />} />,
    );
    await waitFor(() => {
      expect(container.querySelector(".chat-diagram-frame")).not.toBeNull();
    });
    // The fallback chip must NOT have rendered.
    expect(container.querySelector(".chip-fallback")).toBeNull();
  });

  it("falls back to the chip for an svg image artifact", async () => {
    // An .svg comes back as kind "image", not diagram — no inline frame.
    mockedRead.mockResolvedValue(
      preview({ kind: "image", ext: "svg", dataUri: "data:image/svg+xml;base64,AAAA" }),
    );
    const { container } = render(
      <InlineDiagram artifact={artifact("logo.svg")} onFallback={() => <div className="chip-fallback" />} />,
    );
    await waitFor(() => {
      expect(container.querySelector(".chip-fallback")).not.toBeNull();
    });
    expect(container.querySelector(".chat-diagram-frame")).toBeNull();
  });
});
