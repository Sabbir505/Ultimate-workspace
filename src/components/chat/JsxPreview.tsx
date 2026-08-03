// Live preview for model-generated React/JSX artifacts (Claude-style).
//
// A ```jsx / ```tsx code fence in an assistant message is transpiled in the
// main window with @babel/standalone (lazy-loaded on first use) and rendered
// inside a sandboxed iframe. The iframe carries its own inlined React +
// ReactDOM UMD bundles (imported as raw strings at build time), so previews
// work fully offline and cannot reach the parent window, cookies, or Tauri
// APIs (`sandbox="allow-scripts"` only — no `allow-same-origin`).
//
// The user code is expected to `export default` a component (Claude's
// convention); a handful of common global names (App, Example, …) are also
// tried as a fallback. A "Preview / Code" toggle lets the user inspect source.
import { useEffect, useMemo, useRef, useState } from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { useSyntaxTheme } from "../../hooks/useSyntaxTheme";
// UMD builds inlined into the sandbox so it needs no network / same-origin.
// Imported by relative node_modules path because the `react` / `react-dom`
// package `exports` maps don't expose their `umd/` files as bare specifiers.
import reactUMD from "../../../node_modules/react/umd/react.production.min.js?raw";
import reactDomUMD from "../../../node_modules/react-dom/umd/react-dom.production.min.js?raw";

type BabelStandalone = typeof import("@babel/standalone");

let babelPromise: Promise<BabelStandalone> | null = null;
function loadBabel(): Promise<BabelStandalone> {
  if (!babelPromise) babelPromise = import("@babel/standalone");
  return babelPromise;
}

/** Transpile JSX/TSX to sandbox-runnable CommonJS. Throws on syntax errors.
 *
 *  SECURITY: we cap the source size at compile time so a misbehaving model
 *  can't ship a pathologically large JSX/TSX payload that bogs down Babel's
 *  parser. 1 MB is well above any realistic React component (the whole
 *  react-dom bundle is ~140 KB minified — anything larger than 1 MB is
 *  almost certainly adversarial or broken). */
const MAX_JSX_SOURCE_BYTES = 1_000_000;

async function transpile(code: string, isTsx: boolean): Promise<string> {
  const Babel = await loadBabel();
  const source =
    code.length > MAX_JSX_SOURCE_BYTES
      ? code.slice(0, MAX_JSX_SOURCE_BYTES) + "\n/* [source truncated for safety] */"
      : code;
  const result = Babel.transform(source, {
    filename: isTsx ? "artifact.tsx" : "artifact.jsx",
    presets: [
      "react",
      ...(isTsx
        ? ([["typescript", { allExtensions: true, isTSX: true }]] as const)
        : []),
    ],
    plugins: ["transform-modules-commonjs"],
    sourceType: "module",
  });
  return result.code ?? "";
}

/** Assemble the sandbox document: inlined React runtimes + a CommonJS `require`
 *  shim + the transpiled user module + a bootstrap that mounts the component. */
function buildSrcDoc(compiled: string): string {
  // The transpiled module references require("react") etc.; map those to the
  // inlined UMD globals. Escape </script> so the code can't break out.
  const safe = compiled.replace(/<\/script>/gi, "<\\/script>");
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<style>
  html, body { margin: 0; }
  body {
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    padding: 14px;
    color: #1c2530;
    background: #ffffff;
  }
  #root:empty::before { content: "Nothing rendered."; color: #94a3b8; }
  .jsx-preview-err {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
    color: #b42318;
    white-space: pre-wrap;
  }
</style>
</head>
<body>
<div id="root"></div>
<script>${reactUMD}</script>
<script>${reactDomUMD}</script>
<script>
(function () {
  var root = document.getElementById("root");
  function fail(msg) {
    root.innerHTML = "";
    var pre = document.createElement("pre");
    pre.className = "jsx-preview-err";
    pre.textContent = "Preview error: " + msg;
    root.appendChild(pre);
  }
  function require(name) {
    if (name === "react") return window.React;
    if (name === "react-dom" || name === "react-dom/client") return window.ReactDOM;
    throw new Error("module \\"" + name + "\\" is not available in the preview sandbox");
  }
  try {
    var module = { exports: {} };
    var exports = module.exports;
    ${safe}
    var Comp = module.exports && (module.exports.default || (Object.keys(module.exports).length ? module.exports : null));
    if (typeof Comp !== "function") {
      var names = [
        typeof App !== "undefined" ? App : null,
        typeof Example !== "undefined" ? Example : null,
        typeof Demo !== "undefined" ? Demo : null,
        typeof Main !== "undefined" ? Main : null,
        typeof Component !== "undefined" ? Component : null
      ];
      for (var i = 0; i < names.length; i++) {
        if (typeof names[i] === "function") { Comp = names[i]; break; }
      }
    }
    if (typeof Comp !== "function") {
      fail("no component found. Export a component with 'export default'.");
      return;
    }
    var el = window.React.createElement(Comp);
    if (window.ReactDOM.createRoot) {
      window.ReactDOM.createRoot(root).render(el);
    } else {
      window.ReactDOM.render(el, root);
    }
  } catch (e) {
    fail((e && e.message) ? e.message : String(e));
  }
})();
</script>
</body>
</html>`;
}

export function JsxPreview({
  code,
  lang,
  variant = "inline",
}: {
  code: string;
  lang: string;
  /** "pane" makes the block fill its container (used in the preview pane);
   *  "inline" keeps a natural, content-sized height. */
  variant?: "inline" | "pane";
}) {
  const isTsx = lang === "tsx";
  const [tab, setTab] = useState<"preview" | "code">("preview");
  const [srcDoc, setSrcDoc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    let cancelled = false;
    const trimmed = code.trim();
    if (!trimmed) {
      setSrcDoc(null);
      setError(null);
      return;
    }
    // Debounce so partially-streamed code doesn't churn / flash errors.
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const compiled = await transpile(trimmed, isTsx);
          if (cancelled) return;
          setSrcDoc(buildSrcDoc(compiled));
          setError(null);
        } catch (e) {
          if (cancelled) return;
          setSrcDoc(null);
          setError(e instanceof Error ? e.message : String(e));
        }
      })();
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [code, isTsx]);

  const showCode = tab === "code" || (!srcDoc && !!error);

  // useSyntaxTheme returns a new style object whenever data-theme changes,
  // so the highlighted block re-derives and re-renders with the new tokens.
  const syntaxTheme = useSyntaxTheme();
  const highlighted = useMemo(
    () => (
      <SyntaxHighlighter
        style={syntaxTheme}
        language={isTsx ? "tsx" : "jsx"}
        PreTag="div"
        customStyle={{
          margin: 0,
          background: "transparent",
          padding: "12px 16px",
          fontSize: "12px",
          fontFamily: "var(--font-mono)",
          lineHeight: 1.5,
          overflowX: "auto",
        }}
        codeTagProps={{ style: { fontFamily: "var(--font-mono)" } }}
      >
        {code}
      </SyntaxHighlighter>
    ),
    [code, isTsx, syntaxTheme],
  );

  return (
    <div className={`chat-jsx-block${variant === "pane" ? " pane" : ""}`}>
      <div className="chat-jsx-header">
        <span className="chat-jsx-lang">{isTsx ? "tsx" : "jsx"}</span>
        <div className="chat-jsx-tabs">
          <button
            type="button"
            className={`chat-jsx-tab${tab === "preview" ? " active" : ""}`}
            onClick={() => setTab("preview")}
          >
            Preview
          </button>
          <button
            type="button"
            className={`chat-jsx-tab${tab === "code" ? " active" : ""}`}
            onClick={() => setTab("code")}
          >
            Code
          </button>
        </div>
      </div>
      <div className="chat-jsx-body">
        {showCode ? (
          <div className="chat-jsx-code">
            {error && (
              <div className="chat-jsx-error">Could not render preview: {error}</div>
            )}
            {highlighted}
          </div>
        ) : srcDoc ? (
          <iframe
            ref={iframeRef}
            className="chat-jsx-frame"
            title="JSX preview"
            sandbox="allow-scripts"
            srcDoc={srcDoc}
          />
        ) : (
          <div className="chat-jsx-loading">Rendering preview…</div>
        )}
      </div>
    </div>
  );
}
