// MCP Apps bridge for Relay's in-app visualization widgets.
//
// Shape follows the MCP Apps protocol (SEP-1865, `io.modelcontextprotocol/ui`,
// draft 2026-01-26 — the standardization of ChatGPT's Apps SDK bridge): the
// widget document is an app that talks JSON-RPC 2.0 over postMessage to the
// host (the chat). Two halves live here:
//
//   1. `createWidgetHost` — the HOST side (framework-free, unit-tested),
//      modeled on the same protocol surface T3 Code's McpAppFrame runs:
//      handshake, host context, open-link / message / display-mode /
//      download requests, size-driven auto-height, teardown.
//   2. `injectWidgetBootstrap` — the APP-side shim Relay injects into every
//      widget document. Model-authored pages get theme-before-first-paint,
//      link interception, height reporting, and a small `window.relayWidget`
//      API without importing anything.
//
// v1 scope (see docs/architecture/IN_APP_VISUALIZATION.md): built-in widgets
// only — `tools/call` and `resources/read` from a widget are refused, and
// `ui/update-model-context` is acked but not yet injected into the next turn.

export const MCP_APP_PROTOCOL_VERSION = "2026-01-26";

/** Refused beyond this size — a widget cannot OOM the host with one postMessage. */
const MAX_MESSAGE_BYTES = 256 * 1024;
/** Max concurrent app→host requests; further ones are refused, not queued. */
const MAX_PENDING_REQUESTS = 16;
/** How long the host waits for the app to answer `ui/resource-teardown`. */
const TEARDOWN_TIMEOUT_MS = 2000;

export type WidgetDisplayMode = "inline" | "fullscreen";

/** JSON-RPC id: string or a finite number. */
type RpcId = string | number;

export interface WidgetHostContext {
  theme: "light" | "dark";
  styles: { variables: Record<string, string> };
  displayMode: WidgetDisplayMode;
  availableDisplayModes: WidgetDisplayMode[];
  /** Flexible box: the host sizes the frame to the app's reported height. */
  containerDimensions: { width: number; maxHeight: number };
  platform: "desktop";
  locale: string;
  timeZone: string;
  userAgent: string;
  deviceCapabilities: { touch: boolean; hover: boolean };
  safeAreaInsets: { top: number; right: number; bottom: number; left: number };
}

/** A file a widget asked to save via `ui/download-file` (embedded bytes only in v1). */
export interface WidgetDownload {
  name: string;
  mimeType: string;
  bytes: Uint8Array;
}

export interface WidgetHostOptions {
  /** Posts one JSON-RPC message into the widget frame. */
  post: (message: unknown) => void;
  hostContext: () => WidgetHostContext;
  openLink: (url: string) => Promise<void>;
  sendMessage: (text: string) => Promise<void>;
  requestDisplayMode: (mode: WidgetDisplayMode) => Promise<WidgetDisplayMode>;
  downloadFiles: (files: WidgetDownload[]) => Promise<void>;
  /** Acked in v1; the stored payload feeds the next turn in a later phase. */
  updateModelContext: (context: {
    content?: unknown[];
    structuredContent?: Record<string, unknown>;
  }) => Promise<void>;
  onRequestTeardown: () => void;
  onSizeChanged: (size: { width?: number; height?: number }) => void;
}

export interface WidgetHost {
  /** Handles one message posted by the widget (source already verified). */
  receive: (data: unknown) => void;
  /** Re-sends host-context-changed with fields that changed since last send. */
  updateHostContext: () => void;
  /** Asks the widget to wrap up; resolves on its answer or a short timeout. */
  teardown: () => Promise<void>;
  dispose: () => void;
}

const isId = (v: unknown): v is RpcId =>
  typeof v === "string" || (typeof v === "number" && Number.isFinite(v));

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

const jsonBytes = (value: unknown): number => {
  try {
    return new TextEncoder().encode(JSON.stringify(value) ?? "").byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
};

/** Decode an MCP resource content item into bytes (text as UTF-8, blob as
 *  base64). Returns undefined when it carries neither usable shape. */
export function mcpResourceBytes(content: unknown): Uint8Array | undefined {
  if (!isObject(content)) return undefined;
  if (typeof content.text === "string") return new TextEncoder().encode(content.text);
  if (typeof content.blob === "string") {
    try {
      const bin = atob(content.blob);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      return bytes;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function createWidgetHost(options: WidgetHostOptions): WidgetHost {
  let initialized = false;
  let disposed = false;
  let pending = 0;
  let sentContext: WidgetHostContext | undefined;
  let nextHostRequestId = 0;
  const hostRequests = new Map<string, () => void>();

  const post = (message: unknown) => {
    if (!disposed) options.post(message);
  };
  const notify = (method: string, params?: unknown) => post({ jsonrpc: "2.0", method, params });
  const respond = (id: RpcId, result: unknown) => post({ jsonrpc: "2.0", id, result });
  const fail = (id: RpcId, code: number, message: string) =>
    post({ jsonrpc: "2.0", id, error: { code, message } });

  const answer = (id: RpcId, run: () => Promise<unknown>) => {
    if (pending >= MAX_PENDING_REQUESTS) {
      fail(id, -32000, "Too many requests in flight.");
      return;
    }
    pending += 1;
    void run().then(
      (result) => {
        pending -= 1;
        respond(id, result);
      },
      (error: unknown) => {
        pending -= 1;
        fail(id, -32000, error instanceof Error && error.message ? error.message : "Request failed.");
      },
    );
  };

  const handleRequest = (id: RpcId, method: string, params: Record<string, unknown>) => {
    switch (method) {
      case "ui/initialize": {
        sentContext = options.hostContext();
        respond(id, {
          protocolVersion: MCP_APP_PROTOCOL_VERSION,
          hostInfo: { name: "relay", version: "1.0.0" },
          hostCapabilities: {
            openLinks: {},
            message: { text: {} },
            updateModelContext: { text: {}, structuredContent: {} },
            downloadFile: {},
            sandbox: {},
          },
          hostContext: sentContext,
        });
        return;
      }
      case "ping":
        respond(id, {});
        return;
      case "ui/open-link": {
        const url = params.url;
        if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
          fail(id, -32602, "Only http(s) links can be opened.");
          return;
        }
        answer(id, () => options.openLink(url).then(() => ({})));
        return;
      }
      case "ui/message": {
        const blocks = Array.isArray(params.content) ? params.content : [params.content];
        const texts = blocks.map((block) =>
          isObject(block) && block.type === "text" && typeof block.text === "string"
            ? block.text
            : undefined,
        );
        if (params.role !== "user" || texts.length === 0 || texts.includes(undefined)) {
          fail(id, -32602, "Only text messages from the user role are supported.");
          return;
        }
        const text = texts.join("\n").trim();
        if (text === "") {
          fail(id, -32602, "ui/message needs non-empty text.");
          return;
        }
        answer(id, () => options.sendMessage(text).then(() => ({})));
        return;
      }
      case "ui/update-model-context": {
        const content = params.content;
        const structured = params.structuredContent;
        if ((content !== undefined && !Array.isArray(content)) || (structured !== undefined && !isObject(structured))) {
          fail(id, -32602, "Model context needs content blocks or an object of structured content.");
          return;
        }
        answer(id, () =>
          options
            .updateModelContext({
              ...(content === undefined ? {} : { content }),
              ...(structured === undefined ? {} : { structuredContent: structured }),
            })
            .then(() => ({})),
        );
        return;
      }
      case "ui/request-display-mode": {
        const mode = params.mode;
        if (mode !== "inline" && mode !== "fullscreen") {
          respond(id, { mode: options.hostContext().displayMode });
          return;
        }
        answer(id, () => options.requestDisplayMode(mode).then((result) => ({ mode: result })));
        return;
      }
      case "ui/download-file": {
        const files = readDownloads(params.contents);
        if (files === undefined) {
          fail(id, -32602, "ui/download-file needs embedded text or base64 blob contents.");
          return;
        }
        answer(id, () => options.downloadFiles(files).then(() => ({})));
        return;
      }
      // v1: a built-in widget has no server to call back into. The refusal is
      // a clear error the widget can surface, not silent breakage.
      case "tools/call":
        fail(id, -32001, "Widgets cannot call tools in this version of Relay.");
        return;
      case "resources/read":
        fail(id, -32001, "Widgets cannot read resources in this version of Relay.");
        return;
      default:
        fail(id, -32601, `Method not found: ${method}`);
    }
  };

  const handleNotification = (method: string, params: Record<string, unknown>) => {
    switch (method) {
      case "ui/notifications/initialized":
        // The host must not message the widget before this; context changes
        // that piled up during load flush from the caller's updateHostContext.
        initialized = true;
        return;
      case "ui/notifications/size-changed": {
        const width = typeof params.width === "number" ? params.width : undefined;
        const height = typeof params.height === "number" ? params.height : undefined;
        if (width !== undefined || height !== undefined) {
          options.onSizeChanged({
            ...(width === undefined ? {} : { width }),
            ...(height === undefined ? {} : { height }),
          });
        }
        return;
      }
      case "ui/notifications/request-teardown":
        options.onRequestTeardown();
        return;
      default:
        // notifications/message (logging) and unknown notifications are ignored.
        return;
    }
  };

  const handleResponse = (id: RpcId) => {
    const settle = hostRequests.get(String(id));
    if (settle === undefined) return;
    hostRequests.delete(String(id));
    settle();
  };

  const host: WidgetHost = {
    receive(data: unknown) {
      if (disposed) return;
      if (jsonBytes(data) > MAX_MESSAGE_BYTES) return;
      if (!isObject(data) || data.jsonrpc !== "2.0") return;
      const { method, params, id } = data;
      if (method !== undefined) {
        if (typeof method !== "string") return;
        if (method.startsWith("ui/notifications/")) {
          if (isObject(params)) handleNotification(method, params);
          return;
        }
        if (isId(id) && isObject(params)) handleRequest(id, method, params);
        else if (isId(id)) fail(id, -32602, "Request params must be an object.");
        return;
      }
      if (isId(id)) handleResponse(id);
    },

    updateHostContext() {
      if (!initialized || disposed) return;
      const next = options.hostContext();
      const prev = sentContext;
      sentContext = next;
      if (!prev) return;
      const params: Record<string, unknown> = {};
      if (prev.theme !== next.theme) params.theme = next.theme;
      if (JSON.stringify(prev.styles) !== JSON.stringify(next.styles)) {
        params.styles = next.styles;
      }
      if (prev.displayMode !== next.displayMode) params.displayMode = next.displayMode;
      if (
        JSON.stringify(prev.containerDimensions) !== JSON.stringify(next.containerDimensions)
      ) {
        params.containerDimensions = next.containerDimensions;
      }
      if (Object.keys(params).length === 0) return;
      notify("ui/notifications/host-context-changed", params);
    },

    teardown() {
      if (disposed) return Promise.resolve();
      const id = `teardown-${++nextHostRequestId}`;
      return new Promise<void>((resolve) => {
        const timer = window.setTimeout(() => {
          hostRequests.delete(id);
          resolve();
        }, TEARDOWN_TIMEOUT_MS);
        hostRequests.set(id, () => {
          window.clearTimeout(timer);
          resolve();
        });
        post({ jsonrpc: "2.0", id, method: "ui/resource-teardown", params: {} });
      });
    },

    dispose() {
      disposed = true;
      hostRequests.clear();
    },
  };

  return host;
}

/** Read `ui/download-file` contents (embedded `text`/`blob` items only — a
 *  resource link would make the host fetch from the widget's origin). */
function readDownloads(value: unknown): WidgetDownload[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 10) return undefined;
  const files: WidgetDownload[] = [];
  for (const item of value) {
    if (!isObject(item)) return undefined;
    const name =
      typeof item.name === "string" && item.name.trim() !== ""
        ? item.name.trim().slice(0, 120)
        : undefined;
    if (name === undefined) return undefined;
    const bytes = mcpResourceBytes(item);
    if (bytes === undefined || bytes.byteLength > 25 * 1024 * 1024) return undefined;
    files.push({
      name,
      mimeType: typeof item.mimeType === "string" ? item.mimeType : "application/octet-stream",
      bytes,
    });
  }
  return files;
}

// ---- App-side bootstrap (injected into the widget document) ----

/** Base stylesheet for widget documents: transparent page on the chat
 *  background, no margin, hidden inner scrollbar, in-set focus outlines. */
const WIDGET_BASE_CSS =
  "html{background:transparent;color:var(--foreground);font-family:var(--font-sans);font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%;scrollbar-width:none}" +
  "html::-webkit-scrollbar{display:none}body{margin:0}" +
  "code,kbd,pre,samp{font-family:var(--font-mono)}" +
  ":where(:focus-visible){outline:2px solid var(--accent);outline-offset:-2px}";

export interface WidgetBootstrapConfig {
  title: string;
  theme: { appearance: "light" | "dark"; variables: Record<string, string> };
}

/**
 * The app-side shim: applies the theme before first paint, completes the
 * `ui/initialize` handshake, reports content height, intercepts links, and
 * exposes `window.relayWidget`. Runs entirely standalone (no imports) so it
 * can be embedded in a srcDoc document.
 */
const WIDGET_SHIM = `(function(){
var CFG=window.__RELAY_WIDGET__||{title:"widget",theme:{appearance:"dark",variables:{}}};
var seq=0,pending={},initialized=false;
var BASE_CSS=${JSON.stringify(WIDGET_BASE_CSS)};
function post(m){try{parent.postMessage(m,"*")}catch(e){}}
function send(method,params){return new Promise(function(res){var id="rw-"+(++seq);pending[id]=res;post({jsonrpc:"2.0",id:id,method:method,params:params||{}})})}
function notify(method,params){post({jsonrpc:"2.0",method:method,params:params||{}})}
function ensureStyle(){var s=document.getElementById("relay-widget-theme");if(!s){s=document.createElement("style");s.id="relay-widget-theme";var h=document.head||document.documentElement;h.insertBefore(s,h.firstChild)}return s}
function applyTheme(t){if(!t||!t.variables||typeof t.variables!=="object")return;var c=":root{color-scheme:"+(t.appearance==="light"?"light":"dark")+";";for(var k in t.variables){if(/^--[a-z0-9-]+$/.test(k))c+=k+":"+String(t.variables[k]).replace(/[;{}<>]/g,"")+";"}try{ensureStyle().textContent=c+"}"+BASE_CSS}catch(e){}}
try{applyTheme(CFG.theme)}catch(e){}
window.addEventListener("message",function(e){var d=e.data;if(!d||d.jsonrpc!=="2.0")return;if(d.method!==undefined){var p=d.params||{};if(d.method==="ui/notifications/host-context-changed"&&p.styles)applyTheme({appearance:p.theme,variables:p.styles.variables});else if(d.method==="ui/resource-teardown")post({jsonrpc:"2.0",id:d.id,result:{}});return}if(d.id!==undefined&&pending[d.id]){var fn=pending[d.id];delete pending[d.id];fn(d)}});
document.addEventListener("click",function(e){if(!e.isTrusted||window.parent===window)return;var t=e.target;if(!t||!t.closest)return;var a=t.closest("a[href]");if(!a)return;var href=a.getAttribute("href")||"";var u;try{u=new URL(href,location.href)}catch(x){return}if(u.protocol!=="http:"&&u.protocol!=="https:")return;if(u.href.split("#")[0]===location.href.split("#")[0])return;e.preventDefault();send("ui/open-link",{url:u.href})},true);
var lastH=0;function reportH(){var h=Math.ceil(document.documentElement.scrollHeight);if(h!==lastH){lastH=h;notify("ui/notifications/size-changed",{height:h})}}
if(window.ResizeObserver){try{new ResizeObserver(reportH).observe(document.documentElement)}catch(e){}}
document.addEventListener("DOMContentLoaded",reportH);window.addEventListener("load",reportH);reportH();
send("ui/initialize",{appInfo:{name:String(CFG.title||"widget"),version:"1.0.0"},appCapabilities:{availableDisplayModes:["inline","fullscreen"]}}).then(function(r){initialized=true;var ctx=r.result&&r.result.hostContext;if(ctx&&ctx.styles&&ctx.styles.variables)applyTheme({appearance:ctx.theme,variables:ctx.styles.variables});notify("ui/notifications/initialized")}).catch(function(){});
function unwrap(r){if(r.error)throw new Error(r.error.message||"Request failed");return r.result}
window.relayWidget={openLink:function(url){return send("ui/open-link",{url:String(url)}).then(unwrap)},sendMessage:function(text){return send("ui/message",{role:"user",content:{type:"text",text:String(text)}}).then(unwrap)},requestDisplayMode:function(mode){return send("ui/request-display-mode",{mode:mode==="fullscreen"?"fullscreen":"inline"}).then(unwrap)},downloadFile:function(files){return send("ui/download-file",{contents:files}).then(unwrap)},notifyHeight:reportH,onTheme:function(cb){window.addEventListener("message",function(e){var d=e.data;if(d&&d.jsonrpc==="2.0"&&d.method==="ui/notifications/host-context-changed"&&typeof cb==="function")cb(d.params)})}};})();
`;

// Comments, raw text, and template contents are blanked to the same length so
// offsets stay aligned and a `</head>` quoted inside a comment or script can
// never receive the bootstrap. Adapted from the same trick T3 Code uses.
function blankNonMarkup(html: string): string {
  return html.replace(
    /<!--[\s\S]*?(?:-->|$)|<(script|style|textarea|title|xmp|iframe|noembed|noframes|noscript)\b[\s\S]*?(?:<\/\1\s*>|$)|<plaintext\b[\s\S]*$/gi,
    (match) => " ".repeat(match.length),
  );
}

function bootstrapMarkup(config: WidgetBootstrapConfig): string {
  const cfg = JSON.stringify(config).replace(/</g, "\\u003c");
  return [
    `<script>window.__RELAY_WIDGET__=${cfg};${WIDGET_SHIM}</script>`,
  ].join("");
}

/**
 * Inject the widget bootstrap at the START of the document head, so the
 * theme applies before the page's own styles paint and the page's own `:root`
 * rules still win. Falls back through `<html>`, doctype, and bare-fragment
 * documents (model output is not always a complete document).
 */
export function injectWidgetBootstrap(html: string, config: WidgetBootstrapConfig): string {
  const markup = bootstrapMarkup(config);
  const scan = blankNonMarkup(html);
  const headOpen = /<head(?:\s[^>]*)?>/i.exec(scan);
  if (headOpen) {
    const at = headOpen.index + headOpen[0].length;
    return html.slice(0, at) + markup + html.slice(at);
  }
  const htmlOpen = /<html(?:\s[^>]*)?>/i.exec(scan);
  if (htmlOpen) {
    const at = htmlOpen.index + htmlOpen[0].length;
    return `${html.slice(0, at)}<head>${markup}</head>${html.slice(at)}`;
  }
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  if (doctype) {
    const at = doctype[0].length;
    return `${html.slice(0, at)}<head>${markup}</head>${html.slice(at)}`;
  }
  return `<!doctype html><head>${markup}</head>${html}`;
}
