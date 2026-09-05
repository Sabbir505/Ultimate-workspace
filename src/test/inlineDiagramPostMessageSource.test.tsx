// B4 (ISSUES.md): the live inline-visual postMessage handler trusted ANY
// window event carrying the marker key. A malicious/foreign page (or a
// sibling diagram's frame) could resize this frame arbitrarily. The handler
// must verify e.source === this instance's iframe contentWindow AND a
// per-instance handshake token embedded in the injected reporter script.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { fireEvent } from "@testing-library/react";

vi.mock("../lib/ipc", () => ({
  readArtifactPreview: vi.fn(),
  downloadArtifact: vi.fn(),
}));

const { readArtifactPreview } = await import("../lib/ipc");
const readMock = vi.mocked(readArtifactPreview);
import { InlineDiagram } from "../components/chat/InlineDiagram";

const artifact = { path: "D:/artifacts/viz.html", filename: "viz.html" };

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function renderLiveViz() {
  readMock.mockResolvedValue({
    path: artifact.path,
    filename: artifact.filename,
    ext: "html",
    kind: "html",
    text: "<button onclick='go()'>Run</button>",
    dataUri: null,
    originalBytes: null,
    size: 10,
    truncated: false,
  } as never);
  const { container } = render(
    <InlineDiagram artifact={artifact} onFallback={() => <div>chip</div>} />,
  );
  await waitFor(() => {
    expect(container.querySelector("iframe.chat-live-viz-frame")).not.toBeNull();
  });
  const frame = container.querySelector("iframe.chat-live-viz-frame") as HTMLIFrameElement;
  // jsdom gives iframes no usable contentWindow — install a sentinel the
  // handler's source check compares against, mirroring the real browser.
  const frameWindow = {} as Window;
  Object.defineProperty(frame, "contentWindow", { value: frameWindow });
  const token = /__relayInlineVizToken:"([^"]+)"/.exec(frame.getAttribute("srcdoc") ?? "")?.[1];
  expect(token).toBeTruthy();
  return { frame, frameWindow, token: token as string };
}

const heightOf = (frame: HTMLElement) => frame.style.height;

describe("live visual postMessage handshake", () => {
  it("ignores reports from a foreign window (no source match)", async () => {
    const { frame, token } = await renderLiveViz();
    expect(heightOf(frame)).toBe("300px");

    fireEvent(
      window,
      new MessageEvent("message", {
        source: {} as Window, // NOT this frame's contentWindow
        data: { __relayInlineVizHeight: 9000, __relayInlineVizToken: token },
      }),
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(heightOf(frame)).toBe("300px");
  });

  it("ignores reports with a wrong or missing per-instance token", async () => {
    const { frame, frameWindow } = await renderLiveViz();
    expect(heightOf(frame)).toBe("300px");

    fireEvent(
      window,
      new MessageEvent("message", {
        source: frameWindow,
        data: { __relayInlineVizHeight: 9000, __relayInlineVizToken: "viz-spoofed" },
      }),
    );
    fireEvent(
      window,
      new MessageEvent("message", {
        source: frameWindow,
        data: { __relayInlineVizHeight: 9000 }, // no token at all
      }),
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(heightOf(frame)).toBe("300px");
  });

  it("applies a genuine report: correct source window AND instance token", async () => {
    const { frame, frameWindow, token } = await renderLiveViz();
    fireEvent(
      window,
      new MessageEvent("message", {
        source: frameWindow,
        data: { __relayInlineVizHeight: 9000, __relayInlineVizToken: token },
      }),
    );
    await waitFor(() => {
      expect(heightOf(frame)).toBe("520px");
    });
  });
});
