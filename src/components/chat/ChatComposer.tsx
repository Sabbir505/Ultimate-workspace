// Chat composer, Claude-style: a single rounded card with the textarea on
// top and a footer row below — "+" attach button on the left and a circular
// ↑ send button on the right. Agent + model selection live in ONE combined
// chip in the control bar below (AgentModelPicker): left rail of agents,
// right pane of that agent's models with a search header.
// Enter sends; Shift+Enter inserts a newline.
// Attachments: images are sent as vision input, docx/pptx/xlsx/pdf and legacy
// doc/ppt/xls are extracted to text server-side, and plain-text files are
// inlined into the message. Files reach those paths via the "+" picker, by
// pasting straight into the textarea (screenshots, copied images, OS-copied
// files — anything the clipboard exposes as a file), or by dragging them from
// the OS onto the composer card.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import { useSettingsStore } from "../../state/settings";
import { useChatStore, selectContextSessionId } from "../../state/chat";
import { useProjectsStore } from "../../state/projects";
import { blobToBase64, encodeWav16k, joinSamples } from "../../lib/voiceRecording";
import {
  listChatSkills,
  listPromptTemplates,
  templateVariables,
  fillTemplate,
  transcribeAudio,
  cancelTranscription,
  toastError,
  toastInfo,
  toastSuccess,
  compactNow,
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

import {
  QueuedMessageRow,
  QuotedSelectionRow,
  ThinkingIcon,
} from "./composerChrome";
// Split-boundary re-exports: App.tsx (and any other callers) import the
// notches from here — the components now live in composerChrome.tsx.
export { FolderNotch, GitHubNotch } from "./composerChrome";

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
  /** Quoted selections stacked by the selection toolbar's "Ask" — rendered as
   *  removable rows above the textarea (queue-row visual language) and
   *  prepended to the next sent message. The user's typed draft is untouched. */
  quotedSelections?: Array<{ id: number; text: string }>;
  /** Drop one quoted selection from the stack (row's × button). */
  onRemoveQuotedSelection?: (id: number) => void;
  /** Clear the whole quote stack — called after a successful send. */
  onClearQuotedSelections?: () => void;
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
  /** HARNESS session's reasoning-effort tier ("" = "Default"). Undefined =
   *  no harness session (the provider effort slider above covers those). */
  harnessEffort?: string;
  /** Change the harness session's effort tier — persisted per session and
   *  applied by the backend at each spawn. */
  onHarnessEffortChange?: (effort: string) => void;
  /** Auto routing bias + setter (picker's Auto pane footer), wired from the
   *  settings store by ChatView. */
  autoBias?: string;
  onAutoBiasChange?: (bias: string) => void;
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
  quotedSelections,
  onRemoveQuotedSelection,
  onClearQuotedSelections,
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
  harnessEffort,
  onHarnessEffortChange,
  autoBias,
  onAutoBiasChange,
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
  // Per-session draft: each conversation keeps its own unsent text. The
  // composer instance survives session switches (same tree position), so the
  // old component-local useState smeared the half-written prompt into every
  // chat you switched to. Null session (no chat yet — the first send creates
  // one) falls back to local state; it migrates into the store on the first
  // keystroke after the session exists.
  const composerDraft = useChatStore((s) =>
    effectiveSessionId ? (s.composerDrafts[effectiveSessionId] ?? "") : "",
  );
  const [noSessionDraft, setNoSessionDraft] = useState("");
  const setComposerDraft = useChatStore((s) => s.setComposerDraft);
  const content = effectiveSessionId ? composerDraft : noSessionDraft;
  const setContent = useCallback(
    (value: string | ((prev: string) => string)) => {
      if (effectiveSessionId) setComposerDraft(effectiveSessionId, value);
      else setNoSessionDraft(value);
    },
    [effectiveSessionId, setComposerDraft],
  );
  // Team broadcast (roadmap #18): the broadcast action. The session LIST is
  // resolved lazily next to broadcastOpen below — PERF: a live subscription
  // to `s.sessions` re-rendered the whole composer (textarea included) on
  // every session-list mutation (title autorename, status touch, relist),
  // while the list is only ever shown inside the transient broadcast modal.
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

  // Cloud window resolution for the meter: the active model's PINNED window
  // is AUTHORITATIVE (the user's explicit choice — it may RAISE a model
  // above the registry's guess, e.g. a 1M glm served through a remapped
  // endpoint); without a pin, the global cloud context-limit CAP applies
  // (a cap only shrinks). The backend's meter poll + compaction trigger
  // resolve the same way (effective_session_window), so meter and trigger
  // can never disagree about how much room is left.
  const cloudContextLimit = useSettingsStore((s) => s.cloudContextLimit);
  const modelWindowFor = useSettingsStore((s) => s.modelWindowFor);
  const pinnedWindow = modelWindowFor(provider ?? "", model);
  const contextLimitOverride = cloudContextLimit || undefined;

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
  // Read at render time (not a store subscription): the list is only ever
  // rendered inside the open modal, and opening the modal re-renders the
  // composer anyway. New sessions created while the modal sits open won't
  // appear until it's reopened — acceptable for a transient picker.
  const broadcastSessions = broadcastOpen ? useChatStore.getState().sessions : [];
  const [broadcastTargets, setBroadcastTargets] = useState<Record<string, boolean>>({});
  const [broadcastText, setBroadcastText] = useState("");
  // Voice recording (roadmap #16).
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  // Live dictation lands directly in the textarea: while the mic is open,
  // Float32 sample chunks from a ScriptProcessor on a 16 kHz AudioContext
  // (no MediaRecorder) fill two buffers — the full clip, kept for stop's
  // repair pass (used only when a segment commit failed), and the current
  // SEGMENT (audio since the last pause) for the live partial. A short
  // silence commits the segment's text into the draft, so it can never
  // vanish when speech continues; the partial after it is re-rendered in
  // place every PARTIAL_TICK_MS.
  const samplesRef = useRef<Float32Array[]>([]);
  const segmentRef = useRef<Float32Array[]>([]);
  const segmentLenRef = useRef(0);
  const silenceRunRef = useRef(0);
  const segmentHadSoundRef = useRef(false);
  /** Bumped whenever a segment is handed to the commit chain; live-partial
   *  results tagged with an older gen are dropped so a transcription that
   *  overlaps a flush can't duplicate committed words. */
  const segmentGenRef = useRef(0);
  /** Serializes segment-commit transcriptions so their text appends in
   *  audio order even when two flushes overlap. */
  const commitChainRef = useRef<Promise<void>>(Promise.resolve());
  /** How many commit jobs are queued or in flight on the chain. Stop uses it
   *  to show the mic spinner exactly while the last text is still landing —
   *  and to skip the spinner (and its one-frame flash) when nothing pends. */
  const pendingCommitsRef = useRef(0);
  /** At most one live-partial request may be outstanding. The whisper server
   *  transcribes strictly serially, so every extra queued request delays the
   *  segment commits and the stop-flush behind it — a pile-up of stale
   *  partials was the main "dictation gets slower the longer I talk" cause. */
  const partialInFlightRef = useRef(false);
  /** Commit results apply only while this equals the value captured when the
   *  segment was flushed. Cancel and re-begin bump it so a stale commit can
   *  never land in the wrong session; stop deliberately does NOT — commits
   *  still in flight when recording stops must finish landing, because the
   *  full-clip safety pass no longer re-transcribes everything. */
  const commitArmRef = useRef(0);
  /** Latched when a segment commit fails; stop runs the old full-clip repair
   *  pass only when this is set, instead of after every dictation. */
  const commitFailedRef = useRef(false);
  // Where the live dictation text sits in the draft: [start, end) span in
  // `content`, plus the exact text last rendered there (the splice
  // validates against it — if the user edited that region by hand, the next
  // update appends at the end instead of clobbering their edit).
  const voiceSpanRef = useRef<{ start: number; end: number } | null>(null);
  const voiceRenderedRef = useRef("");
  const voiceCommittedRef = useRef("");
  const voicePartialRef = useRef("");
  const voiceFocusAppliedRef = useRef(false);
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

  // The caret position inside the textarea — the slash/@ popups key off the
  // token UNDER THE CURSOR, not off the whole content, so "/" works anywhere
  // in the sentence (text before and after the command is preserved).
  const [caret, setCaret] = useState(0);
  // Escape-dismiss latches: the exact token (position + query) whose popup
  // was dismissed. Any edit to the token re-opens the menu; the dismissal is
  // non-destructive (it no longer wipes the draft).
  const [slashDismissed, setSlashDismissed] = useState("");
  const [atDismissed, setAtDismissed] = useState("");
  const dismissKey = (t: { start: number; query: string }) => `${t.start}:${t.query}`;

  const slashToken = tokenAtCaret(content, caret, "/");
  const slashQuery = slashToken?.query ?? null;
  const slashOpen = slashToken !== null && slashDismissed !== dismissKey(slashToken);

  // (Re)load skills every time the popup opens, so edits made in the Skills
  // Library are picked up immediately (the backend cache is invalidated on
  // every create/save/delete).
  useEffect(() => {
    if (!slashOpen) return;
    let stale = false;
    void listChatSkills()
      .then((list) => {
        if (stale || !list) return;
        setSlashSkills(list.map((s) => ({ name: s.name, slug: s.slug })));
      })
      .catch(() => {
        /* slash-menu skill list is best-effort */
      });
    void listPromptTemplates()
      .then((t) => {
        if (stale) return;
        setPromptTemplates(t);
      })
      .catch(() => {
        /* slash-menu template list is best-effort */
      });
    return () => {
      stale = true;
    };
  }, [slashOpen]);

  // Static slash commands shown alongside skills/prompt templates. `/create`
  // is included so it appears when typing `/`, and subtype-prefixed entries
  // (`/create skill`, etc.) let the user pick the artifact type directly.
  // Harness-session commands: forwarded VERBATIM to the CLI as a normal
  // turn — Claude Code (and compatible CLIs) interpret them as their own
  // context-management commands, and the reply reports the compaction.
  // Relay-side compaction doesn't manage the CLI's internal window, so this
  // is the manual lever for that side of the wall.
  const isHarnessSession = !!agent && (agent.startsWith("harness:") || agent.startsWith("acp:"));
  const harnessSlashCommands: SlashItem[] = isHarnessSession
    ? [
        {
          kind: "command",
          name: "Microcompact (CLI)",
          slug: "microcompact",
          description: "Clear old tool results from the CLI's context (lighter than compact)",
        },
      ]
    : [];

  const staticSlashCommands: SlashItem[] = [
    {
      kind: "command",
      name: "Compact context",
      slug: "compact",
      description: isHarnessSession
        ? "Ask the CLI engine to run its native context compaction"
        : "Summarize older turns to free context window",
    },
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
    ...harnessSlashCommands,
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

  const atToken = tokenAtCaret(content, caret, "@");
  const atQuery = atToken?.query ?? null;
  const atOpen = atToken !== null && atDismissed !== dismissKey(atToken) && !!chatSessionId;

  const refreshAttached = useCallback(() => {
    if (!chatSessionId) {
      setAttachedRows([]);
      return;
    }
    void listSessionConnectors(chatSessionId)
      .then((rows) => {
        setAttachedRows(rows ?? []);
      })
      .catch(() => {
        /* connector rows are best-effort; keep whatever is showing */
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
    void listConnectors()
      .then((list) => {
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
        })
        .catch(() => {
          /* attach-source discovery is best-effort */
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

  // Keep the keyboard-highlighted row visible: both menus are capped-height
  // scroll areas, and arrowing past the fold would otherwise move the
  // selection onto a row the user can't see.
  const slashActiveRef = useRef<HTMLButtonElement | null>(null);
  const atActiveRef = useRef<HTMLButtonElement | null>(null);
  useLayoutEffect(() => {
    if (slashOpen) slashActiveRef.current?.scrollIntoView({ block: "nearest" });
  }, [slashIndex, slashOpen]);
  useLayoutEffect(() => {
    if (atOpen) atActiveRef.current?.scrollIntoView({ block: "nearest" });
  }, [atIndex, atOpen]);

  /** Splice `replacement` over the popup's token span, keep everything else,
   *  and put the caret right after the inserted text. */
  const replaceTokenSpan = useCallback(
    (span: { start: number; end: number }, replacement: string) => {
      setContent((prev) => prev.slice(0, span.start) + replacement + prev.slice(span.end));
      const nextCaret = span.start + replacement.length;
      setCaret(nextCaret);
      const ta = textareaRef.current;
      if (ta) {
        ta.focus();
        requestAnimationFrame(() => ta.setSelectionRange(nextCaret, nextCaret));
      }
    },
    [],
  );

  const applyAttachSource = useCallback(
    (source: AttachSource) => {
      if (!chatSessionId) return;
      // Drop the partial "@query" token from the input; text before and
      // after it stays untouched.
      if (atToken) replaceTokenSpan(atToken, "");
      void addSessionConnector(chatSessionId, source.rowId)
        .then(() => refreshAttached())
        .catch((e) => toastError(`Could not attach ${source.name}.`, e));
    },
    [chatSessionId, refreshAttached, atToken, replaceTokenSpan],
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
    const sep = content && !content.endsWith("\n") ? "\n" : "";
    const next = content ? `${content}${sep}${text}` : text;
    setContent(next);
    // Programmatic setSelectionRange doesn't fire onSelect, so mirror the
    // caret into state explicitly (the popups read it).
    setCaret(next.length);
    const ta = textareaRef.current;
    if (ta) {
      ta.focus();
      // Negative indices clamp to 0 — the caret would sit at the START of
      // the inserted text while `caret` state (above) claims the end,
      // desyncing the slash/@ popup from the real caret position.
      requestAnimationFrame(() => ta.setSelectionRange(next.length, next.length));
    }
  }, [content]);

  // Handle a selected slash-menu item. Prompt templates insert their body;
  // skills and /create commands render as an inline command PILL when the
  // token IS the whole draft, and are spliced into the text in place
  // otherwise — the text before and after the token is always preserved.
  const applySlashItem = useCallback((item: SlashItem) => {
    if (item.kind === "command") {
      if (item.slug === "create") {
        // Drop just the token; any other draft text stays for after the
        // type selector closes.
        if (slashToken) replaceTokenSpan(slashToken, "");
        setCreateInstruction("");
        setCreateTypeOpen(true);
      } else {
        // Commands are message-level directives — they ride the command
        // pill (serialized back to the leading `/slug` on send) while the
        // rest of the draft is kept verbatim.
        if (slashToken) replaceTokenSpan(slashToken, "");
        setCommandPill({ slug: item.slug, label: item.name });
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
        if (slashToken) replaceTokenSpan(slashToken, "");
        setFillingTemplate(template);
        setFillValues({});
      } else if (slashToken) {
        replaceTokenSpan(slashToken, template.body);
      } else {
        insertTemplateText(template.body);
      }
      return;
    }
    // Skill: a bare `/query` occupying the whole draft keeps the pill
    // affordance; anywhere else the `/slug ` token is inserted at the
    // cursor so surrounding text survives and the backend's token-aware
    // skill parsing still sees it.
    if (slashToken && slashToken.start === 0 && slashToken.end === content.length) {
      setCommandPill({ slug: item.slug, label: item.name });
      setContent("");
      setCaret(0);
      const ta = textareaRef.current;
      ta?.focus();
    } else if (slashToken) {
      replaceTokenSpan(slashToken, `/${item.slug} `);
    } else {
      setCommandPill({ slug: item.slug, label: item.name });
      setContent("");
      setCaret(0);
      const ta = textareaRef.current;
      ta?.focus();
    }
  }, [insertTemplateText, promptTemplates, slashToken, content, replaceTokenSpan]);

  // Voice recording (roadmap #16): capture raw mic samples on a 16 kHz
  // AudioContext, commit each silence-bounded segment straight into the
  // textarea while the partial after it re-renders in place every tick, and
  // run one full-buffer pass on stop that replaces it all with the polished
  // text. Same STT server either way — the sidecar lazy-starts itself.
  const stopCapture = useCallback(() => {
    recordingRef.current = false;
    pendingStopRef.current = false;
    if (partialTimerRef.current !== null) {
      window.clearInterval(partialTimerRef.current);
      partialTimerRef.current = null;
    }
    // A live partial still in flight is stale from this moment (its result
    // would be dropped) — cancel it so the server's serial inference queue is
    // free for the commits that actually matter. The whisper server aborts
    // inference early when its client disconnects.
    if (partialInFlightRef.current) {
      cancelTranscription("partial").catch(() => {});
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

  // Diagnostics: WebView2 throttles occluded/hidden windows hard enough to
  // stall invoke delivery (observed: a finished transcription's response sat
  // undelivered for 68s while the server had completed in 0.96s). Log
  // visibility/focus transitions so a slow stop can be correlated with the
  // window going to the background.
  useEffect(() => {
    const stamp = () => new Date().toISOString().slice(11, 23);
    const onVis = () =>
      voiceLog(
        `[voice] ${stamp()} window ${document.visibilityState === "hidden" ? "HIDDEN (renderer throttled)" : "visible"} focus=${document.hasFocus()}`,
      );
    const onBlur = () =>
      voiceLog(`[voice] ${stamp()} window lost focus (visibility=${document.visibilityState})`);
    const onFocus = () =>
      voiceLog(`[voice] ${stamp()} window gained focus (visibility=${document.visibilityState})`);
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

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

  // Splice the current dictation text (committed segments + live partial)
  // into the draft at the tracked span. Validation runs inside the updater
  // against the freshest `content`; if the user hand-edited the region, the
  // update appends at the end rather than clobbering their edit. The ref
  // writes are idempotent (same inputs on a StrictMode double-invoke).
  const renderVoiceText = useCallback(() => {
    const committed = voiceCommittedRef.current;
    const partial = voicePartialRef.current;
    const text = partial ? (committed ? `${committed} ` : "") + partial : committed;
    if (!text) return;
    const span = voiceSpanRef.current;
    const rendered = voiceRenderedRef.current;
    voiceRenderedRef.current = text;
    setContent((prev) => {
      const ok = !!span && prev.slice(span.start, span.end) === rendered;
      const start = ok ? span.start : prev.length;
      const end = ok ? span.end : prev.length;
      voiceSpanRef.current = { start, end: start + text.length };
      return prev.slice(0, start) + text + prev.slice(end);
    });
    // Caret follows the dictated text once the updater has run; the real
    // selection is only moved when the textarea already has focus.
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      const s = voiceSpanRef.current;
      if (!ta || !s) return;
      setCaret(s.end);
      ta.scrollTop = ta.scrollHeight;
      if (document.activeElement !== ta && !voiceFocusAppliedRef.current) {
        voiceFocusAppliedRef.current = true; // focus once per recording, at the first words
        ta.focus();
      }
      if (document.activeElement === ta) ta.setSelectionRange(s.end, s.end);
    });
  }, []);

  // Undo everything dictation put in the box (push-to-talk aborted).
  const removeVoiceSpan = useCallback(() => {
    const span = voiceSpanRef.current;
    const rendered = voiceRenderedRef.current;
    voiceSpanRef.current = null;
    voiceRenderedRef.current = "";
    voiceCommittedRef.current = "";
    voicePartialRef.current = "";
    voiceFocusAppliedRef.current = false;
    if (!span || !rendered) return;
    setContent((prev) =>
      prev.slice(span.start, span.end) === rendered
        ? prev.slice(0, span.start) + prev.slice(span.end)
        : prev,
    );
  }, []);

  // Hand the current segment to the commit chain: swap it out, transcribe,
  // and append its text to the draft as stable committed words. The chain is
  // the record now — commits keep landing after stop (only cancel/re-begin
  // disarm them via commitArmRef), so they must not check the recording
  // generation or the segment gen: a later flush overlapping an in-flight
  // commit would silently drop that segment's words. A failure latches
  // commitFailedRef so stop's repair pass can fill the gap.
  const flushVoiceSegment = useCallback(() => {
    const chunks = segmentRef.current;
    if (chunks.length === 0) return;
    segmentRef.current = [];
    segmentLenRef.current = 0;
    silenceRunRef.current = 0;
    segmentHadSoundRef.current = false;
    segmentGenRef.current += 1;
    const arm = commitArmRef.current;
    // The partial in flight (if any) was transcribing the segment just
    // swapped out — stale now, and its result would be dropped. Cancel it so
    // this commit doesn't queue behind wasted server work.
    if (partialInFlightRef.current) {
      cancelTranscription("partial").catch(() => {});
    }
    pendingCommitsRef.current += 1;
    commitChainRef.current = commitChainRef.current.then(async () => {
      const t0 = performance.now();
      try {
        const wav = encodeWav16k(joinSamples(chunks, rateRef.current));
        const res = await transcribeAudio(await blobToBase64(wav), "audio/wav", "commit");
        if (arm !== commitArmRef.current) return;
        const text = res?.text ? flattenVoiceText(res.text) : "";
        if (text) {
          voiceCommittedRef.current = voiceCommittedRef.current
            ? `${voiceCommittedRef.current} ${text}`
            : text;
          voicePartialRef.current = "";
          renderVoiceText();
        }
        voiceLog(
          `[voice] commit ${Math.round(performance.now() - t0)}ms for ${chunkSeconds(chunks, rateRef.current).toFixed(1)}s audio`,
        );
      } catch {
        voiceLog(`[voice] commit failed after ${Math.round(performance.now() - t0)}ms`);
        // Best-effort: the ghost text (if any) stays on screen, and stop's
        // repair pass fills the gap.
        commitFailedRef.current = true;
      } finally {
        pendingCommitsRef.current -= 1;
      }
    });
  }, [renderVoiceText]);

  const finishVoiceRecording = useCallback(async () => {
    if (!recordingRef.current) return;
    generationRef.current += 1; // disarm live partials — their results drop via the gen check
    stopCapture();
    setRecording(false);
    // Hand the trailing (never-paused) segment to the commit chain, then wait
    // out every commit — in-flight ones included — before finalizing. The old
    // always-on full-clip re-transcription is gone: it queued behind the
    // partial pile-up AND re-decoded the whole session, so the last line
    // froze for ages after stop. Commit results keep landing past this point
    // (commitArmRef is deliberately not bumped); they now carry the text.
    if (segmentHadSoundRef.current) {
      voiceLog(
        `[voice] ${new Date().toISOString().slice(11, 23)} stop: flushing trailing segment (${(segmentLenRef.current / rateRef.current).toFixed(1)}s audio), ${pendingCommitsRef.current} commit(s) already pending, visibility=${document.visibilityState}, focus=${document.hasFocus()}`,
      );
      flushVoiceSegment();
    }
    const chunks = samplesRef.current;
    samplesRef.current = [];
    segmentRef.current = [];
    segmentLenRef.current = 0;
    // Segment text already sits in the box and stays visible through the
    // repair pass — and survives it if the pass fails or comes back empty.
    if (chunks.length === 0) return;
    try {
      // The trailing segment was just queued above and earlier commits may
      // still be in flight: keep the mic spinner on while the last text is
      // landing, and only when something is actually pending (a settled
      // chain must not flash the spinner for a frame).
      if (pendingCommitsRef.current > 0) setTranscribing(true);
      const settleT0 = performance.now();
      await commitChainRef.current;
      voiceLog(`[voice] stop: commits settled ${Math.round(performance.now() - settleT0)}ms after flush`);
      if (commitFailedRef.current) {
        // Some segment commit failed, so words may be missing from the box.
        // Fall back to the polished full-clip pass to repair the text —
        // normally (every commit succeeded) this O(session) cost is skipped.
        setTranscribing(true);
        const repairT0 = performance.now();
        const wav = encodeWav16k(joinSamples(chunks, rateRef.current));
        const res = await transcribeAudio(await blobToBase64(wav), "audio/wav");
        const text = res?.text ? flattenVoiceText(res.text) : "";
        if (text) {
          // One polished full-clip pass replaces the pause-by-pause segments.
          voiceCommittedRef.current = text;
          voicePartialRef.current = "";
          renderVoiceText();
        }
        voiceLog(`[voice] repair pass ${Math.round(performance.now() - repairT0)}ms for ${chunkSeconds(chunks, rateRef.current).toFixed(1)}s audio`);
      }
    } catch {
      toastError(
        "Speech-to-text failed partway — the text already in the box is kept, but some words may be missing. Check Settings → Local Models → Speech if this keeps happening.",
      );
    } finally {
      setTranscribing(false);
      // Whatever the box holds is ordinary draft text now.
      voiceSpanRef.current = null;
      voiceRenderedRef.current = "";
      voiceCommittedRef.current = "";
      voicePartialRef.current = "";
    }
  }, [flushVoiceSegment, renderVoiceText, stopCapture]);

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
        segmentRef.current.push(data);
        segmentLenRef.current += data.length;
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
        const rms = Math.sqrt(sum / data.length);
        levelRef.current = levelRef.current * 0.7 + rms * 0.3;
        // Silence-gap detection: ~0.77s of quiet ends a dictation segment,
        // committing its words into the draft so they can never vanish when
        // speech continues past the live-partial span.
        if (rms < 0.008) {
          silenceRunRef.current += 1;
          if (
            silenceRunRef.current >= VOICE_SILENCE_CHUNKS &&
            segmentLenRef.current > 0 &&
            segmentHadSoundRef.current
          ) {
            flushVoiceSegment();
          }
        } else {
          silenceRunRef.current = 0;
          segmentHadSoundRef.current = true;
        }
      };
      source.connect(processor);
      processor.connect(sink);
      sink.connect(ac.destination);
      captureCtxRef.current = ac;
      captureNodesRef.current = { source, processor, sink };
      captureStreamRef.current = stream;

      samplesRef.current = [];
      segmentRef.current = [];
      segmentLenRef.current = 0;
      silenceRunRef.current = 0;
      segmentHadSoundRef.current = false;
      levelRef.current = 0;
      voiceFocusAppliedRef.current = false;
      // Fresh session: commits still in flight from the previous one must not
      // land here, and a hung partial from it must not block this one.
      commitArmRef.current += 1;
      commitFailedRef.current = false;
      partialInFlightRef.current = false;
      recordingRef.current = true;
      setRecording(true);

      // Live partials: re-transcribe the un-committed segment every tick and
      // re-render it in place in the textarea. Each request is tagged with
      // both the recording generation (dropped after stop/cancel/restart)
      // and the segment generation (dropped if a silence flush swapped the
      // segment mid-request — the commit path owns that text instead).
      partialTimerRef.current = window.setInterval(() => {
        const recGen = generationRef.current;
        const segGen = segmentGenRef.current;
        // A segment that never pauses is force-committed at the cap so the
        // next live partial starts small again.
        if (segmentLenRef.current >= SEGMENT_MAX_SECONDS * rateRef.current) {
          flushVoiceSegment();
          return;
        }
        if (segmentLenRef.current === 0) return; // committed text stays put
        // The server transcribes one request at a time, so a second queued
        // partial would only delay the segment commits behind it — skip the
        // tick while one is still out. Stale results were already dropped
        // via the gen checks below.
        if (partialInFlightRef.current) return;
        partialInFlightRef.current = true;
        void (async () => {
          const t0 = performance.now();
          try {
            const segSamples = segmentRef.current.reduce((n, c) => n + c.length, 0);
            const wav = encodeWav16k(joinSamples(segmentRef.current, rateRef.current));
            const res = await transcribeAudio(await blobToBase64(wav), "audio/wav", "partial");
            if (generationRef.current !== recGen || segGen !== segmentGenRef.current) return;
            voicePartialRef.current = res?.text ? flattenVoiceText(res.text) : "";
            renderVoiceText();
            voiceLog(
              `[voice] partial ${Math.round(performance.now() - t0)}ms for ${(segSamples / rateRef.current).toFixed(1)}s audio`,
            );
          } catch {
            voiceLog(`[voice] partial dropped/cancelled after ${Math.round(performance.now() - t0)}ms`);
            // Partials are best-effort — the commit chain owns the real text.
          } finally {
            partialInFlightRef.current = false;
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
  }, [transcribing, finishVoiceRecording, flushVoiceSegment, renderVoiceText]);

  // Discard the current clip without transcribing — push-to-talk aborted
  // because a real shortcut (Alt+Tab, Alt+arrows, …) joined the hold. The
  // words already spliced into the draft are undone with it.
  const cancelVoiceRecording = useCallback(() => {
    if (!recordingRef.current) return;
    generationRef.current += 1;
    // Disarm in-flight/queued commits too — an aborted take must never insert
    // text later. Stop deliberately skips this: there, commits are the record.
    commitArmRef.current += 1;
    // Free the serial server as well: any commit still running would be
    // dropped by the arm check above, so let it stop early.
    cancelTranscription("commit").catch(() => {});
    stopCapture();
    setRecording(false);
    removeVoiceSpan();
    samplesRef.current = [];
    segmentRef.current = [];
    segmentLenRef.current = 0;
  }, [removeVoiceSpan, stopCapture]);

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
    // Split view mounts TWO composers in one document; the Alt handlers are
    // window-global, so a single press used to start recording in BOTH — two
    // mic captures and the dictated text spliced into both panes. Only the
    // FOCUSED chat's composer may react (read via getState so the listeners
    // don't need re-registering on focus change).
    const isFocusedChat = () => {
      const s = useChatStore.getState();
      const focused = s.focusedChatSessionId ?? s.activeChatSessionId;
      return focused === effectiveSessionId;
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Alt") {
        if (!isFocusedChat()) return;
        // Ignore AltGr (reports as Ctrl+Alt on intl layouts) and shortcuts
        // already in flight — only a solo Alt press starts dictation.
        if (e.ctrlKey || e.metaKey || e.repeat) return;
        // Suppress the default: an Alt release otherwise toggles Win32 menu
        // mode, whose modal loop stalls the whole WebView2 transport —
        // dictation results sat 10-30s undelivered until the next click
        // dismissed the menu mode (the "app freezes, click fixes it" bug).
        e.preventDefault();
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
      // See onKeyDown: the release must not reach the default menu-mode toggle.
      e.preventDefault();
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
    setCaret(draft.text.length);
    const ta = textareaRef.current;
    if (ta) {
      ta.focus();
      const end = draft.text.length;
      requestAnimationFrame(() => ta.setSelectionRange(end, end));
    }
  }, [draft?.nonce]);

  // Auto-grow the textarea as the user types, clamped to the CSS max-height
  // (200px) — taller content scrolls inside the box. The "auto" reset before
  // measuring is required for shrink detection (a clamped textarea reports
  // scrollHeight = its own height, so shrunken content would never shrink the
  // box). It must ALWAYS be followed by restoring a concrete height: an earlier
  // perf guard skipped the restore when the computed height was unchanged,
  // which is precisely the hit-the-ceiling-then-keep-typing case — the inline
  // height stayed `auto` (one row) and the composer collapsed.
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
      try {
        const attachment = await fileToAttachment(file);
        setAttachments((prev) =>
          // Dedupe on name AND size: two different files can share a name
          // (`Screenshot.png` from two folders) — only an exact name+size
          // match is the same file re-selected.
          prev.some((a) => a.name === file.name && (a.size ?? -1) === file.size)
            ? prev
            : [...prev, attachment],
        );
      } catch (e) {
        setAttachError(e instanceof Error && e.message ? e.message : `Could not read ${file.name}`);
      }
    }
  }, []);

  // Long pasted text arrives as clipboard TEXT (no file), but a wall of
  // inline text wrecks the draft and the sent bubble. Above the threshold it
  // becomes a text document card instead — same pipeline as an attached .txt,
  // so size caps apply and the sent message renders a document card.
  const attachPastedText = useCallback(async (text: string) => {
    setAttachError(null);
    try {
      const parsed = await fileToAttachment(
        new File([text], "Pasted text.txt", { type: "text/plain" }),
      );
      setAttachments((prev) => {
        // Same name+size = the same content re-pasted — dedupe. A DIFFERENT
        // long text while one is already attached gets a numbered name, or
        // the name+size dedupe would silently swallow it.
        let attachment = parsed;
        if (prev.some((a) => a.name === parsed.name && (a.size ?? -1) !== parsed.size)) {
          let n = 2;
          while (prev.some((a) => a.name === `Pasted text ${n}.txt`)) n++;
          attachment = { ...parsed, name: `Pasted text ${n}.txt` };
        }
        if (prev.some((a) => a.name === attachment.name && (a.size ?? -1) === attachment.size)) {
          return prev;
        }
        return [...prev, attachment];
      });
    } catch (e) {
      setAttachError(e instanceof Error && e.message ? e.message : "Could not attach pasted text");
    }
  }, []);

  // Paste-to-attach: a screenshot (or any copied image) lands on the
  // clipboard as a file, and so do files copied from the OS file manager.
  // When a paste carries ANY file, intercept it and run the same handleFiles
  // path as the "+" picker; text-only pastes keep the default insert unless
  // they are long enough to become a document card (attachPastedText).
  // Intercepting on the mere presence of files matters because an image+HTML
  // clipboard (copying from Word/browsers) would otherwise paste markup into
  // the draft and drop the image.
  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const clipboard = e.clipboardData;
      const files = clipboard?.files;
      if (files && files.length > 0) {
        e.preventDefault();
        void handleFiles(files);
        return;
      }
      const text = clipboard?.getData("text/plain") ?? "";
      if (text.length >= PASTE_TEXT_DOCUMENT_CHARS) {
        e.preventDefault();
        void attachPastedText(text);
      }
    },
    [handleFiles, attachPastedText],
  );

  // OS drag-and-drop attach: dropping files anywhere on the composer card
  // routes through the same handleFiles path as the "+" picker and paste.
  // REQUIRES the Tauri window to run with dragDropEnabled: false
  // (tauri.conf.json) — with Tauri's own drag-drop interception on, WebView2
  // swallows file drags and these DOM events never fire. The dragover gate
  // on the DataTransfer `types` keeps text/URL drags from lighting the card
  // up or blocking their default (the in-card attachment reorder is
  // pointer-driven and never fires HTML5 drag events, so it can't collide).
  // preventDefault on drop matters — the webview's default for a file drop
  // is to OPEN the file, replacing the app (main.tsx guards the surfaces
  // outside this card the same way).
  const [filesDragOver, setFilesDragOver] = useState(false);
  const composerDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!Array.from(e.dataTransfer.types).includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setFilesDragOver(true);
  }, []);
  const composerDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    // Crossing child elements fires dragleave per element — only clear the
    // highlight when the pointer actually left the card (relatedTarget is
    // null/undefined at the window boundary).
    const related = e.relatedTarget as Node | null | undefined;
    if (!related || !e.currentTarget.contains(related)) {
      setFilesDragOver(false);
    }
  }, []);
  const composerDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      setFilesDragOver(false);
      if (!e.dataTransfer.files?.length) return;
      e.preventDefault();
      void handleFiles(e.dataTransfer.files);
    },
    [handleFiles],
  );

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
    // sessionIdProp: ChatView passes the ACTIVE session id, which changes
    // without a remount (session switch) — a stale closure here would write
    // /create messages, proposals and artifacts into the previous chat.
  }, [sessionIdProp]);

  const handleSend = useCallback(() => {
    if (needsModel || agentLocked) return;
    // The command pill contributes its `/slug` token to the message text so
    // every downstream parser (invoked skills, /create routing) sees the same
    // content it would have seen with a plain-text token.
    // Quoted selections (the selection toolbar's "Ask") ride ABOVE the
    // composer and prepend to the outgoing message — the typed draft is never
    // touched. A quote keeps the composed text from leading with a slash
    // token, so quoting text before "/compact" or "/create" stays a normal
    // quoted turn rather than invoking the command.
    const base = (commandPill ? `/${commandPill.slug} ${content}` : content).trim();
    const quoted = (quotedSelections ?? [])
      .map((q) => q.text.trim())
      .filter(Boolean)
      .join("\n\n");
    const trimmed = quoted ? (base ? `${quoted}\n\n${base}` : quoted) : base;
    if (!trimmed && attachments.length === 0) return;

    // --- /compact: universal context compaction, routed by engine ---
    // CLI harness sessions: forwarded verbatim — the CLI runs its own
    // native /compact. Cloud and local sessions: Relay's own compaction
    // (chat_compact_now — pin+summarize via the session's provider or the
    // sidecar) instead of sending the literal text to the model.
    if (/^\/compact\b/.test(trimmed) && !isHarnessSession) {
      setContent("");
      setCommandPill(null);
      setAttachments([]);
      setAttachError(null);
      setForceResearch(false);
      const ta = textareaRef.current;
      if (ta) ta.style.height = "auto";
      if (!effectiveSessionId) return;
      void compactNow(effectiveSessionId)
        .then((msg) => toastSuccess(msg || "Context compacted"))
        .catch((e) => toastError("Compact failed", e));
      return;
    }

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
    onClearQuotedSelections?.();
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
  }, [content, commandPill, attachments, onSend, needsModel, agentLocked, forceResearch, detectArtifactIntent, triggerArtifactGeneration, isHarnessSession, effectiveSessionId, quotedSelections, onClearQuotedSelections]);

  // Handle ArtifactTypeSelector selection
  const handleCreateTypeSelect = useCallback((type: ArtifactType, instruction?: string) => {
    setCreateTypeOpen(false);
    void triggerArtifactGeneration(type, instruction || createInstruction || "Generate a " + type);
    setCreateInstruction("");
  }, [createInstruction, triggerArtifactGeneration]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // An IME composition's confirming Enter/Tab (CJK input; keyCode 229)
      // must commit the composition, not send the half-composed text or
      // apply a popup item.
      if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
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
          // Dismiss the popup without touching the draft — wiping the whole
          // content destroyed unrelated text once the menu could open
          // mid-sentence.
          if (slashToken) setSlashDismissed(dismissKey(slashToken));
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
          if (atToken) setAtDismissed(dismissKey(atToken));
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
    [disabled, needsModel, agentLocked, handleSend, slashOpen, slashFiltered, slashIndex, applySlashItem, atOpen, atFiltered, atIndex, applyAttachSource, content, commandPill, slashToken, atToken, dismissKey],
  );

  // Quotes stacked above the composer count as sendable content: with a quote
  // present, Send/Enter works even with an empty textarea.
  const isEmpty =
    !content.trim() && attachments.length === 0 && !(quotedSelections && quotedSelections.length > 0);
  // The combined agent/model chip shows whenever there's an active session
  // (agent !== undefined), including the no-agent-picked state.
  const showAgentSelector = agent !== undefined && !!onAgentModelPick;
  // MEMOIZED prop object for ComposerMetrics: a fresh object literal per
  // render would defeat that component's memo and re-render the whole HUD
  // (chips + context meter) on every keystroke.
  const contextMeterProps = useMemo(
    () => ({
      usedTokens: usedTokens ?? null,
      model,
      provider,
      isLocal: provider === "local_gguf",
      localCtx,
      liveMaxTokens,
      // Split view: THIS pane's session, not the globally active one — the
      // meter/hud must not read the main chat's perf + context telemetry.
      chatSessionId: effectiveSessionId,
      contextLimitOverride,
      pinnedWindow: pinnedWindow > 0 ? pinnedWindow : undefined,
    }),
    [usedTokens, model, provider, localCtx, liveMaxTokens, effectiveSessionId, contextLimitOverride, pinnedWindow],
  );
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
      {quotedSelections && quotedSelections.length > 0 && (
        <div className="composer-quotes" aria-label="Quoted selections">
          {quotedSelections.map((q) => (
            <QuotedSelectionRow
              key={q.id}
              quote={q}
              onRemove={() => onRemoveQuotedSelection?.(q.id)}
            />
          ))}
        </div>
      )}
      <div
        className={`chat-composer-card${modeGlowClass}${filesDragOver ? " is-drop-target" : ""}`}
        onDragOver={composerDragOver}
        onDragLeave={composerDragLeave}
        onDrop={composerDrop}
      >
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
            <span className="composer-token-row">
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
          {/* The command/@ decks are rendered at .chat-composer level (see
              below) — inside the card their backdrop blur was dead, and a
              document.body portal broke under the chat zoom scale. */}
          <textarea
            ref={textareaRef}
            className="chat-composer-textarea"
            dir="auto"
            placeholder={
              streaming
                ? "keep typing to queue follow-up changes"
                : agentLocked
                  ? "Ask anything, or select an agent to customize performance…"
                  : "Write a message…  / for skills · @ for apps"
            }
            value={content}
            onChange={(e) => {
              setContent(e.target.value);
              setCaret(e.target.selectionStart ?? e.target.value.length);
            }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
            onPaste={handlePaste}
            onKeyDown={handleKeyDown}
            rows={1}
            disabled={disabled}
          />
        </div>
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
                harnessEffort={harnessEffort}
                onHarnessEffortChange={onHarnessEffortChange}
                autoBias={autoBias}
                onAutoBiasChange={onAutoBiasChange}
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
          chatSessionId={effectiveSessionId}
          streaming={streaming}
          variant="hud"
          contextMeter={contextMeterProps}
        />
      </div>
      {/* Command (@/slash) decks — children of .chat-composer, NOT the card:
          inside .chat-composer-card they were trapped in its backdrop-filter
          root (blur silently dead), and a document.body portal broke under
          the chat zoom scale. From here they anchor to the card with plain
          CSS (see .chat-composer > .composer-slash-menu) and blur for real. */}
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
                ref={i === slashIndex ? slashActiveRef : undefined}
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
              ref={i === atIndex ? atActiveRef : undefined}
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

// Public surface re-exported (tests import these from here).
export {
  classifyAttachment,
  fileToAttachment,
  parseCreateCommand,
  isBareCreateCommand,
  tokenAtCaret,
  detectArtifactIntent,
} from './composerShared';
import {
  classifyAttachment,
  fileToAttachment,
  parseCreateCommand,
  isBareCreateCommand,
  tokenAtCaret,
  detectArtifactIntent,
  FolderIcon,
  pathBasename,
  NO_QUEUED_MESSAGES,
  voiceLog,
  flattenVoiceText,
  chunkSeconds,
  VOICE_SILENCE_CHUNKS,
  SEGMENT_MAX_SECONDS,
  PARTIAL_TICK_MS,
  PASTE_TEXT_DOCUMENT_CHARS,
  AttachmentCard,
  ResearchIcon,
  AttachmentIcon,
  type ChatAttachment,
} from './composerShared';
export type { ChatAttachment } from './composerShared';
