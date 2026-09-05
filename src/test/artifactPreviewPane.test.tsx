// Tests for ArtifactPreviewPane kind routing:
//   1. kind "mermaid" (.mmd/.mermaid artifacts) renders via MermaidDiagram.
//   2. Markdown previews render ```mermaid fences as diagrams (not code).
//   3. Interactive HTML renders the LIVE iframe (allow-scripts), static
//      diagrams keep the sanitized frame.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

vi.mock("../lib/ipc", () => ({
  readArtifactPreview: vi.fn(),
  downloadArtifact: vi.fn(),
  openArtifact: vi.fn(),
  isLibreofficeAvailable: vi.fn().mockResolvedValue(true),
  // Default: no mtime (file stat unavailable) — the pane keeps the last render.
  getFileMtime: vi.fn().mockResolvedValue(null),
}));
// Stub the heavy children — mermaid's bundle doesn't run under jsdom and the
// JSX sandbox document is covered by jsxPreviewRuntime.test.ts.
vi.mock("../components/chat/MermaidDiagram", () => ({
  MermaidDiagram: ({ code }: { code: string }) => (
    <div data-testid="mermaid-stub" data-code={code} />
  ),
}));
vi.mock("../components/chat/JsxPreview", () => ({
  JsxPreview: () => <div data-testid="jsx-stub" />,
}));

const { readArtifactPreview, getFileMtime } = await import("../lib/ipc");
const readMock = vi.mocked(readArtifactPreview);
const mtimeMock = vi.mocked(getFileMtime);
import { ArtifactPreviewPane } from "../components/chat/ArtifactPreviewPane";

function basePreview(over: Record<string, unknown> = {}) {
  return {
    path: "D:/artifacts/x",
    filename: "x",
    ext: "txt",
    kind: "text",
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

describe("ArtifactPreviewPane kind routing", () => {
  it("renders .mmd/.mermaid artifacts as diagrams via MermaidDiagram", async () => {
    readMock.mockResolvedValue(
      basePreview({
        kind: "mermaid",
        ext: "mmd",
        filename: "flow.mmd",
        text: "flowchart TD\n  A --> B",
      }) as never,
    );
    const { container } = render(
      <ArtifactPreviewPane artifact={{ path: "D:/artifacts/flow.mmd", filename: "flow.mmd" }} onClose={() => {}} />,
    );

    await waitFor(() => {
      const stub = container.querySelector('[data-testid="mermaid-stub"]');
      expect(stub).not.toBeNull();
    });
    const stub = container.querySelector('[data-testid="mermaid-stub"]')!;
    expect(stub.getAttribute("data-code")).toContain("flowchart TD");
  });

  it("renders mermaid fences inside markdown previews as diagrams", async () => {
    readMock.mockResolvedValue(
      basePreview({
        kind: "markdown",
        ext: "md",
        filename: "report.md",
        text: [
          "# Report",
          "",
          "```mermaid",
          "sequenceDiagram A->>B: hi",
          "```",
          "",
          "```js",
          "const x = 1;",
          "```",
        ].join("\n"),
      }) as never,
    );
    const { container } = render(
      <ArtifactPreviewPane artifact={{ path: "D:/artifacts/report.md", filename: "report.md" }} onClose={() => {}} />,
    );

    await waitFor(() => {
      expect(container.querySelector('[data-testid="mermaid-stub"]')).not.toBeNull();
    });
    // The mermaid fence carried the diagram source to the stub…
    const stub = container.querySelector('[data-testid="mermaid-stub"]')!;
    expect(stub.getAttribute("data-code")).toContain("sequenceDiagram");
    // …and the plain code fence still renders as code.
    expect(container.querySelector("code.language-js")).not.toBeNull();
  });

  it("renders interactive HTML with the live allow-scripts iframe", async () => {
    readMock.mockResolvedValue(
      basePreview({
        kind: "html",
        ext: "html",
        filename: "app.html",
        text: "<button onclick=\"alert('hi')\">go</button><script>1+1</script>",
      }) as never,
    );
    const { container } = render(
      <ArtifactPreviewPane artifact={{ path: "D:/artifacts/app.html", filename: "app.html" }} onClose={() => {}} />,
    );

    await waitFor(() => {
      const frame = container.querySelector("iframe.artifact-preview-html");
      expect(frame).not.toBeNull();
    });
    const frame = container.querySelector("iframe.artifact-preview-html")!;
    const sandbox = frame.getAttribute("sandbox") ?? "";
    expect(sandbox).toContain("allow-scripts");
    expect(sandbox).toContain("allow-forms");
    expect(sandbox).not.toContain("allow-same-origin");
  });

  it("keeps static diagrams on the sanitized scripts-blocked frame", async () => {
    readMock.mockResolvedValue(
      basePreview({
        kind: "diagram",
        ext: "html",
        filename: "d.html",
        text: "<svg width='100' height='100'><rect /></svg>",
      }) as never,
    );
    const { container } = render(
      <ArtifactPreviewPane artifact={{ path: "D:/artifacts/d.html", filename: "d.html" }} onClose={() => {}} />,
    );

    await waitFor(() => {
      expect(container.querySelector("iframe.artifact-preview-diagram-frame")).not.toBeNull();
    });
    const frame = container.querySelector("iframe.artifact-preview-diagram-frame")!;
    expect(frame.getAttribute("sandbox")).toBe("allow-same-origin");
    // Sanitized: no script tags survive into the srcDoc.
    expect(frame.getAttribute("srcdoc")).not.toContain("<script");
  });

  it("hot-reloads the preview when the file's mtime changes on disk", async () => {
    vi.useFakeTimers();
    try {
      mtimeMock.mockResolvedValue(100);
      readMock.mockResolvedValue(basePreview({ kind: "text", text: "v1" }) as never);
      const { container } = render(
        <ArtifactPreviewPane artifact={{ path: "D:/artifacts/x.txt", filename: "x.txt" }} onClose={() => {}} />,
      );
      await vi.waitFor(() => {
        expect(container.textContent).toContain("v1");
      });

      // The model edits the file: mtime moves, content changes. The next poll
      // tick must re-read and swap the preview without any user action.
      mtimeMock.mockResolvedValue(200);
      readMock.mockResolvedValue(basePreview({ kind: "text", text: "v2" }) as never);
      const callsBefore = readMock.mock.calls.length;
      await vi.advanceTimersByTimeAsync(2_100);

      await vi.waitFor(() => {
        expect(container.textContent).toContain("v2");
      });
      expect(readMock.mock.calls.length).toBeGreaterThan(callsBefore);
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders an inline mermaid SVG inside the zoom/pan canvas", () => {
    // "Open in tab" on a ```mermaid fence passes the diagram inline (no file
    // on disk). It must flow through the canvas path (wheel zoom + drag pan
    // machinery) — the old inline branch rendered a bare static div with no
    // zooming at all.
    const { container } = render(
      <ArtifactPreviewPane
        artifact={{
          path: "flow.svg",
          filename: "flow.svg",
          inline: { kind: "svg", code: "<svg width='120' height='80'><rect width='120' height='80' /></svg>" },
        }}
        onClose={() => {}}
      />,
    );

    const canvas = container.querySelector(".artifact-canvas");
    expect(canvas).not.toBeNull();
    // The sanitized diagram itself renders inside the canvas…
    const svg = canvas!.querySelector(".chat-mermaid-svg svg");
    expect(svg).not.toBeNull();
    // …on the pannable content (gestures attached), with the canvas
    // transform applied at the initial zoom.
    expect(container.querySelector(".artifact-preview-content.pannable")).not.toBeNull();
    expect((canvas as HTMLElement).style.transform).toContain("scale(1)");
    // No header for inline artifacts: download/open-in-app would hit a path
    // that has no file on disk.
    expect(container.querySelector(".artifact-preview-header")).toBeNull();
  });
});
