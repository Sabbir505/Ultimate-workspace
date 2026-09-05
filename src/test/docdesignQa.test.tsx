// Tests for the docdesign QA layer: the docQa store, the render-probe
// helpers, and the DocQaStrip in the artifact preview pane.
import { act, render, screen } from "@testing-library/react";
import { dataUriToBytes } from "../lib/docdesign/rasterize";
import { useDocQaStore } from "../state/docQa";
import type { DocQaReportPayload } from "../lib/ipc";
import { DocQaStrip } from "../components/chat/ArtifactPreviewPane";

// Windows path separators without backslash literals (shell/escaping safety).
const SEP = String.fromCharCode(92);
const DECK_PATH = ["C:", "a", "deck.pptx"].join(SEP);

function report(overrides: Partial<DocQaReportPayload> = {}): DocQaReportPayload {
  return {
    path: DECK_PATH,
    filename: "deck.pptx",
    passed: ["single relay.save", "slide count matches plan (5)"],
    warnings: [],
    probes: [],
    pageCount: 5,
    critic: "not-run",
    clean: true,
    ...overrides,
  };
}

describe("docQa store", () => {
  beforeEach(() => {
    useDocQaStore.setState({ byPath: {} });
  });

  it("stores verdicts by artifact path and clears them", () => {
    const r = report();
    act(() => useDocQaStore.getState().put(r));
    expect(useDocQaStore.getState().byPath[r.path]).toBe(r);

    const r2 = report({ path: ["C:", "a", "report.docx"].join(SEP), clean: false, warnings: ["x"] });
    act(() => useDocQaStore.getState().put(r2));
    expect(Object.keys(useDocQaStore.getState().byPath)).toHaveLength(2);

    act(() => useDocQaStore.getState().clear(r.path));
    expect(useDocQaStore.getState().byPath[r.path]).toBeUndefined();
    expect(useDocQaStore.getState().byPath[r2.path]).toBeDefined();

    // Clearing an unknown path is a no-op.
    act(() => useDocQaStore.getState().clear("nope"));
    expect(Object.keys(useDocQaStore.getState().byPath)).toHaveLength(1);
  });

  it("a later verdict for the same path replaces the earlier one", () => {
    act(() => useDocQaStore.getState().put(report({ clean: true })));
    const revised = report({ clean: false, warnings: ["coherence: no cover"] });
    act(() => useDocQaStore.getState().put(revised));
    expect(useDocQaStore.getState().byPath[revised.path]?.clean).toBe(false);
  });
});

describe("probe helpers", () => {
  it("decodes pdf data URIs to bytes", () => {
    const bytes = dataUriToBytes("data:application/pdf;base64,aGVsbG8=");
    expect(new TextDecoder().decode(bytes)).toBe("hello");
    // Bare base64 passes through too.
    expect(new TextDecoder().decode(dataUriToBytes("aGVsbG8="))).toBe("hello");
  });
});

describe("DocQaStrip", () => {
  beforeEach(() => {
    useDocQaStore.setState({ byPath: {} });
  });

  it("renders nothing when no verdict exists for the path", () => {
    render(<StripFixture artifactPath={["C:", "a", "x.pptx"].join(SEP)} />);
    expect(screen.queryByText(/Design QA/)).toBeNull();
  });

  it("renders a clean verdict", () => {
    act(() => useDocQaStore.getState().put(report()));
    render(<StripFixture artifactPath={DECK_PATH} />);
    expect(screen.getByText(/Design QA passed/)).toBeTruthy();
    expect(screen.getByText(/2 checks/)).toBeTruthy();
  });

  it("lists warnings when the verdict is not clean", () => {
    act(() =>
      useDocQaStore.getState().put(
        report({
          clean: false,
          warnings: ["coherence: decks should open with a cover slide"],
          probes: ["probe/overflow: page 2: text renders outside the page box"],
        }),
      ),
    );
    render(<StripFixture artifactPath={DECK_PATH} />);
    expect(screen.getByText(/2 warnings/)).toBeTruthy();
    expect(screen.getByText(/coherence: decks should open with a cover slide/)).toBeTruthy();
    expect(screen.getByText(/probe\/overflow: page 2/)).toBeTruthy();
  });
});

function StripFixture({ artifactPath }: { artifactPath: string }) {
  return <DocQaStrip artifactPath={artifactPath} />;
}
