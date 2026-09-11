// composerShared — pure helpers, size limits, slash-command parsers,
// attachment classification/encoding, and the small composer chrome
// components (AttachmentCard + the folder/research/attachment icons).
// Extracted from ChatComposer.tsx; ChatComposer re-exports the public
// names so existing importers keep working.
import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import type { ArtifactType } from "../../lib/ipc";
import { toastError } from "../../lib/ipc";

export const MAX_TEXT_BYTES = 512 * 1024;
export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
export const MAX_DOC_BYTES = 10 * 1024 * 1024;
// A paste this large stops being a sentence and becomes a document: it turns
// into a "Pasted text.txt" attachment card (which the sent message renders as
// a document card with a content preview) instead of a wall of inline text in
// the draft and the bubble.
export const PASTE_TEXT_DOCUMENT_CHARS = 1200;

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
 *  typoed `/create artifect` with no recognized subtype. */
export const isBareCreateCommand = (text: string): boolean => {
  const t = text.trim().toLowerCase();
  return t === "/create" || t === "/create artifact" || t === "/create artifect" || t === "/create-artifact";
};

/** The partial `/` or `@` token under the caret, if any. The marker must
 *  START a word (line start or right after whitespace) and run unbroken to
 *  the caret — so `/ski` mid-sentence opens the skill menu, while an email
 *  like `a/b` or a URL path never does. `end` always equals the (clamped)
 *  caret; `start` points at the marker character itself. */
export const tokenAtCaret = (
  text: string,
  caret: number,
  marker: "/" | "@",
): { query: string; start: number; end: number } | null => {
  const pos = Math.max(0, Math.min(caret, text.length));
  const m = new RegExp(`(?:^|\\s)\\${marker}(\\S*)$`).exec(text.slice(0, pos));
  if (!m) return null;
  return {
    query: m[1].toLowerCase(),
    start: m.index + m[0].length - m[1].length - 1,
    end: pos,
  };
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

export const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp"];
export const DOC_EXTS = ["docx", "pptx", "xlsx", "pdf", "doc", "ppt", "xls"];

/** Which attachment bucket a File falls into — shared by the "+" picker, the
 *  paste path, and OS drag-and-drop so all three can never drift. Images match
 *  by extension OR a non-SVG image MIME (a pasted screenshot carries
 *  "image/png" but often only the generic name "image.png"); docs match by
 *  extension; everything else is read as text (binary content is rejected
 *  later by the NUL sniff). */
export function classifyAttachment(file: { name: string; type: string }): {
  kind: ChatAttachment["kind"];
  ext: string;
} {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (
    IMAGE_EXTS.includes(ext) ||
    (file.type.startsWith("image/") && file.type !== "image/svg+xml")
  ) {
    return { kind: "image", ext };
  }
  if (DOC_EXTS.includes(ext)) return { kind: "doc", ext };
  return { kind: "text", ext };
}

/** Short type badge shown on the attachment card (e.g. "PDF", "IMAGE"). */
export function attachmentBadge(a: ChatAttachment): string {
  if (a.kind === "image") return "IMAGE";
  if (a.kind === "doc") return (a.format ?? "DOC").toUpperCase();
  const ext = a.name.includes(".") ? a.name.split(".").pop() ?? "" : "";
  return (ext || "TEXT").toUpperCase();
}

export function AttachmentIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}

/** Magnifier icon for the "Research" menu option + active chip. */
export function ResearchIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

/** Folder icon for the "Choose working folder" menu option + the notch chip. */
export function FolderIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}

/** Basename of a filesystem path (last non-empty segment), both separators. */
export function pathBasename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  return trimmed.split(/[\\/]/).pop() || trimmed;
}

/** Live-partial cadence and segment limits. While the mic is open the
 *  un-committed segment is re-transcribed every 1.5s so dictated text lands
 *  in the textarea as you speak; a ~0.77s pause (3 audio chunks) commits the
 *  segment, and a segment with no pause at all is force-committed at 20s to
 *  bound each request's cost. */
export const PARTIAL_TICK_MS = 1500;
export const VOICE_SILENCE_CHUNKS = 3;
export const SEGMENT_MAX_SECONDS = 20;

/** Whisper was trained on subtitle-style transcripts and sprinkles newline
 *  tokens at segment boundaries — mid-flow, semi-random — plus bracketed
 *  non-speech markers ([BLANK_AUDIO], [MUSIC], …) for quiet tails. Flatten
 *  both away into one predictable paragraph; the composer soft-wraps. */
export function flattenVoiceText(text: string): string {
  return text
    .replace(/\s*\[[^\]]*\]\s*/g, " ")
    .replace(/\s*\n+\s*/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();
}

/** Diagnostics helper: seconds of audio in a captured chunk list (the list's
 *  `.length` is the CHUNK count — chunks are 256ms each at 16 kHz — so sum
 *  the samples, never divide the count). */
export function chunkSeconds(chunks: Float32Array[], rate: number): number {
  return chunks.reduce((n, c) => n + c.length, 0) / rate;
}

/** Dictation diagnostics — dev builds only (these lines diagnosed the
 *  Alt-release menu-mode IPC stall; keep them for the next one). */
export const voiceLog = (...args: unknown[]) => {
  if (import.meta.env.DEV) console.info(...args);
};

/** Stable empty list for the queue selector (a fresh [] per call would make
 *  every store change re-render the composer). */
export const NO_QUEUED_MESSAGES: import("../../state/chat").QueuedChatMessage[] = [];

/** Compact attachment card shown in the composer before sending — a file
 *  icon, the (truncated) name, a type badge, and a remove button. */
export function AttachmentCard({
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
export function readAsBase64(file: File): Promise<string> {
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

/** Turn one picked or pasted File into a ChatAttachment. Throws with a
 *  user-facing message when the file is over its kind's size cap, decodes as
 *  binary on the text path, or can't be read at all. */
export async function fileToAttachment(file: File): Promise<ChatAttachment> {
  const { kind, ext } = classifyAttachment(file);
  const limit =
    kind === "image" ? MAX_IMAGE_BYTES : kind === "doc" ? MAX_DOC_BYTES : MAX_TEXT_BYTES;
  if (file.size > limit) {
    throw new Error(`${file.name} is too large (max ${Math.round(limit / 1024 / 1024)} MB)`);
  }
  if (kind === "image") {
    return {
      name: file.name,
      size: file.size,
      kind: "image",
      data: await readAsBase64(file),
      mediaType: file.type || `image/${ext === "jpg" ? "jpeg" : ext}`,
    };
  }
  if (kind === "doc") {
    return { name: file.name, size: file.size, kind: "doc", data: await readAsBase64(file), format: ext };
  }
  const text = await file.text();
  // NUL bytes are the tell for binary content decoded as text — a pasted OS
  // file with an unregistered extension (an .exe, a font) lands here. Reject
  // it instead of inlining mojibake into the prompt.
  if (text.includes("\u0000")) {
    throw new Error(`${file.name} is not a supported attachment type`);
  }
  return { name: file.name, size: file.size, kind: "text", text };
}
