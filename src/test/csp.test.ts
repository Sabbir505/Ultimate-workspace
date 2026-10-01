// Guards the artifact-preview CSP contract in tauri.conf.json: live HTML
// previews may load scripts/styles/fonts from cdnjs.cloudflare.com (the one
// external source Claude artifacts allow), while the rest of the lockdown
// (no frame-ancestors escape, no object embeds, no arbitrary script hosts)
// stays intact. srcdoc iframes inherit this policy, so these directives are
// what make single-file interactive artifacts work in production builds.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

type TauriConfig = { app: { security: { csp: string } } };

const conf = JSON.parse(
  readFileSync(resolve(process.cwd(), "src-tauri/tauri.conf.json"), "utf8"),
) as TauriConfig;
const csp: string = conf.app.security.csp;

function directive(name: string): string[] {
  const dir = csp
    .split(";")
    .map((d) => d.trim())
    .find((d) => d.startsWith(name + " "));
  if (!dir) return [];
  return dir.split(/\s+/).slice(1);
}

describe("artifact preview CSP", () => {
  it("allows cdnjs scripts, styles, fonts and connections for live previews", () => {
    expect(directive("script-src")).toContain("https://cdnjs.cloudflare.com");
    expect(directive("style-src")).toContain("https://cdnjs.cloudflare.com");
    expect(directive("font-src")).toContain("https://cdnjs.cloudflare.com");
    expect(directive("connect-src")).toContain("https://cdnjs.cloudflare.com");
  });

  it("no longer allows Google Fonts (brand fonts are self-hosted via @fontsource)", () => {
    // 5.21: fonts.css bundles the brand families; the CSP must NOT re-open
    // fonts.googleapis.com / fonts.gstatic.com.
    expect(directive("style-src")).not.toContain("fonts.googleapis.com");
    expect(directive("font-src")).not.toContain("fonts.gstatic.com");
  });

  it("keeps the sandbox lockdown intact", () => {
    expect(directive("script-src")).not.toContain("*");
    expect(directive("script-src")).not.toContain("'unsafe-eval'");
    expect(directive("object-src")).toEqual(["'none'"]);
    expect(directive("frame-ancestors")).toEqual(["'none'"]);
    expect(directive("base-uri")).toEqual(["'self'"]);
    // The app's own origin must stay trusted for its own scripts.
    expect(directive("script-src")).toContain("'self'");
  });

  it("never allows connect-src to every HTTPS host", () => {
    // A bare `https:` here let the main window (and, via inherited policy,
    // every artifact preview iframe) fetch/POST any endpoint on the internet
    // — a ready exfiltration channel for anything that ever injects HTML into
    // the app origin. Remote connects stay pinned to the loopback (sidecars,
    // dev server), huggingface.co (model-market catalog), and cdnjs (live
    // previews fetching their CDN libs). Anything else belongs in Rust
    // commands, which the CSP does not govern.
    expect(directive("connect-src")).not.toContain("https:");
  });
});
