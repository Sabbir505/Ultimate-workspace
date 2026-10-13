// Tests the InlineDiagram gating: artifacts classified as `kind: "diagram"`
// OR `kind: "html"` render inline in the chat. Static content (SVG, no
// scripts/forms) renders in the sanitized measuring frame; interactive HTML
// webapps (with <script>, <form>, <button>) render LIVE inline — an
// allow-scripts sandboxed iframe with the postMessage resize handshake
// (Claude's custom-visuals model) — and the kebab offers the full-size tab.
// A `covered` artifact — one the per-turn changes row already lists, i.e. a
// file written/edited inside the working folder — renders NOTHING inline,
// except a genuine `kind: "diagram"` deliverable which keeps its frame.
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
    speechText: null,
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
    // generate_file — kind stays "html" (no relay:diagram marker), but
    // it should still render inline since it's visual content.
    mockedRead.mockResolvedValue(
      preview({ kind: "html", text: "<!doctype html><html><body><svg viewBox='0 0 100 50'><rect/></svg></body></html>" }),
    );
    const { container } = render(
      <InlineDiagram artifact={artifact("diagram.html")} onFallback={() => <div className="chip-fallback" />} />,
    );
    await waitFor(() => {
      expect(container.querySelector(".chat-diagram-frame")).not.toBeNull();
    });
    // The fallback chip must NOT have rendered.
    expect(container.querySelector(".chip-fallback")).toBeNull();
  });

  it("renders an interactive HTML webapp LIVE inline (no chip fallback)", async () => {
    // An HTML file with <script> or <form> is an interactive webapp — it now
    // renders live inline in an allow-scripts (no same-origin) iframe with
    // the postMessage resize reporter, instead of falling back to a chip.
    mockedRead.mockResolvedValue(
      preview({
        kind: "html",
        text: "<!doctype html><html><body><script>document.querySelector('button').onclick=()=>alert('hi')</script><button>Click</button></body></html>",
      }),
    );
    const { container } = render(
      <InlineDiagram artifact={artifact("app.html")} onFallback={() => <div className="chip-fallback" />} />,
    );
    await waitFor(() => {
      const frame = container.querySelector("iframe.chat-live-viz-frame");
      expect(frame).not.toBeNull();
    });
    const frame = container.querySelector("iframe.chat-live-viz-frame")!;
    const sandbox = frame.getAttribute("sandbox") ?? "";
    expect(sandbox).toContain("allow-scripts");
    expect(sandbox).not.toContain("allow-same-origin");
    expect(frame.getAttribute("srcdoc")).toContain("__relayInlineVizHeight");
    // The page's own script survives (live, not sanitized).
    expect(frame.getAttribute("srcdoc")).toContain("alert('hi')");
    expect(container.querySelector(".chip-fallback")).toBeNull();
  });

  it("renders inline for HTML with SVG + tiny script (styling only)", async () => {
    // A diagram with a small <script> for styling is still a diagram.
    mockedRead.mockResolvedValue(
      preview({
        kind: "html",
        text: "<!doctype html><html><body><svg viewBox='0 0 200 100'><rect/></svg><script>var x=1</script></body></html>",
      }),
    );
    const { container } = render(
      <InlineDiagram artifact={artifact("styled.html")} onFallback={() => <div className="chip-fallback" />} />,
    );
    await waitFor(() => {
      expect(container.querySelector(".chat-diagram-frame")).not.toBeNull();
    });
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

  it("renders NOTHING for an artifact the turn's changes row already covers", async () => {
    // A file written/edited inside the working folder is listed by the
    // per-turn changes row (Review / Open) — the bubble must not render a
    // second copy of it, neither as a live frame nor as a chip.
    mockedRead.mockResolvedValue(
      preview({ kind: "html", text: "<!doctype html><html><body><script>alert('hi')</script><button>Click</button></body></html>" }),
    );
    const onFallback = vi.fn(() => <div className="chip-fallback" />);
    const { container } = render(
      <InlineDiagram artifact={artifact("app.html")} covered onFallback={onFallback} />,
    );
    // "Loading diagram…" first, then the covered-gate drops the row entirely.
    await waitFor(() => {
      expect(container.firstChild).toBeNull();
    });
    expect(container.querySelector("iframe.chat-live-viz-frame")).toBeNull();
    expect(container.querySelector("iframe.chat-diagram-frame")).toBeNull();
    expect(container.querySelector(".chip-fallback")).toBeNull();
    expect(onFallback).not.toHaveBeenCalled();
  });

  it("still renders a covered diagram deliverable inline", async () => {
    // generate_diagram writes to the artifacts dir, never into a checkout —
    // even if its path ever shows up in the changes row, the inline frame
    // (the turn's visual result) stays.
    mockedRead.mockResolvedValue(
      preview({
        kind: "diagram",
        text: "<!doctype html><html><body><svg viewBox='0 0 100 50'></svg></body></html>",
      }),
    );
    const { container } = render(
      <InlineDiagram artifact={artifact()} covered onFallback={() => <div className="chip-fallback" />} />,
    );
    await waitFor(() => {
      expect(container.querySelector(".chat-diagram-frame")).not.toBeNull();
    });
    expect(container.querySelector(".chip-fallback")).toBeNull();
  });
});
