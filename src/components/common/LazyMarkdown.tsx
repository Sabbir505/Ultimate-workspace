// Deferred markdown rendering.
//
// The react-markdown pipeline (micromark → mdast → hast) plus the remark/rehype
// plugin families weigh ~700 KB raw. Every chat transcript is on the landing
// view, so importing those statically parked all of it in the ENTRY chunk: the
// shell could not paint until the parser had downloaded, parsed and evaluated,
// even for a user who never opens a message. They are loaded here instead, on
// first use, and cached by the browser for the rest of the session.
//
// The <Suspense> boundary here wraps ONLY the parser. Callers keep their own
// wrapper element outside it, so layout (and CSS selectors that key on
// `.chat-markdown:last-child`, e.g. the streaming caret) still settle on the
// first synchronous render — only the parsed nodes arrive a tick later.
import { Suspense, lazy } from "react";
import type { Options } from "react-markdown";

/** Protocol allowlist from react-markdown's own default url sanitizer. */
const SAFE_PROTOCOL = /^(https?|ircs?|mailto|xmpp)$/i;

/** Byte-for-byte port of react-markdown's `defaultUrlTransform`, which is in
 *  turn micromark's `sanitizeUri` minus the percent-encoding step (react-
 *  markdown deliberately skips `encode`). Vendored rather than imported so the
 *  `react-markdown` module reference disappears from every call site's import
 *  graph; keep in sync when bumping the dependency. */
export function defaultUrlTransform(value: string): string {
  const colon = value.indexOf(":");
  const questionMark = value.indexOf("?");
  const numberSign = value.indexOf("#");
  const slash = value.indexOf("/");

  if (
    // No protocol at all → relative link, safe.
    colon === -1 ||
    // The first colon comes after a `?`, `#` or `/` → not a protocol.
    (slash !== -1 && colon > slash) ||
    (questionMark !== -1 && colon > questionMark) ||
    (numberSign !== -1 && colon > numberSign) ||
    // It is a protocol, and it is on the allowlist.
    SAFE_PROTOCOL.test(value.slice(0, colon))
  ) {
    return value;
  }
  return "";
}

const ReactMarkdown = lazy(() => import("react-markdown"));

/** react-markdown behind a Suspense boundary, for callers that configure their
 *  own plugin list. */
export function LazyReactMarkdown(props: Options) {
  return (
    <Suspense fallback={null}>
      <ReactMarkdown {...props} />
    </Suspense>
  );
}

/** The chat transcript's configuration, preloaded as one unit.
 *
 *  The plugins are imported alongside react-markdown rather than passed in, so
 *  that remark-gfm / remark-breaks / remark-math / rehype-katex land in the same
 *  deferred chunk instead of being hoisted back into the entry by a static
 *  import at the call site. */
const ChatMarkdownInner = lazy(async () => {
  const [{ default: ReactMarkdown }, { default: remarkGfm }, { default: remarkBreaks }, { default: remarkMath }, { default: rehypeKatex }] =
    await Promise.all([
      import("react-markdown"),
      import("remark-gfm"),
      import("remark-breaks"),
      import("remark-math"),
      import("rehype-katex"),
    ]);
  // remarkBreaks: chat convention (ChatGPT/Discord/Slack) — a model answer
  // written with single newlines renders those breaks instead of collapsing
  // into one run-on paragraph. The .md FILE preview (ArtifactPreviewPane)
  // deliberately stays standard-markdown.
  //
  // singleDollarTextMath: false — a lone `$` pair must NOT open math, or
  // "$5 and $10" renders as KaTeX and collapses the spaces ("5and10").
  // `$$…$$` display math still works.
  const remarkPlugins: Options["remarkPlugins"] = [remarkGfm, remarkBreaks, [remarkMath, { singleDollarTextMath: false }]];
  const rehypePlugins: Options["rehypePlugins"] = [rehypeKatex];
  function Md(props: Options) {
    return (
      <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} {...props} />
    );
  }
  return { default: Md };
});

/** Chat-tuned markdown. `components` / `urlTransform` / `children` come from
 *  the caller; the plugin list is fixed here so it can ride the lazy chunk. */
export function ChatMarkdown(props: Options) {
  return (
    <Suspense fallback={null}>
      <ChatMarkdownInner {...props} />
    </Suspense>
  );
}

/** Same treatment for GFM-only sites (tables, strikethrough, task lists) that
 *  render in the always-mounted chat surface — plan-proposal cards. The rule
 *  is the same: any plugin a call site imports statically is a plugin Rollup
 *  hoists back into the entry chunk, so the import has to happen in here. */
const GfmMarkdownInner = lazy(async () => {
  const [{ default: ReactMarkdown }, { default: remarkGfm }] = await Promise.all([
    import("react-markdown"),
    import("remark-gfm"),
  ]);
  const remarkPlugins: Options["remarkPlugins"] = [remarkGfm];
  function Md(props: Options) {
    return <ReactMarkdown remarkPlugins={remarkPlugins} {...props} />;
  }
  return { default: Md };
});

export function GfmMarkdown(props: Options) {
  return (
    <Suspense fallback={null}>
      <GfmMarkdownInner {...props} />
    </Suspense>
  );
}
