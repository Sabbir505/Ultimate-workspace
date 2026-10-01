// SS4.6.5: the CSV preview windows its body rows through
// @tanstack/react-virtual once they exceed CSV_VIRTUAL_THRESHOLD — a 50k-row
// export used to mount every <tr> at once and freeze the pane. Small tables
// keep the plain full render (copy/select, tests, a11y all unchanged).
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

vi.mock("../lib/ipc", () => ({
  readArtifactPreview: vi.fn(),
  isLibreofficeAvailable: vi.fn().mockResolvedValue(true),
  getFileMtime: vi.fn().mockResolvedValue(null),
  downloadArtifact: vi.fn(),
  openArtifact: vi.fn(),
}));

import { ArtifactPreviewPane } from "../components/chat/ArtifactPreviewPane";

const { readArtifactPreview } = await import("../lib/ipc");
const readMock = vi.mocked(readArtifactPreview);

// Same jsdom accommodation as automationStop.test.tsx: the virtualizer
// sizes its viewport from offsetWidth/offsetHeight, both 0 under jsdom.
beforeAll(() => {
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(400);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(900);
});

afterAll(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function csvText(rows: number): string {
  const lines = ["a,b,c"];
  for (let i = 0; i < rows; i++) lines.push(`${i},cell${i},tail`);
  return lines.join("\n");
}

function basePreview(over: Record<string, unknown> = {}) {
  return {
    path: "D:/artifacts/x",
    filename: "x",
    ext: "csv",
    kind: "csv",
    text: null as string | null,
    dataUri: null as string | null,
    originalBytes: null,
    size: 10,
    truncated: false,
    ...over,
  };
}

describe("CSV preview virtualization", () => {
  it("small CSVs render every row", async () => {
    readMock.mockResolvedValue(basePreview({ text: csvText(20) }) as never);
    const { container } = render(
      <ArtifactPreviewPane artifact={{ path: "D:/artifacts/x.csv", filename: "x.csv" }} onClose={() => {}} />,
    );
    await waitFor(() => expect(container.querySelector("tbody tr")).not.toBeNull());
    expect(container.querySelectorAll("tbody tr").length).toBe(20);
  });

  it("large CSVs window the rows instead of mounting them all", async () => {
    readMock.mockResolvedValue(basePreview({ text: csvText(2000) }) as never);
    const { container } = render(
      <ArtifactPreviewPane artifact={{ path: "D:/artifacts/x.csv", filename: "x.csv" }} onClose={() => {}} />,
    );
    await waitFor(() => expect(container.querySelector("tbody tr")).not.toBeNull());
    const mounted = container.querySelectorAll("tbody tr").length;
    expect(mounted).toBeGreaterThan(0);
    expect(mounted).toBeLessThan(2000 / 2);
  });
});
