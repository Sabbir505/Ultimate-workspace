// Chat composer, Claude-style: a single rounded card with the textarea on
// top and a footer row below — "+" attach button on the left and a circular
// ↑ send button on the right. Agent + model selection live in ONE combined
// chip in the control bar below (AgentModelPicker): left rail of agents,
// right pane of that agent's models with a search header.
// Enter sends; Shift+Enter inserts a newline.
// Attachments: images are sent as vision input, docx/pptx/xlsx/pdf and legacy
// doc/ppt/xls are extracted to text server-side, and plain-text files are
// inlined into the message.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowUpToLine, GripVertical, Mic, Pencil, Plug, Puzzle, SquareSlash, Trash2, X } from "lucide-react";
import { AgentModelPicker, type AgentModelSelection } from "./AgentModelPicker";
import { PermissionModeMenu } from "./PermissionModeMenu";
import { ArtifactTypeSelector } from "./ArtifactTypeSelector";
import type { PermissionMode } from "../../state/chat";
import { ContextMeter } from "./ContextMeter";
import { ComposerMetrics } from "./ComposerMetrics";
import { BranchDropdown } from "./BranchDropdown";
import { useUiStore } from "../../state/ui";
import { useChatStore, selectContextSessionId } from "../../state/chat";
import { useProjectsStore } from "../../state/projects";
import {
  listChatSkills,
  listPromptTemplates,
  templateVariables,
  fillTemplate,
  transcribeAudio,
  toastError,
  toastInfo,
  generateArtifact,
  persistChatCommandMessage,
  addSessionConnector,
  removeSessionConnector,
  listSessionConnectors,
  listConnectors,
  mcpGalleryList,
  type PromptTemplate,
  type LlamaOverrides,
  type ArtifactType,
  type GenerateArtifactRequest,
} from "../../lib/ipc";

const MAX_TEXT_BYTES = 512 * 1024;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_DOC_BYTES = 10 * 1024 * 1024;

// Parse `/create [artifact] [a|an] <type> [instruction]` or
// `/create-artifact [type] [instruction]`. Returns `{ type, instruction }`
// when a recognized artifact type follows, `null` otherwise.
export const parseCreateCommand = (text: string): { type: ArtifactType; instruction: string } | null => {
  const typeMap: Record<string, ArtifactType> = {
    skill: "skill",
    loop: "loop",
    prompt: "prompt_template",
    prompttemplate: "prompt_template",
    automation: "automation",
    workflow: "automation",
  };
  const pattern = /^\/(?:create-artifact|create)\s+(?:(?:artifact)\s+)?(?:a\s+|an\s+)?(skill|loop|prompt(?:[_ -]?template)?|automation|workflow)\b\s*(.*)$/i;
  const match = pattern.exec(text);
  if (!match) return null;
  const key = match[1].toLowerCase().replace(/[\s_-]/g, "");
  const type = typeMap[key];
  return type ? { type, instruction: match[2] || "" } : null;
};

/** True when the input is a bare `/create`, `/create artifact`, or the user's
 * typoed `/create artifect` with no recognized subtype. */
export const isBareCreateCommand = (text: string): boolean => {
  const t = text.trim().toLowerCase();
  return t === "/create" || t === "/create artifact" || t === "/create artifect" || t === "/create-artifact";
};

/**
 * Natural-language artifact-intent detection — the replacement for the old
 * per-message "Save As" / "Find & Update" chips. Matches two shapes:
 *
 * 1. Legacy exact phrases ("turn this into a skill", "create a loop",
 *    "schedule this", …) — kept verbatim so existing phrasings behave the same.
 * 2. Conversation-distill requests: an artifact-type keyword PLUS a reference
 *    to the chat/conversation PLUS a creation verb — e.g. "analyze our chat and
 *    come up with a skill we can reuse" or "turn this conversation into an
 *    automation". The triple match keeps ordinary messages flowing to the
 *    model. "Come up with a/an <type>" is unambiguous enough to match alone.
 *
 * Questions about artifacts ("how do I create a skill in Claude?") never
 * trigger — they must reach the model.
 */
export const detectArtifactIntent = (msg: string): { type: ArtifactType; instruction: string } | null => {
  const lower = msg.toLowerCase();

  if (/\b(how (do|can|to|does)|what('s| is)|explain)\b/.test(lower)) return null;

  // 1. Legacy exact triggers, verbatim.
  const legacy: Array<[RegExp, ArtifactType]> = [
    [/turn this into a skill|save this as a skill|create a skill/, "skill"],
    [/turn this into a loop|make this run until|create a loop/, "loop"],
    [/save this as a prompt|turn this into a prompt template|create a prompt template/, "prompt_template"],
    [/make this run every|create an automation|schedule this/, "automation"],
  ];
  for (const [re, type] of legacy) {
    if (re.test(lower)) return { type, instruction: msg };
  }

  // 2. Type keyword — plural forms included ("come up with some skills").
  const type: ArtifactType | null = /prompt\s*template/.test(lower)
    ? "prompt_template"
    : /\bskills?\b/.test(lower)
      ? "skill"
      : /\bloop\b/.test(lower)
        ? "loop"
        : /\bautomations?\b|\bautomate\b/.test(lower)
          ? "automation"
          : null;
  if (!type) return null;

  // "Come up with a skill" is an unambiguous creation ask on its own.
  const typeWord = type === "prompt_template" ? "prompt ?template" : type;
  if (new RegExp(`come up with (a |an |some )?${typeWord}`).test(lower)) {
    return { type, instruction: msg };
  }

  const conversationRef = /\b(our|this|the) (chat|conversation|thread|discussion)\b/.test(lower);
  const creationVerb = /\b(come up with|create|make|build|turn|save|derive|extract|distill|summarize)\b/.test(lower);
  if (conversationRef && creationVerb) return { type, instruction: msg };

  return null;
};

// Attachment kinds map to the backend `ChatAttachmentInput`: images go to the
// model as vision input, docs are text-extracted server-side, text is inlined.
export interface ChatAttachment {
  name: string;
  /** Byte size — distinguishes two DIFFERENT files that share a name
   *  (e.g. `Screenshot.png` from two folders) for dedupe/keys/removal. */
  size?: number;
  kind: "text" | "image" | "doc";
  /** Decoded text for `kind === "text"`. */
  text?: string;
  /** Base64 bytes (no data: prefix) for images and docs. */
  data?: string;
  /** MIME type for images, e.g. "image/png". */
  mediaType?: string;
  /** File extension for docs: "docx" | "pptx" | "xlsx" | "pdf" | "doc" | "ppt" | "xls". */
  format?: string;
}

const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp"];
const DOC_EXTS = ["docx", "pptx", "xlsx", "pdf", "doc", "ppt", "xls"];

/** Short type badge shown on the attachment card (e.g. "PDF", "IMAGE"). */
function attachmentBadge(a: ChatAttachment): string {
  if (a.kind === "image") return "IMAGE";
  if (a.kind === "doc") return (a.format ?? "DOC").toUpperCase();
  const ext = a.name.includes(".") ? a.name.split(".").pop() ?? "" : "";
  return (ext || "TEXT").toUpperCase();
}

function AttachmentIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}

/** Magnifier icon for the "Research" menu option + active chip. */
function ResearchIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

/** Folder icon for the "Choose working folder" menu option + the notch chip. */
function FolderIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}

/** Basename of a filesystem path (last non-empty segment), both separators. */
function pathBasename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  return trimmed.split(/[\\/]/).pop() || trimmed;
}

/** Concatenate captured Float32 sample chunks into one buffer, resampling
 *  linearly when the AudioContext couldn't run at 16 kHz natively. whisper.cpp
 *  consumes 16 kHz mono PCM, and capturing at (or converting to) that rate
 *  here removes any ffmpeg dependency from the STT path. */
function joinSamples(chunks: Float32Array[], fromRate: number): Float32Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const raw = new Float32Array(total);
  let off = 0;
  for (const c of chunks) {
    raw.set(c, off);
    off += c.length;
  }
  if (fromRate === 16000 || total === 0) return raw;
  const ratio = fromRate / 16000;
  const out = new Float32Array(Math.max(1, Math.floor(total / ratio)));
  for (let i = 0; i < out.length; i++) {
    const src = i * ratio;
    const i0 = Math.floor(src);
    const frac = src - i0;
    const a = raw[i0] ?? 0;
    const b = raw[i0 + 1] ?? a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/** Canonical 44-byte WAV header + 16-bit LE PCM around 16 kHz mono samples. */
function encodeWav16k(pcm: Float32Array): Blob {
  const dataBytes = pcm.length * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buf);
  const wstr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  wstr(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  wstr(8, "WAVE");
  wstr(12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, 16000, true); // sample rate
  view.setUint32(28, 32000, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  wstr(36, "data");
  view.setUint32(40, dataBytes, true);
  let off = 44;
  for (let i = 0; i < pcm.length; i++, off += 2) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: "audio/wav" });
}

/** Chunked base64 — spreading the whole buffer into String.fromCharCode
 *  throws RangeError on clips > ~100KB. 8KB chunks are safe and fast. */
async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Live-partial cadence and window. 3s keeps CPU flat while feeling live;
 *  the 10s tail bounds each request's cost regardless of session length. */
const PARTIAL_TICK_MS = 3000;
const PARTIAL_TAIL_SECONDS = 10;

/** Whisper was trained on subtitle-style transcripts and sprinkles newline
 *  tokens at segment boundaries — mid-flow, semi-random. Flatten them into
 *  one predictable paragraph; the composer soft-wraps for readability. */
function flattenVoiceText(text: string): string {
  return text.replace(/\s*\n+\s*/g, " ").replace(/ {2,}/g, " ").trim();
}

/** Stable empty list for the queue selector (a fresh [] per call would make
 *  every store change re-render the composer). */
const NO_QUEUED_MESSAGES: import("../../state/chat").QueuedChatMessage[] = [];

/** One stacked queued message inside the composer notch (Cursor-style): the
 *  grip drag-reorders via POINTER events (HTML5 drag-and-drop proved dead
 *  inside the Electron webview — no dragstart ever fired), click the text to
 *  expand/collapse it, ↥ Steer sends it immediately (interrupting the running
 *  turn), the pencil edits it in place (compact — Save/Cancel stay on the
 *  row), the trash drops it. */
function QueuedMessageRow({
  message,
  index,
  count,
  onSteer,
  onEdit,
  onDelete,
  onReorder,
}: {
  message: import("../../state/chat").QueuedChatMessage;
  index: number;
  count: number;
  onSteer: () => void;
  onEdit: (text: string) => void;
  onDelete: () => void;
  /** Live reorder: source index → new index while the pointer drags. */
  onReorder: (from: number, to: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const [dragging, setDragging] = useState(false);
  // Drag bookkeeping lives in a ref: the store reorder re-renders the list,
  // but the pointer capture stays on the grip, so tracking survives.
  const dragIndex = useRef(index);
  const dragPointerId = useRef<number | null>(null);

  const label =
    message.content ||
    `${message.attachments?.length ?? 0} attachment${(message.attachments?.length ?? 0) === 1 ? "" : "s"}`;

  const commitEdit = () => {
    const text = draft.trim();
    if (text) onEdit(text);
    setEditing(false);
  };

  const endDrag = () => {
    dragPointerId.current = null;
    setDragging(false);
  };

  const onGripPointerDown = (e: React.PointerEvent<HTMLSpanElement>) => {
    if (editing) return;
    e.preventDefault();
    e.stopPropagation();
    dragIndex.current = index;
    dragPointerId.current = e.pointerId;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
  };

  const onGripPointerMove = (e: React.PointerEvent<HTMLSpanElement>) => {
    if (dragPointerId.current !== e.pointerId) return;
    // Which row slot is the pointer over RIGHT NOW? Rects are queried live so
    // the tracking survives the list re-rendering after each reorder.
    const rows = document.querySelectorAll<HTMLDivElement>(".composer-queue-row");
    let target = dragIndex.current;
    rows.forEach((el, i) => {
      const r = el.getBoundingClientRect();
      if (e.clientY >= r.top && e.clientY <= r.bottom) target = i;
    });
    if (target !== dragIndex.current) {
      const from = dragIndex.current;
      dragIndex.current = target;
      onReorder(from, target);
    }
  };

  return (
    <div className={`composer-queue-row${dragging ? " dragging" : ""}`}>
      <span
        className="composer-queue-grip"
        title="Drag to reorder"
        aria-hidden="true"
        onPointerDown={onGripPointerDown}
        onPointerMove={onGripPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <GripVertical size={12} strokeWidth={2} />
      </span>
      {editing ? (
        <>
          <textarea
            autoFocus
            className="composer-queue-edit-input"
            value={draft}
            rows={Math.min(4, draft.split("\n").length)}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                commitEdit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setDraft(message.content);
                setEditing(false);
              }
            }}
          />
          <button
            type="button"
            className="composer-queue-btn primary"
            title="Save changes"
            onClick={commitEdit}
          >
            Save
          </button>
          <button
            type="button"
            className="composer-queue-icon-btn"
            title="Cancel editing"
            aria-label="Cancel editing"
            onClick={() => {
              setDraft(message.content);
              setEditing(false);
            }}
          >
            <X size={13} strokeWidth={2.2} />
          </button>
        </>
      ) : (
        <>
          <button
            type="button"
            className={`composer-queue-text${expanded ? " expanded" : ""}`}
            title={expanded ? "Click to collapse" : "Click to expand"}
            onClick={() => setExpanded((v) => !v)}
          >
            {label}
          </button>
          <button
            type="button"
            className="composer-queue-steer"
            title="Send this message now — interrupts the current turn"
            aria-label={`Steer queued message ${index + 1} of ${count} — send now`}
            onClick={onSteer}
          >
            <ArrowUpToLine size={12} strokeWidth={2.2} aria-hidden="true" />
            Steer
          </button>
          <button
            type="button"
            className="composer-queue-icon-btn"
            title="Edit this message"
            aria-label="Edit queued message"
            onClick={() => {
              setDraft(message.content);
              setEditing(true);
            }}
          >
            <Pencil size={13} strokeWidth={2} />
          </button>
          <button
            type="button"
            className="composer-queue-icon-btn"
            title="Delete this message"
            aria-label="Delete queued message"
            onClick={onDelete}
          >
            <Trash2 size={13} strokeWidth={2} />
          </button>
        </>
      )}
    </div>
  );
}

/** Notch chip beside the agent selector showing the directory the chat is
 *  working in: the custom folder chosen via the "+" picker when set, else the
 *  chat's isolated worktree (roadmap P0 §3.1.1), else the selected project's
 *  folder. The × (visible on hover) fully unbinds the chat from that project —
 *  drop the per-chat binding, any custom-folder override, and the global
 *  selection when it's the same project. Hidden when neither resolves (no
 *  project selected). When the chat works in an isolated worktree a ⛓ chip
 *  sits beside the folder name — clicking it joins the main working tree. */
export function FolderNotch() {
  // Shared chrome follows the FOCUSED chat (split-view aware), not the plain
  // active session — see selectContextSessionId.
  const activeChatSessionId = useChatStore(selectContextSessionId);
  const override = useChatStore((s) =>
    activeChatSessionId ? s.cwdOverrides[activeChatSessionId] : undefined,
  );
  const worktreePath = useChatStore((s) =>
    activeChatSessionId
      ? s.sessions.find((x) => x.id === activeChatSessionId)?.worktreePath
      : undefined,
  );
  // The chat's own project binding wins over the global selection, so
  // switching chats shows each chat's project — not whichever project was
  // clicked last.
  const boundProjectId = useChatStore((s) =>
    activeChatSessionId ? s.sessionProjects[activeChatSessionId] : undefined,
  );
  const project = useProjectsStore((s) =>
    s.projectById(boundProjectId ?? s.selectedProjectId),
  );
  const path = override ?? worktreePath ?? project?.path ?? null;
  // Only show the folder chip when the chat has an explicit binding — either
  // a per-session project, a custom CWD override, or a worktree. A globally
  // selected project without a per-chat binding is not enough.
  const hasExplicitBinding = !!(boundProjectId || override || worktreePath);
  if (!path || !activeChatSessionId || !hasExplicitBinding) return null;
  return (
    <div className="composer-notch-folder" title={path}>
      <FolderIcon />
      <span className="composer-notch-folder-name">{pathBasename(path)}</span>
      {worktreePath && (
        <button
          type="button"
          className="composer-notch-worktree"
          title={`Isolated worktree (branch on ${pathBasename(worktreePath)}). Click to join the main working tree.`}
          aria-label="Join main working tree"
          onClick={(e) => {
            e.stopPropagation();
            void useChatStore.getState().toggleSessionWorktree(activeChatSessionId);
          }}
        >
          ⛓
        </button>
      )}
    </div>
  );
}

/** GitHub / branch pill — sits beside the project pill. Shows a git-branch
 *  icon + the current branch name. Clicking it opens a small dropdown popover
 *  (right there at the composer) with the branch list, search, create, and git
 *  log — NOT the tool panel. Hidden when the project isn't a git repo. */
export function GitHubNotch() {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  // Same focused-chat rule as FolderNotch: split-view aware.
  const activeChatSessionId = useChatStore(selectContextSessionId);
  const boundProjectId = useChatStore((s) =>
    activeChatSessionId ? s.sessionProjects[activeChatSessionId] : undefined,
  );
  const override = useChatStore((s) =>
    activeChatSessionId ? s.cwdOverrides[activeChatSessionId] : undefined,
  );
  const worktreePath = useChatStore((s) =>
    activeChatSessionId
      ? s.sessions.find((x) => x.id === activeChatSessionId)?.worktreePath
      : undefined,
  );
  const selectedProjectId = useProjectsStore((s) => s.selectedProjectId);
  // Only show the git chip when the chat has an explicit binding (same logic
  // as FolderNotch) — not just a globally selected project.
  const hasExplicitBinding = !!(boundProjectId || override || worktreePath);
  const projectId = hasExplicitBinding ? (boundProjectId ?? selectedProjectId) : null;
  const gitStatus = useProjectsStore((s) =>
    projectId ? s.gitStatuses[projectId] : undefined,
  );

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const t = e.target as Node;
      // The popover portals to <body> (out of the toolbar's backdrop root so
      // its glass frost can see the page) — so both the trigger wrap AND the
      // portaled popover count as "inside".
      if (
        wrapRef.current &&
        !wrapRef.current.contains(t) &&
        !popRef.current?.contains(t)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  if (!gitStatus?.isRepo || !gitStatus.branch || !activeChatSessionId) return null;
  return (
    <div className="composer-notch-github-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`composer-notch-github${open ? " open" : ""}`}
        title={`Branch: ${gitStatus.branch}`}
        onClick={() => setOpen((o) => !o)}
      >
        <svg
          width={13}
          height={13}
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="4" cy="3" r="1.5" />
          <circle cx="4" cy="13" r="1.5" />
          <circle cx="12" cy="3" r="1.5" />
          <path d="M4 4.5v7" />
          <path d="M12 4.5c0 4-4 2-4 4.5" />
        </svg>
        <span className="composer-notch-github-name">{gitStatus.branch}</span>
      </button>
      {open &&
        createPortal(
        <div
          ref={popRef}
          className="composer-notch-github-popover"
          style={{
            position: "fixed",
            // LEFT-anchored to the chip (clamped inside the window): the
            // popover is 340px wide and right-anchoring made it hang over
            // the sidebar. Opens below the pill like a native dropdown.
            top: (wrapRef.current?.getBoundingClientRect().bottom ?? 0) + 6,
            left: Math.min(
              wrapRef.current?.getBoundingClientRect().left ?? 8,
              window.innerWidth - 356,
            ),
            right: "auto",
            bottom: "auto",
            zIndex: 9999,
          }}
        >
          <button
            type="button"
            className="composer-notch-pulls-entry"
            onClick={() => {
              setOpen(false);
              useUiStore.getState().addTab("pulls");
              useUiStore.getState().setToolPanelCollapsed(false);
            }}
            title="Open the Pull Requests tab in the side panel"
          >
            <GitPullRequestIcon />
            <span>Pull Requests</span>
          </button>
          <BranchDropdown onClose={() => setOpen(false)} />
        </div>,
        document.body,
      )}
    </div>
  );
}

/** Small git-pull-request icon for the "Pull Requests" popover row. */
function GitPullRequestIcon() {
  return (
    <svg
      width={13}
      height={13}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="18" cy="18" r="2.5" />
      <path d="M6 8.5v7a4 4 0 0 0 4 4h5.5" />
      <path d="M18 8.5v7" />
      <circle cx="18" cy="6" r="2.5" />
    </svg>
  );
}

/** Brain / lightbulb icon for the extended-thinking toggle. Filled when
 *  thinking is on (state is locked-in to a "think harder" request), outlined
 *  when off. The switch between filled/outlined is handled via `fill`
 *  rather than a separate SVG. */
function ThinkingIcon({ on }: { on: boolean }) {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill={on ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9.5 2a3.5 3.5 0 0 0-3.4 4.2 3 3 0 0 0-1.6 4.6 3 3 0 0 0 1 4.3 3 3 0 0 0 3 3.4h.2a1 1 0 0 0 1-.8l.3-1.7h2l.3 1.7a1 1 0 0 0 1 .8h.2a3 3 0 0 0 3-3.4 3 3 0 0 0 1-4.3 3 3 0 0 0-1.6-4.6A3.5 3.5 0 0 0 14.5 2 3.4 3.4 0 0 0 12 3.1 3.4 3.4 0 0 0 9.5 2Z" />
      <path d="M12 3.1V18" />
      <path d="M10 18h4" />
    </svg>
  );
}

/** Tri-state thinking toggle button:
 *  - default (`null`) — provider decides. Outlined icon, neutral label.
 *  - on (`true`) — explicit "think more". Filled icon, accent color.
 *  - off (`false`) — explicit "no thinking". Faded icon, struck-through.
 *
 *  Clicking cycles null → true → false → null. Each press applies to the
 *  NEXT message only — the store resets to null on session change. */
function ThinkingToggle({
  value,
  onChange,
}: {
  value: boolean | null;
  onChange: (next: boolean | null) => void;
}) {
  const on = value === true;
  const off = value === false;
  const next: boolean | null = value === null ? true : value === true ? false : null;
  const title = value === null
    ? "Extended thinking: provider default. Click to force ON."
    : value === true
      ? "Extended thinking: ON. Click to force OFF."
      : "Extended thinking: OFF. Click to clear override.";
  return (
    <button
      type="button"
      className={`composer-thinking-btn${on ? " on" : ""}${off ? " off" : ""}`}
      title={title}
      aria-label={title}
      aria-pressed={on}
      onClick={() => onChange(next)}
    >
      <ThinkingIcon on={on} />
    </button>
  );
}

/** Compact attachment card shown in the composer before sending — a file
 *  icon, the (truncated) name, a type badge, and a remove button. */
function AttachmentCard({
  attachment,
  onRemove,
}: {
  attachment: ChatAttachment;
  onRemove: () => void;
}) {
  const badge = attachmentBadge(attachment);
  const isImage = attachment.kind === "image";
  const thumb =
    isImage && attachment.data && attachment.mediaType
      ? `data:${attachment.mediaType};base64,${attachment.data}`
      : null;
  return (
    <div className="composer-attachment-card" title={attachment.name}>
      <div className="composer-attachment-thumb">
        {thumb ? (
          <img src={thumb} alt={attachment.name} />
        ) : (
          <AttachmentIcon />
        )}
      </div>
      <div className="composer-attachment-meta">
        <span className="composer-attachment-name">{attachment.name}</span>
        <span className="composer-attachment-badge">{badge}</span>
      </div>
      <button
        type="button"
        className="composer-attachment-remove"
        title="Remove attachment"
        aria-label="Remove attachment"
        onClick={onRemove}
      >
        ×
      </button>
    </div>
  );
}

/** Read a File's bytes as base64 (without the `data:...;base64,` prefix). */
function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const res = typeof reader.result === "string" ? reader.result : "";
      resolve(res.slice(res.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

interface Props {
  /** The chat session this composer writes to. Defaults to the global active
   *  session; the split pane passes its pinned session so slash-command
   *  artifacts (and any other store-bound path) land in the right chat. */
  sessionId?: string | null;
  onSend: (content: string, attachments: ChatAttachment[], forceResearch?: boolean) => void;
  onStop?: () => void;
  streaming: boolean;
  disabled?: boolean;
  /** Prefill the textarea (e.g. editing a prior message). Bumping `nonce`
   *  re-applies `text` even if the text is unchanged. */
  draft?: { text: string; nonce: number };
  /** Combined agent+model selector state — the chip is hidden when model is
   *  undefined (no active session). */
  model?: string;
  /** Optional id → display-label overrides for the active harness's model
   *  catalog (CLI-agent labels). Passed through to AgentModelPicker. */
  modelLabels?: Record<string, string>;
  /** Per-session agent selection ("builtin" | "local" | "harness:<id>" |
   *  "acp:<id>"). undefined = no active session (chip hidden); null = session
   *  active but no agent picked yet — Send stays disabled until the user
   *  chooses one from the picker. */
  agent?: string | null;
  /** Commit a selection from the combined agent/model picker (agent +
   *  provider + model together). */
  onAgentModelPick: (sel: AgentModelSelection) => void;
  /** Spinner on the chip while a harness's config/models load. */
  agentLoading?: boolean;
  /** Per-session permission posture. The selector renders only when BOTH
   *  this and onPermissionModeChange are set AND permissionModeSupported —
   *  Kimi/OpenCode headless runs have no approval channel (they always run
   *  full-auto), so ChatView hides the menu for those harnesses. */
  permissionMode?: PermissionMode;
  /** String-typed: harness sessions pick from their own catalog (values like
   *  "acceptEdits"/"build" aren't built-in PermissionModes). */
  onPermissionModeChange?: (mode: string) => void;
  permissionModeSupported?: boolean;
  /** Whether the mode menu offers the "Plan" posture — true for builtin/local
   *  sessions with tools enabled (the plan gate lives in the built-in loop). */
  planAvailable?: boolean;
  /** HARNESS catalog override: when set (CLI-harness session), the mode menu
   *  lists the harness's own postures instead of the built-in ones. */
  modes?: import("./PermissionModeMenu").ModeOption[];
  effort?: string;
  provider?: string;
  /** Local-model context size in tokens (0 = Auto) — feeds the context meter. */
  localCtx?: number;
  /** True while a local model is loading onto the GPU (see ChatView). */
  modelLoading?: boolean;
  onEffortChange?: (effort: string) => void;
  /** Eject the running local-model sidecar and free its VRAM. Wired by
   *  ChatView only when the local_gguf provider has a live sidecar. */
  onEjectLocalModel?: () => void;
  /** True when a local-model sidecar is currently running — the picker's
   *  Local pane shows an ⏏ row when this is set. Defaults to false. */
  localModelActive?: boolean;
  /** Per-model persisted llama-server overrides, keyed by the picker's local
   *  row id (name/filename) — seeds the gear panel drafts. */
  localOverridesMap?: Record<string, LlamaOverrides>;
  /** "Load model" from the picker's per-model gear panel: persist the
   *  drafted tweaks, spawn the sidecar with them, and point the session at
   *  that model. */
  onLoadLocalModel?: (model: string, overrides: LlamaOverrides) => void;
  /** Per-session extended-thinking toggle. `null` (default) lets the provider
   *  decide; `true` / `false` forces it. Hidden entirely when the active
   *  provider is one that doesn't expose thinking (e.g. plain OpenAI). */
  thinking?: boolean | null;
  onThinkingChange?: (thinking: boolean | null) => void;
  /** When true, the active provider supports extended thinking and the
   *  "brain" button is shown. */
  thinkingSupported?: boolean;
  /** Input tokens of the last assistant turn (the full prompt size the
   *  provider counted). Drives the context meter; null/0 hides it. */
  usedTokens?: number | null;
  /** Live context-window cap from the running llama-server (`-c`). When >0
   * and the session is local, the meter uses this instead of the slider
   * value, so it always matches what the model actually has. */
  liveMaxTokens?: number;
  /** Active chat session — the @-attach menu writes attachment rows
   * (connector ids / `mcp:<id>`) against it. Null when no session. */
  chatSessionId?: string | null;
}

export function ChatComposer({
  sessionId: sessionIdProp,
  onSend,
  onStop,
  streaming,
  disabled,
  draft,
  model,
  modelLabels,
  agent,
  onAgentModelPick,
  agentLoading,
  permissionMode,
  onPermissionModeChange,
  permissionModeSupported = true,
  planAvailable = false,
  modes: harnessModes,
  effort,
  provider,
  localCtx,
  modelLoading,
  onEffortChange,
  onEjectLocalModel,
  localModelActive,
  localOverridesMap,
  onLoadLocalModel,
  usedTokens,
  liveMaxTokens,
  thinking,
  onThinkingChange,
  thinkingSupported,
  chatSessionId,
}: Props) {
  const [content, setContent] = useState("");
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  // Whether the next send should force research mode (set via the "+"
  // menu's "Research" option). Stays on only for the next send, then resets.
  const [forceResearch, setForceResearch] = useState(false);
  // Popover for the "+" attach/attach-research menu.
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const attachMenuRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Messages stacked while a turn is running (FIFO — the store enqueues on
  // send-during-stream and drains when the turn finishes). Rendered as a
  // notch stack above the composer card: one row per message with grip
  // (drag to reorder), expandable text, Steer (send now), Edit and Delete.
  const activeChatSessionId = useChatStore((s) => s.activeChatSessionId);
  // Split view renders one composer per pane (audit B-21): the queue UI, the
  // working-folder picker and the queue actions below must address THIS
  // pane's session, not the globally active one. The prop wins — same
  // precedence the send path uses.
  const effectiveSessionId = sessionIdProp ?? activeChatSessionId;
  // Team broadcast (roadmap #18): the session list + the broadcast action.
  const broadcastSessions = useChatStore((s) => s.sessions);
  const broadcastToSessions = useChatStore((s) => s.broadcastToSessions);
  const queuedMessages = useChatStore((s) =>
    effectiveSessionId
      ? (s.messageQueue[effectiveSessionId] ?? NO_QUEUED_MESSAGES)
      : NO_QUEUED_MESSAGES,
  );
  const removeQueuedMessage = useChatStore((s) => s.removeQueuedMessage);
  const steerQueuedMessage = useChatStore((s) => s.steerQueuedMessage);
  const editQueuedMessage = useChatStore((s) => s.editQueuedMessage);
  const moveQueuedMessage = useChatStore((s) => s.moveQueuedMessage);
  const setCwdOverride = useChatStore((s) => s.setCwdOverride);

  // Open the native (OS) folder dialog so any drive/folder can be picked as
  // the chat session's custom working folder (shown in the FolderNotch).
  const pickWorkingFolder = useCallback(async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({
      directory: true,
      multiple: false,
      title: "Choose working folder",
    });
    if (typeof picked === "string" && effectiveSessionId) {
      setCwdOverride(effectiveSessionId, picked);
    }
    textareaRef.current?.focus();
  }, [effectiveSessionId, setCwdOverride]);

  // Slash-command skill popup: typing "/" as the first character opens a list
  // of every available skill (on-disk harness skills + the built-in
  // doc/pptx/pdf/diagram skills); picking one inserts its `/slug` token,
  // which the backend uses to inject that skill's instructions for this turn
  // only. Skills are managed in the Skills Library, not Settings → Assistant.
  interface SlashSkill {
    name: string;
    slug: string;
  }
  // Unified slash-menu item: skills, prompt templates, or special commands
  // like /create. Each kind handles selection differently.
  type SlashItem =
    | { kind: "skill"; name: string; slug: string; description?: string }
    | { kind: "template"; name: string; trigger: string; description?: string }
    | { kind: "command"; name: string; slug: string; description: string };
  const [slashSkills, setSlashSkills] = useState<SlashSkill[]>([]);
  const [slashIndex, setSlashIndex] = useState(0);
  // The picked slash command rendered as an inline pill (icon + label) in the
  // composer; serialized back to the `/slug` prefix on send so the backend's
  // token parsing (invoked skills, /create) sees exactly what it did before.
  const [commandPill, setCommandPill] = useState<{ slug: string; label: string } | null>(null);
  // Prompt templates (roadmap #14): loaded alongside skills for the slash menu.
  const [promptTemplates, setPromptTemplates] = useState<PromptTemplate[]>([]);
  // Variable-fill state: when a template with variables is selected, show a
  // small inline form to fill them before inserting.
  const [fillingTemplate, setFillingTemplate] = useState<PromptTemplate | null>(null);
  const [fillValues, setFillValues] = useState<Record<string, string>>({});
  // Standalone template picker popover (opens from the attach menu).
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  // Team broadcast (roadmap #18): pick N sessions + a prompt, send to all.
  const [broadcastOpen, setBroadcastOpen] = useState(false);
  const [broadcastTargets, setBroadcastTargets] = useState<Record<string, boolean>>({});
  const [broadcastText, setBroadcastText] = useState("");
  // Voice recording (roadmap #16).
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  // Live partial transcription (updated every PARTIAL_TICK_MS while the mic
  // is open) shown as ghost text under the composer, plus the raw capture
  // plumbing: Float32 sample chunks from a ScriptProcessor on a 16 kHz
  // AudioContext (no MediaRecorder — partials then never re-decode audio).
  const [partialText, setPartialText] = useState<string | null>(null);
  const samplesRef = useRef<Float32Array[]>([]);
  const tailRef = useRef<Float32Array[]>([]);
  const tailLenRef = useRef(0);
  const rateRef = useRef(16000);
  const levelRef = useRef(0);
  const generationRef = useRef(0);
  const partialTimerRef = useRef<number | null>(null);
  const waveBarsRef = useRef<(HTMLSpanElement | null)[]>([]);
  // Mirrors `recording` for hotkey/async paths where state may be stale, plus
  // a "released while the mic was still opening" latch (push-to-talk during
  // the first-run permission prompt).
  const recordingRef = useRef(false);
  const pendingStopRef = useRef(false);
  const captureCtxRef = useRef<AudioContext | null>(null);
  const captureNodesRef = useRef<{
    source: MediaStreamAudioSourceNode;
    processor: ScriptProcessorNode;
    sink: GainNode;
  } | null>(null);
  const captureStreamRef = useRef<MediaStream | null>(null);
  // Artifact creation (Phase 1): /create command + type selector
  const [createTypeOpen, setCreateTypeOpen] = useState(false);
  const [createInstruction, setCreateInstruction] = useState("");

  // The popup is active while the whole content is a partial first token
  // starting with "/" (no space typed yet).
  const slashQuery = /^\/(\S*)$/.exec(content)?.[1]?.toLowerCase() ?? null;
  const slashOpen = slashQuery !== null;

  // (Re)load skills every time the popup opens, so edits made in the Skills
  // Library are picked up immediately (the backend cache is invalidated on
  // every create/save/delete).
  useEffect(() => {
    if (!slashOpen) return;
    let stale = false;
    void listChatSkills().then((list) => {
      if (stale || !list) return;
      setSlashSkills(list.map((s) => ({ name: s.name, slug: s.slug })));
    });
    void listPromptTemplates().then((t) => {
      if (stale) return;
      setPromptTemplates(t);
    });
    return () => {
      stale = true;
    };
  }, [slashOpen]);

  // Static slash commands shown alongside skills/prompt templates. `/create`
  // is included so it appears when typing `/`, and subtype-prefixed entries
  // (`/create skill`, etc.) let the user pick the artifact type directly.
  const staticSlashCommands: SlashItem[] = [
    {
      kind: "command",
      name: "Create artifact",
      slug: "create",
      description: "Create a reusable skill / loop / prompt template / automation",
    },
    {
      kind: "command",
      name: "Create skill",
      slug: "create skill",
      description: "Generate a Reusable Skill artifact",
    },
    {
      kind: "command",
      name: "Create loop",
      slug: "create loop",
      description: "Generate a Goal Loop artifact",
    },
    {
      kind: "command",
      name: "Create prompt template",
      slug: "create prompt template",
      description: "Generate a Prompt Template artifact",
    },
    {
      kind: "command",
      name: "Create automation",
      slug: "create automation",
      description: "Generate a scheduled Automation artifact",
    },
  ];

  // Every entry in the slash menu, normalized to the unified shape:
  // skills, prompt templates (with an optional trigger), and static commands.
  const allSlashItems: SlashItem[] = [
    ...slashSkills.map((s) => ({ kind: "skill" as const, name: s.name, slug: s.slug })),
    ...promptTemplates
      .filter((t) => t.trigger && /\S/.test(t.trigger))
      .map((t) => ({
        kind: "template" as const,
        name: t.name,
        trigger: (t.trigger as string).replace(/^\/+/, ""),
        description: `Prompt template: ${t.body.slice(0, 60) || ""}`,
      })),
    ...staticSlashCommands,
  ];

  const slashFiltered = slashQuery !== null
    ? allSlashItems.filter((it) => {
        const key = ("slug" in it && it.slug) || ("trigger" in it && it.trigger) || "";
        const label = it.name.toLowerCase();
        return key.startsWith(slashQuery) || label.includes(slashQuery);
      })
    : [];

  // Reset the highlight whenever the query changes.
  useEffect(() => {
    setSlashIndex(0);
  }, [slashQuery]);

  // ── Attach-on-demand @-menu ─────────────────────────────────────────────
  // Typing "@" as the first character lists every attachable source —
  // connected connectors (OAuth-credentialed or public) and enabled
  // MCP-gallery servers. Picking one writes a `chat_session_connectors` row
  // for the active session (its tools then ship on every turn of this
  // conversation); the row key is the connector id, or `mcp:<server_id>` for
  // gallery servers. Attachments render as inline icon pills in the input
  // (next to the command pill); each pill's × detaches the source.
  interface AttachSource {
    /** Row key written to the DB: connector id or `mcp:<serverId>`. */
    rowId: string;
    /** Display id used for the @token / label. */
    id: string;
    name: string;
    icon: string;
    description: string;
    kind: "connector" | "mcp";
  }
  const [attachSources, setAttachSources] = useState<AttachSource[]>([]);
  const [attachedRows, setAttachedRows] = useState<string[]>([]);
  const [atIndex, setAtIndex] = useState(0);
  // First-line indent for the textarea = measured width of the pill row, so
  // the pills overlay the empty start of line 1 and the text wraps at FULL
  // column width from line 2 on (a plain textarea can't flow around an
  // inline element; text-indent applies to the first line only).
  const tokenRowRef = useRef<HTMLSpanElement>(null);
  const [tokenIndent, setTokenIndent] = useState(0);
  useLayoutEffect(() => {
    setTokenIndent(tokenRowRef.current?.offsetWidth ?? 0);
  }, [commandPill, attachedRows, attachSources]);

  const atQuery = /^@(\S*)$/.exec(content)?.[1]?.toLowerCase() ?? null;
  const atOpen = atQuery !== null && !!chatSessionId;

  const refreshAttached = useCallback(() => {
    if (!chatSessionId) {
      setAttachedRows([]);
      return;
    }
    void listSessionConnectors(chatSessionId).then((rows) => {
      setAttachedRows(rows ?? []);
    });
  }, [chatSessionId]);

  // Reload the attachment rows whenever the active session changes (and when
  // the model attaches a source mid-turn via attach_connector — cheap).
  useEffect(() => {
    refreshAttached();
  }, [refreshAttached]);

  // Load attachable sources: connected (or public) connectors + enabled
  // MCP-gallery servers. Kiwi is the one public connector — identified by its
  // endpoint (the registry doesn't serialize an isPublic flag).
  const loadAttachSources = useCallback(() => {
    void listConnectors().then((list) => {
      if (!list) return;
      const conns: AttachSource[] = list
        .filter((c) => c.status.connected || c.mcpServerUrl === "https://mcp.kiwi.com")
        .map((c) => ({
          rowId: c.id,
          id: c.id,
          name: c.displayName,
          icon: c.icon,
          description: c.status.connected ? "Connected" : "Public endpoint",
          kind: "connector" as const,
        }));
      void mcpGalleryList().then((g) => {
        if (!g) return;
        const mcps: AttachSource[] = g.installed
          .filter((d) => d.enabled)
          .map((d) => ({
            rowId: `mcp:${d.id}`,
            id: d.id,
            name: d.name,
            icon: "🧩",
            description: d.description?.slice(0, 80) || "MCP server",
            kind: "mcp" as const,
          }));
        setAttachSources([...conns, ...mcps]);
      });
    });
  }, []);

  // (Re)load attachable sources every time the popup opens, and once per
  // session switch so the chips can label rows without the menu ever opening.
  useEffect(() => {
    loadAttachSources();
  }, [loadAttachSources, chatSessionId]);
  useEffect(() => {
    if (atOpen) loadAttachSources();
  }, [atOpen, loadAttachSources]);

  const atFiltered = atQuery !== null
    ? attachSources.filter((s) => {
        const attached = attachedRows.includes(s.rowId);
        const matches =
          s.id.startsWith(atQuery) ||
          s.name.toLowerCase().includes(atQuery) ||
          (atQuery.length > 1 && s.description.toLowerCase().includes(atQuery));
        return matches && !attached;
      })
    : [];

  useEffect(() => {
    setAtIndex(0);
  }, [atQuery]);

  const applyAttachSource = useCallback(
    (source: AttachSource) => {
      if (!chatSessionId) return;
      // Drop the partial "@query" token from the input.
      setContent("");
      const ta = textareaRef.current;
      ta?.focus();
      void addSessionConnector(chatSessionId, source.rowId)
        .then(() => refreshAttached())
        .catch((e) => toastError(`Could not attach ${source.name}.`, e));
    },
    [chatSessionId, refreshAttached],
  );

  const detachSource = useCallback(
    (rowId: string) => {
      if (!chatSessionId) return;
      void removeSessionConnector(chatSessionId, rowId)
        .then(() => refreshAttached())
        .catch((e) => toastError("Could not detach.", e));
    },
    [chatSessionId, refreshAttached],
  );

  // Human label for an attachment row key ("gmail" → "Gmail",
  // "mcp:filesystem" → "filesystem (MCP)").
  const attachLabel = useCallback(
    (rowId: string): string => {
      const src = attachSources.find((s) => s.rowId === rowId);
      if (src) return src.name;
      const mcp = rowId.startsWith("mcp:");
      return mcp ? `${rowId.slice(4)} (MCP)` : rowId;
    },
    [attachSources],
  );

  // Insert a filled prompt template into the composer (roadmap #14).
  const insertTemplateText = useCallback((text: string) => {
    if (!text) return;
    setContent((prev) => {
      const sep = prev && !prev.endsWith("\n") ? "\n" : "";
      return prev ? `${prev}${sep}${text}` : text;
    });
    const ta = textareaRef.current;
    if (ta) {
      ta.focus();
      requestAnimationFrame(() => ta.setSelectionRange(-1, -1));
    }
  }, []);

  // Handle a selected slash-menu item. Prompt templates insert their body
  // (or open variable fill); skills and /create commands become an inline
  // command PILL in the composer (serialized back to the `/slug` token on
  // send) instead of plain text.
  const applySlashItem = useCallback((item: SlashItem) => {
    if (item.kind === "command") {
      if (item.slug === "create") {
        setContent("");
        setCreateInstruction("");
        setCreateTypeOpen(true);
      } else {
        setCommandPill({ slug: item.slug, label: item.name });
        setContent("");
        const ta = textareaRef.current;
        ta?.focus();
      }
      return;
    }
    if (item.kind === "template") {
      const template = promptTemplates.find(
        (t) => (t.trigger ?? "").replace(/^\/+/, "") === item.trigger,
      );
      if (!template) return;
      const variables = templateVariables(template.body);
      if (variables.length > 0) {
        setFillingTemplate(template);
        setFillValues({});
      } else {
        insertTemplateText(template.body);
      }
      return;
    }
    setCommandPill({ slug: item.slug, label: item.name });
    setContent("");
    const ta = textareaRef.current;
    ta?.focus();
  }, [insertTemplateText, promptTemplates]);

  // Voice recording (roadmap #16): capture raw mic samples on a 16 kHz
  // AudioContext, transcribe a sliding tail every PARTIAL_TICK_MS for live
  // ghost text, and run one full-buffer pass on stop for the final insert.
  // Same STT server either way — the sidecar lazy-starts itself.
  const stopCapture = useCallback(() => {
    recordingRef.current = false;
    pendingStopRef.current = false;
    if (partialTimerRef.current !== null) {
      window.clearInterval(partialTimerRef.current);
      partialTimerRef.current = null;
    }
    const nodes = captureNodesRef.current;
    captureNodesRef.current = null;
    if (nodes) {
      try {
        nodes.source.disconnect();
        nodes.processor.disconnect();
        nodes.sink.disconnect();
      } catch {
        // graph already torn down
      }
    }
    void captureCtxRef.current?.close().catch(() => {});
    captureCtxRef.current = null;
    captureStreamRef.current?.getTracks().forEach((t) => t.stop());
    captureStreamRef.current = null;
  }, []);

  // Unmount mid-recording (chat switch, window close) must not leak the mic.
  useEffect(() => stopCapture, [stopCapture]);

  // Wave animation: bars breathe with the live input level (levelRef is fed
  // by onaudioprocess). rAF writes heights straight to the DOM — React state
  // at 60fps would re-render the whole composer.
  useEffect(() => {
    if (!recording) return;
    let raf = 0;
    let phase = 0;
    const tick = () => {
      phase += 0.35;
      const lvl = Math.min(1, levelRef.current * 6);
      for (let i = 0; i < waveBarsRef.current.length; i++) {
        const el = waveBarsRef.current[i];
        if (!el) continue;
        const wobble = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(phase * 2 + i * 0.55));
        const h = lvl > 0.01 ? 3 + Math.min(21, lvl * 26 * wobble + 2) : 3;
        el.style.height = `${h.toFixed(1)}px`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [recording]);

  const finishVoiceRecording = useCallback(async () => {
    if (!recordingRef.current) return;
    generationRef.current += 1; // invalidate in-flight partials
    stopCapture();
    setRecording(false);
    // Keep the last partial on screen while the full clip transcribes —
    // clearing here made the text visibly vanish and pop back later.
    const chunks = samplesRef.current;
    samplesRef.current = [];
    tailRef.current = [];
    tailLenRef.current = 0;
    if (chunks.length === 0) return;
    setTranscribing(true);
    try {
      const wav = encodeWav16k(joinSamples(chunks, rateRef.current));
      const res = await transcribeAudio(await blobToBase64(wav), "audio/wav");
      const text = res?.text ? flattenVoiceText(res.text) : "";
      if (text) {
        insertTemplateText(text);
      } else {
        toastError("Transcription returned no text. Is a Whisper server running? See Settings → Local Models → Speech.");
      }
    } catch (e) {
      toastError(
        "No speech-to-text server running. Install and start one in Settings → Local Models → Speech, or point whisper.baseUrl at an OpenAI-compatible STT endpoint.",
        e,
      );
    } finally {
      setTranscribing(false);
      setPartialText(null);
    }
  }, [insertTemplateText, stopCapture]);

  const beginVoiceRecording = useCallback(async () => {
    if (recordingRef.current || transcribing) return;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      // getUserMedia fails when: the host (WebView2) hasn't granted mic
      // permission, the device has no mic, or the user denied the prompt.
      // Surface the reason instead of dying silently — this is the #1 cause
      // of "mic doesn't work" reports.
      const name = (e as Error)?.name ?? "Error";
      if (name === "NotAllowedError" || name === "SecurityError") {
        // WebView2 denies mic permission requests silently (wry handles only
        // clipboard); the additionalBrowserArgs media switch in
        // tauri.conf.json is what makes the grant happen. If users still hit
        // this, it's an old build or Windows privacy settings.
        toastError("Microphone access was blocked. Restart the app — if it persists, check Windows → Privacy → Microphone.");
      } else if (name === "NotFoundError" || name === "DevicesNotFoundError") {
        toastError("No microphone found on this device.");
      } else {
        toastError("Could not start microphone.", e);
      }
      return;
    }
    try {
      const ac = new AudioContext({ sampleRate: 16000 });
      rateRef.current = ac.sampleRate;
      const source = ac.createMediaStreamSource(stream);
      const processor = ac.createScriptProcessor(4096, 1, 1);
      const sink = ac.createGain();
      sink.gain.value = 0; // silent sink keeps the graph pulled without echo
      processor.onaudioprocess = (e) => {
        const data = new Float32Array(e.inputBuffer.getChannelData(0));
        samplesRef.current.push(data);
        tailRef.current.push(data);
        tailLenRef.current += data.length;
        // Trim the rolling partial window (2s slack over the tail length).
        const maxTail = (PARTIAL_TAIL_SECONDS + 2) * rateRef.current;
        while (tailLenRef.current > maxTail && tailRef.current.length > 1) {
          const dropped = tailRef.current.shift();
          tailLenRef.current -= dropped?.length ?? 0;
        }
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
        levelRef.current = levelRef.current * 0.7 + Math.sqrt(sum / data.length) * 0.3;
      };
      source.connect(processor);
      processor.connect(sink);
      sink.connect(ac.destination);
      captureCtxRef.current = ac;
      captureNodesRef.current = { source, processor, sink };
      captureStreamRef.current = stream;

      samplesRef.current = [];
      tailRef.current = [];
      tailLenRef.current = 0;
      levelRef.current = 0;
      setPartialText(null);
      recordingRef.current = true;
      setRecording(true);

      // Live partials: transcribe the recent tail on a fixed tick. Each tick
      // tags its request with the recording generation — a response landing
      // after stop (or a quick restart) is dropped instead of flashing stale
      // ghost text.
      partialTimerRef.current = window.setInterval(() => {
        const gen = generationRef.current;
        void (async () => {
          try {
            const joined = joinSamples(tailRef.current, rateRef.current);
            let peak = 0;
            for (let i = 0; i < joined.length; i++) {
              const a = Math.abs(joined[i]);
              if (a > peak) peak = a;
            }
            // Silence gate: don't hit the server for an empty tail, and drop
            // ghost text so it tracks what's actually audible.
            if (peak < 0.008) {
              if (generationRef.current === gen) setPartialText(null);
              return;
            }
            const wav = encodeWav16k(joined);
            const res = await transcribeAudio(await blobToBase64(wav), "audio/wav");
            if (generationRef.current !== gen || !res?.text) return;
            setPartialText(flattenVoiceText(res.text));
          } catch {
            // Partials are best-effort — the final pass surfaces real errors.
          }
        })();
      }, PARTIAL_TICK_MS);

      // Released while the mic was still opening (first-run permission
      // prompt): stop immediately so a quick tap can't leave a stuck
      // recording running with no key held.
      if (pendingStopRef.current) {
        pendingStopRef.current = false;
        void finishVoiceRecording();
      }
    } catch (e) {
      stream.getTracks().forEach((t) => t.stop());
      toastError("Could not initialize audio recorder.", e);
    }
  }, [transcribing, finishVoiceRecording]);

  // Discard the current clip without transcribing — push-to-talk aborted
  // because a real shortcut (Alt+Tab, Alt+arrows, …) joined the hold.
  const cancelVoiceRecording = useCallback(() => {
    if (!recordingRef.current) return;
    generationRef.current += 1;
    stopCapture();
    setRecording(false);
    setPartialText(null);
    samplesRef.current = [];
    tailRef.current = [];
    tailLenRef.current = 0;
  }, [stopCapture]);

  const toggleRecording = useCallback(() => {
    if (recordingRef.current) void finishVoiceRecording();
    else void beginVoiceRecording();
  }, [beginVoiceRecording, finishVoiceRecording]);

  // Push-to-talk: HOLD the Alt key to dictate, release to transcribe+insert.
  // Solo Alt only — any other key joining the hold (Alt+Tab, Alt+arrows, …)
  // cancels the dictation so keyboard shortcuts keep working untouched.
  // The mic button still toggles for click users.
  const altTalkRef = useRef(false);
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Alt") {
        // Ignore AltGr (reports as Ctrl+Alt on intl layouts) and shortcuts
        // already in flight — only a solo Alt press starts dictation.
        if (e.ctrlKey || e.metaKey || e.repeat) return;
        if (recordingRef.current || transcribing) return;
        altTalkRef.current = true;
        void beginVoiceRecording();
        return;
      }
      if (altTalkRef.current && e.altKey) {
        // A shortcut joined the hold — abort without transcribing.
        altTalkRef.current = false;
        cancelVoiceRecording();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key !== "Alt" || !altTalkRef.current) return;
      altTalkRef.current = false;
      if (recordingRef.current) {
        void finishVoiceRecording();
      } else {
        // Mic still opening (first-run permission prompt) — stop the moment
        // it does, so a quick tap doesn't leave a stuck recording.
        pendingStopRef.current = true;
      }
    };
    const onBlur = () => {
      if (altTalkRef.current && recordingRef.current) {
        altTalkRef.current = false;
        cancelVoiceRecording();
      }
      altTalkRef.current = false;
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [transcribing, beginVoiceRecording, finishVoiceRecording, cancelVoiceRecording]);

  // Close the "+" popover on outside click.
  useEffect(() => {
    if (!attachMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (attachMenuRef.current && !attachMenuRef.current.contains(e.target as Node)) {
        setAttachMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [attachMenuOpen]);

  // Prefill from an external draft (per-message Edit action). Focuses and
  // moves the caret to the end so the user can immediately tweak and resend.
  useEffect(() => {
    if (!draft || draft.nonce === 0) return;
    setContent(draft.text);
    const ta = textareaRef.current;
    if (ta) {
      ta.focus();
      const end = draft.text.length;
      requestAnimationFrame(() => ta.setSelectionRange(end, end));
    }
  }, [draft?.nonce]);

  // Auto-grow the textarea as the user types.
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, [content]);

  // Re-focus the composer when the right tool panel's tab/collapse state
  // settles — the panel (e.g. a browser webview) can grab focus when it
  // opens or switches, and nothing otherwise gives it back. Only take focus
  // when it was lost to nowhere (activeElement is body); never yank it out
  // of another input the user is actively typing in.
  const toolPanelTab = useUiStore((s) => s.toolPanelTab);
  const toolPanelCollapsed = useUiStore((s) => s.toolPanelCollapsed);
  useEffect(() => {
    if (document.activeElement === document.body) {
      textareaRef.current?.focus();
    }
  }, [toolPanelTab, toolPanelCollapsed]);

  const handleFiles = useCallback(async (files: FileList | null) => {
    if (!files) return;
    setAttachError(null);
    for (const file of Array.from(files)) {
      const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
      const isImage =
        IMAGE_EXTS.includes(ext) ||
        (file.type.startsWith("image/") && file.type !== "image/svg+xml");
      const isDoc = DOC_EXTS.includes(ext);
      const limit = isImage ? MAX_IMAGE_BYTES : isDoc ? MAX_DOC_BYTES : MAX_TEXT_BYTES;
      if (file.size > limit) {
        setAttachError(`${file.name} is too large (max ${Math.round(limit / 1024 / 1024)} MB)`);
        continue;
      }
      try {
        let attachment: ChatAttachment;
        if (isImage) {
          attachment = {
            name: file.name,
            size: file.size,
            kind: "image",
            data: await readAsBase64(file),
            mediaType: file.type || `image/${ext === "jpg" ? "jpeg" : ext}`,
          };
        } else if (isDoc) {
          attachment = {
            name: file.name,
            size: file.size,
            kind: "doc",
            data: await readAsBase64(file),
            format: ext,
          };
        } else {
          attachment = { name: file.name, size: file.size, kind: "text", text: await file.text() };
        }
        setAttachments((prev) =>
          // Dedupe on name AND size: two different files can share a name
          // (`Screenshot.png` from two folders) — only an exact name+size
          // match is the same file re-selected.
          prev.some((a) => a.name === file.name && (a.size ?? -1) === file.size)
            ? prev
            : [...prev, attachment],
        );
      } catch {
        setAttachError(`Could not read ${file.name}`);
      }
    }
  }, []);

  // A model must be explicitly chosen before sending (no default model).
  // ACP agents pick their own model — an empty model must not block Send.
  const needsModel =
    model !== undefined && !model.trim() && !(agent ?? "").startsWith("acp:");
  // No agent picked for the session yet: Send stays disabled so a message
  // can never go to the wrong backend (mockup 02, state A). `agent ===
  // undefined` means no active session — chip hidden entirely.
  const agentLocked = agent === null;

  // --- Conversational Artifact Creation (Phase 1) ---
  // Cheap deterministic detection of natural-language "create artifact" intent.
  // Mirrors the backend `detect_obvious_intent` — no LLM call needed for
  // obvious phrases like "turn this into a skill".
  // Natural-language artifact detection lives at module level
  // (detectArtifactIntent) so it stays pure and unit-testable.

  // Persist the command-only message first, then generate the proposal. This
  // creates one real timeline user row without starting a normal chat turn.
  const triggerArtifactGeneration = useCallback(async (type: ArtifactType, instruction: string) => {
    // Explicit session wins — the split pane's composer must write to ITS
    // chat, not whichever session the global active pointer names.
    const sessionId = sessionIdProp ?? useChatStore.getState().activeChatSessionId;
    if (!sessionId) {
      toastError("No active chat session");
      return;
    }
    const tempId = `temp-${Date.now()}`;
    const commandText = `/create ${type === "prompt_template" ? "prompt template" : type} ${instruction}`.trim();
    let sourceMessageId: number | undefined;
    try {
      const message = await persistChatCommandMessage(sessionId, commandText);
      sourceMessageId = message?.id;
      if (message && useChatStore.getState().activeChatSessionId === sessionId) {
        useChatStore.setState((s) => ({
          messages: [...s.messages, message],
          messagesSessionId: sessionId,
        }));
      } else if (message && useChatStore.getState().splitChatSessionId === sessionId) {
        // The split pane's chat: merge into the SPLIT buffer instead — the
        // main list belongs to whichever session is globally active.
        useChatStore.setState((s) => ({
          splitMessages: [...s.splitMessages, message],
          splitMessagesSessionId: sessionId,
        }));
      }
    } catch (e) {
      // Keep the proposal usable even if command-message persistence fails.
      // The user still gets a visible card and an actionable error toast.
      toastError("Failed to save artifact command", e);
    }

    useChatStore.getState().addArtifactProposal(sessionId, {
      id: tempId,
      artifactType: type,
      spec: { type } as never,
      confidence: 0,
      missingFields: [],
      assumptions: [],
      originalInstruction: instruction,
      sourceMessageId,
    });
    try {
      const proposal = await generateArtifact({
        chatSessionId: sessionId,
        userMessage: instruction,
        artifactType: type,
      });
      useChatStore.getState().updateArtifactProposal(sessionId, tempId, {
        proposal: { ...proposal, originalInstruction: instruction, sourceMessageId },
        state: "ready",
      });
    } catch (e) {
      useChatStore.getState().removeArtifactProposal(sessionId, tempId);
      toastError("Failed to generate artifact", e);
    }
  }, []);

  const handleSend = useCallback(() => {
    if (needsModel || agentLocked) return;
    // The command pill contributes its `/slug` token to the message text so
    // every downstream parser (invoked skills, /create routing) sees the same
    // content it would have seen with a plain-text token.
    const trimmed = (commandPill ? `/${commandPill.slug} ${content}` : content).trim();
    if (!trimmed && attachments.length === 0) return;

    // --- /create slash command: deterministic route to artifact generation ---
    const createCmd = parseCreateCommand(trimmed);
    if (createCmd) {
      // If the instruction is empty, open the type selector
      if (!createCmd.instruction) {
        setCreateTypeOpen(true);
        setCreateInstruction("");
        return;
      }
      // /create commands trigger artifact generation but do NOT start a normal
      // chat turn. The artifact card renders inline below the composer (via
      // ChatView's artifact-proposals-container) without a user message bubble.
      // This prevents double-messages and keeps the flow clean: user types
      // /create, sees proposal card, then continues conversation normally.
      void triggerArtifactGeneration(createCmd.type, createCmd.instruction);
      setContent("");
      setCommandPill(null);
      setAttachments([]);
      setAttachError(null);
      setForceResearch(false);
      setAttachMenuOpen(false);
      const ta = textareaRef.current;
      if (ta) ta.style.height = "auto";
      return;
    }

    // --- Bare `/create` or `/create artifact` with no subtype: open selector ---
    if (isBareCreateCommand(trimmed)) {
      setCreateTypeOpen(true);
      setCreateInstruction("");
      return;
    }

    // --- Natural language cheap filter: detect obvious "create artifact" phrases ---
    const intent = detectArtifactIntent(trimmed);
    if (intent) {
      // Natural language "create a skill" etc. triggers artifact generation only.
      void triggerArtifactGeneration(intent.type, intent.instruction);
      setContent("");
      setCommandPill(null);
      setAttachments([]);
      setAttachError(null);
      setForceResearch(false);
      setAttachMenuOpen(false);
      const ta = textareaRef.current;
      if (ta) ta.style.height = "auto";
      return;
    }

    onSend(trimmed, attachments, forceResearch || undefined);
    setContent("");
    setCommandPill(null);
    setAttachments([]);
    setAttachError(null);
    setForceResearch(false);
    setAttachMenuOpen(false);
    // Reset textarea height.
    const ta = textareaRef.current;
    if (ta) {
      ta.style.height = "auto";
    }
  }, [content, commandPill, attachments, onSend, needsModel, agentLocked, forceResearch, detectArtifactIntent, triggerArtifactGeneration]);

  // Handle ArtifactTypeSelector selection
  const handleCreateTypeSelect = useCallback((type: ArtifactType, instruction?: string) => {
    setCreateTypeOpen(false);
    void triggerArtifactGeneration(type, instruction || createInstruction || "Generate a " + type);
    setCreateInstruction("");
  }, [createInstruction, triggerArtifactGeneration]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // While either popup is showing candidates, it owns navigation keys.
      if (slashOpen && slashFiltered.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSlashIndex((i) => (i + 1) % slashFiltered.length);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSlashIndex((i) => (i - 1 + slashFiltered.length) % slashFiltered.length);
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          const item = slashFiltered[Math.min(slashIndex, slashFiltered.length - 1)];
          applySlashItem(item);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setContent("");
          return;
        }
      }
      if (atOpen && atFiltered.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setAtIndex((i) => (i + 1) % atFiltered.length);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setAtIndex((i) => (i - 1 + atFiltered.length) % atFiltered.length);
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          applyAttachSource(atFiltered[Math.min(atIndex, atFiltered.length - 1)]);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setContent("");
          return;
        }
      }
      // Backspace on empty text removes the command pill (feels like editing
      // the token it stands for).
      if (e.key === "Backspace" && !content && commandPill) {
        e.preventDefault();
        setCommandPill(null);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        // Allowed while streaming too: the store stacks the message above
        // the composer (FIFO queue) and sends it when the turn finishes.
        if (!disabled && !needsModel && !agentLocked) {
          handleSend();
        }
      }
    },
    [disabled, needsModel, agentLocked, handleSend, slashOpen, slashFiltered, slashIndex, applySlashItem, atOpen, atFiltered, atIndex, applyAttachSource, content, commandPill],
  );

  const isEmpty = !content.trim() && attachments.length === 0;
  // The combined agent/model chip shows whenever there's an active session
  // (agent !== undefined), including the no-agent-picked state.
  const showAgentSelector = agent !== undefined && !!onAgentModelPick;
  // The footer row only exists when something visible lives in it (research
  // chip, attach error, needs-model hint) — otherwise it's an empty strip
  // between the textarea and the control bar.
  const showFooterRow = attachedRows.length > 0 || forceResearch || !!attachError || (!agentLocked && needsModel);
  // The permission-mode selector shows for sessions whose runtime honors it
  // (builtin/local + Claude Code harness).
  const showModeSelector =
    permissionModeSupported && permissionMode !== undefined && !!onPermissionModeChange;
  // A colored border/glow on the composer whenever a non-default posture is
  // active, so it's never ambiguous which mode governs tool calls.
  const modeGlowClass =
    showModeSelector && permissionMode && permissionMode !== "manual"
      ? ` composer-mode-${permissionMode}`
      : "";

  return (
    <div className="chat-composer">
      {/* Floating live-dictation pill — hovers just above the card, centered.
          Wave bars only, driven by the live mic level. */}
      {recording && (
        <div className="voice-pill" aria-hidden="true">
          <span className="voice-wave">
            {Array.from({ length: 21 }, (_, i) => (
              <span
                key={i}
                ref={(el) => {
                  waveBarsRef.current[i] = el;
                }}
                style={{ height: 3 }}
              />
            ))}
          </span>
        </div>
      )}
          {/* hidden file input + anchored pickers (moved out of the
               conditional footer so they stay mounted wherever it renders) */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              void handleFiles(e.target.files);
              e.target.value = "";
            }}
          />
          {templatePickerOpen && (
            <div className="composer-template-picker">
              <div className="composer-template-picker-head">
                <span>Insert prompt template</span>
                <button type="button" className="ghost" onClick={() => { setTemplatePickerOpen(false); setFillingTemplate(null); }}>
                  ✕
                </button>
              </div>
              {fillingTemplate ? (
                <div className="composer-template-fill">
                  <div className="composer-template-fill-title">{fillingTemplate.name}</div>
                  {templateVariables(fillingTemplate.body).map((v) => (
                    <input
                      key={v}
                      value={fillValues[v] ?? ""}
                      placeholder={`{{${v}}}`}
                      onChange={(e) => setFillValues((f) => ({ ...f, [v]: e.target.value }))}
                      autoFocus={v === templateVariables(fillingTemplate.body)[0]}
                    />
                  ))}
                  <div className="composer-template-fill-actions">
                    <button
                      type="button"
                      className="primary"
                      onClick={() => {
                        const filled = fillTemplate(fillingTemplate.body, fillValues);
                        insertTemplateText(filled);
                        setTemplatePickerOpen(false);
                        setFillingTemplate(null);
                        setFillValues({});
                      }}
                    >
                      Insert
                    </button>
                    <button type="button" className="ghost" onClick={() => setFillingTemplate(null)}>
                      Back
                    </button>
                  </div>
                </div>
              ) : promptTemplates.length === 0 ? (
                <div className="composer-template-empty">No templates yet — add one under Settings → Assistant → Prompt templates.</div>
              ) : (
                <div className="composer-template-list">
                  {promptTemplates.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      className="composer-template-item"
                      onClick={() => {
                        if (templateVariables(t.body).length > 0) {
                          setFillingTemplate(t);
                          setFillValues({});
                        } else {
                          insertTemplateText(t.body);
                          setTemplatePickerOpen(false);
                        }
                      }}
                    >
                      <span className="composer-template-item-name">{t.name}</span>
                      <span className="composer-template-item-vars">
                        {templateVariables(t.body).map((v) => `{{${v}}}`).join(" ")}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {broadcastOpen && (
            <div className="composer-template-picker">
              <div className="composer-template-picker-head">
                <span>Broadcast to chats</span>
                <button type="button" className="ghost" onClick={() => setBroadcastOpen(false)}>
                  ✕
                </button>
              </div>
              <div className="composer-broadcast-list">
                {broadcastSessions.map((s) => (
                  <label key={s.id} className="composer-broadcast-item">
                    <input
                      type="checkbox"
                      checked={!!broadcastTargets[s.id]}
                      onChange={(e) =>
                        setBroadcastTargets((t) => ({ ...t, [s.id]: e.target.checked }))
                      }
                    />
                    <span className="composer-broadcast-name">{s.title || "Untitled"}</span>
                  </label>
                ))}
              </div>
              <textarea
                className="composer-broadcast-text"
                rows={3}
                placeholder="Prompt to send to every selected chat…"
                value={broadcastText}
                onChange={(e) => setBroadcastText(e.target.value)}
              />
              <div className="composer-template-fill-actions">
                <button
                  type="button"
                  className="primary"
                  disabled={
                    !broadcastText.trim() ||
                    !Object.values(broadcastTargets).some(Boolean)
                  }
                  onClick={() => {
                    const ids = Object.entries(broadcastTargets)
                      .filter(([, v]) => v)
                      .map(([id]) => id);
                    void broadcastToSessions(ids, broadcastText.trim());
                    setBroadcastOpen(false);
                    setBroadcastText("");
                    setBroadcastTargets({});
                  }}
                >
                  Send to {Object.values(broadcastTargets).filter(Boolean).length || 0} chat(s)
                </button>
                <button type="button" className="ghost" onClick={() => setBroadcastOpen(false)}>
                  Cancel
                </button>
              </div>
            </div>
          )}
      {queuedMessages.length > 0 && effectiveSessionId && (
        <div className="composer-queue" aria-label="Queued messages">
          {queuedMessages.map((m, i) => (
            <QueuedMessageRow
              key={m.id}
              message={m}
              index={i}
              count={queuedMessages.length}
              onSteer={() => void steerQueuedMessage(effectiveSessionId, m.id)}
              onEdit={(text) => editQueuedMessage(effectiveSessionId, m.id, text)}
              onDelete={() => removeQueuedMessage(effectiveSessionId, m.id)}
              onReorder={(from, to) => moveQueuedMessage(effectiveSessionId, from, to)}
            />
          ))}
        </div>
      )}
      <div className={`chat-composer-card${modeGlowClass}`}>
        {attachments.length > 0 && (
          <div className="composer-attachments">
            {attachments.map((a) => (
              <AttachmentCard
                // name+size: two different files can share a name.
                key={`${a.name}:${a.size ?? 0}`}
                attachment={a}
                onRemove={() =>
                  setAttachments((prev) =>
                    prev.filter((p) => !(p.name === a.name && (p.size ?? -1) === (a.size ?? -1))),
                  )
                }
              />
            ))}
          </div>
        )}
        <div className="composer-slash-wrap">
          {(commandPill || attachedRows.length > 0) && (
            <span className="composer-token-row" ref={tokenRowRef}>
              {commandPill && (
                <span className="composer-token-pill composer-token-command">
                  <SquareSlash className="composer-token-icon" size={13} aria-hidden="true" />
                  <span className="composer-token-label">{commandPill.label || commandPill.slug}</span>
                  <button
                    type="button"
                    className="composer-token-remove"
                    aria-label={`Remove ${commandPill.slug} command`}
                    onClick={() => setCommandPill(null)}
                  >
                    <X size={11} strokeWidth={2.5} />
                  </button>
                </span>
              )}
              {attachedRows.map((rowId) => {
                const src = attachSources.find((s) => s.rowId === rowId);
                const Icon = src?.kind === "mcp" ? Puzzle : Plug;
                return (
                  <span
                    key={rowId}
                    className="composer-token-pill composer-token-attach"
                    title="Attached for this conversation — hover to detach"
                  >
                    <Icon className="composer-token-icon" size={13} aria-hidden="true" />
                    <span className="composer-token-label">{attachLabel(rowId)}</span>
                    <button
                      type="button"
                      className="composer-token-remove"
                      aria-label={`Detach ${attachLabel(rowId)}`}
                      onClick={() => detachSource(rowId)}
                    >
                      <X size={11} strokeWidth={2.5} />
                    </button>
                  </span>
                );
              })}
            </span>
          )}
          {slashOpen && slashFiltered.length > 0 && (
            <div className="composer-slash-menu" role="listbox" aria-label="Commands">
              {slashFiltered.map((item, i) => {
                const key = item.kind === "template" ? item.trigger : item.slug;
                return (
                  <button
                    key={key}
                    type="button"
                    role="option"
                    aria-selected={i === slashIndex}
                    className={`composer-slash-item${i === slashIndex ? " active" : ""}`}
                    // onMouseDown + preventDefault keeps textarea focus.
                    onMouseDown={(e) => {
                      e.preventDefault();
                      applySlashItem(item);
                    }}
                    onMouseEnter={() => setSlashIndex(i)}
                  >
                    <span className="composer-slash-cmd">
                      {item.kind === "template" ? `/${item.trigger}` : `/${item.slug}`}
                    </span>
                    <span className="composer-slash-name">{item.name}</span>
                    {item.description && (
                      <span className="composer-slash-desc">{item.description}</span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
          {atOpen && atFiltered.length > 0 && (
            <div className="composer-slash-menu" role="listbox" aria-label="Connectors">
              {atFiltered.map((src, i) => (
                <button
                  key={src.rowId}
                  type="button"
                  role="option"
                  aria-selected={i === atIndex}
                  className={`composer-slash-item${i === atIndex ? " active" : ""}`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    applyAttachSource(src);
                  }}
                  onMouseEnter={() => setAtIndex(i)}
                >
                  <span className="composer-slash-cmd">@{src.id}</span>
                  <span className="composer-slash-name">{src.name}</span>
                  <span className="composer-slash-desc">{src.description}</span>
                </button>
              ))}
            </div>
          )}
          <textarea
            ref={textareaRef}
            className="chat-composer-textarea"
            placeholder={
              streaming
                ? "keep typing to queue follow-up changes"
                : agentLocked
                  ? "Ask anything, or select an agent to customize performance…"
                  : "Write a message…  / for skills · @ for apps"
            }
            style={tokenIndent ? { textIndent: tokenIndent + 8 } : undefined}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={1}
            disabled={disabled}
          />
        </div>
        {/* Live partial transcription as ghost text. Rendered while the mic is
            open AND through the final pass, so the words never vanish between
            "live" and "final". */}
        {(recording || transcribing) && partialText && (
          <div className="voice-live" role="status" aria-live="polite">
            <div className="voice-partial">{partialText}</div>
          </div>
        )}
        {showFooterRow && (
        <div className="chat-composer-footer">
          {forceResearch && (
            <button
              type="button"
              className="composer-research-chip"
              title="Research mode will be applied to your next message. Click to turn off."
              onClick={() => setForceResearch(false)}
            >
              <ResearchIcon /> Research
            </button>
          )}
          {attachError && <span className="composer-attach-error">{attachError}</span>}
          {!attachError && !agentLocked && needsModel && (
            <span className="composer-model-hint">Select a model to start</span>
          )}
          <div className="composer-footer-spacer" />
        </div>
        )}
        <div className="composer-control-bar" role="toolbar" aria-label="Composer controls">
          <div className="composer-attach-wrap" ref={attachMenuRef}>
            <button
              type="button"
              className="composer-attach-btn"
              title="Add files or research"
              aria-label="Add files or research"
              aria-expanded={attachMenuOpen}
              onClick={() => setAttachMenuOpen((o) => !o)}
            >
              +
            </button>
            {attachMenuOpen && (
              <div className="composer-attach-menu" role="menu">
                <button
                  type="button"
                  className="composer-attach-menu-item"
                  role="menuitem"
                  onClick={() => {
                    setAttachMenuOpen(false);
                    fileInputRef.current?.click();
                  }}
                >
                  <AttachmentIcon />
                  <span>Add files or photos</span>
                </button>
                <button
                  type="button"
                  className="composer-attach-menu-item"
                  role="menuitem"
                  onClick={() => {
                    setAttachMenuOpen(false);
                    void listPromptTemplates().then((t) => {
                      setPromptTemplates(t);
                      setTemplatePickerOpen(true);
                    });
                  }}
                >
                  <span className="composer-attach-menu-icon">𝈟</span>
                  <span>Insert prompt template…</span>
                </button>
                <button
                  type="button"
                  className="composer-attach-menu-item"
                  role="menuitem"
                  onClick={() => {
                    setAttachMenuOpen(false);
                    setBroadcastOpen(true);
                  }}
                >
                  <span className="composer-attach-menu-icon">⇶</span>
                  <span>Broadcast to chats…</span>
                </button>
                <button
                  type="button"
                  className="composer-attach-menu-item"
                  role="menuitem"
                  onClick={() => {
                    setAttachMenuOpen(false);
                    void pickWorkingFolder();
                  }}
                >
                  <FolderIcon />
                  <span>Choose working folder…</span>
                </button>
                <button
                  type="button"
                  className="composer-attach-menu-item"
                  role="menuitem"
                  aria-pressed={forceResearch}
                  onClick={() => {
                    setForceResearch((v) => !v);
                    setAttachMenuOpen(false);
                    textareaRef.current?.focus();
                  }}
                >
                  <ResearchIcon />
                  <span>
                    {forceResearch ? "Research mode on — tap again to turn off" : "Research a topic"}
                  </span>
                </button>
                {thinkingSupported && onThinkingChange && (
                  <button
                    type="button"
                    className="composer-attach-menu-item"
                    role="menuitem"
                    aria-pressed={thinking === true}
                    onClick={() => {
                      const next: boolean | null =
                        thinking === null ? true : thinking === true ? false : null;
                      onThinkingChange(next);
                      setAttachMenuOpen(false);
                      textareaRef.current?.focus();
                    }}
                  >
                    <ThinkingIcon on={thinking === true} />
                    <span>{thinking === true ? "Thinking on" : "Thinking off"}</span>
                  </button>
                )}
              </div>
            )}
          </div>
          {showAgentSelector && <span className="composer-control-vdiv" aria-hidden="true" />}
          {showAgentSelector && (
            <div className="composer-control-chip composer-control-agent">
              <AgentModelPicker
                agent={agent}
                model={model ?? ""}
                provider={provider}
                modelLabels={modelLabels}
                loading={agentLoading || modelLoading}
                onPick={onAgentModelPick}
                effort={effort}
                onEffortChange={onEffortChange}
                onEjectLocalModel={onEjectLocalModel}
                localModelActive={localModelActive}
                localOverridesMap={localOverridesMap}
                onLoadLocalModel={onLoadLocalModel}
              />
            </div>
          )}
          {showModeSelector && <span className="composer-control-vdiv" aria-hidden="true" />}
          {showModeSelector && (
            <PermissionModeMenu
              mode={permissionMode!}
              onModeChange={onPermissionModeChange!}
              variant="inline"
              planAvailable={planAvailable}
              modes={harnessModes}
            />
          )}
          <div className="composer-control-spacer" />

          <div className="composer-send-wrap">
            <button
              type="button"
              className={`composer-mic-btn${recording ? " recording" : ""}`}
              title={recording ? "Stop recording" : transcribing ? "Transcribing…" : "Record voice (or hold Alt)"}
              aria-label={recording ? "Stop recording" : "Record voice"}
              disabled={transcribing}
              onClick={toggleRecording}
            >
              {transcribing ? (
                <span className="composer-mic-spinner" />
              ) : recording ? (
                <span className="composer-mic-stop" />
              ) : (
                /* flexShrink: 0 — flex-shrink squeezed the svg into the
                   button's content box (invisible) whenever any padding
                   leaks in. */
                <Mic size={14} strokeWidth={1.8} style={{ flexShrink: 0 }} aria-hidden />
              )}
            </button>
            {streaming ? (
              <button
                className="composer-send-btn stop"
                onClick={onStop}
                title="Stop generating"
                aria-label="Stop generating"
              >
                ■
              </button>
            ) : (
              <button
                className="composer-send-btn"
                onClick={handleSend}
                disabled={isEmpty || disabled || needsModel || agentLocked}
                title={
                  agentLocked
                    ? "Select an agent first"
                    : needsModel
                      ? "Select a model first"
                      : "Send message"
                }
                aria-label="Send message"
              >
                ↑
              </button>
            )}
          </div>
        </div>
        <ComposerMetrics
          chatSessionId={activeChatSessionId}
          streaming={streaming}
          variant="hud"
          contextMeter={{
            usedTokens: usedTokens ?? null,
            model,
            provider,
            isLocal: provider === "local_gguf",
            localCtx,
            liveMaxTokens,
            chatSessionId: activeChatSessionId,
          }}
        />
      </div>
      {createTypeOpen && (
        <ArtifactTypeSelector
          onSelect={handleCreateTypeSelect}
          onClose={() => setCreateTypeOpen(false)}
          initialInstruction={createInstruction}
        />
      )}
    </div>
  );
}
