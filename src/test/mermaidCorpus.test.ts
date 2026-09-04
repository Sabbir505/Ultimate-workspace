// Render-corpus smoke tests against the REAL mermaid package (not the mock).
// The component-level suites mock mermaid for determinism; this file pins the
// upgrade contract: every fixture must parse under the installed mermaid
// version, the ELK layout package must load and register, and known-bad
// source must still throw (the parse-first error strategy relies on it).
//
// These are parse checks only — jsdom has no layout engine — real visual
// verification happens in the dev-server browser smoke (diagram-smoke.html).
import { beforeAll, describe, expect, it, vi } from "vitest";

import flowPipeline from "./fixtures/diagrams/flowchart-pipeline.mmd?raw";
import dagreOverride from "./fixtures/diagrams/flowchart-dagre-override.mmd?raw";
import sequenceAuth from "./fixtures/diagrams/sequence-auth.mmd?raw";
import erOrders from "./fixtures/diagrams/er-orders.mmd?raw";
import stateCheckout from "./fixtures/diagrams/state-checkout.mmd?raw";
import mindmapProduct from "./fixtures/diagrams/mindmap-product.mmd?raw";
import gitflow from "./fixtures/diagrams/gitflow.mmd?raw";

const CORPUS: Array<[string, string]> = [
  ["flowchart-pipeline (ELK + subgraph + classDef)", flowPipeline],
  ["flowchart-dagre-override (frontmatter layout override)", dagreOverride],
  ["sequence-auth (autonumber + alt blocks)", sequenceAuth],
  ["er-orders (relationships + attributes)", erOrders],
  ["state-checkout (composite states)", stateCheckout],
  ["mindmap-product", mindmapProduct],
  ["gitflow (branches + merges)", gitflow],
];

beforeAll(
  async () => {
    const mermaid = (await import("mermaid")).default;
    const elk = await import("@mermaid-js/layout-elk");
    mermaid.registerLayoutLoaders(elk.default);
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "antiscript",
      layout: "elk",
    });
  },
  // Importing the real mermaid + ELK bundles in jsdom takes well over the
  // 10s default hook budget on a cold cache.
  120_000,
);

// Default per-test timeout (parses are fast once the module graph is warm).
vi.setConfig({ testTimeout: 60_000 });

describe("mermaid render corpus", () => {
  it.each(CORPUS)("parses %s", async (_name, source) => {
    const mermaid = (await import("mermaid")).default;
    await expect(mermaid.parse(source)).resolves.toBeTruthy();
  });

  it("loads the ELK layout package with its algorithm set", async () => {
    // The public mermaid API exposes no layout-registry introspection, so
    // assert the package contract instead: an array of named loaders whose
    // primary entry is "elk". That registration engages at render time is
    // proven by the dev-server browser smoke (diagram-smoke.html).
    const elk = await import("@mermaid-js/layout-elk");
    expect(Array.isArray(elk.default)).toBe(true);
    const names = (elk.default as Array<{ name: string }>).map((l) => l.name);
    expect(names).toContain("elk");
  });

  it("rejects known-bad source (parse-first error strategy)", async () => {
    const mermaid = (await import("mermaid")).default;
    await expect(mermaid.parse("flowchart TD\n  A [")).rejects.toBeTruthy();
  });
});
