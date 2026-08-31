// Regression test (audit E-9): openArtifactTab dedupes INLINE artifacts
// (mermaid/jsx/svg) by path too. The old `!artifact.inline` gate made every
// re-open stack a duplicate tab and left the in-branch refresh dead code.
import { beforeEach, describe, expect, it } from "vitest";
import { useUiStore } from "../state/ui";

beforeEach(() => {
  useUiStore.setState({
    openTabs: [],
    nextTabId: 1,
    activeTabId: null,
    toolPanelTab: "terminal",
    toolPanelCollapsed: true,
  });
});

describe("openArtifactTab inline dedupe (audit E-9)", () => {
  it("folds two inline artifacts of the same path into one refreshed tab", () => {
    const s = useUiStore.getState();
    s.openArtifactTab({
      path: "auth-flow.svg",
      filename: "auth-flow.svg",
      inline: { kind: "svg", code: "<svg>v1</svg>" },
    });
    s.openArtifactTab({
      path: "auth-flow.svg",
      filename: "auth-flow.svg",
      inline: { kind: "svg", code: "<svg>v2 re-rendered</svg>" },
    });

    const state = useUiStore.getState();
    const artifactTabs = state.openTabs.filter((t) => t.kind === "artifact");
    expect(artifactTabs).toHaveLength(1);
    expect(artifactTabs[0].artifactPath).toBe("auth-flow.svg");
    // The tab carries the NEW payload, not the one it opened with.
    expect(artifactTabs[0].artifactInline).toEqual({ kind: "svg", code: "<svg>v2 re-rendered</svg>" });
    // Re-opening activated (not duplicated) the existing instance.
    expect(state.activeTabId).toBe(artifactTabs[0].instanceId);
    expect(state.nextTabId).toBe(2); // only one tab was ever allocated
  });

  it("dedupes an inline re-open against an on-disk tab of the same path (and vice versa)", () => {
    const s = useUiStore.getState();
    s.openArtifactTab({ path: "report.html", filename: "report.html" });
    s.openArtifactTab({
      path: "report.html",
      filename: "report.html",
      inline: { kind: "jsx", code: "<h1>live</h1>" },
    });

    const artifactTabs = useUiStore.getState().openTabs.filter((t) => t.kind === "artifact");
    expect(artifactTabs).toHaveLength(1);
    expect(artifactTabs[0].artifactInline).toEqual({ kind: "jsx", code: "<h1>live</h1>" });
  });

  it("still dedupes on-disk artifacts and keeps the 8-tab cap", () => {
    const s = useUiStore.getState();
    for (let i = 0; i < 10; i++) {
      s.openArtifactTab({ path: `file-${i}.md`, filename: `file-${i}.md` });
    }
    // Same path twice must not add a second tab…
    s.openArtifactTab({ path: "file-9.md", filename: "file-9.md" });
    const openTabs = useUiStore.getState().openTabs;
    expect(openTabs).toHaveLength(8); // cap holds (oldest evicted)
    expect(openTabs[openTabs.length - 1]?.artifactPath).toBe("file-9.md");
  });
});
