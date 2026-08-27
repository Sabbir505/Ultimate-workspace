// Tests for the diagram full-view surface:
//   1. DiagramLightbox: bare-SVG diagrams render in a letterbox stage with
//      zoom controls, and close via Esc / backdrop click. No 3-dot export
//      menu here — export lives on the INLINE diagram's kebab.
//   2. MermaidDiagram: a source mermaid rejects as a parse error falls back
//      to the readable source block (never mermaid's error-bomb SVG); a good
//      render is clickable into the lightbox AND carries a hover kebab with
//      the save actions on the inline diagram itself.
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
  it("renders the diagram in a letterbox stage without an export menu", () => {
    const onClose = vi.fn();
    render(
      <DiagramLightbox html="<svg width='2400' height='1800' viewBox='0 0 2400 1800'><rect width='2400' height='1800' /></svg>" filename="flow.svg" onClose={onClose} />,
    );

    // The lightbox portals to document.body so no transformed chat ancestor
    // can trap its position:fixed fullscreen overlay.
    const body = document.body;
    // The SVG survives sanitization with its geometry intact.
    const svg = body.querySelector(".diagram-lightbox-svgfill svg");
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute("viewBox")).toBe("0 0 2400 1800");
    // The paper is sized inline to the diagram's viewBox aspect (capped to
    // the viewport) — not a fixed full-height slab.
    const stage = body.querySelector<HTMLElement>(".diagram-lightbox-stage");
    expect(stage).not.toBeNull();
    expect(stage!.style.width).not.toBe("");
    expect(stage!.style.height).not.toBe("");
    // No 3-dot export menu — that belongs to the inline diagram's kebab.
    expect(body.querySelector(".artifact-kebab")).toBeNull();
    // Zoom level starts at 100%.
    expect(body.querySelector(".diagram-lightbox-zoom-level")?.textContent).toBe("100%");
  });

  it("closes on backdrop click", () => {
    const onClose = vi.fn();
    render(
      <DiagramLightbox html="<svg width='10' height='10' />" filename="x.svg" onClose={onClose} />,
    );
    fireEvent.click(document.body.querySelector(".diagram-lightbox")!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("full HTML documents use the bounded scroll card instead of the stage", () => {
    render(
      <DiagramLightbox html="<!doctype html><html><body><div>hi</div></body></html>" filename="page.html" onClose={() => {}} />,
    );
    expect(document.body.querySelector(".diagram-lightbox-doc")).not.toBeNull();
    expect(document.body.querySelector(".diagram-lightbox-stage")).toBeNull();
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

  it("a good render is clickable into the lightbox and carries an inline kebab", async () => {
    parseMock.mockResolvedValue({ diagramType: "flowchart" });
    renderMock.mockResolvedValue({ svg: "<svg width='200' height='100'><rect /></svg>" });
    const { container } = render(<MermaidDiagram code={"flowchart TD\n  A --> B"} />);

    await waitFor(() => {
      expect(container.querySelector(".chat-mermaid-svg")).not.toBeNull();
    });
    expect(document.body.querySelector(".diagram-lightbox")).toBeNull();

    fireEvent.click(container.querySelector(".chat-mermaid-open")!);
    expect(document.body.querySelector(".diagram-lightbox")).not.toBeNull();
    // Mermaid art floats on the chat surface (transparent canvas), so the
    // lightbox paper must carry the chat surface — not the white paper.
    expect(document.body.querySelector(".diagram-lightbox-stage.surface-chat")).not.toBeNull();

    // Close it and verify the inline kebab carries export actions.
    fireEvent.click(document.body.querySelector(".diagram-lightbox-close")!);
    await waitFor(() => {
      expect(document.body.querySelector(".diagram-lightbox")).toBeNull();
    });
    const kebabBtn = container.querySelector<HTMLElement>(
      ".chat-mermaid-block .chat-diagram-actions .artifact-kebab-btn",
    );
    expect(kebabBtn).not.toBeNull();
    fireEvent.click(kebabBtn!);
    const menu = container.querySelector(".chat-mermaid-block .artifact-kebab-menu");
    expect(menu?.textContent).toContain("Download as PNG");
    expect(menu?.textContent).toContain("Download as JPG");
    expect(menu?.textContent).toContain("Open in tab");
  });
});
