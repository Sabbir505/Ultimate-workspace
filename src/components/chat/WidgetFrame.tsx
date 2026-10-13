// The in-app visualization widget card (ChatGPT-Apps-style custom UI).
//
// A `render_widget` artifact (<!-- relay:widget --> marker → kind "widget")
// rendered as a themed, sandboxed iframe speaking the MCP Apps bridge
// (src/lib/mcpApps.ts). The injected bootstrap themes the document before
// first paint, reports content height, and intercepts links; the host side
// maps bridge requests onto Relay: links open the built-in browser pane,
// ui/message drafts into the composer, fullscreen keeps the SAME iframe node
// so the widget keeps its state, and teardown collapses the card without
// losing its place in the timeline.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  createWidgetHost,
  injectWidgetBootstrap,
  type WidgetDisplayMode,
  type WidgetDownload,
  type WidgetHost,
} from "../../lib/mcpApps";
import { observeWidgetTheme, resolveWidgetTheme } from "../../lib/widgetTheme";
import type { ChatArtifact } from "../../state/chat";
import { useChatStore } from "../../state/chat";
import { useUiStore } from "../../state/ui";

// Height bounds for the inline card: content-sized via the bridge, clamped so
// a runaway page can't push the chat into an endless scroll (same discipline
// as the diagram frames; the widget can ask for fullscreen for more room).
const WIDGET_DEFAULT_H = 360;
const WIDGET_MIN_H = 120;
const WIDGET_MAX_H = 640;

/** Longest human title on the card header (the filename is the fallback). */
const MAX_TITLE = 120;

function widgetTitle(filename: string): string {
  const stem = filename.replace(/\.html?$/i, "").replace(/[-_]+/g, " ").trim();
  return (stem || "Widget").slice(0, MAX_TITLE);
}

/** Save embedded bytes through the browser's own download flow. */
function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  // Long after the browser has read it: some downloads start a task or more
  // after the click, and a revoked URL saves nothing.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function WidgetFrame({
  artifact,
  html,
}: {
  artifact: ChatArtifact;
  /** The widget document (already read from disk by the router). */
  html: string;
}) {
  const title = useMemo(() => widgetTitle(artifact.filename), [artifact.filename]);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const blockRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(WIDGET_DEFAULT_H);
  const [width, setWidth] = useState(0);
  const [displayMode, setDisplayMode] = useState<WidgetDisplayMode>("inline");
  // The widget asked to be closed; the card keeps its box and offers reopen.
  const [closed, setClosed] = useState(false);
  // Counted per shown document: reopening loads a new document, which needs
  // its own host, its own srcDoc theme snapshot, and its own load tracking.
  const [documentGeneration, setDocumentGeneration] = useState(0);

  const openArtifactTab = useUiStore((s) => s.openArtifactTab);
  const pushToast = useUiStore((s) => s.pushToast);

  // Track the inline card width so hostContext.containerDimensions follows
  // the chat column (fullscreen reports the viewport box instead).
  useLayoutEffect(() => {
    const el = blockRef.current;
    if (!el) return;
    const update = () => setWidth(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [closed]);

  // Theme follows the app live; the FIRST resolution is baked into the
  // srcDoc (below) so first paint is already themed — later changes flow
  // over the bridge as host-context-changed, never as a srcDoc rebuild
  // (a changed srcDoc attribute reloads the iframe and resets the widget).
  const themeRef = useRef(resolveWidgetTheme());
  useEffect(() => {
    const stop = observeWidgetTheme((next) => {
      themeRef.current = next;
      hostRef.current?.updateHostContext();
    });
    return stop;
  }, []);

  // The bootstrap + shim are injected per document generation; memoized on
  // [html, documentGeneration] only — a parent re-render (streaming updates
  // elsewhere in the message) must never rebuild the srcDoc string.
  const srcDoc = useMemo(
    () =>
      injectWidgetBootstrap(html, {
        title,
        theme: { appearance: themeRef.current.appearance, variables: { ...themeRef.current.variables } },
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- theme is deliberately captured once per document (see above).
    [html, documentGeneration, title],
  );

  // Read by the host on every message via `latest`, so callbacks always see
  // current values without rebuilding the host (which would reset the app).
  const latest = useRef({
    width,
    displayMode,
    artifact,
    openArtifactTab,
    pushToast,
  });
  useEffect(() => {
    latest.current = { width, displayMode, artifact, openArtifactTab, pushToast };
  });

  const hostRef = useRef<WidgetHost | null>(null);
  useEffect(() => {
    const host = createWidgetHost({
      post: (message) => {
        frameRef.current?.contentWindow?.postMessage(message, "*");
      },
      hostContext: () => {
        const { width: w, displayMode: mode } = latest.current;
        const theme = themeRef.current;
        return {
          theme: theme.appearance,
          styles: { variables: theme.variables },
          displayMode: mode,
          availableDisplayModes: ["inline", "fullscreen"],
          containerDimensions:
            mode === "fullscreen"
              ? {
                  width: frameRef.current?.clientWidth || window.innerWidth,
                  maxHeight: window.innerHeight,
                }
              : { width: w, maxHeight: WIDGET_MAX_H },
          platform: "desktop",
          locale: navigator.language,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          userAgent: "relay-widget-host/1.0",
          deviceCapabilities: {
            touch: window.matchMedia("(pointer: coarse)").matches,
            hover: window.matchMedia("(hover: hover)").matches,
          },
          safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
        };
      },
      openLink: async (url) => {
        // http(s) is enforced by the bridge; widget links land in Relay's own
        // browser pane, like every other chat link.
        const { openInBrowserPane } = await import("../../lib/openBrowserPane");
        openInBrowserPane(url);
      },
      sendMessage: async (text) => {
        const sessionId = useChatStore.getState().activeChatSessionId;
        if (!sessionId) throw new Error("No active chat to draft into.");
        useChatStore.getState().setComposerDraft(sessionId, (prev) =>
          prev.trim() ? `${prev}\n\n${text}` : text,
        );
        latest.current.pushToast(
          "info",
          "Widget message drafted",
          "Review it in the composer and press send.",
        );
      },
      requestDisplayMode: async (mode) => {
        setDisplayMode(mode);
        return mode;
      },
      downloadFiles: async (files: WidgetDownload[]) => {
        for (const file of files) {
          saveBlob(new Blob([file.bytes.slice()], { type: file.mimeType }), file.name);
        }
        latest.current.pushToast("info", `Saved ${files.length} file${files.length === 1 ? "" : "s"}`);
      },
      updateModelContext: async () => {
        // Acked in v1; the payload feeds the next turn in a later phase
        // (docs/architecture/IN_APP_VISUALIZATION.md).
      },
      onRequestTeardown: () => {
        if (latest.current.displayMode === "fullscreen") {
          setDisplayMode("inline");
          return;
        }
        void host.teardown().then(() => setClosed(true));
      },
      onSizeChanged: (size) => {
        if (latest.current.displayMode === "fullscreen") return;
        if (typeof size.height === "number" && Number.isFinite(size.height)) {
          setHeight(Math.min(WIDGET_MAX_H, Math.max(WIDGET_MIN_H, Math.round(size.height))));
        }
      },
    });
    hostRef.current = host;
    const receive = (event: MessageEvent) => {
      // Only messages from THIS frame's window reach its host — the frame is
      // opaque-origin, so the window reference is what scopes delivery.
      if (event.source !== null && event.source === frameRef.current?.contentWindow) {
        host.receive(event.data);
      }
    };
    window.addEventListener("message", receive);
    return () => {
      window.removeEventListener("message", receive);
      // A list that recycles rows can't wait: teardown goes out before the
      // frame unmounts.
      void host.teardown();
      host.dispose();
      hostRef.current = null;
    };
  }, [srcDoc]);

  // Context changes (theme, width, display mode) re-send over the bridge.
  useEffect(() => {
    hostRef.current?.updateHostContext();
  }, [width, displayMode]);

  // Fullscreen: Escape and outside focus leave; body scroll locks while open.
  useEffect(() => {
    if (displayMode !== "fullscreen") return;
    const leave = () => setDisplayMode("inline");
    const onFocusIn = (event: FocusEvent) => {
      if (event.target instanceof Node && !blockRef.current?.contains(event.target)) leave();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") leave();
    };
    document.addEventListener("focusin", onFocusIn);
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [displayMode]);

  const reopen = useCallback(() => {
    setClosed(false);
    setHeight(WIDGET_DEFAULT_H);
    setDocumentGeneration((v) => v + 1);
  }, []);

  const fullscreen = displayMode === "fullscreen";
  if (closed) {
    return (
      <div className="chat-widget-block chat-widget-closed">
        <span>Widget closed</span>
        <button type="button" className="chat-widget-reopen" onClick={reopen}>
          Show
        </button>
      </div>
    );
  }

  return (
    // The block keeps its inline height while fullscreen so the timeline
    // doesn't jump; the SAME iframe node is only restyled, never reparented —
    // the widget's state survives the round trip.
    <div
      ref={blockRef}
      className={fullscreen ? "chat-widget-block chat-widget-fullscreen" : "chat-widget-block"}
      style={fullscreen ? undefined : { height }}
    >
      <div className="chat-widget-header">
        <span className="chat-widget-title" title={title}>
          {title}
        </span>
        <div className="chat-widget-actions">
          <button
            type="button"
            className="chat-widget-btn"
            aria-label={fullscreen ? "Exit full view" : "Full view"}
            title={fullscreen ? "Exit full view" : "Full view"}
            onClick={() => setDisplayMode(fullscreen ? "inline" : "fullscreen")}
          >
            {fullscreen ? <CollapseIcon /> : <ExpandIcon />}
          </button>
          <button
            type="button"
            className="chat-widget-btn"
            aria-label="Open in tab"
            title="Open in tab"
            onClick={() => openArtifactTab({ path: artifact.path, filename: artifact.filename })}
          >
            <ExternalIcon />
          </button>
          {fullscreen ? null : (
            <button
              type="button"
              className="chat-widget-btn"
              aria-label="Close widget"
              title="Close widget"
              onClick={() => setClosed(true)}
            >
              <CloseIcon />
            </button>
          )}
        </div>
      </div>
      <iframe
        ref={frameRef}
        className="chat-widget-frame"
        title={title}
        // Opaque origin: no allow-same-origin, so the frame has no Tauri or
        // parent access — everything it can do goes through the bridge.
        sandbox="allow-scripts allow-forms allow-modals allow-popups"
        srcDoc={srcDoc}
        style={fullscreen ? undefined : { height }}
      />
    </div>
  );
}

// Minimal inline icons (no icon dependency in the chat components).
const iconProps = {
  width: 14,
  height: 14,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

function ExpandIcon() {
  return (
    <svg {...iconProps}>
      <polyline points="15 3 21 3 21 9" />
      <polyline points="9 21 3 21 3 15" />
      <line x1="21" y1="3" x2="14" y2="10" />
      <line x1="3" y1="21" x2="10" y2="14" />
    </svg>
  );
}

function CollapseIcon() {
  return (
    <svg {...iconProps}>
      <polyline points="4 14 10 14 10 20" />
      <polyline points="20 10 14 10 14 4" />
      <line x1="14" y1="10" x2="21" y2="3" />
      <line x1="3" y1="21" x2="10" y2="14" />
    </svg>
  );
}

function ExternalIcon() {
  return (
    <svg {...iconProps}>
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg {...iconProps}>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}
