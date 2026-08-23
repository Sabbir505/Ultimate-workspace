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
import { PermissionModeMenu } from "./PermissionModeMenu";
import { ArtifactTypeSelector } from "./ArtifactTypeSelector";
import type { PermissionMode } from "../../state/chat";
import { ContextMeter } from "./ContextMeter";
import { ComposerMetrics } from "./ComposerMetrics";
import { BranchDropdown } from "./BranchDropdown";
import { useUiStore } from "../../state/ui";
import { useChatStore } from "../../state/chat";
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

/** Stable empty list for the queue selector (a fresh [] per call would make
 *  every store change re-render the composer). */
const NO_QUEUED_MESSAGES: import("../../state/chat").QueuedChatMessage[] = [];

/** Notch chip beside the agent selector showing the directory the chat is
 *  working in: the custom folder chosen via the "+" picker when set, else the
 *  chat's isolated worktree (roadmap P0 §3.1.1), else the selected project's
 *  folder. The × (visible on hover) fully unbinds the chat from that project —
 *  drop the per-chat binding, any custom-folder override, and the global
 *  selection when it's the same project. Hidden when neither resolves (no
 *  project selected). When the chat works in an isolated worktree a ⛓ chip
 *  sits beside the folder name — clicking it joins the main working tree. */
function FolderNotch() {
  const activeChatSessionId = useChatStore((s) => s.activeChatSessionId);
  const override = useChatStore((s) =>
    s.activeChatSessionId ? s.cwdOverrides[s.activeChatSessionId] : undefined,
  );
  const worktreePath = useChatStore((s) =>
    s.activeChatSessionId
      ? s.sessions.find((x) => x.id === s.activeChatSessionId)?.worktreePath
      : undefined,
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
  const path = override ?? worktreePath ?? project?.path ?? null;
  // Only show the folder chip when the chat has an explicit binding — either
  // a per-session project, a custom CWD override, or a worktree. A globally
  // selected project without a per-chat binding is not enough.
  const hasExplicitBinding = !!(boundProjectId || override || worktreePath);
  if (!path || !activeChatSessionId || !hasExplicitBinding) return null;
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
  const activeChatSessionId = useChatStore((s) => s.activeChatSessionId);
  const boundProjectId = useChatStore((s) =>
    s.activeChatSessionId ? s.sessionProjects[s.activeChatSessionId] : undefined,
  );
  const override = useChatStore((s) =>
    s.activeChatSessionId ? s.cwdOverrides[s.activeChatSessionId] : undefined,
  );
  const worktreePath = useChatStore((s) =>
    s.activeChatSessionId
      ? s.sessions.find((x) => x.id === s.activeChatSessionId)?.worktreePath
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
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
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
      {open && (
        <div className="composer-notch-github-popover">
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
        </div>
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

/** Whisper icon for voice recording — modern waveform style (Claude Code-like). */
function MicIcon({ recording }: { recording?: boolean }) {
  return (
    <svg
      width={15}
      height={15}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      {/* Sound wave / whisper waveform */}
      <path d="M12 2a10 10 0 0 1 10 10" opacity="0.3" />
      <path d="M12 6a6 6 0 0 1 6 6" opacity="0.5" />
      <path d="M12 10a2 2 0 0 1 2 2" />
      <path d="M2 12h3" />
      <path d="M2 18h3" />
      <path d="M19 12h3" />
      <path d="M19 18h3" />
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
  /** Per-session permission posture. The selector renders only when BOTH
   *  this and onPermissionModeChange are set AND permissionModeSupported —
   *  Kimi/OpenCode headless runs have no approval channel (they always run
   *  full-auto), so ChatView hides the menu for those harnesses. */
  permissionMode?: PermissionMode;
  onPermissionModeChange?: (mode: PermissionMode) => void;
  permissionModeSupported?: boolean;
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
  /** Active local model's spawn record + persisted runtime overrides, and
   *  the Apply handler — threaded to ModelEffortMenu's inline Advanced
   *  runtime settings editor. */
  activeLocal?: { id: string; path: string; mmprojPath?: string | null } | null;
  localOverrides?: LlamaOverrides;
  onApplyLocalOverrides?: (overrides: LlamaOverrides) => Promise<void> | void;
  applyingOverrides?: boolean;
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
  permissionMode,
  onPermissionModeChange,
  permissionModeSupported = true,
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
  activeLocal,
  localOverrides,
  onApplyLocalOverrides,
  applyingOverrides,
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
  // Team broadcast (roadmap #18): the session list + the broadcast action.
  const broadcastSessions = useChatStore((s) => s.sessions);
  const broadcastToSessions = useChatStore((s) => s.broadcastToSessions);
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
  // Unified slash-menu item: skills, prompt templates, or special commands
  // like /create. Each kind handles selection differently.
  type SlashItem =
    | { kind: "skill"; name: string; slug: string; description?: string }
    | { kind: "template"; name: string; trigger: string; description?: string }
    | { kind: "command"; name: string; slug: string; description: string };
  const [slashSkills, setSlashSkills] = useState<SlashSkill[]>([]);
  const [slashIndex, setSlashIndex] = useState(0);
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
  // Voice recording (roadmap #16): MediaRecorder state.
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
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

  // Replace the partial `/query` token with the chosen command.
  const applySlashCommand = useCallback((command: string) => {
    setContent(`/${command} `);
    const ta = textareaRef.current;
    if (ta) {
      ta.focus();
      requestAnimationFrame(() => ta.setSelectionRange(command.length + 2, command.length + 2));
    }
  }, []);

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

  // Handle a selected slash-menu item. Skills and create commands insert a
  // slash token; prompt templates insert their body (or open variable fill).
  const applySlashItem = useCallback((item: SlashItem) => {
    if (item.kind === "command") {
      if (item.slug === "create") {
        setContent("");
        setCreateInstruction("");
        setCreateTypeOpen(true);
      } else {
        setContent(`/${item.slug} `);
        const ta = textareaRef.current;
        if (ta) {
          ta.focus();
          requestAnimationFrame(() => ta.setSelectionRange(item.slug.length + 2, item.slug.length + 2));
        }
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
    applySlashCommand(item.slug);
  }, [applySlashCommand, insertTemplateText, promptTemplates]);

  // Voice recording (roadmap #16): start/stop MediaRecorder, then transcribe
  // the clip and insert the recognized text.
  const toggleRecording = useCallback(async () => {
    if (recording) {
      mediaRecorderRef.current?.stop();
      return;
    }
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
        toastError("Microphone permission denied — allow it in Windows settings and reload.");
      } else if (name === "NotFoundError" || name === "DevicesNotFoundError") {
        toastError("No microphone found on this device.");
      } else {
        toastError("Could not start microphone.", e);
      }
      return;
    }
    try {
      const rec = new MediaRecorder(stream);
      audioChunksRef.current = [];
      rec.ondataavailable = (e) => { if (e.data.size > 0) audioChunksRef.current.push(e.data); };
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(audioChunksRef.current, { type: rec.mimeType || "audio/webm" });
        setRecording(false);
        setTranscribing(true);
        try {
          const buf = await blob.arrayBuffer();
          // Chunked base64 — spreading the whole buffer into String.fromCharCode
          // throws RangeError on clips > ~100KB. 8KB chunks are safe and fast.
          const bytes = new Uint8Array(buf);
          let binary = "";
          const CHUNK = 0x8000;
          for (let i = 0; i < bytes.length; i += CHUNK) {
            binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
          }
          const b64 = btoa(binary);
          const res = await transcribeAudio(b64, blob.type);
          if (res?.text) {
            insertTemplateText(res.text);
          } else {
            toastError("Transcription returned no text. Is a Whisper server running? See Settings → API Keys.");
          }
        } catch (e) {
          // Most common cause: no whisper-compatible server reachable at the
          // configured base URL (default http://127.0.0.1:8081) → ECONNREFUSED.
          toastError("Voice transcription failed — check the Whisper server in Settings → API Keys.", e);
        } finally {
          setTranscribing(false);
        }
      };
      mediaRecorderRef.current = rec;
      rec.start();
      setRecording(true);
    } catch (e) {
      stream.getTracks().forEach((t) => t.stop());
      toastError("Could not initialize audio recorder.", e);
    }
  }, [recording, insertTemplateText]);

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
  const needsModel = model !== undefined && !model.trim();
  // No agent picked for the session yet: model chip is locked and Send stays
  // disabled so a message can never go to the wrong backend (mockup 02,
  // state A). `agent === undefined` means no active session — hidden entirely.
  const agentLocked = agent === null;

  // --- Conversational Artifact Creation (Phase 1) ---
  // Cheap deterministic detection of natural-language "create artifact" intent.
  // Mirrors the backend `detect_obvious_intent` — no LLM call needed for
  // obvious phrases like "turn this into a skill".
  const detectArtifactIntent = useCallback((msg: string): { type: ArtifactType; instruction: string } | null => {
    const lower = msg.toLowerCase();
    if (lower.includes("turn this into a skill") || lower.includes("save this as a skill") || lower.includes("create a skill")) {
      return { type: "skill", instruction: msg };
    }
    if (lower.includes("turn this into a loop") || lower.includes("make this run until") || lower.includes("create a loop")) {
      return { type: "loop", instruction: msg };
    }
    if (lower.includes("save this as a prompt") || lower.includes("turn this into a prompt template") || lower.includes("create a prompt template")) {
      return { type: "prompt_template", instruction: msg };
    }
    if (lower.includes("make this run every") || lower.includes("create an automation") || lower.includes("schedule this")) {
      return { type: "automation", instruction: msg };
    }
    return null;
  }, []);

  // Persist the command-only message first, then generate the proposal. This
  // creates one real timeline user row without starting a normal chat turn.
  const triggerArtifactGeneration = useCallback(async (type: ArtifactType, instruction: string) => {
    const sessionId = useChatStore.getState().activeChatSessionId;
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
    const trimmed = content.trim();
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
    setAttachments([]);
    setAttachError(null);
    setForceResearch(false);
    setAttachMenuOpen(false);
    // Reset textarea height.
    const ta = textareaRef.current;
    if (ta) {
      ta.style.height = "auto";
    }
  }, [content, attachments, onSend, needsModel, agentLocked, forceResearch, detectArtifactIntent, triggerArtifactGeneration]);

  // Handle ArtifactTypeSelector selection
  const handleCreateTypeSelect = useCallback((type: ArtifactType, instruction?: string) => {
    setCreateTypeOpen(false);
    void triggerArtifactGeneration(type, instruction || createInstruction || "Generate a " + type);
    setCreateInstruction("");
  }, [createInstruction, triggerArtifactGeneration]);

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
            const item = slashFiltered[Math.min(slashIndex, slashFiltered.length - 1)];
            applySlashItem(item);
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
    [disabled, needsModel, agentLocked, handleSend, slashOpen, slashFiltered, slashIndex, applySlashItem],
  );

  const isEmpty = !content.trim() && attachments.length === 0;
  const showSelector = model !== undefined && onModelChange && onEffortChange;
  // The agent chip shows whenever there's an active session (agent !==
  // undefined), including the locked no-agent state.
  const showAgentSelector = agent !== undefined && onAgentChange;
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
          <textarea
            ref={textareaRef}
            className="chat-composer-textarea"
            placeholder={agentLocked ? "Ask anything, or select an agent to customize performance…" : "Write a message…  type / for skills"}
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
          {showModeSelector && (
            <PermissionModeMenu
              mode={permissionMode!}
              onModeChange={onPermissionModeChange!}
              variant="inline"
            />
          )}
          {attachError && <span className="composer-attach-error">{attachError}</span>}
          {!attachError && !agentLocked && needsModel && (
            <span className="composer-model-hint">Select a model to start</span>
          )}
          <div className="composer-footer-spacer" />
          {showSelector && agentLocked && (
            <span className="model-chip-locked" title="Pick an agent to unlock the model list">
              🔒 Model locked — pick agent
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
              activeLocal={activeLocal}
              localOverrides={localOverrides}
              onApplyLocalOverrides={onApplyLocalOverrides}
              applyingOverrides={applyingOverrides}
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
            <button
              type="button"
              className={`composer-mic-btn${recording ? " recording" : ""}`}
              title={recording ? "Stop recording" : transcribing ? "Transcribing…" : "Record voice"}
              aria-label={recording ? "Stop recording" : "Record voice"}
              disabled={transcribing}
              onClick={() => void toggleRecording()}
            >
              {transcribing ? <span className="composer-mic-spinner" /> : recording ? <span className="composer-mic-stop" /> : <MicIcon />}
            </button>
          </div>
        </div>
        <div className="composer-control-bar" role="toolbar" aria-label="Composer controls">
          {showAgentSelector && (
            <div className="composer-control-chip composer-control-agent">
              <AgentMenu agent={agent} onAgentChange={onAgentChange!} loading={agentLoading} />
            </div>
          )}
          <FolderNotch />
          <GitHubNotch />
          <div className="composer-control-spacer" />
        </div>
        <ComposerMetrics
          chatSessionId={activeChatSessionId}
          streaming={streaming}
          variant="hud"
          contextMeter={{
            usedTokens: usedTokens ?? null,
            model,
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
