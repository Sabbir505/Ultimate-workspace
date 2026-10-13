// Syntax highlighting for unified-diff lines (PR file patches in the Pulls
// panel — reusable for any parsed diff: see lib/diff.ts).
//
// Whole-stream tokenization: the old side (context + deleted lines) and the
// new side (context + added lines) are each tokenized as one program, so
// multi-line constructs (block comments, triple-quoted strings) keep their
// token color across rows — per-line tokenization would mis-color everything
// after a comment opener. The token tree is then split on newlines and each
// diff row renders its own serialized fragment.
//
// Colors resolve through the same --syntax-* CSS custom properties the chat
// code blocks use (see lib/syntaxTheme.ts), so tokens track light/dark and
// custom themes at paint time — no re-parse when the theme flips.
//
// The engine is refractor — the exact Prism build react-syntax-highlighter
// loads for chat/artifact code blocks — imported lazily so the Pulls panel
// never pays for it until a patch is actually expanded. Callers render plain
// text until the promise resolves (the same progressive-upgrade pattern as
// StepCodeHighlighter).

export type HighlightLinesFn = (code: string, lang: string) => string[];

interface RefractorNode {
  type: "text" | "element";
  value?: string;
  tagName?: string;
  properties?: { className?: string[] };
  children?: RefractorNode[];
}

interface RefractorApi {
  register(language: unknown): void;
  highlight(value: string, language: string): RefractorNode[];
  registered(language: string): boolean;
}

let loading: Promise<HighlightLinesFn> | null = null;

/** Returns a function that tokenizes a source string into per-line HTML
 *  fragments (already HTML-escaped). Languages outside the bundled set fall
 *  back to escaped plain text. A rejected import resets the cache so the next
 *  call retries instead of replaying the failure forever (audit A7). */
export function loadDiffHighlighter(): Promise<HighlightLinesFn> {
  if (!loading) {
    loading = (async (): Promise<HighlightLinesFn> => {
      const [{ default: core }, ...langModules] = await Promise.all([
        import("refractor/core.js"),
        import("refractor/lang/rust.js"),
        import("refractor/lang/c.js"),
        import("refractor/lang/cpp.js"),
        import("refractor/lang/csharp.js"),
        import("refractor/lang/go.js"),
        import("refractor/lang/java.js"),
        import("refractor/lang/kotlin.js"),
        import("refractor/lang/swift.js"),
        import("refractor/lang/python.js"),
        import("refractor/lang/ruby.js"),
        import("refractor/lang/php.js"),
        import("refractor/lang/typescript.js"),
        import("refractor/lang/tsx.js"),
        import("refractor/lang/jsx.js"),
        import("refractor/lang/json.js"),
        import("refractor/lang/yaml.js"),
        import("refractor/lang/toml.js"),
        import("refractor/lang/ini.js"),
        import("refractor/lang/bash.js"),
        import("refractor/lang/sql.js"),
        import("refractor/lang/markdown.js"),
        import("refractor/lang/scss.js"),
        import("refractor/lang/less.js"),
        import("refractor/lang/makefile.js"),
        import("refractor/lang/docker.js"),
      ]);
      const refractor = core as unknown as RefractorApi;
      // CJS interop hands each language module over as a namespace — the
      // registration function lives on `default`.
      for (const mod of langModules) {
        refractor.register((mod as { default?: unknown }).default ?? mod);
      }
      return (code, lang) => {
        if (!refractor.registered(lang)) {
          return code.split("\n").map((line) => escapeHtml(line));
        }
        return splitByLines(refractor.highlight(code, lang)).map((nodes) => serialize(nodes));
      };
    })().catch((err: unknown) => {
      loading = null;
      throw err;
    });
  }
  return loading;
}

/** Map a repo path to a refractor language name (null → no highlighting). */
const EXT_LANG: Record<string, string> = {
  rs: "rust",
  c: "c", h: "c",
  cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp", hxx: "cpp",
  cs: "csharp",
  go: "go",
  java: "java",
  kt: "kotlin", kts: "kotlin",
  swift: "swift",
  py: "python", pyi: "python",
  rb: "ruby",
  php: "php",
  ts: "typescript", mts: "typescript", cts: "typescript",
  tsx: "tsx", jsx: "jsx",
  js: "javascript", mjs: "javascript", cjs: "javascript",
  json: "json",
  yml: "yaml", yaml: "yaml",
  toml: "toml",
  ini: "ini", cfg: "ini", conf: "ini",
  sh: "bash", bash: "bash", zsh: "bash",
  sql: "sql",
  md: "markdown", markdown: "markdown",
  css: "css", scss: "scss", less: "less",
  html: "markup", htm: "markup", xml: "markup", svg: "markup", vue: "markup",
  makefile: "makefile", mk: "makefile",
  dockerfile: "docker",
};

export function langForPath(path: string): string | null {
  const base = path.split(/[\\/]/).pop() ?? "";
  const lower = base.toLowerCase();
  if (lower === "dockerfile" || lower.endsWith(".dockerfile") || lower.startsWith("dockerfile.")) return "docker";
  if (lower === "makefile" || lower.startsWith("makefile.")) return "makefile";
  const dot = lower.lastIndexOf(".");
  if (dot <= 0) return null;
  return EXT_LANG[lower.slice(dot + 1)] ?? null;
}

/** Token colors, most specific first: the first entry whose token name is in
 *  the node's class list wins (refractor emits layered names like
 *  ["token", "function-definition", "function"]). Values are full inline
 *  style bodies over the shared --syntax-* variables. */
const TOKEN_STYLES: [string, string][] = [
  ["comment", "color:var(--syntax-comment);font-style:italic"],
  ["prolog", "color:var(--syntax-comment);font-style:italic"],
  ["doctype", "color:var(--syntax-comment);font-style:italic"],
  ["cdata", "color:var(--syntax-comment);font-style:italic"],
  ["string", "color:var(--syntax-string)"],
  ["char", "color:var(--syntax-string)"],
  ["url", "color:var(--syntax-string)"],
  ["attr-value", "color:var(--syntax-string)"],
  ["keyword", "color:var(--syntax-keyword)"],
  ["selector", "color:var(--syntax-keyword)"],
  ["atrule", "color:var(--syntax-keyword)"],
  ["important", "color:var(--syntax-keyword);font-weight:bold"],
  ["function", "color:var(--syntax-function)"],
  ["class-name", "color:var(--syntax-type)"],
  ["builtin", "color:var(--syntax-builtin)"],
  ["number", "color:var(--syntax-number)"],
  ["boolean", "color:var(--syntax-number)"],
  ["constant", "color:var(--syntax-number)"],
  ["symbol", "color:var(--syntax-number)"],
  ["inserted", "color:var(--syntax-inserted)"],
  ["regex", "color:var(--syntax-regex)"],
  ["tag", "color:var(--syntax-tag)"],
  ["attr-name", "color:var(--syntax-attr-name)"],
  ["property", "color:var(--syntax-variable)"],
  ["variable", "color:var(--syntax-variable)"],
  ["operator", "color:var(--syntax-operator)"],
  ["entity", "color:var(--syntax-operator)"],
  ["punctuation", "color:var(--syntax-punctuation)"],
  ["deleted", "color:var(--syntax-deleted)"],
];

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function styleFor(classes: string[] | undefined): string | null {
  if (!classes) return null;
  for (const [token, style] of TOKEN_STYLES) {
    if (classes.includes(token)) return style;
  }
  return null;
}

/** Split a token tree on newlines: a text node crossing a line boundary is
 *  cut apart, and an element spanning lines is re-opened on each line it
 *  covers (so a multi-line comment's rows all carry the comment span). */
function splitByLines(nodes: RefractorNode[]): RefractorNode[][] {
  const lines: RefractorNode[][] = [[]];
  const pushText = (value: string) => {
    const parts = value.split("\n");
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) lines.push([]);
      if (parts[i]) lines[lines.length - 1].push({ type: "text", value: parts[i] });
    }
  };
  for (const node of nodes) {
    if (node.type === "text") {
      pushText(node.value ?? "");
    } else {
      const childLines = splitByLines(node.children ?? []);
      for (let i = 0; i < childLines.length; i++) {
        if (i > 0) lines.push([]);
        if (childLines[i].length > 0) {
          lines[lines.length - 1].push({
            type: "element",
            tagName: node.tagName ?? "span",
            properties: node.properties,
            children: childLines[i],
          });
        }
      }
    }
  }
  return lines;
}

function serialize(nodes: RefractorNode[]): string {
  let out = "";
  for (const node of nodes) {
    if (node.type === "text") {
      out += escapeHtml(node.value ?? "");
      continue;
    }
    const style = styleFor(node.properties?.className);
    const inner = serialize(node.children ?? []);
    out += style ? `<span style="${style}">${inner}</span>` : inner;
  }
  return out;
}
