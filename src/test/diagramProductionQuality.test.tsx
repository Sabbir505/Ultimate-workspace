// Tests for the diagram production-quality pass:
//   1. diagramExport lib — raster scale math and background resolution
//      (PNG keeps alpha, JPEG is forced opaque).
//   2. MermaidDiagram init contract — the font stack resolves to a literal
//      (no dangling var()), flowchart/sequence layout config is deliberate
//      (spacing + angular curve), the themeVariables carry the diagram
//      palette tokens, and a changed token signature (custom gallery theme)
//      forces a re-initialize.
//   3. ArtifactExportMenu — the kebab exposes the scale picker + transparent
//      toggle, and a chosen transparent background suppresses the painted
//      backdrop rect in the exported SVG.
//
// NOTE: MermaidDiagram keeps module-level state (init key + rendered-SVG
// cache), so every test below uses unique diagram sources to stay
// independent of execution order.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import {
  computeRasterSize,
  DEFAULT_EXPORT_SCALE,
  effectiveExportBackground,
  EXPORT_SCALES,
  svgPixelSize,
} from "../lib/diagramExport";

vi.mock("../lib/ipc", () => ({
  downloadArtifact: vi.fn(),
  readArtifactPreview: vi.fn(),
}));

// Mermaid is lazy-imported by the component; mock the module so init calls
// are observable without the real renderer. layout-elk is mocked too — the
// real package pulls in the full ELK engine, which the component must
// register exactly once before initializing.
const initializeMock = vi.fn();
const parseMock = vi.fn();
const renderMock = vi.fn();
const registerLayoutLoadersMock = vi.fn();
vi.mock("mermaid", () => ({
  default: {
    initialize: (...args: unknown[]) => initializeMock(...args),
    parse: (...args: unknown[]) => parseMock(...args),
    render: (...args: unknown[]) => renderMock(...args),
    registerLayoutLoaders: (...args: unknown[]) => registerLayoutLoadersMock(...args),
  },
}));
vi.mock("@mermaid-js/layout-elk", () => ({ default: { elk: {} } }));

import { MermaidDiagram } from "../components/chat/MermaidDiagram";
import { ArtifactExportMenu } from "../components/chat/ArtifactExportMenu";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  // Tests below mutate inline tokens on <html> — always clean up so other
  // suites see the default environment.
  document.documentElement.removeAttribute("style");
});

describe("diagramExport helpers", () => {
  it("scales the raster canvas; invalid scales fall back to 1×, sizes clamp to 1px", () => {
    expect(computeRasterSize(480, 360, 3)).toEqual({ w: 1440, h: 1080 });
    expect(computeRasterSize(100.4, 10.6, 2)).toEqual({ w: 201, h: 21 });
    // Sub-pixel sources clamp to at least one device pixel per side.
    expect(computeRasterSize(0.3, 0.2, 2)).toEqual({ w: 1, h: 1 });
    // Zero / NaN scale is treated as 1× (no upscale, no zero-size canvas).
    expect(computeRasterSize(10, 10, 0)).toEqual({ w: 10, h: 10 });
    expect(computeRasterSize(10, 10, Number.NaN)).toEqual({ w: 10, h: 10 });
  });

  it("derives intrinsic size from width/height, then viewBox", () => {
    expect(svgPixelSize('<svg width="640" height="480" viewBox="0 0 999 999">')).toEqual({
      w: 640,
      h: 480,
    });
    expect(svgPixelSize('<svg viewBox="0 0 1200 800">')).toEqual({ w: 1200, h: 800 });
    expect(svgPixelSize("<svg>")).toEqual({ w: 0, h: 0 });
  });

  it("keeps PNG alpha on transparent but forces JPEG opaque", () => {
    expect(effectiveExportBackground("#181818", "png", true)).toBe("transparent");
    // JPEG has no alpha channel — a transparent backdrop would encode black.
    expect(effectiveExportBackground("#181818", "jpeg", true)).toBe("#181818");
    expect(effectiveExportBackground("", "png", false)).toBe("#ffffff");
  });

  it("offers 1–4× with 3× as the default", () => {
    expect([...EXPORT_SCALES]).toEqual([1, 2, 3, 4]);
    expect(DEFAULT_EXPORT_SCALE).toBe(3);
  });
});

describe("MermaidDiagram init contract", () => {
  it("initializes with a literal font stack, deliberate layout config, and diagram palette", async () => {
    parseMock.mockResolvedValue({ diagramType: "flowchart" });
    renderMock.mockResolvedValue({ svg: "<svg width='200' height='100'><rect /></svg>" });
    render(<MermaidDiagram code={"flowchart TD\n  A1 --> A2"} />);

    await waitFor(() => {
      expect(initializeMock).toHaveBeenCalled();
    });
    const config = initializeMock.mock.calls[0][0] as Record<string, unknown>;

    // The ELK layout engine is registered once, before initialize, and is
    // the default layout.
    expect(registerLayoutLoadersMock).toHaveBeenCalledTimes(1);
    expect(registerLayoutLoadersMock).toHaveBeenCalledWith({ elk: {} });
    expect(config.layout).toBe("elk");

    // The font must be a literal stack (it is baked into exported SVG files,
    // where a var() reference to app CSS would dangle).
    const font = config.fontFamily as string;
    expect(font).toContain("Space Grotesk");
    expect(font).not.toContain("var(");

    // Deliberate flowchart layout: airier spacing + crisp angular edges.
    const flowchart = config.flowchart as Record<string, unknown>;
    expect(flowchart.nodeSpacing).toBe(55);
    expect(flowchart.rankSpacing).toBe(62);
    expect(flowchart.curve).toBe("linear");

    const sequence = config.sequence as Record<string, unknown>;
    expect(sequence.actorMargin).toBe(60);

    // The theme palette reads the diagram tokens (jsdom resolves no CSS, so
    // the documented fallbacks must be present).
    const vars = config.themeVariables as Record<string, string>;
    expect(vars.mainBkg).toMatch(/^#/);
    expect(vars.nodeBorder).toBeDefined();
    expect(vars.clusterBkg).toBeDefined();
    expect(vars.primaryBorderColor).toBe(vars.primaryColor);
  });

  it("re-initializes when the consumed token values change (custom theme swap)", async () => {
    parseMock.mockResolvedValue({ diagramType: "flowchart" });
    renderMock.mockResolvedValue({ svg: "<svg width='200' height='100'><rect /></svg>" });

    // Each render in this test uses a unique source AND a unique inline
    // token value, so the module-level init key can't leak between tests:
    // the first render establishes the orange palette…
    document.documentElement.style.setProperty("--diagram-accent", "#ff8800");
    render(<MermaidDiagram code={"flowchart TD\n  B1 --> B2"} />);
    await waitFor(() => {
      expect(initializeMock).toHaveBeenCalledTimes(1);
    });
    expect(
      (initializeMock.mock.calls[0][0] as Record<string, unknown>).themeVariables,
    ).toHaveProperty("primaryColor", "#ff8800");

    // …and swapping the accent to a different custom theme re-initializes
    // with the new palette even though the light/dark base never changed.
    document.documentElement.style.setProperty("--diagram-accent", "#00aa88");
    render(<MermaidDiagram code={"flowchart TD\n  B3 --> B4"} />);
    await waitFor(() => {
      expect(initializeMock).toHaveBeenCalledTimes(2);
    });
    const vars = (initializeMock.mock.calls[1][0] as Record<string, unknown>)
      .themeVariables as Record<string, string>;
    expect(vars.primaryColor).toBe("#00aa88");
  });

  it("does NOT re-initialize when only the diagram source changed", async () => {
    parseMock.mockResolvedValue({ diagramType: "flowchart" });
    renderMock.mockResolvedValue({ svg: "<svg width='200' height='100'><rect /></svg>" });

    // First render re-syncs the init key under this test's token signature.
    document.documentElement.style.setProperty("--diagram-accent", "#336699");
    render(<MermaidDiagram code={"flowchart TD\n  C1 --> C2"} />);
    await waitFor(() => {
      expect(initializeMock).toHaveBeenCalledTimes(1);
    });
    // A different source with the SAME token signature must render (not
    // re-init): one initialize total, two renders.
    render(<MermaidDiagram code={"flowchart TD\n  C3 --> C4"} />);
    await waitFor(() => {
      expect(renderMock).toHaveBeenCalledTimes(2);
    });
    expect(initializeMock).toHaveBeenCalledTimes(1);
  });

  it("offers Fix with AI on a parse failure and calls it with source + error", async () => {
    parseMock.mockRejectedValue(new Error("Parse error on line 2"));
    const onFix = vi.fn();
    const { container } = render(
      <MermaidDiagram code={"stateDiagram-v2\n  F1 --> F2"} onFix={onFix} />,
    );

    await waitFor(() => {
      expect(container.querySelector(".chat-mermaid-fallback")).not.toBeNull();
    });
    const btn = container.querySelector<HTMLButtonElement>(".chat-mermaid-fix-btn");
    expect(btn).not.toBeNull();
    fireEvent.click(btn!);
    expect(onFix).toHaveBeenCalledTimes(1);
    expect(onFix).toHaveBeenCalledWith("stateDiagram-v2\n  F1 --> F2", "Parse error on line 2");
  });

  it("omits the fix button when the surface provides no onFix hook", async () => {
    parseMock.mockRejectedValue(new Error("Parse error"));
    const { container } = render(<MermaidDiagram code={"flowchart TD\n  G1 --> G2"} />);

    await waitFor(() => {
      expect(container.querySelector(".chat-mermaid-fallback")).not.toBeNull();
    });
    expect(container.querySelector(".chat-mermaid-fix-btn")).toBeNull();
  });
});

describe("ArtifactExportMenu options", () => {
  const base = {
    path: "docs/flow.svg",
    filename: "flow.svg",
    ext: "svg",
    kind: "diagram" as const,
    text: "<svg xmlns='http://www.w3.org/2000/svg' width='100' height='50'><rect width='100' height='50' fill='#ffffff'/></svg>",
    dataUri: null,
    size: 100,
    truncated: false,
  };

  it("exposes the PNG scale picker and transparent toggle in the kebab", () => {
    const { container } = render(
      <ArtifactExportMenu preview={base} path={base.path} filename={base.filename} variant="kebab" />,
    );
    fireEvent.click(container.querySelector(".artifact-kebab-btn")!);
    const menu = container.querySelector(".artifact-kebab-menu")!;
    expect(menu.textContent).toContain("PNG scale");
    for (const s of EXPORT_SCALES) {
      expect(menu.textContent).toContain(`${s}×`);
    }
    const toggle = menu.querySelector('button[role="menuitemcheckbox"]')!;
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });

  it("defaults the toolbar scale picker to 3× and toggles transparent", () => {
    const { container } = render(
      <ArtifactExportMenu preview={base} path={base.path} filename={base.filename} />,
    );
    const select = container.querySelector<HTMLSelectElement>(".artifact-export-scale")!;
    expect(select.value).toBe("3");
    fireEvent.change(select, { target: { value: "4" } });
    expect(select.value).toBe("4");

    const transparentBtn = container.querySelector("button[aria-pressed]")!;
    expect(transparentBtn.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(transparentBtn);
    expect(transparentBtn.getAttribute("aria-pressed")).toBe("true");
  });

  it("SVG export honors the transparent toggle by omitting the backdrop rect", async () => {
    const createObjectURLMock = vi.fn((..._args: unknown[]) => "blob:mock-svg");
    const revokeObjectURLMock = vi.fn();
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    URL.createObjectURL = createObjectURLMock as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL = revokeObjectURLMock as unknown as typeof URL.revokeObjectURL;
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    try {
      const { container } = render(
        <ArtifactExportMenu preview={base} path={base.path} filename={base.filename} variant="kebab" />,
      );
      fireEvent.click(container.querySelector(".artifact-kebab-btn")!);
      // Turn on transparent, then export SVG.
      fireEvent.click(container.querySelector('button[role="menuitemcheckbox"]')!);
      fireEvent.click(
        [...container.querySelectorAll(".artifact-kebab-item")].find((el) =>
          el.textContent!.includes("Download as SVG"),
        )!,
      );

      await waitFor(() => {
        expect(createObjectURLMock).toHaveBeenCalled();
      });
      const blobArg = createObjectURLMock.mock.calls[0][0] as Blob;
      const text = await blobArg.text();
      // No painted backdrop when the user asked for a transparent export —
      // but the diagram's own SVG content is intact.
      expect(text).not.toContain('data-export-bg="1"');
      expect(text).toContain("<svg");
    } finally {
      clickSpy.mockRestore();
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    }
  });
});
