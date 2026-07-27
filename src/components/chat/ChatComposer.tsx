// Chat composer, Claude-style: a single rounded card with the textarea on
// top and a footer row below — "+" attach button on the left, model/effort
// pill and a circular ↑ send button on the right.
// Enter sends; Shift+Enter inserts a newline.
// Attachments: images are sent as vision input, docx/pptx/xlsx/pdf and legacy
// doc/ppt/xls are extracted to text server-side, and plain-text files are
// inlined into the message.
import { useCallback, useEffect, useRef, useState } from "react";
import { ModelEffortMenu } from "./ModelEffortMenu";
import { PermissionModeMenu } from "./PermissionModeMenu";
import type { PermissionMode } from "../../state/chat";
import { getSetting, listConnectors, listSessionConnectors, setSessionConnectors, type ConnectorWithStatus } from "../../lib/ipc";
import { skillCommand } from "../../lib/skillCommands";

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

/** Plug icon for the "Attach a connector" menu item. */
function ConnectorsIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 2v6a4 4 0 0 0 4 4h0a4 4 0 0 0 4-4V2" />
      <path d="M15 22v-6a4 4 0 0 0-4-4h0a4 4 0 0 0-4 4v6" />
    </svg>
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
  /** Per-session filesystem permission posture. The selector is hidden when
   *  undefined (no active session). */
  permissionMode?: PermissionMode;
  onPermissionModeChange?: (mode: PermissionMode) => void;
  /** Active chat session id — used to load + persist the per-conversation
   *  connector opt-in (attached connectors are scoped to this session only). */
  chatSessionId?: string;
}

export function ChatComposer({
  onSend,
  onStop,
  streaming,
  disabled,
  draft,
  model,
  models,
  localModels,
  effort,
  provider,
  localCtx,
  modelLoading,
  onModelChange,
  onEffortChange,
  onLocalCtxChange,
  permissionMode,
  onPermissionModeChange,
  chatSessionId,
}: Props) {
  const [content, setContent] = useState("");
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  // Connected connectors available to attach (loaded once per session change;
  // only connected ones are eligible for per-conversation opt-in).
  const [connectors, setConnectors] = useState<ConnectorWithStatus[]>([]);
  // Connector ids attached to THIS conversation (per-session opt-in).
  const [attachedConnectors, setAttachedConnectors] = useState<string[]>([]);
  const [connectorsMenuOpen, setConnectorsMenuOpen] = useState(false);
  const connectorsMenuRef = useRef<HTMLDivElement>(null);
  // Whether the next send should force research mode (set via the "+"
  // menu's "Research" option). Stays on only for the next send, then resets.
  const [forceResearch, setForceResearch] = useState(false);
  // Popover for the "+" attach/attach-research menu.
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const attachMenuRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Slash-command skill popup: typing "/" as the first character opens a list
  // of enabled skills (from the Assistant settings tab); picking one inserts
  // its `/command` token, which the backend uses to inject that skill's
  // instructions for this turn only.
  interface SlashSkill {
    name: string;
    command: string;
  }
  const [slashSkills, setSlashSkills] = useState<SlashSkill[]>([]);
  const [slashIndex, setSlashIndex] = useState(0);

  // The popup is active while the whole content is a partial first token
  // starting with "/" (no space typed yet).
  const slashQuery = /^\/(\S*)$/.exec(content)?.[1]?.toLowerCase() ?? null;
  const slashOpen = slashQuery !== null;

  // (Re)load the enabled skills every time the popup opens, so edits made in
  // Settings → Assistant are picked up immediately.
  useEffect(() => {
    if (!slashOpen) return;
    let stale = false;
    void getSetting("assistant.skills").then((raw) => {
      if (stale) return;
      const list: SlashSkill[] = [];
      try {
        const parsed = raw ? (JSON.parse(raw) as unknown[]) : [];
        if (Array.isArray(parsed)) {
          for (const s of parsed) {
            const item = s as { name?: string; command?: string; enabled?: boolean };
            if (item && item.enabled !== false) {
              const command = skillCommand({
                name: item.name ?? "",
                command: item.command,
              });
              if (command) list.push({ name: item.name ?? command, command });
            }
          }
        }
      } catch {
        /* corrupt setting — no skills */
      }
      setSlashSkills(list);
    });
    return () => {
      stale = true;
    };
  }, [slashOpen]);

  const slashFiltered = slashQuery !== null
    ? slashSkills.filter(
        (s) =>
          s.command.startsWith(slashQuery) ||
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

  // Load connected connectors + this session's attached set when the session
  // changes. Attached connectors are per-conversation (persisted in
  // chat_session_connectors); only connected ones are eligible to attach.
  useEffect(() => {
    void listConnectors().then((cs) => {
      setConnectors((cs ?? []).filter((c) => c.status.connected));
    });
    if (!chatSessionId) {
      setAttachedConnectors([]);
      return;
    }
    void listSessionConnectors(chatSessionId).then((ids) => {
      setAttachedConnectors(ids ?? []);
    });
  }, [chatSessionId]);

  // Close the connectors submenu on outside click.
  useEffect(() => {
    if (!connectorsMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (connectorsMenuRef.current && !connectorsMenuRef.current.contains(e.target as Node)) {
        setConnectorsMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [connectorsMenuOpen]);

  const toggleConnector = useCallback(
    (id: string) => {
      if (!chatSessionId) return;
      setAttachedConnectors((prev) => {
        const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
        void setSessionConnectors(chatSessionId, next);
        return next;
      });
    },
    [chatSessionId],
  );

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

  const handleSend = useCallback(() => {
    if (needsModel) return;
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
  }, [content, attachments, onSend, needsModel, forceResearch]);

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
          applySlashCommand(slashFiltered[Math.min(slashIndex, slashFiltered.length - 1)].command);
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
        if (!disabled && !streaming && !needsModel) {
          handleSend();
        }
      }
    },
    [disabled, streaming, needsModel, handleSend, slashOpen, slashFiltered, slashIndex, applySlashCommand],
  );

  const isEmpty = !content.trim() && attachments.length === 0;
  const showSelector = model !== undefined && onModelChange && onEffortChange;
  // The selector shows whenever there's an active session with a mode.
  const showModeSelector = permissionMode !== undefined && onPermissionModeChange;
  // A colored border/glow on the composer whenever a non-default posture is
  // active, so it's never ambiguous which mode governs tool calls.
  const modeGlowClass =
    permissionMode && permissionMode !== "manual" ? ` composer-mode-${permissionMode}` : "";

  return (
    <div className="chat-composer">
      <div className={`chat-composer-card${modeGlowClass}`}>
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
                  key={s.command}
                  type="button"
                  role="option"
                  aria-selected={i === slashIndex}
                  className={`composer-slash-item${i === slashIndex ? " active" : ""}`}
                  // onMouseDown + preventDefault keeps textarea focus.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    applySlashCommand(s.command);
                  }}
                  onMouseEnter={() => setSlashIndex(i)}
                >
                  <span className="composer-slash-cmd">/{s.command}</span>
                  <span className="composer-slash-name">{s.name}</span>
                </button>
              ))}
            </div>
          )}
          <textarea
            ref={textareaRef}
            className="chat-composer-textarea"
            placeholder="Write a message…  type / for skills"
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
                <button
                  type="button"
                  className="composer-attach-menu-item"
                  role="menuitem"
                  disabled={connectors.length === 0}
                  title={connectors.length === 0 ? "Connect an account in Settings → Connectors first" : "Attach a connected account to this conversation"}
                  onClick={() => {
                    setAttachMenuOpen(false);
                    setConnectorsMenuOpen((o) => !o);
                  }}
                >
                  <ConnectorsIcon />
                  <span>
                    {attachedConnectors.length > 0
                      ? `Connectors (${attachedConnectors.length} attached)`
                      : "Attach a connector"}
                  </span>
                </button>
              </div>
            )}
          </div>
          {connectorsMenuOpen && (
            <div className="composer-attach-menu composer-connectors-menu" ref={connectorsMenuRef} role="menu">
              {connectors.map((c) => {
                const on = attachedConnectors.includes(c.id);
                return (
                  <button
                    key={c.id}
                    type="button"
                    className="composer-attach-menu-item"
                    role="menuitemcheckbox"
                    aria-checked={on}
                    onClick={() => toggleConnector(c.id)}
                  >
                    <span className="connector-icon" aria-hidden>{c.icon}</span>
                    <span>{c.displayName}</span>
                    <span className={`connector-toggle${on ? " on" : ""}`}>{on ? "✓" : ""}</span>
                  </button>
                );
              })}
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
          {!attachError && needsModel && (
            <span className="composer-model-hint">Select a model to start</span>
          )}
          <div className="composer-footer-spacer" />
          {showSelector && (
            <ModelEffortMenu
              model={model}
              models={models ?? []}
              localModels={localModels ?? []}
              effort={effort ?? ""}
              provider={provider}
              modelLoading={modelLoading}
              localCtx={localCtx}
              onModelChange={onModelChange}
              onEffortChange={onEffortChange}
              onLocalCtxChange={onLocalCtxChange}
            />
          )}
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
              disabled={isEmpty || disabled || needsModel}
              title={needsModel ? "Select a model first" : "Send message"}
              aria-label="Send message"
            >
              ↑
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
