// Tests for the in-app visualization widget surface:
//   1. The MCP Apps host bridge (createWidgetHost): handshake, request
//      routing, refusals, size-driven auto-height, teardown, context diffs.
//   2. injectWidgetBootstrap: theme-before-paint injection points and the
//      embedded shim/config (per document kind: head / html / doctype / fragment).
//   3. WidgetFrame: sandbox posture, height from the bridge, fullscreen class
//      toggle, and message scoping (a foreign window's postMessage is ignored).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import {
  createWidgetHost,
  injectWidgetBootstrap,
  MCP_APP_PROTOCOL_VERSION,
  type WidgetHostContext,
  type WidgetHostOptions,
} from "../lib/mcpApps";
import { WidgetFrame } from "../components/chat/WidgetFrame";

const THEME = {
  appearance: "dark" as const,
  variables: { "--background": "#181818", "--foreground": "#e4e4e4" },
};

function hostContext(overrides: Record<string, unknown> = {}): WidgetHostContext {
  return {
    theme: THEME.appearance,
    styles: { variables: THEME.variables },
    displayMode: "inline" as const,
    availableDisplayModes: ["inline", "fullscreen"],
    containerDimensions: { width: 640, maxHeight: 640 },
    platform: "desktop" as const,
    locale: "en-US",
    timeZone: "UTC",
    userAgent: "relay-widget-host/test",
    deviceCapabilities: { touch: false, hover: true },
    safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    ...overrides,
  };
}

function baseOptions(over: Partial<WidgetHostOptions> = {}): WidgetHostOptions {
  return {
    post: vi.fn(),
    hostContext: () => hostContext(),
    openLink: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    requestDisplayMode: vi.fn().mockImplementation(async (mode) => mode),
    downloadFiles: vi.fn().mockResolvedValue(undefined),
    updateModelContext: vi.fn().mockResolvedValue(undefined),
    onRequestTeardown: vi.fn(),
    onSizeChanged: vi.fn(),
    ...over,
  };
}

describe("createWidgetHost (MCP Apps bridge)", () => {
  it("answers ui/initialize with protocol version, host info and context", () => {
    const post = vi.fn();
    const host = createWidgetHost(baseOptions({ post, hostContext: () => hostContext() }));
    host.receive({ jsonrpc: "2.0", id: 1, method: "ui/initialize", params: { appInfo: { name: "w" } } });
    expect(post).toHaveBeenCalledTimes(1);
    const resp = post.mock.calls[0]![0] as {
      id: number;
      result: { protocolVersion: string; hostInfo: { name: string }; hostContext: { theme: string; styles: { variables: Record<string, string> } } };
    };
    expect(resp.id).toBe(1);
    expect(resp.result.protocolVersion).toBe(MCP_APP_PROTOCOL_VERSION);
    expect(resp.result.hostInfo.name).toBe("relay");
    expect(resp.result.hostContext.theme).toBe("dark");
    expect(resp.result.hostContext.styles.variables["--background"]).toBe("#181818");
    host.dispose();
  });

  it("routes ui/open-link and refuses non-http schemes", () => {
    const openLink = vi.fn().mockResolvedValue(undefined);
    const post = vi.fn();
    const host = createWidgetHost(baseOptions({ post, openLink }));
    host.receive({ jsonrpc: "2.0", id: "a", method: "ui/open-link", params: { url: "javascript:alert(1)" } });
    host.receive({ jsonrpc: "2.0", id: "b", method: "ui/open-link", params: { url: "file:///etc/passwd" } });
    host.receive({ jsonrpc: "2.0", id: "c", method: "ui/open-link", params: { url: "https://example.com/x" } });
    const error = post.mock.calls[0]![0] as { id: string; error: { code: number } };
    expect(error.id).toBe("a");
    expect(error.error.code).toBe(-32602);
    expect((post.mock.calls[1]![0] as { id: string }).id).toBe("b");
    // The https call reaches the callback.
    expect(openLink).toHaveBeenCalledWith("https://example.com/x");
    host.dispose();
  });

  it("refuses tools/call from a widget with a clear error (v1 scope)", () => {
    const post = vi.fn();
    const host = createWidgetHost(baseOptions({ post }));
    host.receive({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "web_search", arguments: {} } });
    const resp = post.mock.calls[0]![0] as { id: number; error: { code: number; message: string } };
    expect(resp.error.code).toBe(-32001);
    expect(resp.error.message).toContain("cannot call tools");
    host.dispose();
  });

  it("validates ui/message and forwards the text", async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const post = vi.fn();
    const host = createWidgetHost(baseOptions({ post, sendMessage }));
    // Non-user role refused.
    host.receive({ jsonrpc: "2.0", id: 1, method: "ui/message", params: { role: "assistant", content: { type: "text", text: "hi" } } });
    expect((post.mock.calls[0]![0] as { id: number; error?: unknown }).error).toBeTruthy();
    // A text block array is joined and forwarded.
    host.receive({
      jsonrpc: "2.0",
      id: 2,
      method: "ui/message",
      params: { role: "user", content: [{ type: "text", text: "Run" }, { type: "text", text: " the report" }] },
    });
    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith("Run\n the report"));
    host.dispose();
  });

  it("echoes request-display-mode through the callback", async () => {
    const post = vi.fn();
    const host = createWidgetHost(
      baseOptions({ post, requestDisplayMode: vi.fn().mockResolvedValue("fullscreen") }),
    );
    host.receive({ jsonrpc: "2.0", id: "m", method: "ui/request-display-mode", params: { mode: "fullscreen" } });
    await waitFor(() => {
      const resp = post.mock.calls.find((c) => (c[0] as { id?: unknown }).id === "m");
      expect(resp).toBeTruthy();
      expect((resp![0] as { result: { mode: string } }).result.mode).toBe("fullscreen");
    });
    host.dispose();
  });

  it("forwards size-changed notifications to onSizeChanged", () => {
    const onSizeChanged = vi.fn();
    const host = createWidgetHost(baseOptions({ onSizeChanged }));
    host.receive({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: 432.7 } });
    expect(onSizeChanged).toHaveBeenCalledWith({ height: 432.7 });
    // No numbers → no callback.
    onSizeChanged.mockClear();
    host.receive({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: {} });
    expect(onSizeChanged).not.toHaveBeenCalled();
    host.dispose();
  });

  it("ignores oversized and malformed messages", () => {
    const post = vi.fn();
    const host = createWidgetHost(baseOptions({ post }));
    // Malformed: no jsonrpc.
    host.receive({ id: 1, method: "ui/initialize", params: {} });
    // Oversized payload (a 300 KB string rides the params).
    const big = { jsonrpc: "2.0", id: 2, method: "ui/initialize", params: { blob: "x".repeat(300 * 1024) } };
    host.receive(big);
    expect(post).not.toHaveBeenCalled();
    host.dispose();
  });

  it("updateHostContext sends only the changed fields after initialized", () => {
    const post = vi.fn();
    let ctx = hostContext();
    const host = createWidgetHost(baseOptions({ post, hostContext: () => ctx }));
    // Handshake: initialize → 1 post (the response); initialized notification.
    host.receive({ jsonrpc: "2.0", id: 1, method: "ui/initialize", params: { appInfo: { name: "w" } } });
    host.receive({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
    host.updateHostContext();
    // No change → no notification.
    expect(post).toHaveBeenCalledTimes(1); // only the initialize response
    // Theme flips → exactly theme + styles ride the notification.
    ctx = hostContext({ theme: "light" as const, styles: { variables: { "--background": "#fff" } } });
    host.updateHostContext();
    const notify = post.mock.calls[1]![0] as { method: string; params: Record<string, unknown> };
    expect(notify.method).toBe("ui/notifications/host-context-changed");
    expect(notify.params.theme).toBe("light");
    expect(notify.params.styles).toEqual({ variables: { "--background": "#fff" } });
    expect(notify.params.displayMode).toBeUndefined();
    host.dispose();
  });

  it("teardown posts ui/resource-teardown and resolves on the app's response", async () => {
    const post = vi.fn();
    const host = createWidgetHost(baseOptions({ post }));
    const done = host.teardown();
    const req = post.mock.calls[0]![0] as { id: string; method: string };
    expect(req.method).toBe("ui/resource-teardown");
    host.receive({ jsonrpc: "2.0", id: req.id, result: {} });
    await expect(done).resolves.toBeUndefined();
    host.dispose();
  });

  it("request-teardown notification reaches onRequestTeardown", () => {
    const onRequestTeardown = vi.fn();
    const host = createWidgetHost(baseOptions({ onRequestTeardown }));
    host.receive({ jsonrpc: "2.0", method: "ui/notifications/request-teardown", params: {} });
    expect(onRequestTeardown).toHaveBeenCalledTimes(1);
    host.dispose();
  });
});

describe("injectWidgetBootstrap", () => {
  const config = {
    title: "Test widget",
    theme: { appearance: "dark" as const, variables: { "--background": "#181818" } },
  };

  it("injects after <head> when the document has one", () => {
    const out = injectWidgetBootstrap("<!doctype html><html><head><title>t</title></head><body></body></html>", config);
    const at = out.indexOf("</head>");
    expect(out.slice(0, at)).toContain("window.__RELAY_WIDGET__");
    // The bootstrap sits BEFORE the page's own head content (theme first).
    expect(out.indexOf("__RELAY_WIDGET__")).toBeLessThan(out.indexOf("<title>"));
  });

  it("synthesizes a head for <html>-only and doctype-only documents", () => {
    for (const doc of ["<html><body>x</body></html>", "<!doctype html><body>x</body>"]) {
      const out = injectWidgetBootstrap(doc, config);
      expect(out).toContain("<head><script>window.__RELAY_WIDGET__");
      expect(out).toContain("</head>");
    }
  });

  it("wraps a bare fragment in a complete document", () => {
    const out = injectWidgetBootstrap("<div>hi</div>", config);
    expect(out.startsWith("<!doctype html><head>")).toBe(true);
    expect(out.endsWith("<div>hi</div>")).toBe(true);
  });

  it("never injects inside a comment or script that quotes </head>", () => {
    const tricky = `<!doctype html><html><head><script>var s="</head>";<\/script></head><body></body></html>`;
    const out = injectWidgetBootstrap(tricky, config);
    // The bootstrap lands immediately after the real <head> open tag — the
    // quoted "</head>" inside the page's own script (blanked during the scan)
    // did not capture the injection.
    expect(out.startsWith("<!doctype html><html><head><script>window.__RELAY_WIDGET__")).toBe(true);
    expect(out.indexOf("__RELAY_WIDGET__")).toBeLessThan(out.indexOf("var s="));
  });

  it("embeds the theme config and the handshake in the shim", () => {
    const out = injectWidgetBootstrap("<div>x</div>", config);
    expect(out).toContain('"title":"Test widget"');
    expect(out).toContain('"--background":"#181818"');
    expect(out).toContain("ui/initialize");
    expect(out).toContain("ui/notifications/size-changed");
    expect(out).toContain("relayWidget");
  });
});

describe("WidgetFrame", () => {
  // jsdom lacks matchMedia; the host context reads it for deviceCapabilities.
  beforeEach(() => {
    if (!window.matchMedia) {
      Object.defineProperty(window, "matchMedia", {
        writable: true,
        value: vi.fn().mockReturnValue({ matches: false }),
      });
    }
  });

  const artifact = { path: "D:/artifacts/widget.html", filename: "sine-explorer.html" };

  function frameMessage(payload: unknown) {
    window.dispatchEvent(
      new MessageEvent("message", {
        source: (document.querySelector("iframe.chat-widget-frame") as HTMLIFrameElement)
          ?.contentWindow,
        data: payload,
      }),
    );
  }

  it("renders the sandboxed frame with the themed srcDoc and header", () => {
    const { container, unmount } = render(<FrameFixture html="<!doctype html><html><body>hi</body></html>" artifact={artifact} />);
    const frame = container.querySelector("iframe.chat-widget-frame") as HTMLIFrameElement;
    expect(frame).toBeTruthy();
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-forms allow-modals allow-popups");
    // Theme + shim injected into the head of the srcDoc.
    expect(frame.getAttribute("srcdoc")).toContain("__RELAY_WIDGET__");
    const header = container.querySelector(".chat-widget-title");
    expect(header?.textContent).toContain("sine explorer");
    unmount();
  });

  it("sizes the frame from the bridge's size-changed, clamped", async () => {
    const { container, unmount } = render(<FrameFixture html="<div>x</div>" artifact={artifact} />);
    const frame = container.querySelector("iframe.chat-widget-frame") as HTMLIFrameElement;
    // jsdom iframes have no contentWindow until loaded; stub it so the
    // source check passes and the message flows.
    Object.defineProperty(frame, "contentWindow", { value: window });
    fireEvent(frame, new MessageEvent("message", { data: {} })); // foreign shape: ignored
    frameMessage({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: 9000 } });
    await waitFor(() => {
      expect((frame as HTMLIFrameElement & { style: CSSStyleDeclaration }).style.height).toBe("640px");
    });
    frameMessage({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: 300 } });
    await waitFor(() => expect(frame.style.height).toBe("300px"));
    unmount();
  });

  it("ignores messages from other windows (scoping by source)", async () => {
    const { container, unmount } = render(<FrameFixture html="<div>x</div>" artifact={artifact} />);
    const frame = container.querySelector("iframe.chat-widget-frame") as HTMLIFrameElement;
    Object.defineProperty(frame, "contentWindow", { value: window });
    const foreign = {} as Window;
    window.dispatchEvent(
      new MessageEvent("message", { source: foreign, data: { jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: 500 } } }),
    );
    await new Promise((r) => setTimeout(r, 20));
    // Height stays at the default: the foreign message never reached the host.
    expect(frame.style.height).toBe("360px");
    unmount();
  });

  it("fullscreen: display-mode request adds the class, Escape leaves", async () => {
    const { container, unmount } = render(<FrameFixture html="<div>x</div>" artifact={artifact} />);
    const frame = container.querySelector("iframe.chat-widget-frame") as HTMLIFrameElement;
    Object.defineProperty(frame, "contentWindow", { value: window });
    frameMessage({ jsonrpc: "2.0", id: "d1", method: "ui/request-display-mode", params: { mode: "fullscreen" } });
    await waitFor(() => {
      const block = container.querySelector(".chat-widget-block");
      expect(block?.className).toContain("chat-widget-fullscreen");
    });
    fireEvent(window, new KeyboardEvent("keydown", { key: "Escape" }));
    await waitFor(() => {
      const block = container.querySelector(".chat-widget-block");
      expect(block?.className).not.toContain("chat-widget-fullscreen");
    });
    unmount();
  });

  afterEach(cleanup);
});

/** WidgetFrame with the stores it reads stubbed to defaults. */
function FrameFixture(props: { html: string; artifact: { path: string; filename: string } }) {
  return <WidgetFrame artifact={props.artifact} html={props.html} />;
}
