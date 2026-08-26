// Tests for the JSX live-preview sandbox runtime (JsxPreview):
//   1. transpile() lowers ESM imports of the curated artifact libraries to
//      CommonJS require() calls the sandbox shim can resolve.
//   2. buildSrcDoc() inlines the vendored UMD runtimes (react, recharts, d3,
//      lucide-react, prop-types) and maps their module names in the require
//      shim, so `import { LineChart } from "recharts"` style artifacts run
//      offline with full fidelity (Claude-artifact parity).
import { describe, expect, it } from "vitest";
import { buildSrcDoc, transpile } from "../components/chat/JsxPreview";
import rechartsUMD from "../assets/vendor/recharts.umd.min.js?raw";
import d3UMD from "../assets/vendor/d3.umd.min.js?raw";
import lucideReactUMD from "../assets/vendor/lucide-react.umd.min.js?raw";
import propTypesUMD from "../assets/vendor/prop-types.umd.min.js?raw";

describe("jsx preview transpile", () => {
  it("lowers curated-library imports to require() calls", async () => {
    const out = await transpile(
      `import { LineChart } from "recharts";\nimport * as d3 from "d3";\nimport { Camera } from "lucide-react";\nexport default () => null;`,
      false,
    );
    expect(out).toContain('require("recharts")');
    expect(out).toContain('require("d3")');
    expect(out).toContain('require("lucide-react")');
  });

  it("still transpiles tsx with react imports", async () => {
    const out = await transpile(
      // useState must be referenced in the body — unused imports are elided
      // by the CommonJS transform.
      `import { useState } from "react";\nexport default () => { const [x] = useState(0); return <div>{x}</div>; };`,
      true,
    );
    expect(out).toContain('require("react")');
  });
});

describe("jsx preview sandbox document", () => {
  const doc = buildSrcDoc("module.exports.default = function () {};");

  it("inlines the vendored UMD runtimes", () => {
    // Distinctive markers from each vendored bundle prove the raw payloads
    // made it into the sandbox document.
    expect(doc).toContain("Recharts=");
    expect(rechartsUMD.length).toBeGreaterThan(100_000);
    expect(doc).toContain(lucideReactUMD.slice(0, 60));
    expect(doc).toContain(d3UMD.slice(0, 60));
    expect(doc).toContain(propTypesUMD.slice(0, 60));
  });

  it("maps the curated libraries in the require shim", () => {
    expect(doc).toContain('"recharts"');
    expect(doc).toContain("window.Recharts");
    expect(doc).toContain('"d3"');
    expect(doc).toContain("window.d3");
    expect(doc).toContain('"lucide-react"');
    expect(doc).toContain("window.LucideReact");
    expect(doc).toContain("window.PropTypes");
  });

  it("shims process.env before the libraries load", () => {
    expect(doc.indexOf('window.process')).toBeLessThan(doc.indexOf("Recharts="));
  });
});
