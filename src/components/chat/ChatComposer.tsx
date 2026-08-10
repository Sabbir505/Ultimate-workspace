// Chat composer, Claude-style: a single rounded card with the textarea on
// top and a footer row below — "+" attach button on the left, model/effort
// pill and a circular ↑ send button on the right.
// Enter sends; Shift+Enter inserts a newline.
// Attachments: images are sent as vision input, docx/pptx/xlsx/pdf and legacy
// doc/ppt/xls are extracted to text server-side, and plain-text files are
// inlined into the message.
import { useCallback, useEffect, useRef, useState } from "react";
import { ModelEffortMenu } from "./ModelEffortMenu";
import { AgentMenu } from "./AgentMenu";
import { ContextMeter } from "./ContextMeter";
import { BranchDropdown } from "./BranchDropdown";
import { useUiStore } from "../../state/ui";
import { useChatStore } from "../../state/chat";
import { useProjectsStore } from "../../state/projects";
import { listChatSkills } from "../../lib/ipc";

const MAX_TEXT_BYTES = 512 * 1024;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_DOC_BYTES = 10 * 1024 * 1024;

// Attachment kinds map to the backend `ChatAttachmentInput`: images go to the
// model as vision input, docs are text-extracted server-side, text is inlined.
export interface ChatAttachment {
  name: string;
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

/** Stable empty list for the queue selector (a fresh [] per call would make
 *  every store change re-render the composer). */
const NO_QUEUED_MESSAGES: import("../../state/chat").QueuedChatMessage[] = [];

/** Notch chip beside the agent selector showing the directory the chat is
 *  working in: the custom folder chosen via the "+" picker when set, else the
 *  selected project's folder. The × (visible on hover) fully unbinds the chat
 *  from that project — drop the per-chat binding, any custom-folder override,
 *  and the global selection when it's the same project. Hidden when neither
 *  resolves (no project selected). */
function FolderNotch() {
  const activeChatSessionId = useChatStore((s) => s.activeChatSessionId);
  const override = useChatStore((s) =>
    s.activeChatSessionId ? s.cwdOverrides[s.activeChatSessionId] : undefined,
  );
  const unbindProject = useChatStore((s) => s.unbindProject);
  const selectProject = useProjectsStore((s) => s.selectProject);
  // The chat's own project binding wins over the global selection, so
  // switching chats shows each chat's project — not whichever project was
  // clicked last.
  const boundProjectId = useChatStore((s) =>
    s.activeChatSessionId ? s.sessionProjects[s.activeChatSessionId] : undefined,
  );
  const project = useProjectsStore((s) =>
    s.projectById(boundProjectId ?? s.selectedProjectId),
  );
  const path = override ?? project?.path ?? null;
  if (!path || !activeChatSessionId) return null;
  const unbind = () => {
    unbindProject(activeChatSessionId);
    // "Come out of that project" also means the global sidebar selection —
    // only when it's the very project this notch was showing (a chat bound
    // to a different project keeps the global selection untouched).
    const ps = useProjectsStore.getState();
    const showing = boundProjectId ?? ps.selectedProjectId;
    if (ps.selectedProjectId && ps.selectedProjectId === showing) {
      selectProject(null);
    }
  };
  return (
    <div className="composer-notch-folder" title={path}>
      <FolderIcon />
      <span className="composer-notch-folder-name">{pathBasename(path)}</span>
      <button
        type="button"
        className="composer-notch-folder-clear"
        title={`${override ? `Custom folder: ${override}\n` : ""}Click to leave this project`}
        aria-label="Leave this project"
        onClick={unbind}
      >
        ×
      </button>
    </div>
  );
}

/** GitHub / branch pill — sits beside the project pill. Shows a git-branch
 *  icon + the current branch name. Clicking it opens a small dropdown popover
 *  (right there at the composer) with the branch list, search, create, and git
 *  log — NOT the tool panel. Hidden when the project isn't a git repo. */
function GitHubNotch() {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const boundProjectId = useChatStore((s) =>
    s.activeChatSessionId ? s.sessionProjects[s.activeChatSessionId] : undefined,
  );
  const selectedProjectId = useProjectsStore((s) => s.selectedProjectId);
  const projectId = boundProjectId ?? selectedProjectId;
  const gitStatus = useProjectsStore((s) =>
    projectId ? s.gitStatuses[projectId] : undefined,
  );

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  if (!gitStatus?.isRepo || !gitStatus.branch) return null;
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
      {open && (
        <div className="composer-notch-github-popover">
          <BranchDropdown onClose={() => setOpen(false)} />
        </div>
      )}
    </div>
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
  onSend: (content: string, attachments: ChatAttachment[], forceResearch?: boolean) => void;
  onStop?: () => void;
  streaming: boolean;
  disabled?: boolean;
  /** Prefill the textarea (e.g. editing a prior message). Bumping `nonce`
   *  re-applies `text` even if the text is unchanged. */
  draft?: { text: string; nonce: number };
  /** Model/effort selector state — selector is hidden when model is undefined. */
  model?: string;
  models?: string[];
  /** Optional id → display-label overrides for the model list (CLI-agent
   *  catalog). Passed through to ModelEffortMenu. */
  modelLabels?: Record<string, string>;
  /** Custom endpoint the selected CLI agent is pointed at (discovered from
   *  the CLI's own config) — shown in the model dropdown so relay/custom
   *  setups are visible. Passed through to ModelEffortMenu. */
  modelEndpoint?: string | null;
  /** Per-session agent selection ("builtin" | "local" | "harness:<id>").
   *  undefined = no active session (agent chip hidden); null = session active
   *  but no agent picked yet — the model chip renders locked and Send stays
   *  disabled until the user chooses one (mockup 02, state A). */
  agent?: string | null;
  onAgentChange?: (agent: string) => void;
  /** Spinner on the agent chip while a harness's config/models load. */
  agentLoading?: boolean;
  /** Scanned local GGUF display names, shown as a "Local models" section in
   *  the selector regardless of the session's provider. */
  localModels?: string[];
  effort?: string;
  provider?: string;
  /** Local-model context size in tokens (0 = Auto); only used for local_gguf. */
  localCtx?: number;
  /** True while a local model is loading onto the GPU (see ChatView). */
  modelLoading?: boolean;
  onModelChange?: (model: string) => void;
  onEffortChange?: (effort: string) => void;
  onLocalCtxChange?: (ctx: number) => void;
  /** Eject the running local-model sidecar and free its VRAM. Wired by
   *  ChatView only when the local_gguf provider has a live sidecar. */
  onEjectLocalModel?: () => void;
  /** True when a local-model sidecar is currently running — the model pill
   *  shows an ⏏ button when this is set. Defaults to false. */
  localModelActive?: boolean;
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
   *  and the session is local, the meter uses this instead of the slider
   *  value, so it always matches what the model actually has. */
  liveMaxTokens?: number;
}

export function ChatComposer({
  onSend,
  onStop,
  streaming,
  disabled,
  draft,
  model,
  models,
  modelLabels,
  modelEndpoint,
  agent,
  onAgentChange,
  agentLoading,
  localModels,
  effort,
  provider,
  localCtx,
  modelLoading,
  onModelChange,
  onEffortChange,
  onLocalCtxChange,
  onEjectLocalModel,
  localModelActive,
  usedTokens,
  liveMaxTokens,
  thinking,
  onThinkingChange,
  thinkingSupported,
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
  // collapsible strip (collapsed by default) above the composer card;
  // "×" drops one from the queue.
  const [queueExpanded, setQueueExpanded] = useState(false);
  const activeChatSessionId = useChatStore((s) => s.activeChatSessionId);
  const queuedMessages = useChatStore((s) =>
    s.activeChatSessionId
      ? (s.messageQueue[s.activeChatSessionId] ?? NO_QUEUED_MESSAGES)
      : NO_QUEUED_MESSAGES,
  );
  const removeQueuedMessage = useChatStore((s) => s.removeQueuedMessage);
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
    if (typeof picked === "string" && activeChatSessionId) {
      setCwdOverride(activeChatSessionId, picked);
    }
    textareaRef.current?.focus();
  }, [activeChatSessionId, setCwdOverride]);

  // Slash-command skill popup: typing "/" as the first character opens a list
  // of every available skill (on-disk harness skills + the built-in
  // doc/pptx/pdf/diagram skills); picking one inserts its `/slug` token,
  // which the backend uses to inject that skill's instructions for this turn
  // only. Skills are managed in the Skills Library, not Settings → Assistant.
  interface SlashSkill {
    name: string;
    slug: string;
  }
  const [slashSkills, setSlashSkills] = useState<SlashSkill[]>([]);
  const [slashIndex, setSlashIndex] = useState(0);

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
    return () => {
      stale = true;
    };
  }, [slashOpen]);

  const slashFiltered = slashQuery !== null
    ? slashSkills.filter(
        (s) =>
          s.slug.startsWith(slashQuery) ||
          s.name.toLowerCase().includes(slashQuery),
      )
    : [];

  // Reset the highlight whenever the query changes.
  useEffect(() => {
    setSlashIndex(0);
  }, [slashQuery]);

  // Replace the partial `/query` token with the chosen command.
  const applySlashCommand = useCallback((command: string) => {
    setContent(`/${command} `);
    const ta = textareaRef.current;
    if (ta) {
      ta.focus();
      requestAnimationFrame(() => ta.setSelectionRange(command.length + 2, command.length + 2));
    }
  }, []);

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
            kind: "image",
            data: await readAsBase64(file),
            mediaType: file.type || `image/${ext === "jpg" ? "jpeg" : ext}`,
          };
        } else if (isDoc) {
          attachment = {
            name: file.name,
            kind: "doc",
            data: await readAsBase64(file),
            format: ext,
          };
        } else {
          attachment = { name: file.name, kind: "text", text: await file.text() };
        }
        setAttachments((prev) =>
          prev.some((a) => a.name === file.name) ? prev : [...prev, attachment],
        );
      } catch {
        setAttachError(`Could not read ${file.name}`);
      }
    }
  }, []);

  // A model must be explicitly chosen before sending (no default model).
  const needsModel = model !== undefined && !model.trim();
  // No agent picked for the session yet: model chip is locked and Send stays
  // disabled so a message can never go to the wrong backend (mockup 02,
  // state A). `agent === undefined` means no active session — hidden entirely.
  const agentLocked = agent === null;

  const handleSend = useCallback(() => {
    if (needsModel || agentLocked) return;
    const trimmed = content.trim();
    if (!trimmed && attachments.length === 0) return;
    onSend(trimmed, attachments, forceResearch || undefined);
    setContent("");
    setAttachments([]);
    setAttachError(null);
    setForceResearch(false);
    setAttachMenuOpen(false);
    // Reset textarea height.
    const ta = textareaRef.current;
    if (ta) {
      ta.style.height = "auto";
    }
  }, [content, attachments, onSend, needsModel, agentLocked, forceResearch]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // While the slash popup is showing candidates, it owns navigation keys.
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
          applySlashCommand(slashFiltered[Math.min(slashIndex, slashFiltered.length - 1)].slug);
          return;
        }
        if (e.key === "Escape") {
          // The popup is derived from the text, so "close" = drop the token.
          e.preventDefault();
          setContent("");
          return;
        }
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
    [disabled, needsModel, agentLocked, handleSend, slashOpen, slashFiltered, slashIndex, applySlashCommand],
  );

  const isEmpty = !content.trim() && attachments.length === 0;
  const showSelector = model !== undefined && onModelChange && onEffortChange;
  // The agent chip shows whenever there's an active session (agent !==
  // undefined), including the locked no-agent state.
  const showAgentSelector = agent !== undefined && onAgentChange;

  return (
    <div className="chat-composer">
      {queuedMessages.length > 0 && (
        <div className="composer-queue" aria-label="Queued messages">
          <button
            type="button"
            className="composer-queue-header"
            onClick={() => setQueueExpanded((v) => !v)}
            aria-expanded={queueExpanded}
          >
            <span className="composer-queue-chevron" aria-hidden="true">
              {queueExpanded ? "▾" : "▸"}
            </span>
            Queued ({queuedMessages.length})
          </button>
          {queueExpanded &&
            queuedMessages.map((m, i) => (
              <div className="composer-queue-item" key={m.id}>
                <span className="composer-queue-index">{i + 1}</span>
                <span className="composer-queue-text" title={m.content}>
                  {m.content ||
                    `${m.attachments?.length ?? 0} attachment${(m.attachments?.length ?? 0) === 1 ? "" : "s"}`}
                </span>
                <button
                  type="button"
                  className="composer-queue-remove"
                  title="Remove from queue"
                  aria-label="Remove from queue"
                  onClick={() =>
                    activeChatSessionId && removeQueuedMessage(activeChatSessionId, m.id)
                  }
                >
                  ×
                </button>
              </div>
            ))}
        </div>
      )}
      <div className="chat-composer-card">
        {attachments.length > 0 && (
          <div className="composer-attachments">
            {attachments.map((a) => (
              <AttachmentCard
                key={a.name}
                attachment={a}
                onRemove={() =>
                  setAttachments((prev) => prev.filter((p) => p.name !== a.name))
                }
              />
            ))}
          </div>
        )}
        <div className="composer-slash-wrap">
          {slashOpen && slashFiltered.length > 0 && (
            <div className="composer-slash-menu" role="listbox" aria-label="Skills">
              {slashFiltered.map((s, i) => (
                <button
                  key={s.slug}
                  type="button"
                  role="option"
                  aria-selected={i === slashIndex}
                  className={`composer-slash-item${i === slashIndex ? " active" : ""}`}
                  // onMouseDown + preventDefault keeps textarea focus.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    applySlashCommand(s.slug);
                  }}
                  onMouseEnter={() => setSlashIndex(i)}
                >
                  <span className="composer-slash-cmd">/{s.slug}</span>
                  <span className="composer-slash-name">{s.name}</span>
                </button>
              ))}
            </div>
          )}
          <textarea
            ref={textareaRef}
            className="chat-composer-textarea"
            placeholder={agentLocked ? "Select an agent to start…" : "Write a message…  type / for skills"}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={1}
            disabled={disabled}
          />
        </div>
        <div className="chat-composer-footer">
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
          {!attachError && agentLocked && (
            <span className="composer-model-hint">Select an agent to start</span>
          )}
          {!attachError && !agentLocked && needsModel && (
            <span className="composer-model-hint">Select a model to start</span>
          )}
          <div className="composer-footer-spacer" />
          {showSelector && agentLocked && (
            <span className="model-chip-locked" title="Pick an agent to unlock the model list">
              🔒 Model — pick an agent first
            </span>
          )}
          {showSelector && !agentLocked && (
            <ModelEffortMenu
              model={model}
              models={models ?? []}
              labels={modelLabels}
              endpoint={modelEndpoint ?? null}
              localModels={localModels ?? []}
              effort={effort ?? ""}
              provider={provider}
              modelLoading={modelLoading}
              localCtx={localCtx}
              onModelChange={onModelChange}
              onEffortChange={onEffortChange}
              onLocalCtxChange={onLocalCtxChange}
              onEjectLocalModel={onEjectLocalModel}
              localModelActive={localModelActive}
            />
          )}
          <div className="composer-send-wrap">
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
      </div>
      <div className="composer-context-meter-wrap">
        {showAgentSelector && (
          <div className="composer-notch-agent">
            <AgentMenu agent={agent} onAgentChange={onAgentChange!} loading={agentLoading} />
          </div>
        )}
        <FolderNotch />
        <GitHubNotch />
        <div className="composer-context-meter-spacer" />
        <ContextMeter
          usedTokens={usedTokens ?? null}
          model={model}
          isLocal={provider === "local_gguf"}
          localCtx={localCtx}
          liveMaxTokens={liveMaxTokens}
        />
      </div>
    </div>
  );
}
