//! ActivitySteps — Markdown rendering context + activity-step rows for
//! MessageBubble. The Markdown system (lazy highlighter plumbing, icons,
//! citation transforms, <Markdown>) lives here together with the
//! process-step components that consume it; MessageBubble imports the
//! pieces it renders.
import { Fragment, createContext, lazy, memo, Suspense, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Pencil } from "lucide-react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
// PERF rec #3 (2026-09-06): this chunk imports katex.min.css — math can
// only render inside MessageBubble, so the stylesheet (and the fonts it
// references) arrives with this lazy chunk instead of eagerly at boot.
// Vite dedupes the module across chunks (single emitted copy — C8 holds).
import type { ChatMessage, ChatMessageRecord, ChatPerfPayload } from "../../lib/ipc";
import { listCompactedMessages, readArtifactPreview } from "../../lib/ipc";
import type { ChatArtifact } from "../../state/chat";
import { liveAttachmentsForMessage, useChatStore } from "../../state/chat";
import { useUiStore } from "../../state/ui";
import { useProjectsStore } from "../../state/projects";
import { parseUnifiedDiff } from "../../lib/diff";
import { formatDuration } from "../../lib/format";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useTtsStore } from "../../state/tts";
import { toggleReadAloud } from "../../lib/tts";
// Transport glyphs live in lib/icons so the player bar can use them without
// importing this module (and its markdown stack) into the entry chunk.
import { PlayIcon } from "../../lib/icons";
export { SpeakerIcon, StopIcon, PlayIcon } from "../../lib/icons";
import { MdLink } from "./MdLink";
import { DiffCard, editLineStats, type EditPayload } from "./DiffCard";
import { parseSegments, type Segment, type ToolData } from "../../lib/segments";
import { sameTurnFile, TurnChangesRow } from "./TurnChangesRow";
// InlineDiagram (vector diagrams) and MermaidDiagram (mermaid + its
// highlight.js language pack) are rarely seen on the initial chat surface and
// pull in heavy dependencies; lazy-load both so the main bundle stays small.
// The mermaid bundle in particular drags ~1.4 MB of diagram + language-
// definition code that the empty welcome screen never touches. DiffCard stays
// eager: it's a tiny component (no heavy deps) and the per-edit review card
// must render synchronously with the rest of the message.
const InlineDiagram = lazy(() => import("./InlineDiagram").then((m) => ({ default: m.InlineDiagram })));
const MermaidDiagram = lazy(() => import("./MermaidDiagram").then((m) => ({ default: m.MermaidDiagram })));
import { MessageAttachments, parseAttachments } from "./MessageAttachments";
import { useSyntaxTheme } from "../../hooks/useSyntaxTheme";
import type { SyntaxHighlighterProps, SyntaxStyle } from "../../lib/syntaxHighlighter";
import { loadSyntaxHighlighter } from "../../lib/syntaxHighlighter";
import { SmoothReveal } from "../common/SmoothReveal";
import { linkCitations, parseChatSources, sourcesFingerprint, type ChatSource } from "../../lib/chatCitations";
import { ChatCitation, CitationFlagContext, type CitationFlag } from "./ChatCitation";
import { MarkdownTable } from "./MarkdownTable";


export type SyntaxHighlighterComponent = (props: SyntaxHighlighterProps) => React.ReactNode;

/** Hook that loads a lazy component once (on mount) and resolves it via the
 *  provided async loader. The component stays null until the dynamic import
 *  finishes, then re-renders with the loaded module. Safe across StrictMode
 *  double-invoke (the loader memoizes internally). */
export function useLazyComponent<T>(
  loader: () => Promise<T>,
  onReady: (value: T) => void,
) {
  useEffect(() => {
    let mounted = true;
    void loader().then((mod) => {
      if (mounted) onReady(mod);
    });
    return () => {
      mounted = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}


export const iconProps = {
  width: 15,
  height: 15,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export function CopyIcon() {
  return (
    <svg {...iconProps} aria-hidden="true">
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

export function CheckIcon() {
  return (
    <svg {...iconProps} aria-hidden="true">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

export function EditIcon() {
  return (
    <svg {...iconProps} aria-hidden="true">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

export function RepeatIcon() {
  return (
    <svg {...iconProps} aria-hidden="true">
      <path d="M3 2v6h6" />
      <path d="M3 13a9 9 0 1 0 3-7.7L3 8" />
    </svg>
  );
}

export function TrashIcon() {
  return (
    <svg {...iconProps} aria-hidden="true">
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </svg>
  );
}

export function FileIcon() {
  return (
    <svg
      width={13}
      height={13}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}

/** Download/preview chip for a generated file. */
export function ArtifactChip({
  artifact,
  onPreviewArtifact,
}: {
  artifact: ChatArtifact;
  onPreviewArtifact?: (artifact: ChatArtifact) => void;
}) {
  return (
    <button
      type="button"
      className="chat-artifact-chip"
      title={`Preview ${artifact.filename}`}
      onClick={(e) => {
        e.currentTarget.blur();
        onPreviewArtifact?.(artifact);
      }}
    >
      <FileIcon />
      <span>{artifact.filename}</span>
    </button>
  );
}

/** The files an assistant message produced. .html/.svg artifacts are probed via
 *  InlineDiagram, which renders ONLY true diagrams (kind "diagram", authored by
 *  generate_diagram) inline; a plain .html webpage or .svg image falls back to
 *  a download chip so it opens in the preview pane instead. Every other file is
 *  always a download chip. */
export function MessageArtifacts({
  artifacts,
  onPreviewArtifact,
}: {
  artifacts: ChatArtifact[];
  onPreviewArtifact?: (artifact: ChatArtifact) => void;
}) {
  const isVisual = (name: string) => {
    const ext = name.split(".").pop()?.toLowerCase();
    return ext === "html" || ext === "svg";
  };
  const chips = artifacts.filter((a) => !isVisual(a.filename));
  const visuals = artifacts.filter((a) => isVisual(a.filename));
  return (
    <>
      {visuals.map((a) => (
        <Suspense key={a.path} fallback={
          <div className="chat-msg-artifacts">
            <ArtifactChip artifact={a} onPreviewArtifact={onPreviewArtifact} />
          </div>
        }>
          <InlineDiagram
            artifact={a}
            onFallback={() => (
              <div className="chat-msg-artifacts">
                <ArtifactChip artifact={a} onPreviewArtifact={onPreviewArtifact} />
              </div>
            )}
          />
        </Suspense>
      ))}
      {chips.length > 0 && (
        <div className="chat-msg-artifacts" aria-label="Generated files">
          {chips.map((a) => (
            <ArtifactChip key={a.path} artifact={a} onPreviewArtifact={onPreviewArtifact} />
          ))}
        </div>
      )}
    </>
  );
}

/** Per-message action bar (Claude-style icons): copy for every message, edit
 *  for user messages, regenerate for assistant messages, delete for any
 *  persisted message. Appears on hover under the bubble. The message's
 *  end-of-turn timestamp rides INSIDE the bar (leading slot) so it uses the
 *  same hover reveal as the buttons. */
export function MessageActions({
  content,
  onEdit,
  onRepeat,
  onDelete,
  timestamp,
  timestampTitle,
  speakKey,
  speakLabel,
}: {
  content: string;
  onEdit?: (content: string) => void;
  onRepeat?: () => void;
  onDelete?: () => void;
  /** Preformatted end-of-turn time ("14:32") — rendered beside the buttons. */
  timestamp?: string | null;
  timestampTitle?: string;
  /** Identity of the text for read-aloud (`msg:<id>`). Omitted where speaking
   *  makes no sense (the optimistic in-flight bubble), which hides the button. */
  speakKey?: string;
  /** Label shown in the player bar while this text is being read. */
  speakLabel?: string;
}) {
  const [copied, copyToClipboard] = useCopyToClipboard(1800);
  const copy = useCallback(
    async (e: React.MouseEvent<HTMLButtonElement>) => {
      // Drop focus so the hover-only action bar doesn't stay pinned open
      // after a mouse click.
      e.currentTarget.blur();
      await copyToClipboard(content);
    },
    [content, copyToClipboard],
  );

  // Is THIS message the one being read aloud? A selector returning a boolean
  // keeps the other bubbles from re-rendering on every sentence tick.
  const speaking = useTtsStore((s) => !!speakKey && s.key === speakKey && s.phase !== "idle");

  return (
    <div className="chat-msg-actions">
      {timestamp && (
        <span className="chat-msg-time" title={timestampTitle}>
          {timestamp}
        </span>
      )}
      <button
        className="chat-msg-action"
        onClick={copy}
        title={copied ? "Copied" : "Copy message"}
        aria-label="Copy message"
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </button>
      {speakKey && content.trim() && (
        <button
          className={`chat-msg-action${speaking ? " chat-msg-action-active" : ""}`}
          onClick={(e) => {
            e.currentTarget.blur();
            toggleReadAloud({ key: speakKey, label: speakLabel, text: content });
          }}
          // A play triangle, not a speaker: the speaker read as "audio settings"
          // rather than "start reading". No stop square and no sentence counter
          // here either — the player bar at the bottom right owns the transport
          // (pause, stop, progress), and duplicating it in a hover bar was
          // noise. The active tint is the one thing this button still carries,
          // because the bar cannot say WHICH message is being read.
          title={speaking ? "Stop reading" : "Read aloud"}
          aria-label={speaking ? "Stop reading aloud" : "Read aloud"}
        >
          <PlayIcon />
        </button>
      )}
      {onRepeat && (
        <button
          className="chat-msg-action"
          onClick={(e) => {
            e.currentTarget.blur();
            onRepeat();
          }}
          title="Regenerate response"
          aria-label="Regenerate response"
        >
          <RepeatIcon />
        </button>
      )}
      {onEdit && (
        <button
          className="chat-msg-action"
          onClick={(e) => {
            e.currentTarget.blur();
            onEdit(content);
          }}
          title="Edit message"
          aria-label="Edit message"
        >
          <EditIcon />
        </button>
      )}
      {onDelete && (
        <button
          className="chat-msg-action chat-msg-action-danger"
          onClick={(e) => {
            // Drop focus so the hover-only action bar doesn't stay pinned
            // open after the click.
            e.currentTarget.blur();
            onDelete();
          }}
          title="Delete message"
          aria-label="Delete message"
        >
          <TrashIcon />
        </button>
      )}
    </div>
  );
}

/** Codex-style pre-token indicator: a single quiet monospace pulse — no
 *  bouncing dots, just a subtle "working…" line that recedes visually. */
// TypingIndicator moved to ./TypingIndicator (PERF item 12) — re-exported
// here so existing imports keep working without dragging react-markdown into
// the entry chunk via ChatView.
export { TypingIndicator } from "./TypingIndicator";

/** Low-weight, tappable marker shown in the timeline where older context was
 *  condensed by the compaction framework (local or cloud). Expands to reveal
 *  the actual summary that replaced the original turns, plus — context
 *  recovery — the raw folded turns themselves, fetched on demand from the DB
 *  (the summary is lossy by design; the rows are the restorable source).
 *  Reuses the muted aesthetic of `.chat-status-notice` / `.chat-activity-done`. */
export function CompactedContextMarker({
  summary,
  messageId,
  chatSessionId,
}: {
  summary: string;
  messageId?: number;
  chatSessionId?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [turnsOpen, setTurnsOpen] = useState(false);
  const [turns, setTurns] = useState<ChatMessageRecord[] | null>(null);
  const [turnsError, setTurnsError] = useState(false);

  const canRecover = messageId != null && messageId > 0 && !!chatSessionId;
  const toggleTurns = () => {
    const next = !turnsOpen;
    setTurnsOpen(next);
    if (next && turns === null && canRecover) {
      listCompactedMessages(chatSessionId!, messageId!)
        .then((rows) => setTurns(rows ?? []))
        .catch(() => setTurnsError(true));
    }
  };

  return (
    <div className="chat-compacted-marker">
      <button
        type="button"
        className="chat-compacted-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="chat-compacted-dash" aria-hidden="true">—</span>
        earlier context compacted
        <span className={`chat-thinking-chevron${open ? " open" : ""}`}>›</span>
      </button>
      {summary && (
        <SmoothReveal open={open}>
          <div className="chat-compacted-summary">{summary}</div>
        </SmoothReveal>
      )}
      {canRecover && (
        <>
          <button
            type="button"
            className="chat-compacted-recover-toggle"
            aria-expanded={turnsOpen}
            onClick={toggleTurns}
          >
            show folded turns
            <span className={`chat-thinking-chevron${turnsOpen ? " open" : ""}`}>›</span>
          </button>
          <SmoothReveal open={turnsOpen}>
            <div className="chat-compacted-turns">
              {turnsError ? (
                <div className="chat-compacted-turn-note">Couldn't load the folded turns.</div>
              ) : turns === null ? (
                <div className="chat-compacted-turn-note">Loading…</div>
              ) : turns.length === 0 ? (
                <div className="chat-compacted-turn-note">No folded turns recorded for this summary.</div>
              ) : (
                turns.map((t) => (
                  <div className="chat-compacted-turn" key={t.id}>
                    <span className={`chat-compacted-turn-role is-${t.role}`}>
                      {t.role === "user" ? "You" : t.role === "assistant" ? "Relay" : "System"}
                    </span>
                    <span className="chat-compacted-turn-text">
                      {t.content.length > 2000
                        ? `${t.content.slice(0, 2000)}…[truncated]`
                        : t.content}
                    </span>
                  </div>
                ))
              )}
            </div>
          </SmoothReveal>
        </>
      )}
    </div>
  );
}

/** Reasoning disclosure — shared with the subagent pane (Agents panel), which
 *  streams the subagent's <think> blocks with the same visual language. */
export function ThinkingBlock({ thinking, done }: { thinking: string; done: boolean }) {
  // Expanded while streaming (live), collapsed once the turn finishes.
  const [open, setOpen] = useState(!done);
  // Auto-collapse when the turn completes — but only if the user hasn't
  // manually toggled it.
  const [userToggled, setUserToggled] = useState(false);
  useEffect(() => {
    if (done && !userToggled) setOpen(false);
  }, [done, userToggled]);

  const toggle = () => {
    setUserToggled(true);
    setOpen((o) => !o);
  };

  return (
    <div className={`chat-thinking${done ? "" : " live"}`}>
      <button
        className="chat-thinking-toggle"
        onClick={toggle}
        title={open ? "Hide thinking" : "Show thinking"}
      >
        <span className={`chat-thinking-icon${open ? " open" : ""}`}>›</span>
        {done ? "Thinking" : "Thinking…"}
      </button>
      <SmoothReveal open={open}>
        <div className="chat-thinking-body">
          {thinking}
        </div>
      </SmoothReveal>
    </div>
  );
}

export function SearchIcon() {
  return (
    <svg {...iconProps} aria-hidden="true">
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

/** Memory tool steps (save/recall/forget): a sparkles glyph — the "stored
 *  knowledge" mark. Same stroke style as the other inline icons. */
export function MemoryIcon() {
  return (
    <svg {...iconProps} aria-hidden="true">
      <path d="M12 3l1.9 5.8a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3L12 3z" />
    </svg>
  );
}

export function GlobeIcon() {
  return (
    <svg {...iconProps} aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <path d="M2 12h20" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  );
}

export function TerminalIcon() {
  return (
    <svg {...iconProps} aria-hidden="true">
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  );
}

export function WrenchIcon() {
  return (
    <svg {...iconProps} aria-hidden="true">
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
    </svg>
  );
}

/** Per-tool-kind icon for an activity step (Cursor-style: recognizable glyph
 *  per action instead of one uniform dot). */
export function ToolIcon({ kind }: { kind?: string }) {
  switch (kind) {
    case "search":
      return <SearchIcon />;
    case "web":
    case "browser":
      return <GlobeIcon />;
    case "file":
      return <FileIcon />;
    case "code":
      return <TerminalIcon />;
    case "memory":
      return <MemoryIcon />;
    default:
      return <WrenchIcon />;
  }
}

/** Step status: spinner while the call runs, green check once it completes —
 *  the at-a-glance progress signal Cursor gives every tool row. */
export function StepStatusIcon({ done }: { done: boolean }) {
  if (!done) return <span className="chat-activity-spinner" aria-label="running" />;
  return (
    <span className="chat-step-done-icon" aria-label="done">
      <CheckIcon />
    </span>
  );
}

/** A short, *specific* label for one tool step — rendered in monospace like a
 *  terminal log entry. The backend emits a generic `title` ("Reading a web page",
 *  "Searching the web") but also a `detail` carrying the actual target (url /
 *  query / filename). We prefer the detail so each step reads as what it
 *  actually touched, falling back to the title only when no detail is available.
 *  Format: `command  target` (two-space separation, log-style). */
export function stepLabel(data: ToolData | null): string {
  if (!data) return "working…";
  const title = data.title?.trim() || "working…";
  const detail = data.detail?.trim();
  // Shell commands read terminal-style, like Cursor's command rows.
  if (data.kind === "code" && data.code) {
    const cmd = data.code.trim();
    return `$ ${cmd.length > 90 ? `${cmd.slice(0, 90)}…` : cmd}`;
  }
  if (!detail) return title;
  // For code-producing tools the "detail" is sometimes the full code body —
  // too long for a row label; in that case keep the title.
  if (data.code && detail.length > 80) return title;
  // Log-style: "write_file  src/main.rs" rather than "Writing file — src/main.rs"
  const cmd = title.toLowerCase().replace(/\s+/g, "_").replace(/ing$/, "");
  return `${cmd}  ${detail}`;
}


/** Detect whether a string looks like a unified diff. */
export function looksLikeDiff(text: string): boolean {
  return text.startsWith("diff --git") || text.startsWith("--- ") || text.includes("\n@@ ");
}

/** Render a unified diff inline inside a tool step body. Reuses the existing
 *  diff parser and CSS classes for a terminal-native look. */
export function InlineDiff({ diffText }: { diffText: string }) {
  const files = useMemo(() => parseUnifiedDiff(diffText), [diffText]);
  if (files.length === 0) return <div className="chat-step-detail">{diffText}</div>;
  return (
    <div className="chat-diff-inline">
      {files.map((file, i) => (
        <div className="diff-file" key={`${file.newPath || file.oldPath || i}-${i}`}>
          <div className="diff-file-header">
            {file.oldPath === file.newPath || file.newPath === ""
              ? file.oldPath || file.newPath || `file ${i + 1}`
              : `${file.oldPath} → ${file.newPath}`}
          </div>
          {file.lines
            .filter((l) => l.type !== "meta")
            .map((line, j) => (
              <div key={j} className={`diff-line ${line.type}`}>
                {line.type === "add" ? "+ " : line.type === "del" ? "- " : line.type === "hunk" ? "" : "  "}
                {line.text}
              </div>
            ))}
        </div>
      ))}
    </div>
  );
}

/** A single tool-call row inside an expanded ProcessSummary. Renders the
 *  step's type icon + a specific label (the actual URL/query/filename, not a
 *  repeated generic title). Any narration text the model produced around
 *  this step is folded into the row above/below the label. The whole row is
 *  itself expandable (a second, nested disclosure) to reveal full detail:
 *  exact tool kind, detail string, and the code block for code-producing
 *  tools. File edits that contain a unified diff render as an inline diff. */
/** Syntax highlighter component for tool-step and markdown code blocks.
 *  Uses the current theme's CSS custom properties (--syntax-*) for token
 *  colors, switching instantly when data-theme changes.
 *
 *  BUNDLE: the Prism highlighter + language pack is ~700 KB and only needed
 *  once a code block renders — so we load it via dynamic import() on first
 *  use. Before then we render the raw code in a <pre> (styled the same) so
 *  the user sees content immediately; it upgrades to highlighted once the
 *  chunk lands. */
export function StepCodeHighlighter({ code, language }: { code: string; language: string }) {
  const theme = useSyntaxTheme();
  // `comp` resolves to the lazy-loaded Prism component after first use.
  const [comp, setComp] = useState<SyntaxHighlighterComponent | null>(null);
  // The loaded value IS a function component — pass it via an updater fn,
  // otherwise React treats it as a setState updater and calls it with the
  // previous state (null) as props, crashing inside the highlighter.
  useLazyComponent(loadSyntaxHighlighter, (c) => setComp(() => c));
  if (!comp) {
    // Fallback <pre> before the chunk loads — styled to match the highlighter's
    // output so there's no layout shift when it upgrades.
    return (
      <pre
        className="code-block-pre-fallback"
        style={{
          margin: 0,
          background: "transparent",
          padding: "12px 16px",
          fontSize: "calc(12px * var(--chat-zoom, 1))",
          fontFamily: "var(--font-mono)",
          lineHeight: 1.5,
          overflowX: "auto",
        }}
      >
        <code>{code}</code>
      </pre>
    );
  }
  const SyntaxHighlighter = comp;
  // Cache the HIGHLIGHTED element tree (keyed by theme+language+code): the
  // Prism tokenization pass is the single most expensive thing a code block
  // does, and virtualized remounts used to pay it again on every scroll-back.
  // The element tree is immutable; reconciliation still diffs it against the
  // DOM, only the tokenization is skipped. Keyed on the data-theme attribute
  // (useSyntaxTheme returns a fresh object each recompute — stringifying it
  // would never invalidate).
  const themeKey = typeof document !== "undefined" ? document.documentElement.dataset.theme ?? "dark" : "dark";
  return cachedMarkdown(`hl:${themeKey}:${language}:${code}`, () => (
    <SyntaxHighlighter
      style={theme}
      language={language}
      PreTag="div"
      customStyle={{
        margin: 0,
        background: "transparent",
        padding: "12px 16px",
        fontSize: "calc(12px * var(--chat-zoom, 1))",
        fontFamily: "var(--font-mono)",
        lineHeight: 1.5,
        overflowX: "auto",
      }}
      codeTagProps={{ style: { fontFamily: "var(--font-mono)" } }}
    >
      {code}
    </SyntaxHighlighter>
  ));
}

export function ActivityStepRow({
  step,
  done,
}: {
  step: ActivityStep;
  done: boolean;
}) {
  const [open, setOpen] = useState(false);
  const hasBody = Boolean(
    step.data?.code || step.data?.detail || step.data?.result,
  );
  // Subagent Task steps render as the agent chip — same visual language as
  // the git sidebar's AGENTS rows: icon + SubAgent + blue role + task, a
  // shimmer sweep while the agent runs, click opens the Agents pane.
  // The chip's `<tool>` marker closes the instant the spawn is parsed, so
  // `done` alone shows ✓ while the agent is still working. Track the agent's
  // REAL status from the store instead (hook is unconditional — rules of
  // hooks); null when this step isn't a subagent or never registered
  // (persisted messages from before this session's spawns).
  const isSubagentStep = step.data?.kind === "subagent";
  const subTask = isSubagentStep ? step.data?.task || step.data?.detail || "" : "";
  const subRole = isSubagentStep ? step.data?.role || "agent" : "";
  const liveStatus = useChatStore((s) => {
    if (!isSubagentStep) return null;
    const list = s.activeChatSessionId
      ? s.subagents[s.activeChatSessionId]
      : undefined;
    if (!list) return null;
    const match =
      Object.values(list).find((x) => x.task === subTask && x.role === subRole) ??
      Object.values(list).find((x) => x.task === subTask);
    return match ? match.status : null;
  });
  if (isSubagentStep) {
    const role = subRole;
    const task = subTask;
    const settled = liveStatus ? liveStatus !== "running" : done;
    const openAgent = () => {
      const s = useChatStore.getState();
      const list = s.activeChatSessionId
        ? Object.values(s.subagents[s.activeChatSessionId] ?? {})
        : [];
      const match =
        list.find((x) => x.status === "running" && x.task === task) ??
        list.find((x) => x.task === task) ??
        list.find((x) => x.role === role && x.status === "running");
      if (match) {
        // Opens exactly THIS agent; reuses the Agents pane (no tab spam).
        useUiStore.getState().openAgentsTab(match.id);
      }
    };
    return (
      <div className={`chat-agent-chip${settled ? "" : " running"}`}>
        <button
          type="button"
          className="chat-agent-chip-btn"
          onClick={openAgent}
          title={`${task} — click to watch this agent`}
        >
          <svg className="chat-agent-chip-icon" width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
            <rect x="4" y="8" width="16" height="12" rx="2" />
            <circle cx="9" cy="14" r="1.2" fill="currentColor" stroke="none" />
            <circle cx="15" cy="14" r="1.2" fill="currentColor" stroke="none" />
            <path d="M12 8V4M8 4h8" />
          </svg>
          <span className="chat-agent-chip-label">SubAgent</span>
          <span className="chat-agent-chip-role">{role}</span>
          <span className="chat-agent-chip-sep" aria-hidden="true">·</span>
          <span className="chat-agent-chip-task">{task}</span>
          {liveStatus === "error" ? (
            <span
              className="chat-agent-chip-check"
              aria-hidden="true"
              style={{ color: "#f85149" }}
            >
              ✕
            </span>
          ) : settled ? (
            <span className="chat-agent-chip-check" aria-hidden="true">✓</span>
          ) : null}
        </button>
      </div>
    );
  }
  return (
    <div className={`chat-step${done ? "" : " live"}`}>
      <button
        className="chat-step-toggle"
        onClick={() => hasBody && setOpen((o) => !o)}
        title={hasBody ? (open ? "Hide details" : "Show details") : undefined}
        disabled={!hasBody}
      >
        <span className="chat-step-status">
          <StepStatusIcon done={done} />
        </span>
        <span className="chat-step-icon">
          <ToolIcon kind={step.data?.kind} />
        </span>
        <span className="chat-step-label">{stepLabel(step.data)}</span>
        {hasBody && (
          <span className={`chat-thinking-chevron${open ? " open" : ""}`}>›</span>
        )}
      </button>
      {open && hasBody && (
        <div className="chat-step-body">
          {step.data?.detail && (
            <div className="chat-step-detail">{step.data.detail}</div>
          )}
          {step.data?.code && (
            looksLikeDiff(step.data.code) ? (
              <InlineDiff diffText={step.data.code} />
            ) : (
              <div className="chat-code-block">
                <div className="chat-code-header">
                  <span className="chat-code-lang">{step.data.lang || "text"}</span>
                  <CopyButton code={step.data.code} />
                </div>
                <StepCodeHighlighter code={step.data.code} language={step.data.lang || "text"} />
              </div>
            )
          )}
          {step.data?.result && (
            looksLikeDiff(step.data.result) ? (
              <InlineDiff diffText={step.data.result} />
            ) : (
              <div className="chat-step-result">{step.data.result}</div>
            )
          )}
        </div>
      )}
    </div>
  );
}

/** The single collapsed row that wraps an assistant turn's ENTIRE process —
 *  thinking, tool calls, and file edits — into one line ("Worked for Xs" once
 *  done; a live action label while streaming). Expanding reveals what the turn
 *  actually did, in source order: ThinkingBlock disclosures, ActivityStepRow
 *  tool rows, and inline DiffCards. The model's synthesized answer and the
 *  files-changed summary render OUTSIDE this row, after it.
 *
 *  The label is computed by the caller (MessageBubbleInner) so this component
 *  stays presentational: `live` drives the spinner/check icon and `label` is
 *  either the live action, "Worked for Xs" (when a duration is known), or a
 *  legacy one-line summary fallback. */
export function ProcessSummary({
  live,
  label,
  keepExpandedOnEnd,
  children,
}: {
  live: boolean;
  label: string;
  /** True when the turn ended WITHOUT a duration (the user pressed stop).
   *  Completed turns auto-collapse; a stopped turn keeps whatever expansion
   *  it had — its process steps are the only content it produced, and
   *  folding them into an empty-looking "Worked" row erases the turn. */
  keepExpandedOnEnd?: boolean;
  children: ReactNode;
}) {
  // The toggle IS the assistant-message-header slot: plain "Working for Xs"
  // while streaming, "Worked for Xs ›" once done — same muted header style,
  // with the chevron marking it expandable.
  //
  // Auto-expand while the TURN is in flight (so live tool activity and
  // thinking are visible — they already show what's happening, so no separate
  // action line is needed), auto-collapse when it ends. The turn-level live
  // flag doesn't flicker between tool rounds (unlike per-step state), so
  // this doesn't flash. A manual toggle latches for the rest of the turn.
  const [open, setOpen] = useState(live || !!keepExpandedOnEnd);
  const [userToggled, setUserToggled] = useState(false);
  useEffect(() => {
    if (userToggled) return;
    if (live) {
      setOpen(true);
    } else if (!keepExpandedOnEnd) {
      setOpen(false);
    }
  }, [live, keepExpandedOnEnd, userToggled]);

  return (
    <div className={`chat-process${live ? " live" : ""}`}>
      <button
        type="button"
        className="chat-process-toggle"
        onClick={() => {
          setUserToggled(true);
          setOpen((o) => !o);
        }}
        title={open ? "Hide what was done" : "Show what was done"}
        aria-expanded={open}
      >
        <span className="chat-process-label">{label}</span>
        <span className={`chat-thinking-chevron${open ? " open" : ""}`} aria-hidden="true">
          ›
        </span>
      </button>
      <SmoothReveal open={open}>
        <div className="chat-process-body">{children}</div>
      </SmoothReveal>
    </div>
  );
}

/** One render block of an assistant turn's process region. `activity` flattens
 *  to its step rows (the outer ProcessSummary is the single collapse; nested
 *  collapsibles would be confusing). `diff` keeps its inline DiffCard. `think`
 *  is its own disclosure. `text` is mid-run narration as markdown. */
/** Render one process block inside the ProcessSummary region. Keys carry the
 *  block KIND plus the loop index (PERFORMANCE_AUDIT.md F6): a bare `key={i}`
 *  remounts a block whenever the block at that index changes kind (e.g. a
 *  think block that gains a tool run below it mid-stream), losing collapse
 *  state. Diff blocks key on their file path, which is unique per turn. */
export function renderProcessBlock(
  b: Block,
  i: number,
  onPreviewArtifact?: (artifact: ChatArtifact) => void,
  cache = true,
  sources?: ChatSource[],
  chatSessionId?: string | null,
) {
  switch (b.kind) {
    case "activity":
      return (
        <div className="chat-activity-steps" key={`activity:${i}`}>
          {b.group.steps.map((step, j) => (
            <ActivityStepRow
              key={`${step.data?.kind ?? "step"}:${step.data?.path ?? step.data?.title ?? j}:${j}`}
              step={step}
              done={step.done}
            />
          ))}
        </div>
      );
    case "folded":
      return (
        <FoldedStepGroup
          key={`folded:${b.title}:${i}`}
          title={b.title}
          icon={b.icon}
          count={b.count}
          steps={b.steps}
        />
      );
    case "editrow":
      return <EditFileRow key={`editrow:${b.step.data?.path ?? i}`} step={b.step} />;
    case "think":
      return b.text.length > 0 ? (
        <ThinkingBlock key={`think:${i}`} thinking={b.text} done={b.done} />
      ) : null;
    case "text":
      return b.text.trim().length > 0 ? (
        <Markdown key={`text:${i}`} content={b.text} onPreviewArtifact={onPreviewArtifact} cache={cache} sources={sources} chatSessionId={chatSessionId} />
      ) : null;
  }
}

/** A run of N consecutive same-tool calls folded into ONE expandable row
 *  ("⌗ Terminal · 2 commands ⌄") — nine stacked search rows drowned the
 *  transcript. Expanded, it renders the original per-call rows. */
export function FoldedStepGroup({
  title,
  icon,
  count,
  steps,
}: {
  title: string;
  icon: string;
  count: number;
  steps: ActivityStep[];
}) {
  const [open, setOpen] = useState(false);
  const allDone = steps.every((s) => s.done);
  // Noun matches what the run actually did — "reading_a_web_page · 3 searches"
  // read as a bug; web rows are page reads, search rows are searches.
  const noun =
    icon === "code"
      ? "commands"
      : icon === "search"
        ? "searches"
        : icon === "web" || icon === "browser"
          ? "pages"
          : "calls";
  return (
    <div className="chat-fold-group">
      <button
        type="button"
        className="chat-fold-toggle"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <StepStatusIcon done={allDone} />
        <ToolIcon kind={icon} />
        <span className="chat-fold-title">{title.toLowerCase().replace(/\s+/g, "_")}</span>
        <span className="chat-fold-count">
          {count} {noun}
        </span>
        <span className={`chat-thinking-chevron${open ? " open" : ""}`} aria-hidden="true">
          ›
        </span>
      </button>
      <SmoothReveal open={open}>
        <div className="chat-fold-body chat-activity-steps">
          {steps.map((step, j) => (
            <ActivityStepRow
              key={`${step.data?.kind ?? "step"}:${j}`}
              step={step}
              done={step.done}
            />
          ))}
        </div>
      </SmoothReveal>
    </div>
  );
}

/** Compact file-edit row (Cursor-style): ✏ Edit  [kind icon] file  dir  +N −M.
 *  Clicking the row expands the inline diff card; clicking the FILE NAME opens
 *  the file in the right-side diff overlay (same surface the git sidebar and
 *  turn-changes rows use). */
export function EditFileRow({ step }: { step: ActivityStep }) {
  const [open, setOpen] = useState(false);
  const path = step.data?.path ?? "";
  const edit = step.data?.edit;
  const fileName = path.split(/[\\/]/).pop() ?? path;
  const dir = path.slice(0, path.length - fileName.length).replace(/[\\/]$/, "");
  const stats = useMemo(() => (edit ? editLineStats(edit) : null), [edit]);
  const selectedProjectId = useProjectsStore((s) => s.selectedProjectId);
  const projectPath = useProjectsStore((s) =>
    s.projects.find((p) => p.id === s.selectedProjectId)?.path,
  );

  const openDiffOverlay = () => {
    // Same routing as the turn-changes rows: an open git repo diff goes to
    // the DevDiffPanel overlay; anything else falls back to a file tab.
    const status = selectedProjectId
      ? useProjectsStore.getState().gitStatuses[selectedProjectId]
      : undefined;
    useUiStore.getState().setDiffPanelFile(path, status && !status.isRepo ? null : (projectPath ?? null));
    useUiStore.getState().addTab("files");
  };

  return (
    <div className="chat-edit-row">
      <button
        type="button"
        className="chat-edit-row-toggle"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <Pencil size={12} strokeWidth={2} className="chat-edit-row-pen" aria-hidden="true" />
        <span className="chat-edit-row-verb">{step.done ? "Edit" : "Editing"}</span>
        <span
          className="chat-edit-row-file"
          role="button"
          tabIndex={0}
          title={`Open ${path} in the diff panel`}
          onClick={(e) => {
            e.stopPropagation();
            openDiffOverlay();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.stopPropagation();
              e.preventDefault();
              openDiffOverlay();
            }
          }}
        >
          {fileName}
        </span>
        {dir && <span className="chat-edit-row-dir">{dir}</span>}
        {stats && (
          <span className="chat-edit-row-stats">
            {stats.adds > 0 && <span className="diff-stat-add">+{stats.adds}</span>}
            {stats.dels > 0 && <span className="diff-stat-del">−{stats.dels}</span>}
          </span>
        )}
        <span className={`chat-thinking-chevron${open ? " open" : ""}`} aria-hidden="true">
          ›
        </span>
      </button>
      {edit && path && (
        <SmoothReveal open={open}>
          <DiffCard path={path} edit={edit} done={step.done} />
        </SmoothReveal>
      )}
    </div>
  );
}

/** The bubble's end-of-turn timestamp: "14:32" today, "Sep 7, 14:32" older.
 *  Persisted rows carry Unix SECONDS while the optimistic just-sent message
 *  carries Date.now() ms — normalize via the 1e12 µs/ms threshold. Returns
 *  null when absent or unparseable (legacy rows render without a stamp). */
export function formatMessageTimestamp(ts?: number): string | null {
  if (ts == null || !Number.isFinite(ts) || ts <= 0) return null;
  const d = new Date(ts > 1e12 ? ts : ts * 1000);
  if (Number.isNaN(d.getTime())) return null;
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  return sameDay
    ? time
    : `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`;
}

/** Live whole-seconds elapsed for the "Working for Xs" header. Reading the
 *  latest `chat:perf` snapshot directly made the timer feel sluggish: the
 *  backend heartbeat emits every ~500ms through a throttle shared with
 *  token-driven emits (so gaps can stretch toward ~1s), then the value crosses
 *  IPC + render latency and gets floored to whole seconds — the visible counter
 *  could lag wall-clock by over a second and tick unevenly. Instead, each
 *  snapshot ANCHORS true elapsed at its arrival instant and a local 250ms
 *  ticker interpolates between anchors, so the displayed second flips on real
 *  time boundaries no matter when events land.
 *
 *  `fallback` (the bubble's live flag) keeps the ticker running from MOUNT
 *  when no perf snapshots exist at all — harness turns (claude/opencode CLIs)
 *  never emit chat:perf, so without the fallback their header stuck on a bare
 *  "Working" with no seconds. */
export function useLiveElapsedSec(
  perf: ChatPerfPayload | null | undefined,
  fallback: boolean,
): number | null {
  const [sec, setSec] = useState<number | null>(null);
  const anchor = useRef<{ baseMs: number; at: number } | null>(null);
  const mountedAt = useRef<number>(performance.now());
  // Re-anchor ONLY when a new snapshot object lands — not on unrelated
  // re-renders (token flushes), which would otherwise keep advancing `at`
  // against a stale baseMs and freeze the interpolation mid-stream.
  const lastPerf = useRef<ChatPerfPayload | null | undefined>(undefined);
  if (perf !== lastPerf.current) {
    lastPerf.current = perf;
    anchor.current = perf ? { baseMs: perf.elapsedMs, at: performance.now() } : null;
  }

  // Adopt each snapshot's truth as it lands. TURN RESET: within one turn
  // elapsedMs only grows, so a snapshot landing FAR behind the previous
  // snapshot's means a NEW turn is reusing this bubble (cancel + resend
  // before the live row remounts) — adopt the smaller truth instead of
  // letting the monotonic display guard freeze the old turn's count on
  // screen (the stale "Working for Xs" regression). Small backwards jitter
  // (<1.5s) still can't regress the display.
  const prevPerfRef = useRef<ChatPerfPayload | null | undefined>(undefined);
  useEffect(() => {
    const prev = prevPerfRef.current;
    prevPerfRef.current = perf;
    if (!perf) {
      setSec(null);
      return;
    }
    const next = Math.floor(perf.elapsedMs / 1000);
    const isTurnReset = prev != null && perf.elapsedMs + 1500 < prev.elapsedMs;
    setSec((cur) => (isTurnReset || cur == null || next >= cur ? next : cur));
  }, [perf]);

  // Interpolate between snapshots so the displayed second flips on real
  // wall-clock boundaries. Runs while snapshots exist OR while `fallback` is
  // set (a live bubble without perf events — anchored to mount time), so
  // completed bubbles (no perf, not live) never pay for a timer.
  const ticking = perf != null || fallback;
  useEffect(() => {
    if (!ticking) return;
    const iv = window.setInterval(() => {
      const a = anchor.current ?? { baseMs: 0, at: mountedAt.current };
      const interpolated = Math.floor(
        (a.baseMs + Math.max(0, performance.now() - a.at)) / 1000,
      );
      setSec((prev) => (prev == null || interpolated > prev ? interpolated : prev));
    }, 250);
    return () => window.clearInterval(iv);
  }, [ticking]);

  return sec;
}

/** Returns a style object for inline code elements using CSS variable lookups
 *  that work in both light and dark themes (the variables resolve at runtime).
 *  Module-level constant: every Markdown render (cached or fresh) must share
 *  one identity so cached element trees stay reusable. */
export const inlineCodeStyle = {
  background: "var(--surface-2)",
  padding: "2px 6px",
  borderRadius: "var(--radius-xs)",
  fontFamily: "var(--font-mono)",
  fontSize: "0.9em",
  boxShadow: "var(--glass-rim-soft)",
} as const;

/**
 * LRU cache of RENDERED markdown element trees, keyed by content.
 *
 * The message list is virtualized: rows unmount when they scroll out of the
 * window and REMOUNT when the user scrolls back. Without this cache every
 * remount re-ran the full remark → rehype-katex → syntax-highlight pipeline
 * (tens of ms per large bubble), which is the dominant scroll cost in long
 * conversations. React elements are immutable descriptors, so a built tree is
 * safe to reuse across mounts and parents — reconciliation still diffs it
 * against the DOM, only the parse is skipped.
 *
 * Callers must only cache content whose rendered handlers are call-site
 * independent (the components config reads no per-message closure except
 * onPreviewArtifact, which is the stable store action at every call site).
 */
export const MD_CACHE_MAX = 240;
export const markdownElementCache = new Map<string, ReactNode>();

export function cachedMarkdown(key: string, build: () => ReactNode): ReactNode {
  const hit = markdownElementCache.get(key);
  if (hit !== undefined) {
    // Refresh LRU order (Map iterates insertion-first).
    markdownElementCache.delete(key);
    markdownElementCache.set(key, hit);
    return hit;
  }
  const el = build();
  markdownElementCache.set(key, el);
  if (markdownElementCache.size > MD_CACHE_MAX) {
    const oldest = markdownElementCache.keys().next().value;
    if (oldest !== undefined) markdownElementCache.delete(oldest);
  }
  return el;
}

export function CopyButton({ code }: { code: string }) {
  const [copied, copyToClipboard] = useCopyToClipboard(1800);

  const handleCopy = useCallback(async () => {
    await copyToClipboard(code);
  }, [code, copyToClipboard]);

  return (
    <button className="ghost copy-code-btn" onClick={handleCopy}>
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

/** djb2 — a tiny stable hash so a JSX block gets a consistent preview id. */
export function hashCode(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** Strictly limit how much of a tool step's code we hand to a `<SyntaxHighlighter>`.
 *  React-Syntax-Highlighter ships a vulnerable dependency tree (refractor / hast)
 *  historically; an extremely long `code` payload from a misbehaving model could
 *  amplify any parser cost. A 200 KB cap is well above any legitimate code block
 *  and bounds the worst case. */
export const MAX_CODE_BLOCK_BYTES = 200_000;

/** Chip that opens a ```jsx / ```tsx block as a live preview in the side pane
 *  (Claude-style), instead of rendering it inline in the chat. */
export function JsxArtifactChip({
  code,
  lang,
  onPreviewArtifact,
}: {
  code: string;
  lang: "jsx" | "tsx";
  onPreviewArtifact?: (artifact: ChatArtifact) => void;
}) {
  const filename = `Component.${lang}`;
  return (
    <button
      type="button"
      className="chat-artifact-chip chat-jsx-chip"
      title="Open live React preview"
      onClick={(e) => {
        e.currentTarget.blur();
        onPreviewArtifact?.({
          path: `jsx:${lang}:${hashCode(code)}`,
          filename,
          inline: { kind: lang, code },
        });
      }}
    >
      <ReactIcon />
      <span>React preview</span>
    </button>
  );
}

export function ReactIcon() {
  return (
    <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
      <ellipse cx="12" cy="12" rx="10" ry="4" />
      <ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(60 12 12)" />
      <ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(120 12 12)" />
    </svg>
  );
}

/** Module cache of decoded local-image data URIs. Virtualized rows remount on
 *  every scroll; without this each remount re-fetched the file over IPC and
 *  repainted "Loading image…" — visible flicker plus IPC churn. Keyed by the
 *  exact source path; bounded like the markdown cache. */
export const IMAGE_CACHE_MAX = 64;
export const imageDataUriCache = new Map<string, string>();

/** Renders `![alt](src)` inside assistant markdown. Remote/data/blob URLs
 *  render directly. LOCAL file references — what the agent produces when it
 *  saves a screenshot or image to disk (`C:\…`, `file:///…`, `/…`) — can never
 *  work as an <img> src here: the CSP allows only 'self' data: blob: https:,
 *  no asset protocol is registered, and a bare path resolves against the app
 *  origin and 404s. So local refs load their bytes over IPC (the same
 *  read_artifact_preview the canvas uses) and render as a data URI. */
export function ChatImage({ src, alt }: { src: string; alt?: string }) {
  const isRemote = /^(https?:|data:|blob:)/i.test(src);
  const cachedUri = isRemote ? null : imageDataUriCache.get(src) ?? null;
  const [dataUri, setDataUri] = useState<string | null>(cachedUri);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (isRemote || cachedUri) return;
    let stale = false;
    let path = src.trim();
    const fileMatch = /^file:\/\/\/?(.*)$/i.exec(path);
    if (fileMatch) path = fileMatch[1];
    try {
      path = decodeURIComponent(path);
    } catch {
      // Not URL-encoded (e.g. a raw Windows path with %) — keep it as-is.
    }
    // "file:///C:/…" leaves a leading slash before the drive letter.
    if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
    void readArtifactPreview(path)
      .then((preview) => {
        if (stale) return;
        if (preview?.kind === "image" && preview.dataUri) {
          imageDataUriCache.set(src, preview.dataUri);
          if (imageDataUriCache.size > IMAGE_CACHE_MAX) {
            const oldest = imageDataUriCache.keys().next().value;
            if (oldest !== undefined) imageDataUriCache.delete(oldest);
          }
          setDataUri(preview.dataUri);
        } else {
          setFailed(true);
        }
      })
      .catch(() => {
        if (!stale) setFailed(true);
      });
    return () => {
      stale = true;
    };
  }, [src, isRemote, cachedUri]);

  if (isRemote || dataUri) {
    return <img src={isRemote ? src : dataUri!} alt={alt ?? ""} />;
  }
  if (failed) {
    return (
      <span style={{ color: "var(--muted, #888)", fontSize: "0.85em" }}>
        {alt || "Image"} — preview unavailable ({src})
      </span>
    );
  }
  return <span style={{ color: "var(--muted, #888)", fontSize: "0.85em" }}>Loading image…</span>;
}

// react-markdown's default URL sanitizer strips unknown schemes — which
// would blank our internal `cite:` links before the `a` component ever sees
// them. Pass them through untouched; everything else keeps the default
// sanitization.
export function citeUrlTransform(url: string): string {
  return url.startsWith("cite:") ? url : defaultUrlTransform(url);
}

// Fenced code blocks ALWAYS render inside a <pre> in the hast tree
// react-markdown builds; inline code never does. The `pre` override marks its
// subtree so the `code` override can tell real block code from inline code —
// the old heuristic ("no language class AND no newline") misclassified a
// single-line fenced block with no language as inline code.
export const InsidePreContext = createContext(false);

/** Renders a markdown string with syntax-highlighted code fences, mermaid
 *  diagrams and glass-styled links — the assistant's normal answer body.
 *  `cache` (default true) reuses the rendered element tree across mounts via
 *  the module LRU — pass false for content that changes every flush (the live
 *  streaming bubble), which would otherwise insert a cache entry per token.
 *  `sources` (assistant turns only) enables interactive inline citations:
 *  `[1]` / `(1,2)` markers whose numbers appear in the turn's Sources section
 *  render as hover/click chips (see chatCitations.ts). */
export function Markdown({
  content,
  onPreviewArtifact,
  cache = true,
  sources,
  chatSessionId,
}: {
  content: string;
  onPreviewArtifact?: (artifact: ChatArtifact) => void;
  cache?: boolean;
  sources?: ChatSource[];
  /** Owning chat session — enables the mermaid "Fix with AI" repair button
   *  and routes the fix request to the right conversation (split pane and
   *  background sessions must not leak into the globally active one). */
  chatSessionId?: string | null;
}) {
  const hasSources = !!sources && sources.length > 0;
  const fingerprint = sourcesFingerprint(sources);
  const build = () => {
    const body = hasSources ? linkCitations(content, sources!) : content;
    return (
      <ReactMarkdown
        // singleDollarTextMath: false — a lone `$` pair must NOT open math:
        // "$5 and $10" used to render as KaTeX, which collapses the spaces
        // ("5and10"). `$$…$$` display math still works.
        remarkPlugins={[remarkGfm, remarkBreaks, [remarkMath, { singleDollarTextMath: false }]]}
        // remarkBreaks: chat convention (ChatGPT/Discord/Slack) — a model
        // answer written with single newlines renders those breaks instead of
        // collapsing into one run-on paragraph. The .md FILE preview
        // (ArtifactPreviewPane) deliberately stays standard-markdown.
        rehypePlugins={[rehypeKatex]}
        urlTransform={citeUrlTransform}
        components={{
          table: MarkdownTable,
          pre({ children }) {
            // Marks the subtree so `code` below knows it is a fenced block
            // (see InsidePreContext above). The <pre> itself stays in the DOM.
            return (
              <InsidePreContext.Provider value={true}>
                <pre>{children}</pre>
              </InsidePreContext.Provider>
            );
          },
          code({ className, children, ...props }) {
            const match = /language-(\w+)/.exec(className || "");
            const rawCode = String(children).replace(/\n$/, "");
            // Cap the code string before handing it to the highlighter so a
            // misbehaving model can't ship a pathologically large payload
            // that amplifies any parser cost in the (historically
            // vulnerable) highlighter dep tree. Truncate cleanly.
            const codeString =
              rawCode.length > MAX_CODE_BLOCK_BYTES
                ? rawCode.slice(0, MAX_CODE_BLOCK_BYTES) + "\n… (truncated)"
                : rawCode;

            // Inline code: no language class and not inside a fenced block.
            const insidePre = useContext(InsidePreContext);
            if (!match && !insidePre) {
              return (
                <code style={inlineCodeStyle} {...props}>
                  {children}
                </code>
              );
            }

            // Mermaid diagrams render as inline SVG, not as highlighted text.
            if (match && match[1] === "mermaid") {
              return (
                <Suspense fallback={<pre className="chat-markdown-mermaid-fallback">{codeString}</pre>}>
                  <MermaidDiagram
                    code={codeString}
                    // A diagram that failed to parse offers a one-click fix:
                    // send the source + error back to the agent in this
                    // session (queued automatically if a stream is running).
                    onFix={
                      chatSessionId
                        ? (source, error) => {
                            const clipped =
                              source.length > 4096
                                ? source.slice(0, 4096) + "\n%% …(truncated)"
                                : source;
                            void useChatStore
                              .getState()
                              .sendMessage(
                                `The mermaid diagram in your previous message failed to render with this error: ${error}\n\nBroken source:\n\`\`\`mermaid\n${clipped}\n\`\`\`\nReply with the corrected diagram as a single \`\`\`mermaid block — no other commentary.`,
                                undefined,
                                false,
                                chatSessionId,
                              );
                          }
                        : undefined
                    }
                  />
                </Suspense>
              );
            }
            // React/JSX artifacts open as a live preview in the side pane
            // (rendered by ArtifactPreviewPane), not inline in the chat.
            if (match && (match[1] === "jsx" || match[1] === "tsx")) {
              return (
                <JsxArtifactChip
                  code={codeString}
                  lang={match[1] as "jsx" | "tsx"}
                  onPreviewArtifact={onPreviewArtifact}
                />
              );
            }

            // Code block with language.
            return (
              <div className="chat-code-block">
                <div className="chat-code-header">
                  <span className="chat-code-lang">{match ? match[1] : "text"}</span>
                  <CopyButton code={codeString} />
                </div>
                <StepCodeHighlighter code={codeString} language={match ? match[1] : "text"} />
              </div>
            );
          },
          // Images: remote URLs render as-is; local file paths (agent-saved
          // screenshots/images) are loaded over IPC into a data URI — see
          // ChatImage for why a bare path can never render in this webview.
          img({ src, alt }) {
            return <ChatImage src={typeof src === "string" ? src : ""} alt={alt} />;
          },
          // Links open in the built-in browser pane, NOT the system browser:
          // in a Tauri webview a target=_blank navigation falls through to the
          // OS default handler. Intercept the click and route it to the pane.
          // `cite:` targets are rewritten citation markers ([1] / (1,2)) and
          // render as interactive source chips instead of plain links.
          a({ href, children }) {
            if (hasSources && href?.startsWith("cite:")) {
              const nums = href
                .slice("cite:".length)
                .split(",")
                .map((x) => parseInt(x, 10))
                .filter((n) => Number.isFinite(n));
              const citation = <ChatCitation nums={nums} sources={sources!} />;
              if (citation) return citation;
            }
            return <MdLink href={href}>{children}</MdLink>;
          },
        }}
      >
        {body}
      </ReactMarkdown>
    );
  };
  return (
    <div className="chat-markdown">
      {/* chatSessionId is in the key: the built tree closes over it (mermaid
          "Fix with AI" routes to that session), so identical content in the
          main + split sessions must NOT share one cached tree — the repair
          would route to whichever session cached first. */}
      {cache
        ? cachedMarkdown(
            `md:${chatSessionId ?? ""}:${content}${fingerprint ? `|src:${fingerprint}` : ""}`,
            build,
          )
        : build()}
    </div>
  );
}

/** One step inside an activity group. Tool steps carry the call's `ToolData`;
 *  think steps (`think` set, `data` null) are reasoning interludes folded into
 *  the SAME group so a turn renders as one outer container instead of
 *  alternating activity/thinking blocks. (`before`/`after` narration slots are
 *  retired: model prose renders as normal message text OUTSIDE the process
 *  region, in source order — captions glued to tool rows read as broken.) */
export interface ActivityStep {
  data: ToolData | null;
  done: boolean;
}

/** A grouped run of tool steps, collapsed into one summary line by default. */
export interface ActivityGroup {
  steps: ActivityStep[];
}

/** A render block: either a standalone text/think segment (rendered as
 *  before), a collapsed activity group spanning a contiguous tool run, a
 *  folded run of consecutive same-tool rows (one expandable row), or a
 *  compact file-edit row that expands to the inline diff card. */
export type Block =
  | { kind: "text"; text: string }
  | { kind: "think"; text: string; done: boolean }
  | { kind: "activity"; group: ActivityGroup }
  | { kind: "folded"; title: string; icon: string; count: number; steps: ActivityStep[] }
  | { kind: "editrow"; step: ActivityStep };

/** Titles used for the consecutive-same-tool folding. Subagent chips, edit
 *  cards and result rows keep their dedicated rendering. */
export function foldableTitle(step: ActivityStep): string | null {
  const kind = step.data?.kind;
  if (kind === "subagent" || kind === "edit" || kind === "result") return null;
  const title = step.data?.title?.trim();
  return title ? title : null;
}

/** Walk the parsed segments and collapse the turn's TOOL activity into
 *  ActivityGroup blocks. Thinking (`<think>`) never enters a group: each
 *  reasoning interlude is emitted as its own standalone disclosure beside the
 *  collapsed tool-call summary, so it stays visible without expanding the
 *  group and only tool calls live inside the collapsible.
 *
 *  Boundary rules:
 *  - Text before the first tool/think renders ABOVE the container as markdown.
 *  - A group starts at the first `tool` segment and absorbs every following
 *    `tool` segment — except file-edit tool calls (`kind: "edit"`),
 *    which break out into their own inline diff review card so an edit is
 *    reviewable at a glance instead of buried in the collapsed group. A diff
 *    card flushes the in-progress group, so a turn with edits renders as
 *    alternating activity/diff blocks in call order.
 *  - A `think` segment flushes the in-progress group (if any) and renders as
 *    its own block; a following tool starts a fresh group. A turn thus renders
 *    as alternating think/activity blocks in source order.
 *  - Mid-run prose is NORMAL message text, not tool-row decoration: it closes
 *    the in-progress run and emits as its own text block, so every narration
 *    the model writes renders outside the process region as markdown (the old
 *    behavior glued it to tool rows as tiny captions — unreadable).
 *  - Text trailing the last tool/think is the model's synthesized answer and
 *    renders OUTSIDE the group as markdown, after the summary.
 *  - A turn with thinking but NO tool calls keeps the old behavior: the think
 *    segment stays its own standalone disclosure. */
export function groupSegments(segments: Segment[]): Block[] {
  // No tool activity at all → pass through (a lone thinking block stays its
  // own disclosure, text renders as markdown).
  if (!segments.some((s) => s.type === "tool")) {
    return segments.map((seg) =>
      seg.type === "think"
        ? { kind: "think", text: seg.text, done: seg.done }
        : { kind: "text", text: seg.type === "text" ? seg.text : "" },
    );
  }

  const blocks: Block[] = [];
  let steps: ActivityStep[] = [];

  // Close out the in-progress activity group. Consecutive runs of the SAME
  // tool (nine web searches in a row, two shell commands, …) fold into ONE
  // expandable "tool · N" row — one row per call drowned the transcript.
  const flushSteps = () => {
    if (steps.length === 0) return;
    let run: ActivityStep[] = [];
    const flushRun = () => {
      if (run.length === 0) return;
      if (run.length >= 2 && run.every((s) => foldableTitle(s) !== null)) {
        blocks.push({
          kind: "folded",
          title: foldableTitle(run[0]) ?? "",
          icon: run[0].data?.kind ?? "tool",
          count: run.length,
          steps: run,
        });
      } else {
        for (const s of run) blocks.push({ kind: "activity", group: { steps: [s] } });
      }
      run = [];
    };
    for (const step of steps) {
      const title = foldableTitle(step);
      const prevTitle = run.length > 0 ? foldableTitle(run[run.length - 1]) : null;
      if (run.length > 0 && (title === null || title !== prevTitle)) {
        flushRun();
      }
      if (title !== null) {
        run.push(step);
      } else {
        // Non-foldable kinds (subagent chips etc.) keep their own row.
        blocks.push({ kind: "activity", group: { steps: [step] } });
      }
    }
    flushRun();
    steps = [];
  };

  for (const seg of segments) {
    if (seg.type === "text") {
      // ALL prose — leading, mid-run narration, and the trailing answer —
      // renders as normal markdown outside the process region, in source
      // order. Flush the run so the text lands between tool groups. Text
      // never opens the process region (only tools/think do).
      flushSteps();
      blocks.push({ kind: "text", text: seg.text });
      continue;
    }
    if (seg.type === "tool") {
      // A "result" kind block is the captured output of the preceding shell
      // command — merge it INTO that step instead of creating a separate
      // "Output" row, so expanding the shell command reveals its output.
      if (seg.data?.kind === "result" && steps.length > 0) {
        const prev = steps[steps.length - 1];
        if (prev.data?.kind === "code" && !prev.data.result) {
          prev.data.result = seg.data.result;
          continue;
        }
      }
      const step: ActivityStep = {
        data: seg.data,
        done: seg.done,
      };
      if (seg.data?.kind === "edit" && seg.data.path && seg.data.edit) {
        flushSteps();
        blocks.push({ kind: "editrow", step });
      } else if (seg.data?.kind === "result") {
        // A result that didn't merge (no preceding shell step, or the
        // preceding step already has a result) — keep it as its own row so
        // the output is never lost.
        steps.push(step);
      } else {
        steps.push(step);
      }
      continue;
    }
    if (seg.type === "think") {
      // Skip empty think shells (e.g. an opening tag that just started
      // streaming); any pending narration stays held for the next step.
      if (seg.text.length === 0) continue;
      // Pull thinking OUT of the activity group: close any in-progress tool
      // run, then emit the reasoning as its own disclosure beside the
      // collapsed tool-call summary (not buried inside it). A following tool
      // starts a fresh group, so a turn renders as alternating
      // think/activity blocks in source order.
      flushSteps();
      blocks.push({ kind: "think", text: seg.text, done: seg.done });
      continue;
    }
  }

  flushSteps();
  return blocks;
}
