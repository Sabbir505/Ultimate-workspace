// Unit tests for ArtifactCardThumb under the redesigned "folded document card"
// layout. Text-like artifacts (text/markdown/code/json/csv) show a faint
// monospaced snippet when content is available, else an outline icon; non-text
// artifacts always show the outline icon (no content is fetched). readArtifactPreview
// is mocked so no live artifact on disk is needed.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { ArtifactCardThumb } from "../components/sidebar/ArtifactLibrary";
import type { ArtifactPreview, ArtifactRecord } from "../lib/ipc";

vi.mock("../lib/ipc", () => ({
  readArtifactPreview: vi.fn(),
  listArtifacts: vi.fn(),
  listChatArtifacts: vi.fn(),
  deleteArtifact: vi.fn(),
  openArtifact: vi.fn(),
  downloadArtifact: vi.fn(),
  downloadArtifactsZip: vi.fn(),
}));

const { readArtifactPreview } = await import("../lib/ipc");
const mockedRead = vi.mocked(readArtifactPreview);

function record(kind: string, path = "artifacts/thing", filename = "thing"): ArtifactRecord {
  return {
    id: "1",
    chatSessionId: null,
    chatMessageId: null,
    filename,
    path,
    kind,
    createdAt: 0,
    expiresAt: 0,
  };
}

function preview(over: Partial<ArtifactPreview>): ArtifactPreview {
  return {
    path: "artifacts/thing",
    filename: "thing",
    ext: "txt",
    kind: "text",
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

describe("ArtifactCardThumb (document-card layout)", () => {
  it("shows a faint text snippet for text artifacts with content", async () => {
    mockedRead.mockResolvedValue(
      preview({ kind: "text", ext: "txt", text: "hello\nworld\nline3" }),
    );
    const { container } = render(<ArtifactCardThumb artifact={record("txt")} />);
    await waitFor(() => {
      const snippet = container.querySelector(".doc-card-snippet pre");
      expect(snippet).not.toBeNull();
      expect(snippet?.textContent).toContain("hello");
    });
    expect(container.querySelector(".doc-card-icon")).toBeNull();
  });

  it("shows a text snippet for markdown artifacts", async () => {
    mockedRead.mockResolvedValue(
      preview({ kind: "markdown", ext: "md", text: "# Title\nsome paragraph" }),
    );
    const { container } = render(<ArtifactCardThumb artifact={record("md")} />);
    await waitFor(() => {
      const snippet = container.querySelector(".doc-card-snippet pre");
      expect(snippet).not.toBeNull();
      expect(snippet?.textContent).toContain("Title");
    });
  });

  it("shows a text snippet for code artifacts", async () => {
    mockedRead.mockResolvedValue(
      preview({ kind: "code", ext: "ts", text: "const x = 1;\nreturn x;" }),
    );
    const { container } = render(<ArtifactCardThumb artifact={record("ts")} />);
    await waitFor(() => {
      expect(container.querySelector(".doc-card-snippet pre")).not.toBeNull();
    });
  });

  it("truncates the snippet to the first 7 lines", async () => {
    const body = Array.from({ length: 12 }, (_, i) => `line${i + 1}`).join("\n");
    mockedRead.mockResolvedValue(preview({ kind: "code", ext: "ts", text: body }));
    const { container } = render(<ArtifactCardThumb artifact={record("ts")} />);
    await waitFor(() => {
      const snippet = container.querySelector(".doc-card-snippet pre");
      expect(snippet?.textContent).toContain("line1");
      expect(snippet?.textContent).toContain("line7");
      expect(snippet?.textContent).not.toContain("line8");
    });
  });

  it("shows the outline icon for non-text artifacts (image)", async () => {
    // The preview is fetched, but since its kind is "image" (not a text kind),
    // the card renders the outline icon — no <img>/<iframe>/<embed>.
    mockedRead.mockResolvedValue(
      preview({ kind: "image", ext: "png", dataUri: "data:image/png;base64,AAAA" }),
    );
    const { container } = render(<ArtifactCardThumb artifact={record("png")} />);
    await waitFor(() => {
      const icon = container.querySelector(".doc-card-icon");
      expect(icon).not.toBeNull();
      expect(icon?.querySelector("svg")).not.toBeNull();
    });
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.querySelector("embed")).toBeNull();
    expect(mockedRead).toHaveBeenCalled();
  });

  it("shows the outline icon for PDF artifacts (no live embed)", async () => {
    mockedRead.mockResolvedValue(
      preview({ kind: "pdf", ext: "pdf", dataUri: "data:application/pdf;base64,AAAA" }),
    );
    const { container } = render(<ArtifactCardThumb artifact={record("pdf")} />);
    await waitFor(() => {
      expect(container.querySelector(".doc-card-icon svg")).not.toBeNull();
    });
    expect(container.querySelector("embed")).toBeNull();
  });

  it("shows the outline icon for office/binary artifacts", async () => {
    mockedRead.mockResolvedValue(preview({ kind: "binary", ext: "docx", text: null }));
    const { container } = render(<ArtifactCardThumb artifact={record("docx")} />);
    await waitFor(() => {
      expect(container.querySelector(".doc-card-icon svg")).not.toBeNull();
    });
  });

  it("shows the outline icon for html/diagram artifacts (no live iframe)", async () => {
    mockedRead.mockResolvedValue(
      preview({ kind: "diagram", ext: "svg", text: "<svg></svg>" }),
    );
    const { container } = render(<ArtifactCardThumb artifact={record("svg")} />);
    await waitFor(() => {
      expect(container.querySelector(".doc-card-icon svg")).not.toBeNull();
    });
    expect(container.querySelector("iframe")).toBeNull();
  });

  it("falls back to the icon for a text artifact when read fails", async () => {
    mockedRead.mockRejectedValue(new Error("boom"));
    const { container } = render(<ArtifactCardThumb artifact={record("txt")} />);
    await waitFor(() => {
      expect(container.querySelector(".doc-card-icon svg")).not.toBeNull();
    });
    expect(container.querySelector(".doc-card-snippet")).toBeNull();
  });

  it("falls back to the icon for a text artifact with no readable text", async () => {
    mockedRead.mockResolvedValue(preview({ kind: "text", ext: "txt", text: null }));
    const { container } = render(<ArtifactCardThumb artifact={record("txt")} />);
    await waitFor(() => {
      expect(container.querySelector(".doc-card-icon svg")).not.toBeNull();
    });
    expect(container.querySelector(".doc-card-snippet")).toBeNull();
  });
});
