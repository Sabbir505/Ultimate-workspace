// The context meter must report the window a LOCAL sidecar was actually
// started with. This is a regression guard: a local session whose provider
// got blanked fell through to `API_CONTEXT_WINDOW`, so a model the user
// deliberately limited to 64k reported 500k in the composer.
//
// The model name matters. `MODEL_CONTEXT_RULES` (contextWindow.ts) substring-
// matches ids like "deepseek" and "qwen", so a cloud session on such a model
// gets a real registry answer. A GGUF display name that matches nothing —
// "MiniCPM5-2B", "Ling-3.0-tiny" — is the case that falls through to 500k,
// which is what the report was about.
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ContextMeter } from "../components/chat/ContextMeter";

vi.mock("../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/ipc")>();
  return {
    ...actual,
    safeInvoke: vi.fn().mockRejectedValue(new Error("no backend in tests")),
    safeListen: vi.fn().mockResolvedValue(() => {}),
  };
});

/** No substring in MODEL_CONTEXT_RULES matches this. */
const UNREGISTERED = "MiniCPM5-2B-Q8_0.gguf";

const base = {
  usedTokens: 8192,
  model: UNREGISTERED,
  agent: null as string | null,
  localCtx: 0,
  liveMaxTokens: 0,
  chatSessionId: "s1",
};

/** Hover opens the panel, then read the one line that states the window and
 *  where it came from. Targeting that line keeps the assertion off the rest of
 *  the panel, which repeats the same figures in the usage row.
 *
 *  Note the figures are the RAW token counts, formatted: a `-c` of 65536 reads
 *  "65.5k", not "64k" — the meter reports what the sidecar was given rather
 *  than rounding to a power of two. */
function windowNote(): string {
  fireEvent.mouseOver(document.querySelector(".context-meter-circle")!);
  return document.querySelector(".context-meter-panel-note")?.textContent ?? "";
}

describe("ContextMeter window for a local model", () => {
  it("uses the user's chosen localCtx instead of the 500k cloud default", () => {
    render(<ContextMeter {...base} provider="local_gguf" isLocal localCtx={65536} />);
    const note = windowNote();
    expect(note).toContain("65.5k");
    expect(note).not.toContain("500");
  });

  it("prefers the live sidecar cap over the chosen window", () => {
    // llama-server is the authority once it's up — it was launched with `-c`.
    render(
      <ContextMeter {...base} provider="local_gguf" isLocal localCtx={65536} liveMaxTokens={32768} />,
    );
    const note = windowNote();
    expect(note).toContain("32.8k");
    expect(note).toContain("live");
    expect(note).not.toContain("500");
  });

  it("still falls back to 500k for the SAME model when it is not local", () => {
    // Pins that the fix didn't quietly change cloud behaviour: with
    // isLocal=false and no registry hit, the cloud default is correct.
    render(<ContextMeter {...base} provider="openai_compatible" isLocal={false} />);
    expect(windowNote()).toContain("500");
  });
});
