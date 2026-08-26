// Tests for the diagram full-view surface:
//   1. DiagramLightbox: renders the sanitized diagram, zoom buttons update
//      the level, Esc closes.
//   2. MermaidDiagram: a source mermaid rejects as a parse error falls back
//      to the readable source block (never mermaid's error-bomb SVG), and a
//      good render is clickable open into the lightbox.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

vi.mock("../lib/ipc", () => ({
  downloadArtifact: vi.fn(),
  readArtifactPreview: vi.fn(),
}));

// Mermaid is lazy-imported by the component; mock the module so the parse
// failure path is deterministic in jsdom.
const parseMock = vi.fn();
const renderMock = vi.fn();
vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    parse: (...args: unknown[]) => parseMock(...args),
    render: (...args: unknown[]) => renderMock(...args),
  },
}));

import { DiagramLightbox } from "../components/chat/DiagramLightbox";
import { MermaidDiagram } from "../components/chat/MermaidDiagram";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("DiagramLightbox", () => {
  it("renders the diagram with zoom controls and closes on Esc", async () => {
    const onClose = vi.fn();
    const { container, getByTitle } = render(
      <DiagramLightbox html="<svg width='120' height='80' viewBox='0 0 120 80'><rect width='120' height='80' /></svg>" filename="flow.svg" onClose={onClose} />,
    );

    // Diagram content is rendered (sanitized) into the canvas — and the SVG
    // survives with its geometry intact: the HTML-profile sanitizer strips
    // svg attributes and would leave an invisible empty box (regression).
    const svg = container.querySelector(".diagram-lightbox-doc svg");
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute("viewBox")).toBe("0 0 120 80");
    expect(svg!.getAttribute("width")).toBe("120");
    // …the shared export kebab is present (3-dot menu)…
    expect(container.querySelector(".artifact-kebab")).not.toBeNull();
    // …and the zoom level starts at 100%.
    expect(getByTitle("Reset zoom").textContent).toBe("100%");

    fireEvent.click(getByTitle("Zoom in"));
    expect(getByTitle("Reset zoom").textContent).toBe("115%");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on backdrop click", () => {
    const onClose = vi.fn();
    const { container } = render(
      <DiagramLightbox html="<svg width='10' height='10' />" filename="x.svg" onClose={onClose} />,
    );
    fireEvent.click(container.querySelector(".diagram-lightbox")!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("MermaidDiagram render fallback", () => {
  it("a parse error falls back to the readable source, not an error-bomb SVG", async () => {
    parseMock.mockRejectedValue(new Error("Syntax error in text"));
    const { container } = render(<MermaidDiagram code={"stateDiagram-v2\n  [*] --> red"} />);

    await waitFor(() => {
      expect(container.querySelector(".chat-mermaid-fallback")).not.toBeNull();
    });
    // The raw source is shown so the user can see what failed…
    expect(container.querySelector(".chat-mermaid-source")?.textContent).toContain("stateDiagram-v2");
    // …and render() was never reached (no bomb SVG injected).
    expect(renderMock).not.toHaveBeenCalled();
    expect(container.querySelector(".chat-mermaid-svg")).toBeNull();
  });

  it("a good render shows the diagram and clicking opens the lightbox", async () => {
    parseMock.mockResolvedValue({ diagramType: "flowchart" });
    renderMock.mockResolvedValue({ svg: "<svg width='200' height='100'><rect /></svg>" });
    const { container } = render(<MermaidDiagram code={"flowchart TD\n  A --> B"} />);

    await waitFor(() => {
      expect(container.querySelector(".chat-mermaid-svg")).not.toBeNull();
    });
    expect(container.querySelector(".chat-mermaid-svg")!.innerHTML).toContain("<rect");
    expect(container.querySelector(".diagram-lightbox")).toBeNull();

    fireEvent.click(container.querySelector(".chat-mermaid-open")!);
    expect(container.querySelector(".diagram-lightbox")).not.toBeNull();
  });
});
