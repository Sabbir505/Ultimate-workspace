// Visual attachments rendered ABOVE the message text bubble.
//
// Attachments are not stored as structured data on a persisted message — at
// send time they're folded into the message `content` as text markers (see
// state/chat.ts and src-tauri/src/chat/commands.rs::process_attachments):
//   [Attached image: NAME]                              → image
//   Attached file: NAME\n```\nEXTRACTED_TEXT\n```       → doc/text with content
//   [Attached file NAME could not be read as text.]     → unreadable doc
//   [Connected: NAME, NAME]                             → connector chips
//
// This module parses those markers out of the content, renders each as the
// attachment itself — the picture for images, a quiet glyph + name row for
// docs/text — and returns the cleaned text with the markers removed so they
// no longer appear as inline plain text.
//
// For the optimistic just-sent message, real ChatAttachment objects (with the
// image base64) can be passed in `liveAttachments` so images get a genuine
// preview even before the backend persists anything. For a PERSISTED image
// the marker carries the path the backend saved the bytes to, and the
// renderer re-reads them over IPC — otherwise the image survived only as a
// glyph.
import type { ChatAttachmentInput } from "../../lib/ipc";
import { splitImageMarker, usePersistedImageDataUri } from "../../lib/chatAttachments";

/** A parsed attachment to render. */
export interface ParsedAttachment {
  /** Stable key. */
  key: string;
  /** Original filename. */
  name: string;
  /** "image" | "doc" | "text" — drives the rendering shape. */
  kind: "image" | "doc" | "text";
  /** For doc/text: a short excerpt of the extracted content (preview). */
  preview?: string;
  /** For the optimistic message: a live image data URI (base64). */
  thumbDataUri?: string;
  /** For a persisted image: where the backend saved the uploaded bytes. */
  path?: string;
}

/** A single combined regex matching any attachment marker, with four
 *  alternatives captured positionally: group 1 = image name, group 2 =
 *  unreadable-doc name, group 3 = doc name, group 4 = doc body, group 5 =
 *  bracketed file name (the optimistic pre-persist marker injected by
 *  state/chat.ts). Matched in one pass (matchAll) so attachments come out in
 *  document order regardless of kind. */
const RE_ANY =
  /(?:\n*\[Attached image: ([^\]]+)\]\n*)|(?:\n*\[Attached file ([^\]]+) could not be read as text\.\]\n*)|(?:\n*Attached file: (.+?)\n```(?:\r?\n)([\s\S]*?)\r?\n```)|(?:\n*\[Attached file: ([^\]]+)\]\n*)|(?:\n*\[Connected: ([^\]]+)\]\n*)/g;

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1) : "";
}

const DOC_EXTS = ["docx", "pptx", "xlsx", "pdf", "doc", "ppt", "xls"];

/** Parse attachment markers out of `content`. Returns the list of attachments
 *  (in document order), the connector names from any `[Connected: …]` marker,
 *  and the content with every marker stripped, so the bubble shows clean
 *  text + the cards/chips above it. */
export function parseAttachments(
  content: string,
  liveAttachments?: ChatAttachmentInput[],
): { attachments: ParsedAttachment[]; connectors: string[]; text: string } {
  const attachments: ParsedAttachment[] = [];
  const connectors: string[] = [];
  let i = 0;

  // Collect every match in document order, then strip them all in one pass.
  for (const m of content.matchAll(RE_ANY)) {
    if (m[1] != null) {
      // [Attached image: NAME] or [Attached image: NAME|<path on disk>]
      const { name, path } = splitImageMarker(m[1]);
      attachments.push({
        key: `img-${i++}`,
        name,
        kind: "image",
        path,
      });
    } else if (m[2] != null) {
      // [Attached file NAME could not be read as text.]
      const name = m[2].trim();
      attachments.push({
        key: `unread-${i++}`,
        name,
        kind: "doc",
        preview: "Could not be read as text",
      });
    } else if (m[3] != null) {
      // Attached file: NAME\n```\nBODY\n```
      const name = m[3].trim();
      const body = (m[4] ?? "").trim();
      const ext = extOf(name);
      attachments.push({
        key: `doc-${i++}`,
        name,
        kind: ext && DOC_EXTS.includes(ext) ? "doc" : "text",
        preview: body.slice(0, 280),
      });
    } else if (m[5] != null) {
      // [Attached file: NAME] — the optimistic marker (pre-persist). No
      // extracted text yet; render as a plain file row.
      const name = m[5].trim();
      const ext = extOf(name);
      attachments.push({
        key: `pending-${i++}`,
        name,
        kind: ext && DOC_EXTS.includes(ext) ? "doc" : "text",
      });
    } else if (m[6] != null) {
      // [Connected: NAME, NAME] — the connectors attached to this
      // conversation at send time (composer @-menu). Chips, not cards.
      for (const name of m[6].split(",")) {
        const trimmed = name.trim();
        if (trimmed) connectors.push(trimmed);
      }
    }
  }

  const text =
    attachments.length > 0 || connectors.length > 0
      ? content.replace(RE_ANY, "")
      : content;

  // For the optimistic message, attach live image thumbnails by filename match.
  if (liveAttachments && liveAttachments.length > 0) {
    for (const a of attachments) {
      if (a.kind !== "image") continue;
      const live = liveAttachments.find(
        (la) => la.kind === "image" && la.name === a.name,
      );
      if (live?.data && live.mediaType) {
        // MIME allowlist: only forward known image media types to a data:
        // URI. An attacker who controls the `mediaType` field (a model
        // replying to the user with a synthetic attachment marker) could
        // otherwise set text/html, image/svg+xml-with-script, or
        // application/javascript, which a permissive renderer would treat
        // as active content. The frontend receives the marker from the
        // backend (which in turn trusts the user) but defensively the
        // frontend double-checks.
        if (/^image\/(png|jpe?g|gif|webp|bmp)$/i.test(live.mediaType)) {
          a.thumbDataUri = `data:${live.mediaType};base64,${live.data}`;
        }
      }
    }
  }

  return { attachments, connectors, text: text.replace(/\n{3,}/g, "\n\n").trim() };
}

function FileGlyph({ kind }: { kind: ParsedAttachment["kind"] }) {
  // Minimal outline file icon; image kind gets a picture glyph.
  if (kind === "image") {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <circle cx="8.5" cy="8.5" r="1.5" />
        <path d="m21 15-5-5L5 21" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}

/** One attachment, rendered as the attachment itself rather than a card about
 *  it. An image IS its picture — no frame, no filename row, no type pill, the
 *  way a pasted screenshot reads in any chat app; the name stays reachable in
 *  the tooltip/alt text and the model still sees it in the message body. When
 *  the bytes are gone (history from before uploads were saved, or the file has
 *  since been deleted) a dashed tile + name stands in, because a bare glyph
 *  identifies nothing. Docs/text keep their name — a file with no name is
 *  unusable — but drop the boxed card and the ext pill for a quiet glyph +
 *  name row with the content preview clamped underneath. */
function AttachmentPreviewCard({ att }: { att: ParsedAttachment }) {
  const isImage = att.kind === "image";
  // Only reach for the disk when this run didn't supply the bytes.
  const persistedUri = usePersistedImageDataUri(
    isImage && !att.thumbDataUri ? att.path : undefined,
  );
  const thumbSrc = att.thumbDataUri ?? persistedUri;

  if (isImage && thumbSrc) {
    return (
      <img
        className="msg-attachment-image"
        src={thumbSrc}
        alt={att.name}
        title={att.name}
        loading="lazy"
      />
    );
  }

  if (isImage) {
    return (
      <div className="msg-attachment-placeholder" title={att.name}>
        <FileGlyph kind="image" />
        <span className="msg-attachment-name">{att.name}</span>
      </div>
    );
  }

  return (
    <div className="msg-attachment-file" title={att.name}>
      <span className="msg-attachment-file-glyph">
        <FileGlyph kind={att.kind} />
      </span>
      <span className="msg-attachment-name">{att.name}</span>
      {att.preview && <div className="msg-attachment-preview">{att.preview}</div>}
    </div>
  );
}

/** The attachment row rendered above the message text. Returns null when
 *  there are no attachments, so the bubble layout is unchanged for plain
 *  messages. */
export function MessageAttachments({
  attachments,
}: {
  attachments: ParsedAttachment[];
}) {
  if (attachments.length === 0) return null;
  return (
    <div className="msg-attachments">
      {attachments.map((a) => (
        <AttachmentPreviewCard key={a.key} att={a} />
      ))}
    </div>
  );
}

function ConnectorGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 7V3M15 7V3M8 21a4 4 0 0 1-4-4v-3a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v3a4 4 0 0 1-4 4H8zM7 7h10v3H7z" />
    </svg>
  );
}

/** Connector chips rendered above the message text — the message-side
 *  counterpart of the composer's attach pills, so the turn shows which
 *  connectors it used. Returns null when there are none. */
export function MessageConnectors({ connectors }: { connectors: string[] }) {
  if (connectors.length === 0) return null;
  return (
    <div className="msg-connectors">
      {connectors.map((name) => (
        <span key={name} className="msg-connector-chip" title={`Connected: ${name}`}>
          <ConnectorGlyph />
          {name}
        </span>
      ))}
    </div>
  );
}
