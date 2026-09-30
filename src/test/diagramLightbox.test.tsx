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
    registerLayoutLoaders: vi.fn(),
    parse: (...args: unknown[]) => parseMock(...args),
    render: (...args: unknown[]) => renderMock(...args),
  },
}));
vi.mock("@mermaid-js/layout-elk", () => ({ default: {} }));

import { DiagramLightbox, clampPanToView, type StageGeometry } from "../components/chat/DiagramLightbox";
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

  it("clamps the pan to the visible card, so a drag can reach the screen edge", () => {
    // The HTML path draws the artifact on a card NARROWER than the stage it
    // sits on. Clamping against the stage stopped the drag hundreds of pixels
    // short of the right edge — the "invisible border I can't drag past"
    // report. jsdom lays nothing out, so the boxes are stubbed: a 400px card
    // centred in a 1000px viewport.
    render(
      <DiagramLightbox html="<!doctype html><html><body><div>hi</div></body></html>" filename="page.html" onClose={() => {}} />,
    );
    const root = document.body.querySelector<HTMLElement>(".diagram-lightbox")!;
    const stage = document.body.querySelector<HTMLElement>(".diagram-lightbox-content")!;
    const card = document.body.querySelector<HTMLElement>(".diagram-lightbox-doc")!;
    vi.spyOn(root, "getBoundingClientRect").mockReturnValue({
      left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800, x: 0, y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    const box = (el: HTMLElement, w: number, h: number, left: number, top: number) => {
      Object.defineProperty(el, "offsetWidth", { configurable: true, value: w });
      Object.defineProperty(el, "offsetHeight", { configurable: true, value: h });
      Object.defineProperty(el, "offsetLeft", { configurable: true, value: left });
      Object.defineProperty(el, "offsetTop", { configurable: true, value: top });
    };
    box(stage, 1000, 800, 0, 0);
    box(card, 400, 200, 300, 300);

    // Wheel-zoom anchored on a cursor far to the RIGHT: the content is pushed
    // right, and the clamp decides how far. (The wheel listener is a native
    // non-passive one; the component's pointer handlers are React synthetic
    // events that jsdom doesn't route into a portal.)
    fireEvent.wheel(stage, { deltaY: -100, clientX: 5000, clientY: 400 });

    // Card-based clamp: the card's right edge may reach x=1000, so at 1.15×
    // its centre travels to 770 from 500 → -270px. A stage-based clamp sizes
    // the content at the full 1000px stage, where the "cover" interval
    // collapses to the centre and yields 0px — the drag dead zone.
    const transform = stage.style.transform;
    const panX = Number(/translate\(([-\d.]+)px/.exec(transform)?.[1] ?? "NaN");
    expect(panX).toBe(-270);
  });

  it("injects a viewBox into svg files that lack one so the full drawing stays reachable", () => {
    // A root svg without a viewBox crops its drawing to the svg viewport
    // (the paper) — only the top-left slice renders, and no amount of
    // panning or zooming can reach the rest. The lightbox must derive the
    // missing box (from the explicit size here) on measure.
    render(
      <DiagramLightbox
        html="<svg width='2400' height='1800'><rect width='2400' height='1800' /></svg>"
        filename="no-viewbox.svg"
        onClose={() => {}}
      />,
    );
    const svg = document.body.querySelector(".diagram-lightbox-svgfill svg");
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute("viewBox")).toBe("0 0 2400 1800");
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
    // The three formats share ONE row (they are one action on three
    // targets); as three separate lines the menu outgrew the card it hangs
    // off and ran off the bottom of the window.
    const formatRow = menu?.querySelector(".artifact-kebab-format-row");
    expect(formatRow).not.toBeNull();
    expect(
      [...(formatRow?.querySelectorAll(".artifact-kebab-format-btn") ?? [])].map((b) =>
        b.textContent?.trim(),
      ),
    ).toEqual(["SVG", "PNG", "JPG"]);
    expect(menu?.textContent).toContain("Open in tab");
  });
});

describe("clampPanToView (edge-shake regression)", () => {
  // 1000×800 stage laid out centered at (500, 400) inside an 800×600 view.
  const geo: StageGeometry = {
    cx: 500,
    cy: 400,
    view: { left: 0, right: 800, top: 0, bottom: 600 },
    w: 1000,
    h: 800,
  };

  it("keeps cover-mode panning free so a screen-filling diagram stays draggable", () => {
    // Zoomed past fit (2× → 2000×1600 stage in an 800×600 view): the pan
    // range is the slack (scaled − view = 1200×1000). Interior pans pass
    // through untouched…
    expect(clampPanToView({ x: -300, y: -400 }, 2, geo)).toEqual({ x: -300, y: -400 });
    // …and the extremes stop exactly where a stage edge would come inside
    // the view. (The old min(scaled, view) clamp collapsed this interval to
    // a point, pinning the diagram to the center — dragging did nothing.)
    expect(clampPanToView({ x: -5000, y: -9000 }, 2, geo)).toEqual({ x: -700, y: -600 });
    expect(clampPanToView({ x: 4000, y: 6000 }, 2, geo)).toEqual({ x: 500, y: 400 });
  });

  it("is idempotent — clamping an already-clamped pan is a no-op", () => {
    const once = clampPanToView({ x: -999, y: 123 }, 2, geo);
    const twice = clampPanToView(once, 2, geo);
    expect(twice).toEqual(once);
  });

  it("leaves interior pans untouched while the stage fits the view", () => {
    // At 0.5× (500×400) the stage fits: pan is free within the slack
    // (x ∈ [-250, 50], y ∈ [-200, 200] for this geometry).
    const p = { x: 40, y: -80 };
    expect(clampPanToView(p, 0.5, geo)).toEqual(p);
    // …bounded by keeping the stage fully visible at the extremes.
    expect(clampPanToView({ x: 900, y: 0 }, 0.5, geo).x).toBe(50);
  });
});
